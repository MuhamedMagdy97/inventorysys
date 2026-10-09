import type { Prisma, SalesReturnStatus } from "@/generated/prisma/client";
import { assertTransactable } from "@/server/catalog/catalog";
import { writeAudit } from "@/server/core/audit";
import { requireNotCreator, requirePermission, scopeFilter, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { nextNumber } from "@/server/core/sequences";
import { stateMachine } from "@/server/core/state";
import { db, type Tx } from "@/server/db";
import { Dec, dec, postMovements, type DecValue, type Leg } from "@/server/inventory/post";
import { utcToday } from "@/server/inventory/reservations";
import { notify } from "@/server/notifications/notify";

// Doc 13 §2, flow 16, doc 23. requested → approved (≠ creator) → received (+blocked,
// sale_return_quarantine at the fulfilment cost — never sellable, INV-009) → inspected on
// /inspection, lot by lot → restocked | written_off. Build decisions: doc 13 §5 (SR-05…).

export const SR = stateMachine<SalesReturnStatus>("Sales return", {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["received", "cancelled"],
  received: ["inspected"],
  inspected: ["restocked", "written_off"],
  restocked: [],
  written_off: [],
  rejected: [],
  cancelled: [],
});
const LIVE = { notIn: ["rejected", "cancelled"] as SalesReturnStatus[] };

export type SalesReturnLineInput = {
  reservationId: string; // the order line (SR-01)
  qty: DecValue;
  batchId?: string | null; // only this fulfilled batch
  serials?: string[]; // serialized: the units coming back
};

const s4 = (d: Dec) => d.toFixed(4);

// Each fulfilment movement of a reservation, oldest first, with what is still returnable
// (SR-01: fulfilled − already returned).
async function fulfilmentLots(tx: Tx | typeof db, ctx: Ctx, reservationId: string) {
  const moves = await tx.inventoryMovement.findMany({
    where: { companyId: ctx.companyId, type: "sale_fulfilment", sourceType: "fulfilment", sourceId: { startsWith: `${reservationId}:` } },
    orderBy: { id: "asc" },
  });
  const used = await tx.salesReturnLine.groupBy({
    by: ["fulfilmentMovementId"],
    where: { fulfilmentMovementId: { in: moves.map((m) => m.id) }, salesReturn: { status: LIVE } },
    _sum: { qty: true },
  });
  return moves.map((m) => ({ ...m, returnable: dec(m.dOnHand).neg().minus(dec(used.find((u) => u.fulfilmentMovementId === m.id)?._sum.qty ?? 0)) }));
}

export async function createSalesReturn(
  tx: Tx,
  ctx: Ctx,
  input: { reasonCode: string; note?: string | null; lines: SalesReturnLineInput[] },
) {
  await requirePermission(ctx, "sales.return_create");
  const reasonCode = input.reasonCode?.trim();
  if (!reasonCode || reasonCode.length > 50) throw new AppError("validation_error", "A reason code is required (max 50 chars)", { field: "reasonCode" });
  if (!input.lines.length) throw new AppError("validation_error", "Add at least one line", { field: "lines" });

  // Lock the order lines: concurrent returns of one reservation serialise here (SR-01).
  const resIds = [...new Set(input.lines.map((l) => l.reservationId))].sort();
  await tx.$executeRaw`SELECT 1 FROM reservation WHERE id = ANY(${resIds}::text[]) AND company_id = ${ctx.companyId} ORDER BY id FOR UPDATE`;
  const reservations = await tx.reservation.findMany({
    where: { id: { in: resIds }, companyId: ctx.companyId },
    include: { variant: { include: { product: true } }, warehouse: true },
  });
  if (reservations.length !== resIds.length) throw new AppError("validation_error", "Unknown order line", { field: "reservationId" });
  const warehouse = reservations[0].warehouse;
  if (reservations.some((r) => r.warehouseId !== warehouse.id)) throw new AppError("validation_error", "One return covers one warehouse's order lines", { field: "reservationId" });
  if (warehouse.status === "archived") throw new AppError("archived_conflict", "Warehouse is archived (SR-04)", { field: "reservationId" });

  const rows: Omit<Prisma.SalesReturnLineCreateManySalesReturnInput, "lineNo">[] = [];
  const taken = new Map<string, Dec>();
  for (const l of input.lines) {
    const r = reservations.find((x) => x.id === l.reservationId)!;
    const v = r.variant;
    assertTransactable(v, "existing"); // SR-04: discontinued may come back; archived may not
    const q = dec(l.qty);
    if (!q.gt(0) || q.decimalPlaces() > 4) throw new AppError("validation_error", `${v.sku}: quantity must be > 0 (max 4 decimals)`, { field: "qty", sku: v.sku });
    const lots = (await fulfilmentLots(tx, ctx, r.id)).filter((m) => !l.batchId || m.batchId === l.batchId);
    const free = (m: (typeof lots)[number]) => m.returnable.minus(taken.get(m.id) ?? 0);
    const total = lots.reduce((t, m) => t.plus(Dec.max(free(m), 0)), dec(0));
    if (total.lt(q)) {
      throw new AppError("validation_error", `${v.sku}: return exceeds fulfilled − already returned (SR-01); returnable ${total.toString()}`, { field: "qty", sku: v.sku, returnable: total.toString() });
    }
    // Serialized: the named units must be ones this order line sold; they link by batch.
    let groups: { batchId: string | null | undefined; n: Dec; serials: string[] }[] = [{ batchId: undefined, n: q, serials: [] }];
    if (v.product.isSerialized) {
      const list = [...new Set((l.serials ?? []).map((x) => x.trim()).filter(Boolean))];
      if (!q.isInteger() || list.length !== q.toNumber()) throw new AppError("validation_error", `${v.sku}: list exactly ${q.toString()} distinct serial number(s)`, { field: "serials", sku: v.sku });
      const units = await tx.serialUnit.findMany({ where: { companyId: ctx.companyId, variantId: v.id, serialNo: { in: list }, status: "sold", reservationId: r.id } });
      const bad = list.filter((n) => !units.some((u) => u.serialNo === n));
      if (bad.length) throw new AppError("validation_error", `${v.sku}: not sold on this order line: ${bad.join(", ")}`, { field: "serials", serials: bad });
      groups = [...Map.groupBy(units, (u) => u.batchId)].map(([batchId, us]) => ({ batchId, n: dec(us.length), serials: us.map((u) => u.serialNo) }));
    } else if (l.serials?.length) {
      throw new AppError("validation_error", `${v.sku} is not serialized`, { field: "serials" });
    }
    for (const g of groups) {
      let left = g.n;
      const serials = [...g.serials];
      for (const m of lots.filter((x) => g.batchId === undefined || x.batchId === g.batchId)) {
        const n = Dec.min(free(m), left);
        if (!n.gt(0)) continue;
        taken.set(m.id, (taken.get(m.id) ?? dec(0)).plus(n));
        rows.push({
          reservationId: r.id, fulfilmentMovementId: m.id, variantId: v.id, batchId: m.batchId, qty: s4(n),
          unitCost: s4(dec(m.unitCost)), serials: serials.splice(0, n.toNumber()),
        });
        left = left.minus(n);
        if (!left.gt(0)) break;
      }
      if (left.gt(0)) throw new AppError("validation_error", `${v.sku}: those units exceed what was fulfilled from their batch (SR-01)`, { field: "serials" });
    }
  }
  const orders = new Set(reservations.map((r) => r.salesOrderRefId));
  const year = new Date().getUTCFullYear();
  const sr = await tx.salesReturn.create({
    data: {
      companyId: ctx.companyId, number: await nextNumber(tx, ctx.companyId, `sr:${year}`, `SR-${year}-`, 5),
      warehouseId: warehouse.id, salesOrderRefId: orders.size === 1 ? [...orders][0] : null,
      reasonCode, note: input.note?.trim() || null, createdBy: ctx.userId,
      lines: { createMany: { data: rows.map((x, i) => ({ ...x, lineNo: i + 1 })) } },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "sales_return", entityId: sr.id, warehouseId: sr.warehouseId, after: sr });
  return sr;
}

async function lockReturn(tx: Tx, ctx: Ctx, id: string, version?: number) {
  await tx.$executeRaw`SELECT 1 FROM sales_return WHERE id = ${id} AND company_id = ${ctx.companyId} FOR UPDATE`;
  const r = await tx.salesReturn.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { lines: { orderBy: { lineNo: "asc" }, include: { variant: { include: { product: true } }, batch: true } } },
  });
  if (!r) throw new AppError("not_found", "Sales return not found");
  if (version !== undefined && version !== r.version) throw new AppError("version_conflict", "Sales return was changed by someone else", { currentVersion: r.version });
  return r;
}
type Locked = Awaited<ReturnType<typeof lockReturn>>;

async function move(tx: Tx, r: { id: string; version: number; status: SalesReturnStatus }, to: SalesReturnStatus, data: Prisma.SalesReturnUpdateManyMutationInput = {}) {
  SR.assert(r.status, to);
  assertVersion(await tx.salesReturn.updateMany({
    where: { id: r.id, version: r.version, status: r.status },
    data: { ...data, status: to, version: { increment: 1 } },
  }), "Sales return", r.version);
}

async function done<E extends object>(tx: Tx, ctx: Ctx, before: Locked, action: string, extra: E = {} as E) {
  const after = await tx.salesReturn.findUniqueOrThrow({ where: { id: before.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  const audit = await writeAudit(tx, ctx, {
    action, entityType: "sales_return", entityId: before.id, warehouseId: before.warehouseId,
    before: { status: before.status, version: before.version }, after: { status: after.status, version: after.version, ...extra },
  });
  return { ...after, ...extra, auditId: audit.id };
}

export const salesReturnValue = (r: { lines: { qty: DecValue; unitCost: DecValue }[] }) =>
  r.lines.reduce((t, l) => t.plus(dec(l.qty).times(dec(l.unitCost))), dec(0)).toDecimalPlaces(4);

export async function approveSalesReturn(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment?: string | null }) {
  const r = await lockReturn(tx, ctx, input.id, input.version);
  const amount = salesReturnValue(r);
  await requirePermission(ctx, "sales.return_approve", { amount });
  await requireNotCreator(ctx, r.createdBy, { type: "sales_return", id: r.id });
  await move(tx, r, "approved", { approvedBy: ctx.userId, approvedAt: new Date() });
  await tx.approval.create({ data: { companyId: ctx.companyId, entityType: "sales_return", entityId: r.id, actorId: ctx.userId, decision: "approved", amount: s4(amount), comment: input.comment?.trim() || null } });
  await notify(tx, ctx, { type: "sales_return.approved", entityType: "sales_return", entityId: r.id, warehouseId: r.warehouseId, message: `${r.number} approved — expect the goods`, link: `/returns/sales/${r.id}` });
  return done(tx, ctx, r, "approve");
}

// Doc 23: rejected is a terminal exit before receipt.
export async function rejectSalesReturn(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment: string }) {
  await requirePermission(ctx, "sales.return_approve");
  const r = await lockReturn(tx, ctx, input.id, input.version);
  await requireNotCreator(ctx, r.createdBy, { type: "sales_return", id: r.id });
  if (!input.comment?.trim()) throw new AppError("validation_error", "A rejection needs a comment", { field: "comment" });
  await move(tx, r, "rejected", { closedAt: new Date() });
  await tx.approval.create({ data: { companyId: ctx.companyId, entityType: "sales_return", entityId: r.id, actorId: ctx.userId, decision: "rejected", comment: input.comment.trim() } });
  await notify(tx, ctx, { type: "sales_return.rejected", entityType: "sales_return", entityId: r.id, userId: r.createdBy, message: `${r.number} rejected: ${input.comment.trim()}`, link: `/returns/sales/${r.id}` });
  return done(tx, ctx, r, "reject");
}

export async function cancelSalesReturn(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  await requirePermission(ctx, ["sales.return_create", "sales.return_approve"]);
  const r = await lockReturn(tx, ctx, input.id, input.version);
  await move(tx, r, "cancelled", { closedAt: new Date() });
  return done(tx, ctx, r, "cancel");
}

// Flow 16 receive: every unit lands in `blocked` in the quarantine bin at its fulfilment
// cost (INV-009/022), opening one quarantine lot per line. SR-03: the units keep their
// fulfilled batch unless it has expired — then they join a new inspection batch.
export async function receiveSalesReturn(
  tx: Tx,
  ctx: Ctx,
  input: { id: string; version: number; lines?: { lineId: string; qty?: DecValue; expiryDate?: Date | null }[] },
) {
  const peek = await tx.salesReturn.findFirst({ where: { id: input.id, companyId: ctx.companyId }, select: { warehouseId: true } });
  if (!peek) throw new AppError("not_found", "Sales return not found");
  await requirePermission(ctx, "sales.return_receive", { warehouseId: peek.warehouseId });
  const r = await lockReturn(tx, ctx, input.id, input.version);
  SR.assert(r.status, "received");
  const bin = await tx.bin.findFirst({ where: { warehouseId: r.warehouseId, type: "quarantine", archived: false }, orderBy: { code: "asc" } });
  if (!bin) throw new AppError("conflict", "Warehouse has no active quarantine bin", { reason: "missing_bin" });
  for (const o of input.lines ?? []) {
    if (!r.lines.some((l) => l.id === o.lineId)) throw new AppError("validation_error", "Line is not on this return", { field: "lineId" });
  }

  const today = utcToday();
  const legs: Leg[] = [];
  const plan = new Map<number, { qty: Dec; batchId: string | null }>();
  for (const l of r.lines) {
    const o = input.lines?.find((x) => x.lineId === l.id);
    const q = o?.qty === undefined ? dec(l.qty) : dec(o.qty);
    if (q.isNeg() || q.gt(dec(l.qty)) || q.decimalPlaces() > 4) throw new AppError("validation_error", `${l.variant.sku}: received must be 0…${dec(l.qty).toString()}`, { field: "qty" });
    if (q.isZero()) continue;
    if (l.variant.product.isSerialized && !q.eq(dec(l.qty))) throw new AppError("validation_error", `${l.variant.sku}: serialized lines are received whole`, { field: "qty" });
    let batchId = l.batchId;
    if (l.batch?.expiryDate && l.batch.expiryDate <= today) {
      // SR-03: never back into an expired batch → a new inspection batch.
      const exp = o?.expiryDate ? new Date(o.expiryDate.toISOString().slice(0, 10)) : null;
      if (l.variant.product.requiresExpiry && !exp) throw new AppError("validation_error", `${l.variant.sku}: batch ${l.batch.batchNo} has expired; give the expiry date for the inspection batch`, { field: "expiryDate" });
      if (exp && exp <= today) throw new AppError("validation_error", "Expiry date must be in the future", { field: "expiryDate" });
      const b = await tx.batch.create({ data: { companyId: ctx.companyId, variantId: l.variantId, batchNo: `${r.number}-${l.lineNo}`, expiryDate: exp } });
      await writeAudit(tx, ctx, { action: "create", entityType: "batch", entityId: b.id, after: { ...b, reason: "SR-03 inspection batch", replaces: l.batchId } });
      batchId = b.id;
    }
    plan.set(l.lineNo, { qty: q, batchId });
    legs.push({
      type: "sale_return_quarantine", variantId: l.variantId, warehouseId: r.warehouseId, binId: bin.id, batchId,
      delta: { blocked: q }, unitCost: l.unitCost, linkedFulfilmentRef: l.fulfilmentMovementId, line: l.lineNo, reasonCode: "sale_return",
      note: r.reasonCode, ...(l.variant.product.isSerialized ? { serialized: true as const } : {}),
    });
  }
  if (!legs.length) throw new AppError("validation_error", "Nothing received", { field: "lines" });
  const posted = await postMovements(tx, ctx, { sourceType: "sales_return", sourceId: r.id, action: "receive", legs });
  const lots = await tx.quarantineLot.findMany({ where: { movementId: { in: posted.movements.map((m) => m.id) } } });
  for (const l of r.lines) {
    const p = plan.get(l.lineNo);
    if (!p) continue;
    const lot = lots.find((x) => x.sourceLine === String(l.lineNo))!;
    await tx.salesReturnLine.update({ where: { id: l.id }, data: { qtyReceived: s4(p.qty), batchId: p.batchId, lotId: lot.id } });
    if (l.serials.length) {
      await tx.serialUnit.updateMany({
        where: { companyId: ctx.companyId, variantId: l.variantId, serialNo: { in: l.serials }, status: "sold", reservationId: l.reservationId },
        data: { status: "quarantine", warehouseId: r.warehouseId, binId: bin.id, batchId: p.batchId, version: { increment: 1 } },
      });
    }
  }
  await move(tx, r, "received", { receivedBy: ctx.userId, receivedAt: new Date() });
  return done(tx, ctx, r, "receive", { movementIds: posted.movements.map((m) => m.id) });
}

// Inspection hooks (src/server/inventory/inspection.ts). Lock order: the document first,
// then the ledger — so this runs before the inspection posts.
export async function lockReturnForLot(tx: Tx, ctx: Ctx, lotId: string) {
  const line = await tx.salesReturnLine.findUnique({ where: { lotId }, select: { returnId: true } });
  if (!line) throw new AppError("not_found", "No sales return line for this lot");
  const r = await lockReturn(tx, ctx, line.returnId);
  if (r.status !== "received") throw new AppError("invalid_transition", `Sales return is ${r.status}`, { status: r.status });
  return { ret: r, line: r.lines.find((l) => l.lotId === lotId)! };
}

// After a decision: count it on the line; once every received unit is decided the
// return is inspected → restocked (any unit back to sellable) | written_off.
export async function settleReturnLine(
  tx: Tx, ctx: Ctx, ret: Locked, lineId: string, outcome: "pass" | "reject" | "dispose", qty: Dec,
) {
  const field = outcome === "pass" ? "qtyRestocked" : outcome === "reject" ? "qtyRejected" : "qtyDisposed";
  await tx.salesReturnLine.update({ where: { id: lineId }, data: { [field]: { increment: s4(qty) } } });
  const lines = await tx.salesReturnLine.findMany({ where: { returnId: ret.id } });
  const open = lines.some((l) => dec(l.qtyReceived).gt(dec(l.qtyRestocked).plus(dec(l.qtyRejected)).plus(dec(l.qtyDisposed))));
  if (open) return ret.status;
  await move(tx, ret, "inspected");
  const end = lines.some((l) => dec(l.qtyRestocked).gt(0)) ? "restocked" : "written_off";
  await move(tx, { ...ret, status: "inspected", version: ret.version + 1 }, end, { closedAt: new Date() });
  await writeAudit(tx, ctx, { action: "inspect", entityType: "sales_return", entityId: ret.id, warehouseId: ret.warehouseId, before: { status: ret.status }, after: { status: end } });
  return end;
}

// ───────────── Reads ─────────────

export async function listSalesReturns(ctx: Ctx, input: { page: number; perPage: number; status?: SalesReturnStatus; q?: string; warehouseId?: string }) {
  await requirePermission(ctx, "sales.view");
  const q = input.q?.trim();
  const where: Prisma.SalesReturnWhereInput = {
    companyId: ctx.companyId, status: input.status, warehouseId: scopeFilter(ctx, input.warehouseId),
    ...(q ? { number: { contains: q.toUpperCase() } } : {}),
  };
  const [total, items] = await Promise.all([
    db.salesReturn.count({ where }),
    db.salesReturn.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (input.page - 1) * input.perPage, take: input.perPage,
      include: { warehouse: { select: { code: true } }, _count: { select: { lines: true } } },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

export async function getSalesReturn(ctx: Ctx, id: string) {
  const r = await db.salesReturn.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      warehouse: { select: { id: true, code: true } }, creator: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          variant: { select: { sku: true, product: { select: { name: true } } } }, batch: { select: { batchNo: true, expiryDate: true } },
          lot: { select: { id: true, qtyOpen: true, inspections: { orderBy: { createdAt: "asc" }, include: { inspector: { select: { name: true } } } } } },
        },
      },
    },
  });
  if (!r) throw new AppError("not_found", "Sales return not found");
  await requirePermission(ctx, "sales.view", { warehouseId: r.warehouseId });
  const [approvals, movements] = await Promise.all([
    db.approval.findMany({ where: { companyId: ctx.companyId, entityType: "sales_return", entityId: r.id }, orderBy: { createdAt: "asc" }, include: { actor: { select: { name: true } } } }),
    db.inventoryMovement.findMany({
      where: {
        companyId: ctx.companyId,
        OR: [{ sourceType: "sales_return", sourceId: r.id }, { sourceType: "inspection", sourceId: { in: r.lines.flatMap((l) => l.lot?.inspections.map((i) => i.id) ?? []) } }],
      },
      orderBy: { id: "asc" }, include: { bin: { select: { code: true } } },
    }),
  ]);
  return { ...r, approvals, movements, value: salesReturnValue(r) };
}

// Fulfilled order lines a return can be raised against (for the new-return screen).
export async function returnableOrderLines(ctx: Ctx, input: { reservationId?: string; externalOrderId?: string }) {
  await requirePermission(ctx, "sales.return_create");
  const rs = await db.reservation.findMany({
    where: {
      companyId: ctx.companyId, qtyFulfilled: { gt: 0 },
      ...(input.reservationId ? { id: input.reservationId } : {}),
      ...(input.externalOrderId ? { order: { externalOrderId: input.externalOrderId } } : {}),
    },
    include: { variant: { select: { sku: true } }, warehouse: { select: { code: true } }, order: { select: { channel: true, externalOrderId: true } } },
    orderBy: { createdAt: "desc" }, take: 50,
  });
  const out = [];
  for (const r of rs) {
    const lots = await fulfilmentLots(db, ctx, r.id);
    out.push({ ...r, returnable: lots.reduce((t, m) => t.plus(Dec.max(m.returnable, 0)), dec(0)).toString() });
  }
  return out;
}
