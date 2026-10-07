import type { Prisma, TransferLine, TransferStatus } from "@/generated/prisma/client";
import { assertTransactable } from "@/server/catalog/catalog";
import { writeAudit } from "@/server/core/audit";
import { inScope, requireNotCreator, requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { nextNumber } from "@/server/core/sequences";
import { stateMachine } from "@/server/core/state";
import { db, type Tx } from "@/server/db";
import { notify } from "@/server/notifications/notify";
import { Dec, dec, lockPositions, pickBins, postMovements, type DecValue, type Leg } from "./post";
import { utcToday } from "./reservations";
import { perBin, takeSerials } from "./serials";

// Doc 11 + doc 23. Ship relieves the source at WAC (transfer_out); receives admit at
// the dest at that same snapshot (transfer_in); approved missing units become a
// transfer_variance. In transit is derived from the lines, never stored (doc 07).
// Build decisions: doc 11 §5.

export const TR = stateMachine<TransferStatus>("Transfer", {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "draft", "cancelled"], // → draft = rejected
  approved: ["in_transit", "cancelled"],
  in_transit: ["partially_received", "completed", "closed_with_variance"],
  partially_received: ["partially_received", "completed", "closed_with_variance"],
  completed: [],
  closed_with_variance: [],
  cancelled: [],
});

// Warehouse archive (WH-02, edge #25) and product archive (flow 3) block on these.
export const OPEN_TRANSFER: TransferStatus[] = ["draft", "submitted", "approved", "in_transit", "partially_received"];

export type TransferLineInput = { variantId: string; qty: DecValue; batchId?: string | null };

const s4 = (d: Dec) => d.toFixed(4);
const ZERO = dec(0);

function qty(v: DecValue | undefined, field: string) {
  const d = dec(v ?? 0);
  if (d.isNeg() || d.decimalPlaces() > 4) throw new AppError("validation_error", `${field}: ≥ 0, max 4 decimals`, { field });
  return d;
}

// Shipped − received − damaged − missing (approved); a pending missing report is still in transit.
export const inTransit = (l: Pick<TransferLine, "qtyShipped" | "qtyReceived" | "qtyDamaged" | "qtyMissing">) =>
  dec(l.qtyShipped).minus(dec(l.qtyReceived)).minus(dec(l.qtyDamaged)).minus(dec(l.qtyMissing));

// Value settled by `q` of a line's in-transit units: pro rata of the shipped value; the
// settlement that empties the line takes the exact remainder, so in-transit value hits 0.
function settle(l: TransferLine, q: Dec) {
  const left = dec(l.shippedValue).minus(dec(l.settledValue));
  if (q.eq(inTransit(l))) return left;
  return Dec.min(q.times(dec(l.shippedValue)).div(dec(l.qtyShipped)).toDecimalPlaces(4), left);
}
const shipCost = (l: TransferLine) => (dec(l.qtyShipped).isZero() ? ZERO : dec(l.shippedValue).div(dec(l.qtyShipped)).toDecimalPlaces(4));

// TR-01 creator side: the requester works in either end of the transfer.
const either = (ctx: Ctx, t: { fromWarehouseId: string; toWarehouseId: string }) =>
  inScope(ctx, t.fromWarehouseId) ? t.fromWarehouseId : t.toWarehouseId;

async function activeWarehouse(tx: Tx, ctx: Ctx, id: string, field: string) {
  const w = await tx.warehouse.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!w) throw new AppError("validation_error", "Unknown warehouse", { field });
  if (w.status !== "active") throw new AppError("archived_conflict", `Warehouse ${w.code} is ${w.status} (TR-07)`, { field });
  return w;
}

// Value at the source's current WAC — the INV-020 amount for approving.
async function sourceValue(tx: Tx, warehouseId: string, lines: { variantId: string; qty: DecValue }[]) {
  const costs = await tx.variantCost.findMany({ where: { warehouseId, variantId: { in: lines.map((l) => l.variantId) } } });
  return lines.reduce((t, l) => {
    const c = costs.find((x) => x.variantId === l.variantId);
    return c && !dec(c.qty).isZero() ? t.plus(dec(l.qty).times(dec(c.value)).div(dec(c.qty))) : t;
  }, ZERO).toDecimalPlaces(4);
}

export async function createTransfer(
  tx: Tx,
  ctx: Ctx,
  input: { fromWarehouseId: string; toWarehouseId: string; notes?: string | null; lines: TransferLineInput[] },
) {
  await requirePermission(ctx, "inventory.transfer_create", { warehouseId: either(ctx, input) });
  if (input.fromWarehouseId === input.toWarehouseId) throw new AppError("validation_error", "Source and destination must differ (TR-01)", { field: "toWarehouseId" });
  const [from, to] = [await activeWarehouse(tx, ctx, input.fromWarehouseId, "fromWarehouseId"), await activeWarehouse(tx, ctx, input.toWarehouseId, "toWarehouseId")];
  if (!input.lines.length) throw new AppError("validation_error", "Add at least one line", { field: "lines" });

  const lines: Prisma.TransferLineCreateWithoutTransferInput[] = [];
  const warnings: string[] = [];
  for (const [i, l] of input.lines.entries()) {
    const v = await tx.productVariant.findFirst({ where: { id: l.variantId, companyId: ctx.companyId }, include: { product: true } });
    if (!v) throw new AppError("validation_error", "Unknown variant", { field: "variantId" });
    assertTransactable(v); // TR-07 / INV-019: no new transfers of discontinued/archived variants
    const q = qty(l.qty, "qty");
    if (q.isZero()) throw new AppError("validation_error", "Quantity must be > 0", { field: "qty", sku: v.sku });
    if (v.product.isSerialized && !q.isInteger()) throw new AppError("validation_error", `Serialized ${v.sku} moves in whole units`, { field: "qty", sku: v.sku });
    let batchId: string | null = null;
    if (v.product.requiresBatch) {
      const b = l.batchId ? await tx.batch.findFirst({ where: { id: l.batchId, variantId: v.id } }) : null;
      if (!b) throw new AppError("validation_error", `Pick the batch to move for ${v.sku} (TR-04)`, { field: "batchId", sku: v.sku });
      if (b.expiryDate && b.expiryDate <= utcToday()) throw new AppError("validation_error", `Batch ${b.batchNo} has expired`, { field: "batchId", sku: v.sku });
      batchId = b.id;
    } else if (l.batchId) {
      throw new AppError("validation_error", `${v.sku} is not batch-tracked`, { field: "batchId" });
    }
    // TR-02: request-time ATP is advisory; ship re-checks under lock.
    const [onHand, alloc] = await Promise.all([
      tx.stockBalance.aggregate({ where: { variantId: v.id, warehouseId: from.id, batchId }, _sum: { onHand: true } }),
      tx.stockAllocation.findFirst({ where: { variantId: v.id, warehouseId: from.id, batchId } }),
    ]);
    const atp = dec(onHand._sum.onHand).minus(dec(alloc?.qtyReserved));
    if (atp.lt(q)) warnings.push(`${v.sku}: only ${atp.toString()} available at ${from.code} now`);
    lines.push({ lineNo: i + 1, variant: { connect: { id: v.id } }, ...(batchId ? { batch: { connect: { id: batchId } } } : {}), qtyRequested: s4(q) });
  }
  const year = new Date().getUTCFullYear();
  const t = await tx.transfer.create({
    data: {
      company: { connect: { id: ctx.companyId } }, number: await nextNumber(tx, ctx.companyId, `tr:${year}`, `TR-${year}-`, 5),
      fromWarehouse: { connect: { id: from.id } }, toWarehouse: { connect: { id: to.id } },
      notes: input.notes?.trim() || null, creator: { connect: { id: ctx.userId } }, lines: { create: lines },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "transfer", entityId: t.id, warehouseId: from.id, after: t });
  return { ...t, warnings };
}

// Row lock first: every transition of one transfer serialises here, before ledger locks.
// version given → stale writes fail right after the lock, before anything posts (I-08, edge #33).
async function lockTransfer(tx: Tx, ctx: Ctx, id: string, version?: number) {
  await tx.$executeRaw`SELECT 1 FROM transfer WHERE id = ${id} AND company_id = ${ctx.companyId} FOR UPDATE`;
  const t = await tx.transfer.findFirst({
    where: { id, companyId: ctx.companyId },
    include: { lines: { orderBy: { lineNo: "asc" }, include: { variant: { include: { product: true } } } } },
  });
  if (!t) throw new AppError("not_found", "Transfer not found");
  if (version !== undefined && version !== t.version) throw new AppError("version_conflict", "Transfer was changed by someone else", { currentVersion: t.version });
  return t;
}

// INV-023 compare-and-increment on (id, version, status).
async function move(tx: Tx, t: { id: string; version: number; status: TransferStatus }, version: number, to: TransferStatus, data: Prisma.TransferUpdateManyMutationInput = {}) {
  TR.assert(t.status, to);
  assertVersion(await tx.transfer.updateMany({
    where: { id: t.id, version, status: t.status },
    data: { ...data, status: to, version: { increment: 1 } },
  }), "Transfer", t.version);
}

async function done(tx: Tx, ctx: Ctx, before: { id: string; fromWarehouseId: string; status: TransferStatus; version: number }, action: string, extra: object = {}) {
  const after = await tx.transfer.findUniqueOrThrow({ where: { id: before.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  const audit = await writeAudit(tx, ctx, {
    action, entityType: "transfer", entityId: before.id, warehouseId: before.fromWarehouseId,
    before: { status: before.status, version: before.version }, after: { status: after.status, version: after.version, ...extra },
  });
  return { ...after, ...extra, auditId: audit.id };
}

export async function submitTransfer(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  const t = await lockTransfer(tx, ctx, input.id, input.version);
  await requirePermission(ctx, "inventory.transfer_submit", { warehouseId: either(ctx, t) });
  await move(tx, t, input.version, "submitted");
  return done(tx, ctx, t, "submit");
}

// TR-01 / INV-006: approver ≠ creator, approve grant on the source, limit covers the value.
export async function approveTransfer(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment?: string | null }) {
  const t = await lockTransfer(tx, ctx, input.id, input.version);
  const amount = await sourceValue(tx, t.fromWarehouseId, t.lines.map((l) => ({ variantId: l.variantId, qty: l.qtyRequested })));
  await requirePermission(ctx, "inventory.transfer_approve", { warehouseId: t.fromWarehouseId, amount });
  await requireNotCreator(ctx, t.createdBy, { type: "transfer", id: t.id });
  await move(tx, t, input.version, "approved", { approvedBy: ctx.userId, approvedAt: new Date() });
  await tx.approval.create({ data: { companyId: ctx.companyId, entityType: "transfer", entityId: t.id, actorId: ctx.userId, decision: "approved", amount: s4(amount), comment: input.comment?.trim() || null } });
  await notify(tx, ctx, { type: "transfer.approved", entityType: "transfer", entityId: t.id, warehouseId: t.fromWarehouseId, message: `${t.number} approved — ready to ship`, link: `/transfers/${t.id}` });
  return done(tx, ctx, t, "approve");
}

export async function rejectTransfer(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment: string }) {
  const t = await lockTransfer(tx, ctx, input.id, input.version);
  await requirePermission(ctx, "inventory.transfer_approve", { warehouseId: t.fromWarehouseId });
  await requireNotCreator(ctx, t.createdBy, { type: "transfer", id: t.id });
  if (!input.comment?.trim()) throw new AppError("validation_error", "A rejection needs a comment", { field: "comment" });
  if (t.status !== "submitted") throw new AppError("invalid_transition", `Only a submitted transfer can be rejected (is ${t.status})`, { from: t.status, to: "draft" });
  await move(tx, t, input.version, "draft");
  await tx.approval.create({ data: { companyId: ctx.companyId, entityType: "transfer", entityId: t.id, actorId: ctx.userId, decision: "rejected", comment: input.comment.trim() } });
  await notify(tx, ctx, { type: "transfer.rejected", entityType: "transfer", entityId: t.id, userId: t.createdBy, message: `${t.number} sent back: ${input.comment.trim()}`, link: `/transfers/${t.id}` });
  return done(tx, ctx, t, "reject");
}

// TR-05: only before ship.
export async function cancelTransfer(tx: Tx, ctx: Ctx, input: { id: string; version: number; reason?: string | null }) {
  const t = await lockTransfer(tx, ctx, input.id, input.version);
  await requirePermission(ctx, ["inventory.transfer_create", "inventory.transfer_approve"], { warehouseId: either(ctx, t) });
  if (!TR.can(t.status, "cancelled")) throw new AppError("invalid_transition", "A shipped transfer can't be cancelled; receive it and transfer back (TR-05)", { from: t.status, to: "cancelled" });
  await move(tx, t, input.version, "cancelled", { closedAt: new Date(), reason: input.reason?.trim() || null });
  return done(tx, ctx, t, "cancel");
}

export type ShipLineInput = { lineId: string; qty?: DecValue; serials?: string[] };

// Doc 11 §3 ship: per position (SUM(on_hand) − shipped) ≥ reserved (I-07) and ATP ≥ shipped
// (TR-02), both enforced by postMovements under the allocation lock. Lines left out ship
// their requested qty; qty 0 leaves a line unshipped.
export async function shipTransfer(tx: Tx, ctx: Ctx, input: { id: string; version: number; lines?: ShipLineInput[] }) {
  const t = await lockTransfer(tx, ctx, input.id, input.version);
  await requirePermission(ctx, "inventory.transfer_ship", { warehouseId: t.fromWarehouseId });
  TR.assert(t.status, "in_transit");
  await activeWarehouse(tx, ctx, t.toWarehouseId, "toWarehouseId"); // TR-07: re-target before ship
  for (const l of input.lines ?? []) {
    if (!t.lines.some((x) => x.id === l.lineId)) throw new AppError("validation_error", "Line is not on this transfer", { field: "lineId" });
  }
  const plan = t.lines.map((l) => {
    const given = input.lines?.find((x) => x.lineId === l.id);
    const q = given?.qty === undefined ? dec(l.qtyRequested) : qty(given.qty, "qty");
    if (q.gt(dec(l.qtyRequested))) throw new AppError("validation_error", `${l.variant.sku}: can't ship more than requested`, { field: "qty", sku: l.variant.sku });
    return { l, q, serials: given?.serials };
  }).filter((p) => p.q.gt(0));
  if (!plan.length) throw new AppError("validation_error", "Ship at least one unit", { field: "lines" });

  await lockPositions(tx, ctx, plan.map((p) => [p.l.variantId, t.fromWarehouseId, p.l.batchId] as const));
  const legs: Leg[] = [];
  const units = new Map<string, string[]>(); // line id → serial unit ids
  for (const { l, q, serials } of plan) {
    assertTransactable(l.variant, "existing"); // TR-07: discontinued in flight still ships
    const sku = l.variant.sku;
    if (l.batchId) {
      const b = await tx.batch.findUniqueOrThrow({ where: { id: l.batchId } });
      if (b.expiryDate && b.expiryDate <= utcToday()) throw new AppError("validation_error", `Batch ${b.batchNo} has expired; it can't ship`, { sku });
    }
    const common = { type: "transfer_out" as const, variantId: l.variantId, warehouseId: t.fromWarehouseId, batchId: l.batchId, line: l.lineNo, reasonCode: "transfer" };
    if (l.variant.product.isSerialized) {
      const us = await takeSerials(tx, ctx, { sku, variantId: l.variantId, warehouseId: t.fromWarehouseId, batchId: l.batchId, qty: q, serials, status: ["in_stock"] });
      units.set(l.id, us.map((u) => u.id));
      for (const b of perBin(us)) legs.push({ ...common, binId: b.binId, delta: { onHand: -b.qty }, leg: legs.length + 1, serialized: true });
    } else {
      for (const b of await pickBins(tx, ctx, { variantId: l.variantId, warehouseId: t.fromWarehouseId, batchId: l.batchId, qty: q })) {
        legs.push({ ...common, binId: b.binId, delta: { onHand: b.qty.neg() }, leg: legs.length + 1 });
      }
    }
  }
  const posted = await postMovements(tx, ctx, { sourceType: "transfer_shipment", sourceId: t.id, action: "ship", legs });
  for (const { l, q } of plan) {
    const value = posted.movements
      .filter((m) => m.idempotencyKey.startsWith(`transfer_shipment:${t.id}:${l.lineNo}:`))
      .reduce((s, m) => s.minus(dec(m.valueDelta)), ZERO);
    await tx.transferLine.update({ where: { id: l.id }, data: { qtyShipped: s4(q), shippedValue: s4(value) } });
    const ids = units.get(l.id);
    if (ids) await tx.serialUnit.updateMany({ where: { id: { in: ids } }, data: { status: "in_transit", binId: null, transferLineId: l.id, version: { increment: 1 } } });
  }
  await move(tx, t, input.version, "in_transit", { shippedBy: ctx.userId, shippedAt: new Date() });
  await notify(tx, ctx, { type: "transfer.shipped", entityType: "transfer", entityId: t.id, warehouseId: t.toWarehouseId, message: `${t.number} is on its way`, link: `/transfers/${t.id}` });
  return done(tx, ctx, t, "ship", { movementIds: posted.movements.map((m) => m.id) });
}

export type ReceiveLineInput = {
  lineId: string;
  received?: DecValue;
  damaged?: DecValue;
  missing?: DecValue; // reported; becomes a transfer_variance once approved
  binId?: string; // sellable/receiving bin for good units (default: receiving bin)
  serials?: string[]; // good units
  damagedSerials?: string[];
};

// Doc 11 §3 receive, repeatable (partial receives). TR-03: never above what is in transit.
export async function receiveTransfer(
  tx: Tx,
  ctx: Ctx,
  input: { id: string; version: number; note?: string | null; lines: ReceiveLineInput[] },
) {
  const t = await lockTransfer(tx, ctx, input.id, input.version);
  await requirePermission(ctx, "inventory.transfer_receive", { warehouseId: t.toWarehouseId });
  if (!["in_transit", "partially_received"].includes(t.status)) throw new AppError("invalid_transition", `Nothing to receive (transfer is ${t.status})`, { status: t.status });
  if (!input.lines.length) throw new AppError("validation_error", "Add at least one line", { field: "lines" });
  const bins = await tx.bin.findMany({ where: { warehouseId: t.toWarehouseId, archived: false } });
  const pick = (f: (b: (typeof bins)[number]) => boolean, what: string) => {
    const b = bins.find(f);
    if (!b) throw new AppError("conflict", `Destination has no active ${what} bin`, { reason: "missing_bin" });
    return b;
  };

  const legs: Leg[] = [];
  const updates: { l: (typeof t.lines)[number]; rcv: Dec; dmg: Dec; miss: Dec; value: Dec; good: string[]; bad: string[]; binId: string; damagedBinId: string | null }[] = [];
  const seen = new Set<string>();
  for (const r of input.lines) {
    const l = t.lines.find((x) => x.id === r.lineId);
    if (!l || seen.has(r.lineId)) throw new AppError("validation_error", "Unknown or repeated transfer line", { field: "lineId" });
    seen.add(r.lineId);
    const sku = l.variant.sku;
    const [rcv, dmg, miss] = [qty(r.received, "received"), qty(r.damaged, "damaged"), qty(r.missing, "missing")];
    if (rcv.plus(dmg).plus(miss).isZero()) throw new AppError("validation_error", `${sku}: line has no quantity`, { field: "received", sku });
    const open = inTransit(l).minus(dec(l.qtyMissingReported));
    if (rcv.plus(dmg).plus(miss).gt(open)) {
      throw new AppError("validation_error", `${sku}: only ${open.toString()} still in transit (TR-03)`, { field: "received", sku, inTransit: open.toString() });
    }
    const serialized = l.variant.product.isSerialized;
    if (serialized && miss.gt(0) && !miss.eq(open.minus(rcv).minus(dmg))) {
      // Which units are lost must be unambiguous: the report covers every unit not received.
      throw new AppError("validation_error", `${sku}: report missing serialized units only for all units not received`, { field: "missing", sku });
    }
    const good = rcv.gt(0) && serialized
      ? (await takeSerials(tx, ctx, { sku, variantId: l.variantId, warehouseId: t.fromWarehouseId, batchId: l.batchId, qty: rcv, serials: r.serials, status: ["in_transit"], transferLineId: l.id })).map((u) => u.id) : [];
    const bad = dmg.gt(0) && serialized
      ? (await takeSerials(tx, ctx, { sku, variantId: l.variantId, warehouseId: t.fromWarehouseId, batchId: l.batchId, qty: dmg, serials: r.damagedSerials, status: ["in_transit"], transferLineId: l.id, field: "damagedSerials" })).map((u) => u.id) : [];
    if (good.some((id) => bad.includes(id))) throw new AppError("validation_error", `${sku}: a unit can't be both received and damaged`, { field: "damagedSerials", sku });

    const goodBin = r.binId
      ? pick((b) => b.id === r.binId && (b.type === "sellable" || b.type === "receiving"), "chosen sellable/receiving")
      : pick((b) => b.isDefaultReceiving, "default receiving");
    const damagedBin = dmg.gt(0) ? pick((b) => b.type === "damaged", "damaged") : null;
    const value = rcv.plus(dmg).gt(0) ? settle(l, rcv.plus(dmg)) : ZERO;
    const goodValue = dmg.isZero() ? value : rcv.times(value).div(rcv.plus(dmg)).toDecimalPlaces(4);
    const common = {
      type: "transfer_in" as const, variantId: l.variantId, warehouseId: t.toWarehouseId, batchId: l.batchId, line: l.lineNo,
      unitCost: shipCost(l), reasonCode: "transfer", ...(serialized ? { serialized: true as const } : {}),
    };
    if (rcv.gt(0)) legs.push({ ...common, binId: goodBin.id, delta: { onHand: rcv }, value: goodValue, leg: 1 });
    if (dmg.gt(0)) legs.push({ ...common, binId: damagedBin!.id, delta: { damaged: dmg }, value: value.minus(goodValue), leg: 2, reasonCode: "damaged_in_transit" });
    updates.push({ l, rcv, dmg, miss, value, good, bad, binId: goodBin.id, damagedBinId: damagedBin?.id ?? null });
  }

  // Each receive of a given version is its own source (a replay of that version is a version_conflict).
  const posted = legs.length
    ? await postMovements(tx, ctx, { sourceType: "transfer_receipt", sourceId: `${t.id}:r${t.version}`, action: "receive", legs })
    : null;
  for (const u of updates) {
    await tx.transferLine.update({
      where: { id: u.l.id },
      data: {
        qtyReceived: { increment: s4(u.rcv) }, qtyDamaged: { increment: s4(u.dmg) },
        qtyMissingReported: { increment: s4(u.miss) }, settledValue: { increment: s4(u.value) },
      },
    });
    if (u.good.length) await tx.serialUnit.updateMany({ where: { id: { in: u.good } }, data: { status: "in_stock", warehouseId: t.toWarehouseId, binId: u.binId, version: { increment: 1 } } });
    if (u.bad.length) await tx.serialUnit.updateMany({ where: { id: { in: u.bad } }, data: { status: "damaged", warehouseId: t.toWarehouseId, binId: u.damagedBinId, version: { increment: 1 } } });
  }
  const status = await statusOf(tx, t.id);
  await move(tx, t, input.version, status, status === "partially_received" ? {} : { closedAt: new Date() });
  if (updates.some((u) => u.miss.gt(0))) {
    await notify(tx, ctx, { type: "transfer.variance_reported", entityType: "transfer", entityId: t.id, warehouseId: t.toWarehouseId, message: `${t.number}: missing units reported, approval needed`, link: `/transfers/${t.id}` });
  }
  return done(tx, ctx, t, "receive", { movementIds: posted?.movements.map((m) => m.id) ?? [], note: input.note?.trim() || null });
}

// All shipped units accounted (received/damaged/missing, no pending report) → completed or
// closed_with_variance; otherwise still partially received.
async function statusOf(tx: Tx, id: string): Promise<TransferStatus> {
  const lines = await tx.transferLine.findMany({ where: { transferId: id } });
  if (lines.some((l) => inTransit(l).gt(0))) return "partially_received";
  return lines.some((l) => dec(l.qtyDamaged).gt(0) || dec(l.qtyMissing).gt(0)) ? "closed_with_variance" : "completed";
}

// Doc 11 §5: an approver (≠ creator) turns reported missing units into a transfer_variance
// (loss at the ship snapshot), or rejects the report (units stay in transit).
export async function decideVariance(tx: Tx, ctx: Ctx, input: { id: string; version: number; approve: boolean; comment?: string | null }) {
  const t = await lockTransfer(tx, ctx, input.id, input.version);
  const reported = t.lines.filter((l) => dec(l.qtyMissingReported).gt(0));
  const amount = reported.reduce((s, l) => s.plus(settle(l, dec(l.qtyMissingReported))), ZERO);
  await requirePermission(ctx, "inventory.transfer_approve", { warehouseId: t.toWarehouseId, ...(input.approve ? { amount } : {}) });
  await requireNotCreator(ctx, t.createdBy, { type: "transfer", id: t.id });
  if (!reported.length) throw new AppError("invalid_transition", "No missing units are awaiting a decision", { status: t.status });
  if (!input.approve && !input.comment?.trim()) throw new AppError("validation_error", "A rejection needs a comment", { field: "comment" });

  let movementIds: string[] = [];
  if (input.approve) {
    const legs: Leg[] = reported.map((l) => ({
      type: "transfer_variance", variantId: l.variantId, warehouseId: t.fromWarehouseId, batchId: l.batchId, delta: {},
      unitCost: shipCost(l), value: settle(l, dec(l.qtyMissingReported)), line: l.lineNo, reasonCode: "missing_in_transit",
      note: input.comment?.trim() || undefined, ...(l.variant.product.isSerialized ? { serialized: true as const } : {}),
    }));
    const posted = await postMovements(tx, { ...ctx, warehouseIds: [t.fromWarehouseId] }, {
      sourceType: "transfer_variance", sourceId: `${t.id}:v${t.version}`, action: "variance_approve", legs,
    });
    movementIds = posted.movements.map((m) => m.id);
  }
  for (const l of reported) {
    const q = dec(l.qtyMissingReported);
    await tx.transferLine.update({
      where: { id: l.id },
      data: input.approve
        ? { qtyMissing: { increment: s4(q) }, qtyMissingReported: "0", settledValue: { increment: s4(settle(l, q)) } }
        : { qtyMissingReported: "0" },
    });
    if (input.approve && l.variant.product.isSerialized) {
      await tx.serialUnit.updateMany({ where: { transferLineId: l.id, status: "in_transit" }, data: { status: "lost", version: { increment: 1 } } });
    }
  }
  await tx.approval.create({
    data: {
      companyId: ctx.companyId, entityType: "transfer_variance", entityId: t.id, actorId: ctx.userId,
      decision: input.approve ? "approved" : "rejected", amount: s4(amount), comment: input.comment?.trim() || null,
    },
  });
  const status = await statusOf(tx, t.id);
  await move(tx, t, input.version, status, status === "partially_received" ? {} : { closedAt: new Date() });
  return done(tx, ctx, t, input.approve ? "variance_approve" : "variance_reject", { movementIds });
}

// ───────────── Reads ─────────────

// Transfers touching a warehouse in scope.
const visible = (ctx: Ctx): Prisma.TransferWhereInput =>
  ctx.warehouseIds === "all" ? {} : { OR: [{ fromWarehouseId: { in: ctx.warehouseIds } }, { toWarehouseId: { in: ctx.warehouseIds } }] };

export async function listTransfers(
  ctx: Ctx,
  input: { page: number; perPage: number; status?: TransferStatus; warehouseId?: string; q?: string },
) {
  await requirePermission(ctx, "inventory.view");
  const q = input.q?.trim();
  const where: Prisma.TransferWhereInput = {
    companyId: ctx.companyId, status: input.status,
    AND: [
      visible(ctx),
      input.warehouseId ? { OR: [{ fromWarehouseId: input.warehouseId }, { toWarehouseId: input.warehouseId }] } : {},
      q ? { number: { contains: q.toUpperCase() } } : {},
    ],
  };
  const [total, items] = await Promise.all([
    db.transfer.count({ where }),
    db.transfer.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (input.page - 1) * input.perPage, take: input.perPage,
      include: { fromWarehouse: { select: { code: true } }, toWarehouse: { select: { code: true } }, _count: { select: { lines: true } } },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

export async function getTransfer(ctx: Ctx, id: string) {
  await requirePermission(ctx, "inventory.view");
  const t = await db.transfer.findFirst({
    where: { id, companyId: ctx.companyId, AND: [visible(ctx)] },
    include: {
      fromWarehouse: { select: { id: true, code: true, name: true } },
      toWarehouse: { select: { id: true, code: true, name: true } },
      creator: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          variant: { select: { sku: true, product: { select: { name: true, isSerialized: true } } } },
          batch: { select: { batchNo: true, expiryDate: true } },
          serials: { select: { serialNo: true, status: true } },
        },
      },
    },
  });
  if (!t) throw new AppError("not_found", "Transfer not found");
  const [approvals, movements] = await Promise.all([
    db.approval.findMany({ where: { companyId: ctx.companyId, entityId: t.id }, orderBy: { createdAt: "asc" }, include: { actor: { select: { name: true } } } }),
    db.inventoryMovement.findMany({
      where: { companyId: ctx.companyId, sourceType: { in: ["transfer_shipment", "transfer_receipt", "transfer_variance"] }, OR: [{ sourceId: t.id }, { sourceId: { startsWith: `${t.id}:` } }] },
      orderBy: { id: "asc" }, include: { bin: { select: { code: true } }, warehouse: { select: { code: true } } },
    }),
  ]);
  return { ...t, lines: t.lines.map((l) => ({ ...l, inTransit: inTransit(l) })), approvals, movements };
}
