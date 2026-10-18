import { requirePermission, scopeFilter, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db, type Tx } from "@/server/db";
import { Dec, dec, type DecValue } from "@/server/inventory/post";
import { createPo, OPEN_PO } from "./purchase-orders";

// Reorder engine, doc 09 §6 (RO-01…06). Suggests only — a PO comes from the user's
// explicit createReorderPos call, never from a job (INV-016).

// RO-03, base units. Exported for the math test.
export function suggestQty(r: {
  position: DecValue; reorderPoint: DecValue; reorderQty?: DecValue | null; maxStock?: DecValue | null;
  minOrderQty?: DecValue | null; serialized?: boolean;
}): Dec {
  const position = dec(r.position);
  let qty = r.maxStock != null
    ? dec(r.maxStock).minus(position)
    : Dec.max(dec(r.reorderQty ?? 0), dec(r.reorderPoint).minus(position));
  if (qty.lte(0)) return dec(0);
  if (r.minOrderQty != null) qty = Dec.max(qty, dec(r.minOrderQty));
  return r.serialized ? qty.ceil() : qty.toDecimalPlaces(4, Dec.ROUND_UP);
}

const s = (d: Dec) => d.toString();

export async function listReorderSuggestions(ctx: Ctx, input: { warehouseId?: string } = {}) {
  await requirePermission(ctx, "purchases.create", { warehouseId: input.warehouseId });
  const warehouseId = scopeFilter(ctx, input.warehouseId);
  const settings = await db.variantWarehouseSettings.findMany({
    where: {
      companyId: ctx.companyId, warehouseId, reorderPoint: { not: null },
      warehouse: { status: "active" }, variant: { status: "active", product: { status: "active" } },
    },
    include: {
      warehouse: { select: { code: true } },
      variant: { select: { sku: true, name: true, product: { select: { name: true, isSerialized: true } } } },
    },
  });
  if (!settings.length) return [];
  const variantIds = [...new Set(settings.map((x) => x.variantId))];
  const where = { companyId: ctx.companyId, warehouseId, variantId: { in: variantIds } };
  const [balances, allocations, poLines, offers] = await Promise.all([
    db.stockBalance.groupBy({ by: ["variantId", "warehouseId"], where, _sum: { onHand: true } }),
    db.stockAllocation.groupBy({ by: ["variantId", "warehouseId"], where, _sum: { qtyReserved: true } }),
    db.poLine.findMany({
      where: { removed: false, variantId: { in: variantIds }, po: { companyId: ctx.companyId, warehouseId, status: { in: OPEN_PO } } },
      select: { variantId: true, qtyOrderedBase: true, qtyReceivedBase: true, po: { select: { warehouseId: true } } },
    }),
    db.supplierProduct.findMany({
      where: { variantId: { in: variantIds }, supplier: { companyId: ctx.companyId, status: "active" } },
      include: { supplier: { select: { code: true, name: true, currency: true, leadTimeDays: true } } },
    }),
  ]);
  const key = (variantId: string, wh: string) => `${variantId}|${wh}`;
  const sum = new Map<string, Dec>();
  const add = (k: string, d: Dec) => sum.set(k, (sum.get(k) ?? dec(0)).plus(d));
  for (const b of balances) add(key(b.variantId, b.warehouseId), dec(b._sum.onHand?.toString() ?? 0));
  for (const a of allocations) add(key(a.variantId, a.warehouseId), dec(a._sum.qtyReserved?.toString() ?? 0).neg());
  const onOrder = new Map<string, Dec>();
  for (const l of poLines) {
    const k = key(l.variantId, l.po.warehouseId);
    onOrder.set(k, (onOrder.get(k) ?? dec(0)).plus(Dec.max(0, dec(l.qtyOrderedBase.toString()).minus(l.qtyReceivedBase.toString()))));
  }

  const rows = [];
  for (const x of settings) {
    const k = key(x.variantId, x.warehouseId);
    const available = sum.get(k) ?? dec(0);
    const ordered = onOrder.get(k) ?? dec(0);
    const position = available.plus(ordered);
    if (position.gt(x.reorderPoint!.toString())) continue; // RO-02
    // RO-04: cheapest first, unknown price last; no FX.
    const suppliers = offers.filter((o) => o.variantId === x.variantId)
      .map((o) => ({
        supplierId: o.supplierId, code: o.supplier.code, name: o.supplier.name, currency: o.supplier.currency,
        lastPrice: o.lastPrice?.toString() ?? null, minOrderQty: o.minOrderQty?.toString() ?? null,
        leadDays: o.leadDays ?? o.supplier.leadTimeDays, preferred: o.isPreferred,
      }))
      .sort((a, b) => dec(a.lastPrice ?? Infinity).cmp(b.lastPrice ?? Infinity));
    const chosen = suppliers.find((o) => o.supplierId === x.preferredSupplierId)
      ?? suppliers.find((o) => o.preferred) ?? suppliers.find((o) => o.lastPrice !== null);
    const supplierId = chosen?.supplierId ?? x.preferredSupplierId; // preferred with no supplier_product row still defaults
    const qty = suggestQty({
      position, reorderPoint: x.reorderPoint!.toString(), reorderQty: x.reorderQty?.toString(), maxStock: x.maxStock?.toString(),
      minOrderQty: chosen?.minOrderQty, serialized: x.variant.product.isSerialized,
    });
    if (qty.lte(0)) continue;
    rows.push({
      variantId: x.variantId, sku: x.variant.sku, name: x.variant.name ? `${x.variant.product.name} — ${x.variant.name}` : x.variant.product.name,
      warehouseId: x.warehouseId, warehouseCode: x.warehouse.code,
      available: s(available), onOrder: s(ordered), position: s(position),
      reorderPoint: x.reorderPoint!.toString(), reorderQty: x.reorderQty?.toString() ?? null, maxStock: x.maxStock?.toString() ?? null,
      suggestedQty: s(qty), supplierId: supplierId ?? null, suppliers,
    });
  }
  return rows.sort((a, b) => a.warehouseCode.localeCompare(b.warehouseCode) || a.sku.localeCompare(b.sku));
}

export type ReorderLine = { variantId: string; warehouseId: string; supplierId: string; qty: DecValue };

// RO-05: one draft PO per (supplier, warehouse) through createPo, all in the caller's transaction.
export async function createReorderPos(tx: Tx, ctx: Ctx, input: { lines: ReorderLine[] }) {
  await requirePermission(ctx, "purchases.create");
  if (!input.lines.length) throw new AppError("validation_error", "Select at least one suggestion", { field: "lines" });
  const groups = new Map<string, ReorderLine[]>();
  const seen = new Set<string>();
  for (const l of input.lines) {
    const k = `${l.variantId}|${l.warehouseId}`;
    if (seen.has(k)) throw new AppError("validation_error", "Each item/warehouse can be selected once", { field: "lines", variantId: l.variantId });
    seen.add(k);
    const g = `${l.supplierId}|${l.warehouseId}`;
    groups.set(g, [...(groups.get(g) ?? []), l]);
  }
  for (const wh of new Set(input.lines.map((l) => l.warehouseId))) await requirePermission(ctx, "purchases.create", { warehouseId: wh }); // RO-06
  const pos = [];
  for (const lines of groups.values()) {
    pos.push(await createPo(tx, ctx, {
      supplierId: lines[0].supplierId, warehouseId: lines[0].warehouseId, notes: "Created from reorder suggestions",
      lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
    }));
  }
  return pos;
}
