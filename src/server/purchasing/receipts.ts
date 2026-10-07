import type { Prisma, SerialStatus } from "@/generated/prisma/client";
import { assertTransactable, uomFactor } from "@/server/catalog/catalog";
import { writeAudit } from "@/server/core/audit";
import { requireNotCreator, requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { nextNumber } from "@/server/core/sequences";
import { db, type Tx } from "@/server/db";
import { Dec, dec, postMovements, type DecValue, type Leg } from "@/server/inventory/post";
import { readSettings } from "@/server/settings/settings";
import { baseUnitCost, lineTotal, PO, receivedStatus, recalcTotals, RECEIVABLE } from "./purchase-orders";

// Doc 10. A receipt posts balances + movements + PO progress + audit in ONE transaction
// (flow 6/7). Corrections are reversal receipts (RC-08), never edits.

export type ReceiptLineInput = {
  poLineId?: string; // PO line being received …
  variantId?: string; // … or the item that actually arrived instead (wrong product, RC-13)
  uom?: string; // default: the PO line's order unit (wrong product: base unit)
  accepted?: DecValue; // in `uom`
  damaged?: DecValue;
  expired?: DecValue;
  missing?: DecValue; // short vs delivery note; claim info only
  qty?: DecValue; // wrong product: units that arrived
  held?: boolean; // wrong product kept on site → blocked_in (default true)
  binId?: string; // sellable/receiving bin for accepted units (default: receiving bin)
  batchNo?: string;
  expiryDate?: Date;
  mfgDate?: Date;
  serials?: string[]; // accepted + excess (+ held wrong product) units
  damagedSerials?: string[]; // damaged + expired units
  note?: string;
};

const ZERO = dec(0);
const s4 = (d: Dec) => d.toFixed(4);
const today = () => new Date(new Date().toISOString().slice(0, 10));

function qty(v: DecValue | undefined, field: string) {
  const d = dec(v ?? 0);
  if (d.isNeg() || d.decimalPlaces() > 4) throw new AppError("validation_error", `${field}: ≥ 0, max 4 decimals`, { field });
  return d;
}

// Locks the PO row: concurrent receipts of one PO serialise here (edge #1), before any ledger lock.
async function lockPo(tx: Tx, ctx: Ctx, poId: string) {
  await tx.$executeRaw`SELECT 1 FROM purchase_order WHERE id = ${poId} AND company_id = ${ctx.companyId} FOR UPDATE`;
  const po = await tx.purchaseOrder.findFirst({ where: { id: poId, companyId: ctx.companyId }, include: { lines: true, supplier: true } });
  if (!po) throw new AppError("not_found", "Purchase order not found");
  return po;
}

async function grn(tx: Tx, ctx: Ctx) {
  const year = new Date().getUTCFullYear();
  return nextNumber(tx, ctx.companyId, `grn:${year}`, `GRN-${year}-`, 5);
}

// B-01/B-02/RC-10: find or create the batch; expiry must be in the future and match.
// Also used by opening balances (Part 8), which have no supplier.
export async function resolveBatch(tx: Tx, ctx: Ctx, v: { id: string; sku: string; product: { requiresBatch: boolean; requiresExpiry: boolean } }, l: Pick<ReceiptLineInput, "batchNo" | "expiryDate" | "mfgDate">, supplierId: string | null) {
  const batchNo = l.batchNo?.trim();
  if (!v.product.requiresBatch) {
    if (batchNo || l.expiryDate) throw new AppError("validation_error", `${v.sku} is not batch-tracked`, { field: "batchNo" });
    return null;
  }
  if (!batchNo) throw new AppError("validation_error", `Batch number required for ${v.sku}`, { field: "batchNo", sku: v.sku });
  if (v.product.requiresExpiry && !l.expiryDate) throw new AppError("validation_error", `Expiry date required for ${v.sku}`, { field: "expiryDate", sku: v.sku });
  if (l.expiryDate && l.expiryDate <= today()) {
    throw new AppError("validation_error", "Batch has already expired; record these units as expired (B-02)", { field: "expiryDate", sku: v.sku });
  }
  const found = await tx.batch.findUnique({ where: { variantId_batchNo: { variantId: v.id, batchNo } } });
  if (found) {
    if ((found.expiryDate?.getTime() ?? null) !== (l.expiryDate ? new Date(l.expiryDate.toISOString().slice(0, 10)).getTime() : null)) {
      throw new AppError("validation_error", `Batch ${batchNo} exists with a different expiry`, { field: "expiryDate", sku: v.sku });
    }
    return found;
  }
  return tx.batch.create({
    data: { companyId: ctx.companyId, variantId: v.id, batchNo, expiryDate: l.expiryDate ?? null, mfgDate: l.mfgDate ?? null },
  }).then(async (b) => {
    await writeAudit(tx, ctx, { action: "create", entityType: "batch", entityId: b.id, after: { ...b, supplierId } });
    return b;
  });
}

function serialList(list: string[] | undefined, expected: Dec, isSerialized: boolean, sku: string, field: string) {
  const xs = (list ?? []).map((x) => x.trim()).filter(Boolean);
  if (!isSerialized) {
    if (xs.length) throw new AppError("validation_error", `${sku} is not serialized`, { field });
    return [];
  }
  if (!expected.isInteger()) throw new AppError("validation_error", `Serialized ${sku} is received in whole units`, { field: "accepted", sku });
  if (xs.length !== expected.toNumber() || new Set(xs).size !== xs.length) {
    throw new AppError("validation_error", `${sku}: list exactly ${expected.toString()} distinct serial number(s) (RC-11)`, { field, sku, expected: expected.toString(), got: xs.length });
  }
  return xs;
}

// Flow 6/7 + doc 10 §3. RC-01: `inventory.receive` in the PO's warehouse.
export async function postReceipt(
  tx: Tx,
  ctx: Ctx,
  input: { poId: string; supplierRef?: string | null; note?: string | null; lines: ReceiptLineInput[] },
  idempotencyKey?: string | null,
) {
  const peek = await tx.purchaseOrder.findFirst({ where: { id: input.poId, companyId: ctx.companyId }, select: { warehouseId: true } });
  if (!peek) throw new AppError("not_found", "Purchase order not found");
  await requirePermission(ctx, "inventory.receive", { warehouseId: peek.warehouseId });
  const po = await lockPo(tx, ctx, input.poId);
  if (!RECEIVABLE.includes(po.status)) throw new AppError("invalid_transition", `Receiving needs an ordered PO (is ${po.status}) (PO-04)`, { status: po.status });
  if (!input.lines.length) throw new AppError("validation_error", "Add at least one line", { field: "lines" });

  const settings = await readSettings(tx, ctx.companyId);
  const tolerancePct = dec((po.supplier.receiptTolerancePct ?? settings.receiptTolerancePct).toString());
  const bins = await tx.bin.findMany({ where: { warehouseId: po.warehouseId, archived: false } });
  const pick = (f: (b: (typeof bins)[number]) => boolean, what: string) => {
    const b = bins.find(f);
    if (!b) throw new AppError("conflict", `Warehouse has no active ${what} bin`, { reason: "missing_bin" });
    return b;
  };
  const received = new Map(po.lines.map((l) => [l.id, dec(l.qtyReceivedBase.toString())]));
  const warnings: string[] = [];

  type Planned = {
    row: Omit<Prisma.ReceiptLineCreateManyInput, "receiptId" | "lineNo">;
    legs: Omit<Leg, "line">[];
    serials: { serialNo: string; status: SerialStatus; binId: string }[];
  };
  const planned: Planned[] = [];
  for (const l of input.lines) {
    const poLine = l.poLineId ? po.lines.find((x) => x.id === l.poLineId && !x.removed) : null;
    if (l.poLineId && !poLine) throw new AppError("validation_error", "Line is not on this PO", { field: "poLineId" });
    const variantId = poLine?.variantId ?? l.variantId;
    if (!variantId) throw new AppError("validation_error", "Each line needs a PO line or the variant that arrived", { field: "poLineId" });
    const v = await tx.productVariant.findFirst({ where: { id: variantId, companyId: ctx.companyId }, include: { product: true } });
    if (!v) throw new AppError("validation_error", "Unknown variant", { field: "variantId" });
    assertTransactable(v, "existing"); // RC-04: archived blocked; discontinued finishes open PO qty

    const uom = l.uom ?? poLine?.orderUom ?? v.product.baseUom;
    const factor = dec((await uomFactor(tx, v.productId, uom)).toString());
    const base = (d: Dec, field: string) => {
      const b = d.times(factor);
      if (b.decimalPlaces() > 4) throw new AppError("validation_error", `${field} × unit factor needs more than 4 decimals`, { field });
      return b;
    };
    const batch = await resolveBatch(tx, ctx, v, l, po.supplierId);
    const binOf = (b: (typeof bins)[number]) => b.id;
    const goodBin = l.binId
      ? pick((b) => b.id === l.binId && (b.type === "sellable" || b.type === "receiving"), "chosen sellable/receiving")
      : pick((b) => b.isDefaultReceiving, "default receiving");
    const common = { variantId: v.id, warehouseId: po.warehouseId, batchId: batch?.id ?? null, ...(v.product.isSerialized ? { serialized: true as const } : {}) };

    if (!poLine) {
      // Wrong product (doc 10 §3): no PO effect; held units are quarantined at current WAC.
      const q = base(qty(l.qty, "qty"), "qty");
      if (q.isZero()) throw new AppError("validation_error", "Quantity must be > 0 (edge #30)", { field: "qty" });
      const held = l.held !== false;
      const serials = held ? serialList(l.serials, q, v.product.isSerialized, v.sku, "serials") : [];
      planned.push({
        row: {
          variantId: v.id, wrongProduct: true, held, orderUom: uom, uomFactor: factor.toFixed(6), orderQty: s4(qty(l.qty, "qty")), baseQty: s4(q),
          batchId: batch?.id ?? null, binId: goodBin.id, note: l.note?.trim() || null,
        },
        legs: held ? [{ ...common, type: "blocked_in", binId: goodBin.id, delta: { blocked: q }, leg: 1, reasonCode: "wrong_product" }] : [],
        serials: serials.map((serialNo) => ({ serialNo, status: "quarantine", binId: binOf(goodBin) })),
      });
      continue;
    }

    const [accIn, dmgIn, expIn, missIn] = [qty(l.accepted, "accepted"), qty(l.damaged, "damaged"), qty(l.expired, "expired"), qty(l.missing, "missing")];
    const [acc, dmg, exp, miss] = [base(accIn, "accepted"), base(dmgIn, "damaged"), base(expIn, "expired"), base(missIn, "missing")];
    if (acc.plus(dmg).plus(exp).plus(miss).isZero()) throw new AppError("validation_error", "Line has no quantity (edge #30)", { field: "accepted" });

    // PO-04/INV-007: accepted ≤ ordered + tolerance; the excess is blocked, never sellable (edge #22).
    const ordered = dec(poLine.qtyOrderedBase.toString());
    const room = Dec.max(ordered.times(dec(100).plus(tolerancePct)).div(100).toDecimalPlaces(4).minus(received.get(poLine.id)!), ZERO);
    const accepted = Dec.min(acc, room);
    const excess = acc.minus(accepted);
    received.set(poLine.id, received.get(poLine.id)!.plus(accepted));
    const inspection = v.requiresInspection || po.supplier.requiresInspection; // RC-05
    const unitCost = baseUnitCost({ unitPrice: poLine.unitPrice.toString(), discountPct: poLine.discountPct.toString(), uomFactor: poLine.uomFactor.toString() });
    if (excess.gt(0)) warnings.push(`${v.sku}: ${excess.toString()} over the ordered quantity held as blocked pending a decision`);

    const good = serialList(l.serials, acc, v.product.isSerialized, v.sku, "serials");
    const bad = serialList(l.damagedSerials, dmg.plus(exp), v.product.isSerialized, v.sku, "damagedSerials");
    const damagedBin = dmg.gt(0) ? pick((b) => b.type === "damaged", "damaged") : null;
    const quarantineBin = exp.gt(0) ? pick((b) => b.type === "quarantine", "quarantine") : null;
    const legs: Omit<Leg, "line">[] = [];
    if (accepted.gt(0)) {
      legs.push(inspection
        ? { ...common, type: "blocked_in", binId: goodBin.id, delta: { blocked: accepted }, unitCost, leg: 1, reasonCode: "inspection" }
        : { ...common, type: "purchase_receipt", binId: goodBin.id, delta: { onHand: accepted }, unitCost, leg: 1, reasonCode: "received" });
    }
    if (excess.gt(0)) legs.push({ ...common, type: "blocked_in", binId: goodBin.id, delta: { blocked: excess }, unitCost, leg: 2, reasonCode: "excess" });
    if (dmg.gt(0)) legs.push({ ...common, type: "purchase_receipt", binId: damagedBin!.id, delta: { damaged: dmg }, unitCost, leg: 3, reasonCode: "damaged" });
    if (exp.gt(0)) legs.push({ ...common, type: "purchase_receipt", binId: quarantineBin!.id, delta: { expired: exp }, unitCost, leg: 4, reasonCode: "expired" });

    const goodN = accepted.toNumber();
    planned.push({
      row: {
        poLineId: poLine.id, variantId: v.id, orderUom: uom, uomFactor: factor.toFixed(6),
        orderQty: s4(accIn.plus(dmgIn).plus(expIn)), baseQty: s4(acc.plus(dmg).plus(exp)),
        qtyAccepted: s4(accepted), qtyDamaged: s4(dmg), qtyExpired: s4(exp), qtyExcessBlocked: s4(excess), qtyMissing: s4(miss),
        inspection, batchId: batch?.id ?? null, binId: goodBin.id, unitCost: s4(unitCost), note: l.note?.trim() || null,
        excessStatus: excess.gt(0) ? "pending" : null,
      },
      legs,
      serials: [
        ...good.map((serialNo, i) => ({ serialNo, status: (i < goodN && !inspection ? "in_stock" : "quarantine") as SerialStatus, binId: goodBin.id })),
        ...bad.slice(0, dmg.toNumber()).map((serialNo) => ({ serialNo, status: "damaged" as SerialStatus, binId: damagedBin?.id ?? goodBin.id })),
        ...bad.slice(dmg.toNumber()).map((serialNo) => ({ serialNo, status: "damaged" as SerialStatus, binId: quarantineBin?.id ?? goodBin.id })),
      ],
    });
  }

  const receipt = await tx.goodsReceipt.create({
    data: {
      companyId: ctx.companyId, number: await grn(tx, ctx), poId: po.id, warehouseId: po.warehouseId,
      supplierRef: input.supplierRef?.trim() || null, note: input.note?.trim() || null, receivedBy: ctx.userId, idempotencyKey: idempotencyKey ?? null,
    },
  });
  const rows = await tx.receiptLine.createManyAndReturn({ data: planned.map((p, i) => ({ ...p.row, receiptId: receipt.id, lineNo: i + 1 })) });
  const legs = planned.flatMap((p, i) => p.legs.map((leg) => ({ ...leg, line: i + 1 })));
  const posted = legs.length
    ? await postMovements(tx, ctx, { sourceType: "goods_receipt", sourceId: receipt.id, legs, action: "receive" })
    : null;
  const serials = planned.flatMap((p, i) => p.serials.map((s) => ({
    ...s, companyId: ctx.companyId, variantId: rows[i].variantId, batchId: rows[i].batchId, warehouseId: po.warehouseId, receiptLineId: rows[i].id,
  })));
  if (serials.length) {
    // S-01: globally unique among live units (the partial unique index is the backstop).
    const taken = await tx.serialUnit.findMany({ where: { companyId: ctx.companyId, serialNo: { in: serials.map((s) => s.serialNo) }, status: { not: "reversed" } }, select: { serialNo: true } });
    const dupes = [...taken.map((t) => t.serialNo), ...serials.map((s) => s.serialNo).filter((n, i, a) => a.indexOf(n) !== i)];
    if (dupes.length) throw new AppError("duplicate", `Serial number(s) already exist: ${[...new Set(dupes)].join(", ")}`, { field: "serials", serials: [...new Set(dupes)] });
    await tx.serialUnit.createMany({ data: serials });
  }

  for (const [id, r] of received) {
    const line = po.lines.find((l) => l.id === id)!;
    if (!r.eq(line.qtyReceivedBase.toString())) await tx.poLine.update({ where: { id }, data: { qtyReceivedBase: s4(r) } });
  }
  const status = await receivedStatus(tx, po.id);
  if (status !== po.status) PO.assert(po.status, status);
  await tx.purchaseOrder.update({ where: { id: po.id }, data: { status, version: { increment: 1 } } });
  await writeAudit(tx, ctx, {
    action: "receipt_posted", entityType: "purchase_order", entityId: po.id, warehouseId: po.warehouseId,
    before: { status: po.status }, after: { status, receiptId: receipt.id, number: receipt.number },
  });
  return {
    receipt: { ...receipt, lines: rows }, poStatus: status, warnings,
    movementIds: posted?.movements.map((m) => m.id) ?? [], auditId: posted?.auditId ?? null,
  };
}

// RC-08: mirror every movement of the receipt (and of an approved excess release) with
// `reverses_movement_id`; roll qty_received + PO status back; serials → `reversed`.
export async function reverseReceipt(tx: Tx, ctx: Ctx, input: { receiptId: string; reason: string }) {
  const original = await tx.goodsReceipt.findFirst({ where: { id: input.receiptId, companyId: ctx.companyId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!original) throw new AppError("not_found", "Receipt not found");
  if (original.reversalOfReceiptId) throw new AppError("invalid_transition", "A reversal can't be reversed; post a new receipt", { reason: "is_reversal" });
  if (!input.reason?.trim()) throw new AppError("validation_error", "A reversal needs a reason", { field: "reason" });
  const po = await lockPo(tx, ctx, original.poId);
  if (await tx.goodsReceipt.findUnique({ where: { reversalOfReceiptId: original.id } })) throw new AppError("duplicate", "Receipt was already reversed");
  if (!["ordered", "partially_received", "fully_received"].includes(po.status)) {
    throw new AppError("invalid_transition", `Receipts of a ${po.status} PO can't be reversed`, { status: po.status });
  }
  const moves = await tx.inventoryMovement.findMany({
    where: {
      companyId: ctx.companyId,
      OR: [{ sourceType: "goods_receipt", sourceId: original.id }, { sourceType: "receipt_excess", sourceId: { in: original.lines.map((l) => l.id) } }],
    },
    orderBy: { id: "asc" },
  });
  const value = moves.filter((m) => m.sourceType === "goods_receipt").reduce((t, m) => t.plus(m.valueDelta.toString()), dec(0));
  await requirePermission(ctx, "inventory.adjust_approve", { warehouseId: original.warehouseId, amount: value.toFixed(4) });

  const reversal = await tx.goodsReceipt.create({
    data: {
      companyId: ctx.companyId, number: await grn(tx, ctx), poId: po.id, warehouseId: original.warehouseId,
      note: input.reason.trim(), receivedBy: ctx.userId, reversalOfReceiptId: original.id,
    },
  });
  const neg = (d: Prisma.Decimal) => s4(dec(d.toString()).neg());
  await tx.receiptLine.createMany({
    data: original.lines.map((l) => ({
      receiptId: reversal.id, lineNo: l.lineNo, poLineId: l.poLineId, variantId: l.variantId, wrongProduct: l.wrongProduct, held: l.held,
      orderUom: l.orderUom, uomFactor: l.uomFactor, orderQty: neg(l.orderQty), baseQty: neg(l.baseQty),
      qtyAccepted: neg(l.qtyAccepted), qtyDamaged: neg(l.qtyDamaged), qtyExpired: neg(l.qtyExpired), qtyExcessBlocked: neg(l.qtyExcessBlocked),
      qtyMissing: neg(l.qtyMissing), inspection: l.inspection, batchId: l.batchId, binId: l.binId, unitCost: l.unitCost, note: input.reason.trim(),
    })),
  });
  // Excess releases first, so the blocked units are back in `blocked` when blocked_in is undone.
  const ordered = [...moves.filter((m) => m.sourceType === "receipt_excess"), ...moves.filter((m) => m.sourceType === "goods_receipt")];
  const posted = ordered.length
    ? await postMovements(tx, ctx, {
      sourceType: "goods_receipt", sourceId: reversal.id, action: "reverse",
      legs: ordered.map((m, i) => ({
        type: m.type, variantId: m.variantId, warehouseId: m.warehouseId, binId: m.binId, batchId: m.batchId, serialized: true,
        delta: { onHand: m.dOnHand.neg(), blocked: m.dBlocked.neg(), damaged: m.dDamaged.neg(), expired: m.dExpired.neg() },
        line: i + 1, reasonCode: "receipt_reversal", note: input.reason.trim(), reversesMovementId: m.id,
      })),
    })
    : null;
  await tx.serialUnit.updateMany({ where: { receiptLineId: { in: original.lines.map((l) => l.id) } }, data: { status: "reversed", version: { increment: 1 } } });

  for (const l of original.lines) {
    if (!l.poLineId) continue;
    const back = dec(l.qtyAccepted.toString()).plus(l.excessStatus === "approved" ? l.qtyExcessBlocked.toString() : 0);
    if (back.gt(0)) await tx.poLine.update({ where: { id: l.poLineId }, data: { qtyReceivedBase: { decrement: s4(back) } } });
  }
  await tx.receiptLine.updateMany({ where: { receiptId: original.id, excessStatus: "pending" }, data: { excessStatus: "reversed" } });
  const status = await receivedStatus(tx, po.id);
  if (status !== po.status) PO.assert(po.status, status);
  await tx.purchaseOrder.update({ where: { id: po.id }, data: { status, version: { increment: 1 } } });
  await writeAudit(tx, ctx, {
    action: "receipt_reversed", entityType: "goods_receipt", entityId: original.id, warehouseId: original.warehouseId,
    reason: input.reason.trim(), before: { poStatus: po.status }, after: { reversalId: reversal.id, number: reversal.number, poStatus: status },
  });
  return { reversal, poStatus: status, movementIds: posted?.movements.map((m) => m.id) ?? [], auditId: posted?.auditId ?? null };
}

// Doc 10 §3 over-delivery: (a) approve → blocked_release + PO qty amended (this IS the
// re-approval: purchases.approve covering the excess value, approver ≠ PO creator);
// (b) reject → stays blocked for a supplier return / disposal (Parts 6–7).
export async function decideExcess(tx: Tx, ctx: Ctx, input: { receiptLineId: string; approve: boolean; comment?: string | null }) {
  const line = await tx.receiptLine.findFirst({ where: { id: input.receiptLineId, receipt: { companyId: ctx.companyId } }, include: { receipt: true, variant: { include: { product: true } } } });
  if (!line) throw new AppError("not_found", "Receipt line not found");
  const po = await lockPo(tx, ctx, line.receipt.poId);
  const excess = dec(line.qtyExcessBlocked.toString());
  await requirePermission(ctx, "purchases.approve", { amount: excess.times(line.unitCost?.toString() ?? 0).toFixed(4) });
  await requireNotCreator(ctx, po.createdBy, { type: "purchase_order", id: po.id });
  if (!input.approve && !input.comment?.trim()) throw new AppError("validation_error", "A rejection needs a comment", { field: "comment" });

  // Compare-and-set on the pending state: a second decision gets version_conflict (edge #33).
  const claimed = await tx.receiptLine.updateMany({
    where: { id: line.id, excessStatus: "pending" },
    data: { excessStatus: input.approve ? "approved" : "rejected", excessDecidedBy: ctx.userId, excessDecidedAt: new Date(), excessComment: input.comment?.trim() || null },
  });
  if (!claimed.count) throw new AppError("version_conflict", "This over-delivery was already decided", { status: line.excessStatus });

  let movementIds: string[] = [];
  let status = po.status;
  if (input.approve) {
    if (!["ordered", "partially_received", "fully_received"].includes(po.status)) throw new AppError("invalid_transition", `PO is ${po.status}`);
    // With inspection on, units stay blocked until inspected (RC-12); only the PO is amended.
    if (!line.inspection) {
      // The approver acts globally (purchases.approve); the release is part of that decision,
      // so it posts in the receipt warehouse even if the approver holds no warehouse scope.
      const posted = await postMovements(tx, { ...ctx, warehouseIds: [line.receipt.warehouseId] }, {
        sourceType: "receipt_excess", sourceId: line.id, action: "excess_approve",
        legs: [{
          type: "blocked_release", variantId: line.variantId, warehouseId: line.receipt.warehouseId, binId: line.binId, batchId: line.batchId,
          delta: { blocked: excess.neg(), onHand: excess }, line: 1, reasonCode: "excess_approved",
          ...(line.variant.product.isSerialized ? { serialized: true as const } : {}),
        }],
      });
      movementIds = posted.movements.map((m) => m.id);
      await tx.serialUnit.updateMany({ where: { receiptLineId: line.id, status: "quarantine" }, data: { status: "in_stock", version: { increment: 1 } } });
    }
    const poLine = po.lines.find((l) => l.id === line.poLineId)!;
    const orderedBase = dec(poLine.qtyOrderedBase.toString()).plus(excess);
    const orderedQty = orderedBase.div(poLine.uomFactor.toString()).toDecimalPlaces(4);
    await tx.poLine.update({
      where: { id: poLine.id },
      data: {
        qtyOrderedBase: s4(orderedBase), qtyOrdered: s4(orderedQty), qtyReceivedBase: { increment: s4(excess) },
        lineTotal: s4(lineTotal(orderedQty, poLine.unitPrice.toString(), poLine.discountPct.toString(), poLine.taxPct.toString())),
      },
    });
    await recalcTotals(tx, po.id);
    status = await receivedStatus(tx, po.id);
    if (status !== po.status) PO.assert(po.status, status);
  }
  await tx.purchaseOrder.update({ where: { id: po.id }, data: { status, version: { increment: 1 } } });
  await writeAudit(tx, ctx, {
    action: input.approve ? "excess_approve" : "excess_reject", entityType: "receipt_line", entityId: line.id, warehouseId: line.receipt.warehouseId,
    reason: input.comment?.trim() || null, after: { qty: excess.toString(), poStatus: status, movementIds },
  });
  return { receiptLineId: line.id, excessStatus: input.approve ? "approved" : "rejected", poStatus: status, movementIds };
}

// ───────────── Reads ─────────────

export async function getReceipt(ctx: Ctx, id: string) {
  const r = await db.goodsReceipt.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      po: { select: { id: true, number: true, supplierName: true, createdBy: true } },
      warehouse: { select: { code: true, name: true } },
      receiver: { select: { name: true } },
      reversal: { select: { id: true, number: true } },
      reversalOf: { select: { id: true, number: true } },
      lines: { orderBy: { lineNo: "asc" }, include: { variant: { select: { sku: true } }, batch: true, bin: { select: { code: true } }, serials: { select: { serialNo: true, status: true } } } },
    },
  });
  if (!r) throw new AppError("not_found", "Receipt not found");
  await requirePermission(ctx, ["purchases.view", "inventory.receive"], { warehouseId: ctx.permissions.has("purchases.view") ? undefined : r.warehouseId });
  return r;
}

// Pending over-delivery decisions (approver queue until the Part 6 inbox).
export async function listPendingExcess(ctx: Ctx) {
  await requirePermission(ctx, ["purchases.approve", "purchases.view"]);
  return db.receiptLine.findMany({
    where: { excessStatus: "pending", receipt: { companyId: ctx.companyId } },
    include: { variant: { select: { sku: true } }, receipt: { select: { id: true, number: true, receivedAt: true, po: { select: { id: true, number: true, supplierName: true } } } } },
    orderBy: { receipt: { receivedAt: "asc" } },
  });
}
