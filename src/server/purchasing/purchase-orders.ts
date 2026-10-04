import { Prisma, type PoStatus } from "@/generated/prisma/client";
import { assertTransactable, uomFactor } from "@/server/catalog/catalog";
import { writeAudit } from "@/server/core/audit";
import { inScope, requireNotCreator, requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { nextNumber } from "@/server/core/sequences";
import { stateMachine } from "@/server/core/state";
import { db, type Tx } from "@/server/db";
import { Dec, dec, type DecValue } from "@/server/inventory/post";

// Doc 09 + doc 23. Lines are editable in draft only (PO-09); after approval the only
// line edit is reducing qty (PO-03). Receipts drive ordered → partially/fully_received.

export const PO = stateMachine<PoStatus>("Purchase order", {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "draft", "cancelled"], // → draft = rejected (version++)
  approved: ["ordered", "cancelled"],
  ordered: ["partially_received", "fully_received", "closed"],
  partially_received: ["fully_received", "ordered", "closed"], // → ordered only via receipt reversal
  fully_received: ["partially_received", "ordered", "closed"],
  closed: [],
  cancelled: [],
});

// Supplier archive (SUP-01), product archive (flow 3), warehouse archive (WH-02) all block on these.
export const OPEN_PO: PoStatus[] = ["draft", "submitted", "approved", "ordered", "partially_received"];
export const RECEIVABLE: PoStatus[] = ["ordered", "partially_received"];

export type PoLineInput = {
  id?: string; // existing draft line to update
  variantId: string;
  qty: DecValue;
  uom?: string; // default: product base unit
  unitPrice?: DecValue; // default: supplier last price, else variant cost price (SUP-03: informational)
  discountPct?: DecValue;
  taxPct?: DecValue;
};
export type PoHeader = {
  expectedDate?: Date | null;
  notes?: string | null;
  discount?: DecValue;
  tax?: DecValue;
  shipping?: DecValue;
};

const money = (v: DecValue | undefined, field: string) => {
  const d = dec(v ?? 0);
  if (d.isNeg() || d.decimalPlaces() > 4) throw new AppError("validation_error", `${field}: ≥ 0, max 4 decimals`, { field });
  return d;
};
const pct = (v: DecValue | undefined, field: string) => {
  const d = dec(v ?? 0);
  if (d.isNeg() || d.gt(100) || d.decimalPlaces() > 2) throw new AppError("validation_error", `${field}: 0–100`, { field });
  return d;
};

// Doc 09 §4: qty × price − discount% + tax%.
export const lineTotal = (qty: DecValue, price: DecValue, discountPct: DecValue, taxPct: DecValue) =>
  dec(qty).times(dec(price)).times(dec(100).minus(dec(discountPct))).div(100).times(dec(100).plus(dec(taxPct))).div(100).toDecimalPlaces(4);

// PO-11: receipt cost per base unit = net price (after line discount, before tax) ÷ factor.
export const baseUnitCost = (l: { unitPrice: DecValue; discountPct: DecValue; uomFactor: DecValue }) =>
  dec(l.unitPrice).times(dec(100).minus(dec(l.discountPct))).div(100).div(dec(l.uomFactor)).toDecimalPlaces(4);

const s4 = (d: Dec) => d.toFixed(4);

async function buildLine(tx: Tx, ctx: Ctx, supplierId: string, input: PoLineInput) {
  const v = await tx.productVariant.findFirst({ where: { id: input.variantId, companyId: ctx.companyId }, include: { product: true } });
  if (!v) throw new AppError("validation_error", "Unknown variant", { field: "variantId" });
  assertTransactable(v); // INV-019: no new PO lines for draft/inactive/discontinued/archived
  const uom = input.uom ?? v.product.baseUom;
  const factor = dec((await uomFactor(tx, v.productId, uom)).toString());
  const qty = dec(input.qty);
  if (qty.lte(0) || qty.decimalPlaces() > 4) throw new AppError("validation_error", "Quantity must be > 0 (max 4 decimals)", { field: "qty", sku: v.sku });
  const qtyBase = qty.times(factor);
  if (qtyBase.decimalPlaces() > 4) throw new AppError("validation_error", "Quantity × unit factor needs more than 4 decimals", { field: "qty", sku: v.sku });
  if (v.product.isSerialized && !qtyBase.isInteger()) throw new AppError("validation_error", "Serialized items are ordered in whole units", { field: "qty", sku: v.sku });
  let price = input.unitPrice;
  if (price === undefined) {
    const sp = await tx.supplierProduct.findUnique({ where: { supplierId_variantId: { supplierId, variantId: v.id } } });
    const last = sp?.lastPrice ?? v.costPrice;
    if (last == null) throw new AppError("validation_error", `Unit price required for ${v.sku}`, { field: "unitPrice", sku: v.sku });
    price = dec(last.toString()).times(factor).toDecimalPlaces(4); // last/cost price is per base unit
  }
  const unitPrice = money(price, "unitPrice");
  const discountPct = pct(input.discountPct, "discountPct");
  const taxPct = pct(input.taxPct, "taxPct");
  return {
    variantId: v.id, sku: v.sku, name: v.name ? `${v.product.name} — ${v.name}` : v.product.name,
    orderUom: uom, uomFactor: factor.toFixed(6), qtyOrdered: s4(qty), qtyOrderedBase: s4(qtyBase),
    unitPrice: s4(unitPrice), discountPct: discountPct.toFixed(2), taxPct: taxPct.toFixed(2),
    lineTotal: s4(lineTotal(qty, unitPrice, discountPct, taxPct)),
    requiresBatch: v.product.requiresBatch, requiresExpiry: v.product.requiresExpiry,
  };
}

// Doc 09 §4 header: subtotal − discount + tax + shipping.
export async function recalcTotals(tx: Tx, poId: string) {
  const [po, lines] = await Promise.all([
    tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId } }),
    tx.poLine.findMany({ where: { poId, removed: false }, select: { lineTotal: true } }),
  ]);
  const subtotal = lines.reduce((t, l) => t.plus(l.lineTotal.toString()), dec(0));
  const total = subtotal.minus(po.discount.toString()).plus(po.tax.toString()).plus(po.shipping.toString());
  if (total.isNeg()) throw new AppError("validation_error", "Header discount exceeds the order value", { field: "discount" });
  await tx.purchaseOrder.update({ where: { id: poId }, data: { subtotal: s4(subtotal), total: s4(total) } });
}

function header(h: PoHeader) {
  return {
    expectedDate: h.expectedDate, notes: h.notes === undefined ? undefined : h.notes?.trim() || null,
    discount: h.discount === undefined ? undefined : s4(money(h.discount, "discount")),
    tax: h.tax === undefined ? undefined : s4(money(h.tax, "tax")),
    shipping: h.shipping === undefined ? undefined : s4(money(h.shipping, "shipping")),
  };
}

async function activeSupplier(tx: Tx, ctx: Ctx, id: string) {
  const s = await tx.supplier.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!s) throw new AppError("validation_error", "Unknown supplier", { field: "supplierId" });
  if (s.status !== "active") throw new AppError("archived_conflict", `Supplier is ${s.status}`, { field: "supplierId" });
  return s;
}

export async function createPo(tx: Tx, ctx: Ctx, input: PoHeader & { supplierId: string; warehouseId: string; lines: PoLineInput[] }) {
  await requirePermission(ctx, "purchases.create");
  const supplier = await activeSupplier(tx, ctx, input.supplierId);
  const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: ctx.companyId } });
  if (!wh) throw new AppError("validation_error", "Unknown warehouse", { field: "warehouseId" });
  if (wh.status !== "active") throw new AppError("archived_conflict", `Warehouse is ${wh.status}`, { field: "warehouseId" });
  if (!input.lines.length) throw new AppError("validation_error", "Add at least one line", { field: "lines" });
  const lines = [];
  for (const l of input.lines) lines.push(await buildLine(tx, ctx, supplier.id, l));
  const year = new Date().getUTCFullYear();
  const po = await tx.purchaseOrder.create({
    data: {
      ...header(input), companyId: ctx.companyId, number: await nextNumber(tx, ctx.companyId, `po:${year}`, `PO-${year}-`, 5),
      supplierId: supplier.id, supplierName: supplier.name, warehouseId: wh.id, currency: supplier.currency, createdBy: ctx.userId,
      lines: { create: lines.map((l, i) => ({ ...l, lineNo: i + 1 })) },
    },
  });
  await recalcTotals(tx, po.id);
  const after = await loadPo(tx, po.id);
  await writeAudit(tx, ctx, { action: "create", entityType: "purchase_order", entityId: po.id, warehouseId: wh.id, after });
  return after;
}

const loadPo = (tx: Tx | typeof db, id: string) =>
  tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });

async function findPo(tx: Tx, ctx: Ctx, id: string) {
  const po = await tx.purchaseOrder.findFirst({ where: { id, companyId: ctx.companyId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!po) throw new AppError("not_found", "Purchase order not found");
  return po;
}

// Compare-and-increment on (id, version, status) — the INV-023 guard for every PO move.
async function move(tx: Tx, po: { id: string; version: number; status: PoStatus }, version: number, to: PoStatus, data: Prisma.PurchaseOrderUpdateManyMutationInput = {}) {
  if (po.status !== to) PO.assert(po.status, to);
  assertVersion(await tx.purchaseOrder.updateMany({
    where: { id: po.id, version, status: po.status },
    data: { ...data, status: to, version: { increment: 1 } },
  }), "Purchase order", po.version);
}

// Draft edit: header, supplier (PO-08) and the full line list. Lines left out are flagged
// `removed` (never deleted); lines with an id are rebuilt in place.
export async function updatePo(
  tx: Tx,
  ctx: Ctx,
  input: PoHeader & { id: string; version: number; supplierId?: string; lines?: PoLineInput[] },
) {
  await requirePermission(ctx, "purchases.update");
  const before = await findPo(tx, ctx, input.id);
  if (before.status !== "draft") throw new AppError("invalid_transition", "Only a draft PO can be edited (PO-09)", { status: before.status });
  const supplierId = input.supplierId ?? before.supplierId;
  const supplier = input.supplierId ? await activeSupplier(tx, ctx, input.supplierId) : null;
  await move(tx, before, input.version, "draft", {
    ...header(input), ...(supplier ? { supplierId: supplier.id, supplierName: supplier.name, currency: supplier.currency } : {}),
  });
  if (input.lines) {
    if (!input.lines.length) throw new AppError("validation_error", "Add at least one line", { field: "lines" });
    const live = before.lines.filter((l) => !l.removed);
    const keep = new Set(input.lines.map((l) => l.id).filter(Boolean));
    for (const l of live) if (!keep.has(l.id)) await tx.poLine.update({ where: { id: l.id }, data: { removed: true } });
    let next = Math.max(0, ...before.lines.map((l) => l.lineNo)) + 1;
    for (const l of input.lines) {
      const data = await buildLine(tx, ctx, supplierId, l);
      if (l.id) {
        if (!live.some((x) => x.id === l.id)) throw new AppError("validation_error", "Unknown line", { field: "lines", id: l.id });
        await tx.poLine.update({ where: { id: l.id }, data });
      } else {
        await tx.poLine.create({ data: { ...data, poId: before.id, lineNo: next++ } });
      }
    }
  }
  await recalcTotals(tx, before.id);
  const after = await loadPo(tx, before.id);
  await writeAudit(tx, ctx, { action: "update", entityType: "purchase_order", entityId: before.id, warehouseId: before.warehouseId, before, after });
  return after;
}

// PO-03 after approval: qty only goes down, never below what was received.
export async function reducePoLine(tx: Tx, ctx: Ctx, input: { poId: string; version: number; lineId: string; qty: DecValue }) {
  await requirePermission(ctx, "purchases.update");
  const before = await findPo(tx, ctx, input.poId);
  if (!["approved", "ordered", "partially_received"].includes(before.status)) {
    throw new AppError("invalid_transition", `Line quantities can't be reduced in ${before.status}`, { status: before.status });
  }
  const line = before.lines.find((l) => l.id === input.lineId && !l.removed);
  if (!line) throw new AppError("not_found", "PO line not found");
  const qty = dec(input.qty);
  const qtyBase = qty.times(line.uomFactor.toString());
  if (qty.lte(0) || qty.gte(line.qtyOrdered.toString()) || qtyBase.decimalPlaces() > 4) {
    throw new AppError("validation_error", "New quantity must be > 0 and below the ordered quantity", { field: "qty" });
  }
  if (qtyBase.lt(line.qtyReceivedBase.toString())) {
    throw new AppError("validation_error", "Quantity can't drop below what was received (PO-03, edge #9)", { field: "qty", received: line.qtyReceivedBase.toString() });
  }
  await tx.poLine.update({
    where: { id: line.id },
    data: { qtyOrdered: s4(qty), qtyOrderedBase: s4(qtyBase), lineTotal: s4(lineTotal(qty, line.unitPrice.toString(), line.discountPct.toString(), line.taxPct.toString())) },
  });
  await recalcTotals(tx, before.id);
  const status = before.status === "approved" ? "approved" : await receivedStatus(tx, before.id);
  await move(tx, before, input.version, status);
  const after = await loadPo(tx, before.id);
  await writeAudit(tx, ctx, { action: "line_reduce", entityType: "purchase_order", entityId: before.id, warehouseId: before.warehouseId, before: line, after: after.lines.find((l) => l.id === line.id) });
  return after;
}

// ordered / partially_received / fully_received from the lines' received quantities.
export async function receivedStatus(tx: Tx, poId: string): Promise<PoStatus> {
  const lines = await tx.poLine.findMany({ where: { poId, removed: false } });
  if (lines.every((l) => l.qtyReceivedBase.gte(l.qtyOrderedBase))) return "fully_received";
  return lines.some((l) => l.qtyReceivedBase.gt(0)) ? "partially_received" : "ordered";
}

export async function submitPo(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  await requirePermission(ctx, "purchases.submit");
  const po = await findPo(tx, ctx, input.id);
  if (!po.lines.some((l) => !l.removed)) throw new AppError("validation_error", "Add at least one line", { field: "lines" });
  await move(tx, po, input.version, "submitted");
  return audited(tx, ctx, po, "submit");
}

// PO-01/PO-12: approver ≠ creator, limit covers the total, SUP-02 contact + address.
export async function approvePo(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment?: string | null }) {
  const po = await findPo(tx, ctx, input.id);
  await requirePermission(ctx, "purchases.approve", { amount: po.total });
  await requireNotCreator(ctx, po.createdBy, { type: "purchase_order", id: po.id });
  const supplier = await tx.supplier.findUniqueOrThrow({
    where: { id: po.supplierId },
    include: { _count: { select: { contacts: { where: { archived: false } }, addresses: { where: { archived: false } } } } },
  });
  if (supplier.status !== "active") throw new AppError("archived_conflict", `Supplier is ${supplier.status}`);
  if (!supplier._count.contacts || !supplier._count.addresses) {
    throw new AppError("validation_error", "Supplier needs a contact and an address before a PO can be approved (SUP-02)", { reason: "supplier_incomplete" });
  }
  await move(tx, po, input.version, "approved", { approvedBy: ctx.userId, approvedAt: new Date() });
  await tx.poApproval.create({ data: { poId: po.id, actorId: ctx.userId, decision: "approved", amount: po.total, comment: input.comment?.trim() || null } });
  return audited(tx, ctx, po, "approve");
}

// submitted → draft with a mandatory comment (doc 23).
export async function rejectPo(tx: Tx, ctx: Ctx, input: { id: string; version: number; comment: string }) {
  const po = await findPo(tx, ctx, input.id);
  await requirePermission(ctx, "purchases.approve");
  await requireNotCreator(ctx, po.createdBy, { type: "purchase_order", id: po.id });
  if (!input.comment?.trim()) throw new AppError("validation_error", "A rejection needs a comment", { field: "comment" });
  if (po.status !== "submitted") throw new AppError("invalid_transition", `Only a submitted PO can be rejected (is ${po.status})`, { from: po.status, to: "draft" });
  await move(tx, po, input.version, "draft");
  await tx.poApproval.create({ data: { poId: po.id, actorId: ctx.userId, decision: "rejected", amount: po.total, comment: input.comment.trim() } });
  return audited(tx, ctx, po, "reject");
}

export async function orderPo(tx: Tx, ctx: Ctx, input: { id: string; version: number }) {
  await requirePermission(ctx, "purchases.order");
  const po = await findPo(tx, ctx, input.id);
  await move(tx, po, input.version, "ordered", { orderedAt: new Date() });
  return audited(tx, ctx, po, "order");
}

// PO-05: closing with an open remainder needs a reason; pending excess decisions block.
export async function closePo(tx: Tx, ctx: Ctx, input: { id: string; version: number; reason?: string | null }) {
  await requirePermission(ctx, "purchases.close");
  const po = await findPo(tx, ctx, input.id);
  const remainder = po.lines.some((l) => !l.removed && l.qtyReceivedBase.lt(l.qtyOrderedBase));
  if (remainder && !input.reason?.trim()) throw new AppError("validation_error", "Closing with an open remainder needs a reason (PO-05)", { field: "reason" });
  const pending = await tx.receiptLine.count({ where: { receipt: { poId: po.id }, excessStatus: "pending" } });
  if (pending) throw new AppError("conflict", "Decide the pending over-delivery first", { reason: "pending_excess", count: pending });
  await move(tx, po, input.version, "closed", { closedAt: new Date(), closeReason: input.reason?.trim() || null });
  return audited(tx, ctx, po, "close");
}

// Doc 23: only before any receipt (draft|submitted|approved); afterwards close instead.
export async function cancelPo(tx: Tx, ctx: Ctx, input: { id: string; version: number; reason?: string | null }) {
  await requirePermission(ctx, "purchases.cancel");
  const po = await findPo(tx, ctx, input.id);
  if (await tx.goodsReceipt.count({ where: { poId: po.id } })) throw new AppError("invalid_transition", "A PO with receipts can't be cancelled; close it", { status: po.status });
  await move(tx, po, input.version, "cancelled", { closedAt: new Date(), closeReason: input.reason?.trim() || null });
  return audited(tx, ctx, po, "cancel");
}

async function audited(tx: Tx, ctx: Ctx, before: { id: string; warehouseId: string; status: PoStatus; version: number }, action: string) {
  const after = await loadPo(tx, before.id);
  await writeAudit(tx, ctx, {
    action, entityType: "purchase_order", entityId: before.id, warehouseId: before.warehouseId,
    before: { status: before.status, version: before.version }, after: { status: after.status, version: after.version },
  });
  return after;
}

// ───────────── Reads ─────────────

// Buyers (purchases.view) see every PO; a receiver sees receivable POs of their warehouses (doc 02 §3).
function visibility(ctx: Ctx): Prisma.PurchaseOrderWhereInput {
  if (ctx.permissions.has("purchases.view")) return {};
  if (ctx.permissions.has("inventory.receive")) {
    // From `ordered` on, so the receiver still sees the PO (and its GRNs) after receiving it.
    return { status: { in: ["ordered", "partially_received", "fully_received", "closed"] }, ...(ctx.warehouseIds === "all" ? {} : { warehouseId: { in: ctx.warehouseIds } }) };
  }
  return { id: "-" };
}

export async function listPos(
  ctx: Ctx,
  input: { page: number; perPage: number; q?: string; status?: PoStatus; supplierId?: string; warehouseId?: string },
) {
  await requirePermission(ctx, ["purchases.view", "inventory.receive"]);
  const q = input.q?.trim();
  const where: Prisma.PurchaseOrderWhereInput = {
    companyId: ctx.companyId, status: input.status, supplierId: input.supplierId, warehouseId: input.warehouseId,
    ...(q ? { OR: [{ number: { contains: q.toUpperCase() } }, { supplierName: { contains: q, mode: "insensitive" } }] } : {}),
    AND: [visibility(ctx)],
  };
  const [total, items] = await Promise.all([
    db.purchaseOrder.count({ where }),
    db.purchaseOrder.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (input.page - 1) * input.perPage, take: input.perPage,
      include: { warehouse: { select: { code: true } }, _count: { select: { lines: { where: { removed: false } } } } },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

export async function getPo(ctx: Ctx, id: string) {
  await requirePermission(ctx, ["purchases.view", "inventory.receive"]);
  const po = await db.purchaseOrder.findFirst({
    where: { id, companyId: ctx.companyId, AND: [visibility(ctx)] },
    include: {
      warehouse: { select: { id: true, code: true, name: true } },
      supplier: { select: { id: true, code: true, name: true, requiresInspection: true, receiptTolerancePct: true } },
      creator: { select: { id: true, name: true } },
      lines: { orderBy: { lineNo: "asc" }, include: { variant: { select: { requiresInspection: true, product: { select: { isSerialized: true, baseUom: true } } } } } },
      approvals: { orderBy: { createdAt: "asc" }, include: { actor: { select: { name: true } } } },
      receipts: { orderBy: { receivedAt: "asc" }, include: { lines: { orderBy: { lineNo: "asc" } }, receiver: { select: { name: true } } } },
    },
  });
  if (!po) throw new AppError("not_found", "Purchase order not found");
  return { ...po, canReceive: RECEIVABLE.includes(po.status) && ctx.permissions.has("inventory.receive") && inScope(ctx, po.warehouseId) };
}
