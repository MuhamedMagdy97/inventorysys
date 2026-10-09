import type { Prisma, PurchaseReturnStatus, SerialStatus } from "@/generated/prisma/client";
import { assertTransactable } from "@/server/catalog/catalog";
import { writeAudit } from "@/server/core/audit";
import { requireNotCreator, requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { nextNumber } from "@/server/core/sequences";
import { stateMachine } from "@/server/core/state";
import { db, type Tx } from "@/server/db";
import { Dec, dec, lockPositions, pickBins, postMovements, type DecValue, type Leg } from "@/server/inventory/post";
import { perBin, takeSerials } from "@/server/inventory/serials";
import { notify } from "@/server/notifications/notify";

// Doc 13 §1, flow 8, doc 23. draft → submitted → approved (≠ creator, limit) → shipped
// (posts purchase_return, relieving each linked receipt's cost — INV-022) →
// supplier_confirmed → closed; or shipped → supplier_rejected (goods back → blocked_in,
// decided on the inspection screen) → closed. Build decisions: doc 13 §5 (PR-04…PR-08).

export const PR = stateMachine<PurchaseReturnStatus>("Purchase return", {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "draft", "cancelled"], // → draft = rejected
  approved: ["shipped", "cancelled"],
  shipped: ["supplier_confirmed", "supplier_rejected"],
  supplier_confirmed: ["closed"],
  supplier_rejected: ["closed"],
  closed: [],
  cancelled: [],
});

export type ReturnBucket = "onHand" | "blocked" | "damaged" | "expired";
const BUCKETS: ReturnBucket[] = ["onHand", "blocked", "damaged", "expired"];
// The state a unit is in while it sits in that bucket (doc 14 §3).
const SERIAL_IN: Record<ReturnBucket, SerialStatus> = { onHand: "in_stock", blocked: "quarantine", damaged: "damaged", expired: "damaged" };
// Returns that still hold (or held) units against their receipt lot.
const LIVE = { notIn: ["cancelled", "supplier_rejected"] as PurchaseReturnStatus[] };

export type PurchaseReturnLineInput = {
  variantId: string;
  qty: DecValue; // base units
  batchId?: string | null;
  bucket?: ReturnBucket; // default onHand
  receiptLineId?: string | null; // the lot to relieve; default oldest receipt first (edge #35)
  serials?: string[]; // PR-03
};

const s4 = (d: Dec) => d.toFixed(4);

async function lockPo(tx: Tx, ctx: Ctx, poId: string) {
  await tx.$executeRaw`SELECT 1 FROM purchase_order WHERE id = ${poId} AND company_id = ${ctx.companyId} FOR UPDATE`;
  const po = await tx.purchaseOrder.findFirst({ where: { id: poId, companyId: ctx.companyId }, include: { warehouse: true } });
  if (!po) throw new AppError("not_found", "Purchase order not found");
  return po;
}

// Receipt lots of a PO for one variant/batch, oldest first, with what is still returnable
// (PR-02: received − already returned). Reversed receipts and reversals hold nothing.
export async function receiptLots(tx: Tx | typeof db, ctx: Ctx, p: { poId: string; variantId?: string; batchId?: string | null; excludeReturnId?: string }) {
  const rows = await tx.receiptLine.findMany({
    where: {
      variantId: p.variantId, ...(p.batchId !== undefined ? { batchId: p.batchId } : {}),
      receipt: { poId: p.poId, companyId: ctx.companyId, reversalOfReceiptId: null, reversal: { is: null } },
    },
    include: { receipt: { select: { id: true, number: true, receivedAt: true } }, variant: { select: { sku: true } }, batch: { select: { batchNo: true } } },
    orderBy: [{ receipt: { receivedAt: "asc" } }, { lineNo: "asc" }],
  });
  const used = await tx.purchaseReturnLine.groupBy({
    by: ["receiptLineId"],
    where: { receiptLineId: { in: rows.map((r) => r.id) }, purchaseReturn: { status: LIVE, ...(p.excludeReturnId ? { id: { not: p.excludeReturnId } } : {}) } },
    _sum: { qty: true },
  });
  const out = [];
  for (const r of rows) {
    const physical = r.wrongProduct
      ? (r.held ? dec(r.baseQty) : dec(0))
      : dec(r.qtyAccepted).plus(dec(r.qtyExcessBlocked)).plus(dec(r.qtyDamaged)).plus(dec(r.qtyExpired));
    const returned = dec(used.find((u) => u.receiptLineId === r.id)?._sum.qty ?? 0);
    // Wrong-product lots have no PO price: their cost is the one they were held at.
    const unitCost = r.unitCost != null ? dec(r.unitCost) : dec((await tx.inventoryMovement.findFirst({
      where: { companyId: ctx.companyId, sourceType: "goods_receipt", sourceId: r.receiptId, idempotencyKey: { startsWith: `goods_receipt:${r.receiptId}:${r.lineNo}:` } },
    }))?.unitCost ?? 0);
    out.push({ ...r, unitCost, returnable: physical.minus(returned) });
  }
  return out;
}
type Lot = Awaited<ReturnType<typeof receiptLots>>[number];

const tooMuch = (sku: string, returnable: Dec) =>
  new AppError("validation_error", `${sku}: return exceeds received − already returned (PR-02); returnable ${returnable.toString()}`, { field: "qty", sku, returnable: returnable.toString() });

export async function createPurchaseReturn(
  tx: Tx,
  ctx: Ctx,
  input: { poId: string; reasonCode: string; note?: string | null; lines: PurchaseReturnLineInput[] },
) {
  await requirePermission(ctx, "purchases.return_create");
  const po = await lockPo(tx, ctx, input.poId); // serialises PR-02 across concurrent returns
  if (po.warehouse.status === "archived") throw new AppError("archived_conflict", "Warehouse is archived", { field: "poId" });
  const reasonCode = input.reasonCode?.trim();
  if (!reasonCode || reasonCode.length > 50) throw new AppError("validation_error", "A reason code is required (max 50 chars)", { field: "reasonCode" });
  if (!input.lines.length) throw new AppError("validation_error", "Add at least one line", { field: "lines" });

  const rows: Omit<Prisma.PurchaseReturnLineCreateManyPurchaseReturnInput, "lineNo">[] = [];
  const warnings: string[] = [];
  const taken = new Map<string, Dec>(); // receipt line → qty claimed earlier in this request
  for (const l of input.lines) {
    const v = await tx.productVariant.findFirst({ where: { id: l.variantId, companyId: ctx.companyId }, include: { product: true } });
    if (!v) throw new AppError("validation_error", "Unknown variant", { field: "variantId" });
    assertTransactable(v, "existing");
    const q = dec(l.qty);
    if (!q.gt(0) || q.decimalPlaces() > 4) throw new AppError("validation_error", `${v.sku}: quantity must be > 0 (max 4 decimals)`, { field: "qty", sku: v.sku });
    const bucket = l.bucket ?? "onHand";
    if (!BUCKETS.includes(bucket)) throw new AppError("validation_error", "Unknown bucket", { field: "bucket" });
    if (v.product.requiresBatch !== !!l.batchId) {
      throw new AppError("validation_error", v.product.requiresBatch ? `Pick the batch for ${v.sku}` : `${v.sku} is not batch-tracked`, { field: "batchId", sku: v.sku });
    }
    const lots = await receiptLots(tx, ctx, { poId: po.id, variantId: v.id, batchId: l.batchId ?? null });
    const free = (lot: Lot) => lot.returnable.minus(taken.get(lot.id) ?? 0);
    const claim = (lot: Lot, n: Dec, serials: string[] = []) => {
      taken.set(lot.id, (taken.get(lot.id) ?? dec(0)).plus(n));
      rows.push({
        receiptLineId: lot.id, receiptId: lot.receiptId, poLineId: lot.poLineId, variantId: v.id, batchId: l.batchId ?? null,
        bucket, qty: s4(n), unitCost: s4(lot.unitCost), serials,
      });
    };

    if (v.product.isSerialized) {
      // PR-03: units are named; each one links to the receipt that brought it in.
      const units = await takeSerials(tx, ctx, { sku: v.sku, variantId: v.id, warehouseId: po.warehouseId, batchId: l.batchId ?? null, qty: q, serials: l.serials, status: [SERIAL_IN[bucket]] });
      for (const [receiptLineId, group] of Map.groupBy(units, (u) => u.receiptLineId)) {
        const lot = lots.find((x) => x.id === receiptLineId);
        if (!lot) throw new AppError("validation_error", `${v.sku}: serial(s) ${group.map((u) => u.serialNo).join(", ")} were not received on this PO`, { field: "serials" });
        if (free(lot).lt(group.length)) throw tooMuch(v.sku, free(lot));
        claim(lot, dec(group.length), group.map((u) => u.serialNo));
      }
      continue;
    }
    if (l.serials?.length) throw new AppError("validation_error", `${v.sku} is not serialized`, { field: "serials" });
    if (l.receiptLineId) {
      const lot = lots.find((x) => x.id === l.receiptLineId);
      if (!lot) throw new AppError("validation_error", "That receipt line is not a lot of this item on this PO", { field: "receiptLineId" });
      if (free(lot).lt(q)) throw tooMuch(v.sku, free(lot));
      claim(lot, q);
      continue;
    }
    // Edge #35: no lot named → oldest receipt first, with an explicit notice.
    const total = lots.reduce((t, x) => t.plus(Dec.max(free(x), 0)), dec(0));
    if (total.lt(q)) throw tooMuch(v.sku, total);
    let left = q;
    const used: string[] = [];
    for (const lot of lots) {
      if (!left.gt(0)) break;
      const n = Dec.min(free(lot), left);
      if (!n.gt(0)) continue;
      claim(lot, n);
      used.push(`${lot.receipt.number} ×${n.toString()} @ ${lot.unitCost.toString()}`);
      left = left.minus(n);
    }
    warnings.push(`${v.sku}: linked oldest receipt first — ${used.join(", ")}`);
  }

  const year = new Date().getUTCFullYear();
  const pr = await tx.purchaseReturn.create({
    data: {
      companyId: ctx.companyId, number: await nextNumber(tx, ctx.companyId, `pr:${year}`, `PR-${year}-`, 5),
      poId: po.id, supplierId: po.supplierId, warehouseId: po.warehouseId, reasonCode, note: input.note?.trim() || null, createdBy: ctx.userId,
      lines: { createMany: { data: rows.map((r, i) => ({ ...r, lineNo: i + 1 })) } },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "purchase_return", entityId: pr.id, warehouseId: pr.warehouseId, after: { ...pr, warnings } });
  return { ...pr, warnings };
}

// version given → a stale write fails right after the lock, before anything posts.
async function lockReturn(tx: Tx, ctx: Ctx, id: string, version: number) {
  await tx.$executeRaw`SELECT 1 FROM purchase_return WHERE id = ${id} AND company_id = ${ctx.companyId} FOR UPDATE`;
  const r = await tx.purchaseReturn.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { lines: { orderBy: { lineNo: "asc" }, include: { variant: { include: { product: true } } } } },
  });
  if (!r) throw new AppError("not_found", "Purchase return not found");
  if (version !== r.version) throw new AppError("version_conflict", "Purchase return was changed by someone else", { currentVersion: r.version });
  return r;
}
type Locked = Awaited<ReturnType<typeof lockReturn>>;

// Stock-moving actions lock the PO first (same order as receipts), then the return.
async function lockForStock(tx: Tx, ctx: Ctx, id: string, version: number) {
  const peek = await tx.purchaseReturn.findFirst({ where: { id, companyId: ctx.companyId }, select: { poId: true, warehouseId: true } });
  if (!peek) throw new AppError("not_found", "Purchase return not found");
  await requirePermission(ctx, "purchases.return_ship", { warehouseId: peek.warehouseId });
  await lockPo(tx, ctx, peek.poId);
  return lockReturn(tx, ctx, id, version);
}

async function move(tx: Tx, r: Locked, to: PurchaseReturnStatus, data: Prisma.PurchaseReturnUpdateManyMutationInput = {}) {
  PR.assert(r.status, to);
  assertVersion(await tx.purchaseReturn.updateMany({
    where: { id: r.id, version: r.version, status: r.status },
    data: { ...data, status: to, version: { increment: 1 } },
  }), "Purchase return", r.version);
}

async function done<E extends object>(tx: Tx, ctx: Ctx, before: Locked, action: string, extra: E = {} as E) {
  const after = await tx.purchaseReturn.findUniqueOrThrow({ where: { id: before.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  const audit = await writeAudit(tx, ctx, {
    action, entityType: "purchase_return", entityId: before.id, warehouseId: before.warehouseId,
    before: { status: before.status, version: before.version }, after: { status: after.status, version: after.version, ...extra },
  });
  return { ...after, ...extra, auditId: audit.id };
}

export const returnValue = (r: { lines: { qty: DecValue; unitCost: DecValue }[] }) =>
  r.lines.reduce((t, l) => t.plus(dec(l.qty).times(dec(l.unitCost))), dec(0)).toDecimalPlaces(4);

export async function submitPurchaseReturn(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  await requirePermission(ctx, "purchases.return_create");
  const r = await lockReturn(tx, ctx, input.id, input.version);
  await move(tx, r, "submitted");
  return done(tx, ctx, r, "submit");
}

// PR-01: creator ≠ approver; INV-020 limit on the linked value.
export async function approvePurchaseReturn(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment?: string | null }) {
  const r = await lockReturn(tx, ctx, input.id, input.version);
  const amount = returnValue(r);
  await requirePermission(ctx, "purchases.return_approve", { amount });
  await requireNotCreator(ctx, r.createdBy, { type: "purchase_return", id: r.id });
  await move(tx, r, "approved", { approvedBy: ctx.userId, approvedAt: new Date() });
  await tx.approval.create({ data: { companyId: ctx.companyId, entityType: "purchase_return", entityId: r.id, actorId: ctx.userId, decision: "approved", amount: s4(amount), comment: input.comment?.trim() || null } });
  await notify(tx, ctx, { type: "purchase_return.approved", entityType: "purchase_return", entityId: r.id, warehouseId: r.warehouseId, message: `${r.number} approved — ready to ship`, link: `/returns/purchase/${r.id}` });
  return done(tx, ctx, r, "approve");
}

export async function rejectPurchaseReturn(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment: string }) {
  await requirePermission(ctx, "purchases.return_approve");
  const r = await lockReturn(tx, ctx, input.id, input.version);
  await requireNotCreator(ctx, r.createdBy, { type: "purchase_return", id: r.id });
  if (!input.comment?.trim()) throw new AppError("validation_error", "A rejection needs a comment", { field: "comment" });
  if (r.status !== "submitted") throw new AppError("invalid_transition", `Only a submitted return can be rejected (is ${r.status})`, { from: r.status, to: "draft" });
  await move(tx, r, "draft");
  await tx.approval.create({ data: { companyId: ctx.companyId, entityType: "purchase_return", entityId: r.id, actorId: ctx.userId, decision: "rejected", comment: input.comment.trim() } });
  await notify(tx, ctx, { type: "purchase_return.rejected", entityType: "purchase_return", entityId: r.id, userId: r.createdBy, message: `${r.number} sent back: ${input.comment.trim()}`, link: `/returns/purchase/${r.id}` });
  return done(tx, ctx, r, "reject");
}

export async function cancelPurchaseReturn(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  await requirePermission(ctx, ["purchases.return_create", "purchases.return_approve"]);
  const r = await lockReturn(tx, ctx, input.id, input.version);
  await move(tx, r, "cancelled");
  return done(tx, ctx, r, "cancel");
}

// Flow 8: one event; per line on_hand (or the chosen bucket) −qty at the linked receipt's
// cost; I-07 (reserved units stay) is enforced by postMovements. The shipper may
// re-point a line at another lot of the same item (edge #35).
export async function shipPurchaseReturn(
  tx: Tx,
  ctx: Ctx,
  input: { id: string; version: number; lines?: { lineId: string; receiptLineId: string }[] },
) {
  const r = await lockForStock(tx, ctx, input.id, input.version);
  PR.assert(r.status, "shipped");
  for (const o of input.lines ?? []) {
    const line = r.lines.find((l) => l.id === o.lineId);
    if (!line) throw new AppError("validation_error", "Line is not on this return", { field: "lineId" });
    if (line.variant.product.isSerialized && o.receiptLineId !== line.receiptLineId) {
      throw new AppError("validation_error", "Serialized units are linked to the receipt that brought them in", { field: "receiptLineId" });
    }
    const lot = (await receiptLots(tx, ctx, { poId: r.poId, variantId: line.variantId, batchId: line.batchId })).find((x) => x.id === o.receiptLineId);
    if (!lot) throw new AppError("validation_error", "That receipt line is not a lot of this item on this PO", { field: "receiptLineId" });
    await tx.purchaseReturnLine.update({ where: { id: line.id }, data: { receiptLineId: lot.id, receiptId: lot.receiptId, unitCost: s4(lot.unitCost) } });
    Object.assign(line, { receiptLineId: lot.id, receiptId: lot.receiptId, unitCost: lot.unitCost });
  }
  // PR-02 again under the PO lock: other returns may have shipped since this one was created.
  for (const [receiptLineId, ls] of Map.groupBy(r.lines, (l) => l.receiptLineId)) {
    const lot = (await receiptLots(tx, ctx, { poId: r.poId, variantId: ls[0].variantId, batchId: ls[0].batchId, excludeReturnId: r.id })).find((x) => x.id === receiptLineId)!;
    const want = ls.reduce((t, l) => t.plus(dec(l.qty)), dec(0));
    if (lot.returnable.lt(want)) throw tooMuch(ls[0].variant.sku, lot.returnable);
  }

  await lockPositions(tx, ctx, r.lines.map((l) => [l.variantId, r.warehouseId, l.batchId] as const));
  const legs: Leg[] = [];
  const unitIds: string[] = [];
  for (const l of r.lines) {
    const bucket = l.bucket as ReturnBucket;
    const base = {
      type: "purchase_return" as const, variantId: l.variantId, warehouseId: r.warehouseId, batchId: l.batchId, line: l.lineNo,
      unitCost: l.unitCost, linkedReceiptId: l.receiptId, reasonCode: r.reasonCode, note: r.note ?? undefined,
    };
    const push = (binId: string, n: DecValue, serialized?: true) =>
      legs.push({ ...base, binId, delta: { [bucket]: dec(n).neg() }, leg: legs.filter((x) => x.line === l.lineNo).length + 1, ...(serialized ? { serialized } : {}) });
    if (l.variant.product.isSerialized) {
      const units = await takeSerials(tx, ctx, { sku: l.variant.sku, variantId: l.variantId, warehouseId: r.warehouseId, batchId: l.batchId, qty: dec(l.qty), serials: l.serials, status: [SERIAL_IN[bucket]] });
      unitIds.push(...units.map((u) => u.id));
      for (const b of perBin(units)) push(b.binId, b.qty, true);
    } else {
      for (const b of await pickBins(tx, ctx, { variantId: l.variantId, warehouseId: r.warehouseId, batchId: l.batchId, qty: dec(l.qty), bucket })) push(b.binId, b.qty);
    }
  }
  const posted = await postMovements(tx, ctx, { sourceType: "purchase_return", sourceId: r.id, action: "ship", legs });
  if (unitIds.length) await tx.serialUnit.updateMany({ where: { id: { in: unitIds } }, data: { status: "returned_pending", binId: null, version: { increment: 1 } } });
  for (const l of r.lines) {
    if (l.poLineId) await tx.poLine.update({ where: { id: l.poLineId }, data: { qtyReturnedBase: { increment: s4(dec(l.qty)) } } });
  }
  await move(tx, r, "shipped", { shippedBy: ctx.userId, shippedAt: new Date() });
  return done(tx, ctx, r, "ship", { movementIds: posted.movements.map((m) => m.id), value: posted.movements.reduce((t, m) => t.plus(dec(m.valueDelta)), dec(0)).neg().toString() });
}

export async function confirmPurchaseReturn(tx: Tx, ctx: Ctx, input: { id: string; version: number; creditNoteRef?: string | null }) {
  await requirePermission(ctx, ["purchases.return_create", "purchases.return_ship"]);
  const r = await lockReturn(tx, ctx, input.id, input.version);
  await move(tx, r, "supplier_confirmed", { creditNoteRef: input.creditNoteRef?.trim() || null });
  const serials = r.lines.flatMap((l) => l.serials.map((serialNo) => ({ variantId: l.variantId, serialNo })));
  if (serials.length) {
    await tx.serialUnit.updateMany({ where: { companyId: ctx.companyId, status: "returned_pending", OR: serials }, data: { status: "returned", version: { increment: 1 } } });
  }
  return done(tx, ctx, r, "supplier_confirm", { creditNoteRef: input.creditNoteRef?.trim() || null });
}

// Doc 13: supplier refuses the goods → they come back as blocked_in (at the value relieved
// on ship, so the round trip nets to zero) into the quarantine bin; decided on /inspection.
export async function supplierRejectPurchaseReturn(tx: Tx, ctx: Ctx, input: { id: string; version: number; note: string }) {
  const r = await lockForStock(tx, ctx, input.id, input.version);
  if (!input.note?.trim()) throw new AppError("validation_error", "Say why the supplier refused the goods", { field: "note" });
  PR.assert(r.status, "supplier_rejected");
  const bin = await tx.bin.findFirst({ where: { warehouseId: r.warehouseId, type: "quarantine", archived: false }, orderBy: { code: "asc" } });
  if (!bin) throw new AppError("conflict", "Warehouse has no active quarantine bin", { reason: "missing_bin" });
  const shipped = await tx.inventoryMovement.findMany({ where: { companyId: ctx.companyId, sourceType: "purchase_return", sourceId: r.id } });
  const legs: Leg[] = r.lines.map((l) => {
    const value = shipped.filter((m) => m.idempotencyKey.startsWith(`purchase_return:${r.id}:${l.lineNo}:`))
      .reduce((t, m) => t.minus(dec(m.valueDelta)), dec(0));
    return {
      type: "blocked_in", variantId: l.variantId, warehouseId: r.warehouseId, binId: bin.id, batchId: l.batchId,
      delta: { blocked: l.qty }, unitCost: l.unitCost, value, line: l.lineNo, reasonCode: "supplier_rejected", note: input.note.trim(),
      ...(l.variant.product.isSerialized ? { serialized: true as const } : {}),
    };
  });
  const posted = await postMovements(tx, ctx, { sourceType: "purchase_return_rejected", sourceId: r.id, action: "supplier_reject", legs });
  for (const l of r.lines) {
    if (l.serials.length) {
      await tx.serialUnit.updateMany({
        where: { companyId: ctx.companyId, variantId: l.variantId, serialNo: { in: l.serials }, status: "returned_pending" },
        data: { status: "quarantine", warehouseId: r.warehouseId, binId: bin.id, version: { increment: 1 } },
      });
    }
    if (l.poLineId) await tx.poLine.update({ where: { id: l.poLineId }, data: { qtyReturnedBase: { decrement: s4(dec(l.qty)) } } });
  }
  await move(tx, r, "supplier_rejected", { note: [r.note, `Supplier rejected: ${input.note.trim()}`].filter(Boolean).join("\n") });
  return done(tx, ctx, r, "supplier_reject", { movementIds: posted.movements.map((m) => m.id) });
}

export async function closePurchaseReturn(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  await requirePermission(ctx, ["purchases.return_create", "purchases.return_ship"]);
  const r = await lockReturn(tx, ctx, input.id, input.version);
  await move(tx, r, "closed", { closedAt: new Date() });
  return done(tx, ctx, r, "close");
}

// ───────────── Reads ─────────────

const canView = (ctx: Ctx, warehouseId?: string) =>
  requirePermission(ctx, ["purchases.view", "purchases.return_ship"], { warehouseId: ctx.permissions.has("purchases.view") ? undefined : warehouseId });

export async function listPurchaseReturns(ctx: Ctx, input: { page: number; perPage: number; status?: PurchaseReturnStatus; q?: string; poId?: string }) {
  await canView(ctx);
  const q = input.q?.trim();
  const where: Prisma.PurchaseReturnWhereInput = {
    companyId: ctx.companyId, status: input.status, poId: input.poId,
    ...(ctx.permissions.has("purchases.view") || ctx.warehouseIds === "all" ? {} : { warehouseId: { in: ctx.warehouseIds } }),
    ...(q ? { number: { contains: q.toUpperCase() } } : {}),
  };
  const [total, items] = await Promise.all([
    db.purchaseReturn.count({ where }),
    db.purchaseReturn.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (input.page - 1) * input.perPage, take: input.perPage,
      include: { supplier: { select: { name: true } }, po: { select: { number: true } }, warehouse: { select: { code: true } }, _count: { select: { lines: true } } },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

export async function getPurchaseReturn(ctx: Ctx, id: string) {
  const r = await db.purchaseReturn.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      supplier: { select: { id: true, name: true } }, po: { select: { id: true, number: true } },
      warehouse: { select: { id: true, code: true } }, creator: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: { variant: { select: { sku: true, product: { select: { name: true } } } }, batch: { select: { batchNo: true } }, receiptLine: { select: { lineNo: true, receipt: { select: { number: true } } } } },
      },
    },
  });
  if (!r) throw new AppError("not_found", "Purchase return not found");
  await canView(ctx, r.warehouseId);
  const [approvals, movements] = await Promise.all([
    db.approval.findMany({ where: { companyId: ctx.companyId, entityType: "purchase_return", entityId: r.id }, orderBy: { createdAt: "asc" }, include: { actor: { select: { name: true } } } }),
    db.inventoryMovement.findMany({
      where: { companyId: ctx.companyId, sourceType: { in: ["purchase_return", "purchase_return_rejected"] }, sourceId: r.id },
      orderBy: { id: "asc" }, include: { bin: { select: { code: true } }, linkedReceipt: { select: { number: true } } },
    }),
  ]);
  return { ...r, approvals, movements, value: returnValue(r) };
}
