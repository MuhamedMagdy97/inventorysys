import type { Prisma, SerialStatus } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import { deny, requirePermission, scopeFilter, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db, type Tx } from "@/server/db";
import { attachEvidence } from "@/server/evidence/evidence";
import { lockReturnForLot, settleReturnLine } from "@/server/returns/sales-returns";
import { dec, postMovements, type DecValue, type Leg } from "./post";
import { utcToday } from "./reservations";
import { takeSerials } from "./serials";

// Doc 25 Inspection + doc 13 §2: blocked stock (quarantine lots) is decided lot by lot.
//   restockable          → pass: sale_return_restock / blocked_release (+ putaway to sellable)
//   damaged | defective | missing_parts → reject: blocked_reject → damaged
//   expired              → reject: blocked_reject → expired
//   dispose              → disposal straight from blocked
// The inspector is the approver of the decision (inventory.inspect, or
// sales.return_inspect for customer returns). SR-02: a pass is never decided by the
// person who received the units, unless nobody else in that warehouse could (audited).

export const DISPOSITIONS = ["restockable", "damaged", "defective", "missing_parts", "expired", "dispose"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
const OUTCOME: Record<Disposition, "pass" | "reject" | "dispose"> = {
  restockable: "pass", damaged: "reject", defective: "reject", missing_parts: "reject", expired: "reject", dispose: "dispose",
};
const SERIAL_AFTER: Record<"pass" | "reject" | "dispose", SerialStatus> = { pass: "in_stock", reject: "damaged", dispose: "disposed" };

const grantsFor = (reason: string) => (reason === "sale_return" ? ["sales.return_inspect", "inventory.inspect"] : ["inventory.inspect"]);

// What blocks a pass on this lot (null = nothing): over-deliveries need their PO decision first.
async function passBlocker(tx: Tx | typeof db, lot: { reason: string; sourceType: string; sourceId: string; sourceLine: string }) {
  if (lot.reason !== "excess" || lot.sourceType !== "goods_receipt") return null;
  const line = await tx.receiptLine.findFirst({ where: { receiptId: lot.sourceId, lineNo: Number(lot.sourceLine) }, select: { excessStatus: true } });
  if (line?.excessStatus === "approved") return null;
  return line?.excessStatus === "rejected"
    ? "This over-delivery was rejected: return it to the supplier or dispose of it"
    : "Decide the over-delivery on the PO first";
}

// SR-02 "where possible": refuse when someone else active could inspect this warehouse.
async function receiverMayPass(tx: Tx, ctx: Ctx, lot: { id: string; createdBy: string; warehouseId: string; reason: string }) {
  if (lot.createdBy !== ctx.userId) return false;
  const others = await tx.user.count({
    where: {
      companyId: ctx.companyId, status: "active", isSystem: false, isService: false, id: { not: ctx.userId },
      roles: { some: { role: { permissions: { some: { permissionCode: { in: grantsFor(lot.reason) } } } } } },
      OR: [{ roles: { some: { role: { allWarehouses: true } } } }, { warehouses: { some: { warehouseId: lot.warehouseId } } }],
    },
  });
  if (others > 0) {
    throw await deny(ctx, "The receiver can't pass their own units; another inspector is available (SR-02)", { reason: "receiver_is_inspector" }, { type: "quarantine_lot", id: lot.id, warehouseId: lot.warehouseId });
  }
  return true; // single-inspector warehouse: allowed, flagged on the inspection + audit
}

export async function inspectLot(
  tx: Tx,
  ctx: Ctx,
  input: { lotId: string; disposition: Disposition; qty: DecValue; binId?: string | null; note?: string | null; serials?: string[]; evidenceIds?: string[] },
) {
  const lot = await tx.quarantineLot.findFirst({
    where: { id: input.lotId, companyId: ctx.companyId },
    include: { variant: { include: { product: true } }, bin: true, batch: true },
  });
  if (!lot) throw new AppError("not_found", "Quarantine lot not found");
  await requirePermission(ctx, grantsFor(lot.reason), { warehouseId: lot.warehouseId });
  if (!DISPOSITIONS.includes(input.disposition)) throw new AppError("validation_error", "Unknown disposition", { field: "disposition" });
  const outcome = OUTCOME[input.disposition];
  const q = dec(input.qty);
  if (!q.gt(0) || q.decimalPlaces() > 4) throw new AppError("validation_error", "Quantity must be > 0 (max 4 decimals)", { field: "qty" });
  if (q.gt(dec(lot.qtyOpen))) throw new AppError("validation_error", `Only ${dec(lot.qtyOpen).toString()} left to inspect in this lot`, { field: "qty" });
  const note = input.note?.trim() || null;
  if (outcome !== "pass" && !note && !input.evidenceIds?.length) {
    throw new AppError("validation_error", "A reject or disposal needs a note or evidence", { field: "note" });
  }

  // Document first, then the ledger (lock order).
  const sr = lot.reason === "sale_return" ? await lockReturnForLot(tx, ctx, lot.id) : null;

  let sodWaived = false;
  let target = lot.bin;
  if (outcome === "pass") {
    const blocker = await passBlocker(tx, lot);
    if (blocker) throw new AppError("invalid_transition", blocker, { reason: lot.reason });
    if (lot.batch?.expiryDate && lot.batch.expiryDate <= utcToday()) {
      throw new AppError("validation_error", `Batch ${lot.batch.batchNo} has expired: reject these units as expired (SR-03)`, { field: "disposition" });
    }
    sodWaived = await receiverMayPass(tx, ctx, lot);
    // Restocked units leave the quarantine/damaged bin for a sellable one (doc 25 preview shows the putaway).
    const chosen = input.binId
      ? await tx.bin.findFirst({ where: { id: input.binId, warehouseId: lot.warehouseId, archived: false, type: { in: ["sellable", "receiving"] } } })
      : lot.bin.type === "sellable" || lot.bin.type === "receiving" ? lot.bin
      : await tx.bin.findFirst({ where: { warehouseId: lot.warehouseId, isDefaultSellable: true, archived: false } });
    if (!chosen) throw new AppError(input.binId ? "validation_error" : "conflict", input.binId ? "Pick a sellable or receiving bin of this warehouse" : "Warehouse has no default sellable bin", { field: "binId", reason: "missing_bin" });
    target = chosen;
  } else if (input.binId) {
    throw new AppError("validation_error", "Only a pass moves units to another bin", { field: "binId" });
  }

  const units = lot.variant.product.isSerialized
    ? await takeSerials(tx, ctx, { sku: lot.variant.sku, variantId: lot.variantId, warehouseId: lot.warehouseId, batchId: lot.batchId, binId: lot.binId, qty: q, serials: input.serials, status: ["quarantine"] })
    : [];
  if (!lot.variant.product.isSerialized && input.serials?.length) throw new AppError("validation_error", `${lot.variant.sku} is not serialized`, { field: "serials" });

  const inspection = await tx.inspection.create({
    data: {
      companyId: ctx.companyId, lotId: lot.id, warehouseId: lot.warehouseId, disposition: input.disposition, outcome, qty: q.toFixed(4),
      note, serials: units.map((u) => u.serialNo), inspectorId: ctx.userId, sodWaived,
    },
  });
  const base = {
    variantId: lot.variantId, warehouseId: lot.warehouseId, batchId: lot.batchId, line: 1, reasonCode: input.disposition, note: note ?? undefined,
    ...(units.length ? { serialized: true as const } : {}),
  };
  const legs: Leg[] = [];
  if (outcome === "pass") {
    legs.push({ ...base, type: lot.reason === "sale_return" ? "sale_return_restock" : "blocked_release", binId: lot.binId, delta: { blocked: q.neg(), onHand: q }, lotId: lot.id, leg: 1 });
    if (target.id !== lot.binId) {
      legs.push({ ...base, type: "putaway_out", binId: lot.binId, delta: { onHand: q.neg() }, leg: 2 });
      legs.push({ ...base, type: "putaway_in", binId: target.id, delta: { onHand: q }, leg: 3 });
    }
  } else if (outcome === "reject") {
    legs.push({ ...base, type: "blocked_reject", binId: lot.binId, delta: { blocked: q.neg(), [input.disposition === "expired" ? "expired" : "damaged"]: q }, lotId: lot.id, leg: 1 });
  } else {
    legs.push({ ...base, type: "disposal", binId: lot.binId, delta: { blocked: q.neg() }, lotId: lot.id, leg: 1 });
  }
  const posted = await postMovements(tx, ctx, { sourceType: "inspection", sourceId: inspection.id, action: "inspect", legs });
  if (units.length) {
    await tx.serialUnit.updateMany({
      where: { id: { in: units.map((u) => u.id) } },
      data: { status: SERIAL_AFTER[outcome], ...(outcome === "pass" ? { binId: target.id } : {}), version: { increment: 1 } },
    });
  }
  const evidenceIds = await attachEvidence(tx, ctx, input.evidenceIds, { type: "inspection", id: inspection.id, warehouseId: lot.warehouseId });
  const returnStatus = sr ? await settleReturnLine(tx, ctx, sr.ret, sr.line.id, outcome, q) : null;
  const audit = await writeAudit(tx, ctx, {
    action: "inspect", entityType: "quarantine_lot", entityId: lot.id, warehouseId: lot.warehouseId, reason: note,
    after: { inspectionId: inspection.id, disposition: input.disposition, outcome, qty: q.toString(), sodWaived, evidenceIds, movementIds: posted.movements.map((m) => m.id), returnStatus },
  });
  return {
    inspection, outcome, sodWaived, evidenceIds, returnStatus,
    lot: await tx.quarantineLot.findUniqueOrThrow({ where: { id: lot.id } }),
    movementIds: posted.movements.map((m) => m.id), auditId: audit.id,
  };
}

// ───────────── Reads ─────────────

// The quarantine list (doc 25): open lots by reason, oldest first, with whether a pass is possible now.
export async function listQuarantine(ctx: Ctx, input: { warehouseId?: string; reason?: string } = {}) {
  await requirePermission(ctx, ["inventory.inspect", "sales.return_inspect", "inventory.view"], { warehouseId: input.warehouseId });
  const where: Prisma.QuarantineLotWhereInput = {
    companyId: ctx.companyId, qtyOpen: { gt: 0 }, warehouseId: scopeFilter(ctx, input.warehouseId), reason: input.reason,
  };
  const lots = await db.quarantineLot.findMany({
    where, orderBy: { createdAt: "asc" }, take: 500, // ponytail: one page; paginate past 500
    include: {
      variant: { select: { sku: true, product: { select: { name: true, isSerialized: true } } } },
      bin: { select: { code: true, type: true } }, batch: { select: { batchNo: true, expiryDate: true } }, warehouse: { select: { code: true } },
      salesReturnLine: { select: { salesReturn: { select: { id: true, number: true } } } },
    },
  });
  const units = await db.serialUnit.findMany({
    where: { companyId: ctx.companyId, status: "quarantine", variantId: { in: lots.filter((l) => l.variant.product.isSerialized).map((l) => l.variantId) } },
    select: { serialNo: true, variantId: true, binId: true, batchId: true },
  });
  return Promise.all(lots.map(async (l) => ({
    ...l,
    passBlocker: await passBlocker(db, l),
    serials: units.filter((u) => u.variantId === l.variantId && u.binId === l.binId && u.batchId === l.batchId).map((u) => u.serialNo),
  })));
}

export async function listInspections(ctx: Ctx, input: { warehouseId?: string; take?: number } = {}) {
  await requirePermission(ctx, ["inventory.inspect", "sales.return_inspect", "inventory.view"], { warehouseId: input.warehouseId });
  return db.inspection.findMany({
    where: { companyId: ctx.companyId, warehouseId: scopeFilter(ctx, input.warehouseId) },
    orderBy: { createdAt: "desc" }, take: input.take ?? 50,
    include: {
      inspector: { select: { name: true } },
      lot: { select: { reason: true, variant: { select: { sku: true } }, warehouse: { select: { code: true } } } },
    },
  });
}
