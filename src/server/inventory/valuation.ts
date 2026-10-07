import { requirePermission, type Ctx } from "@/server/core/ctx";
import { db } from "@/server/db";
import { dec } from "./post";

// Point-in-time value (doc 15, INV-022): replay of every movement with
// created_at <= T, using each movement's snapshot (value_delta = qty × snapshot cost).
// Warehouse lines include damaged/expired/blocked; in-transit is its own line (TR-06),
// counted for transfers touching a warehouse in scope.
export async function valueAt(ctx: Ctx, at: Date, input: { warehouseId?: string } = {}) {
  await requirePermission(ctx, ["inventory.view", "reports.view"], { warehouseId: input.warehouseId });
  const scope = scopeOf(ctx, input.warehouseId);
  const rows = await db.inventoryMovement.groupBy({
    by: ["variantId", "warehouseId"],
    where: {
      companyId: ctx.companyId, createdAt: { lte: at }, type: { not: "transfer_variance" },
      ...(scope ? { warehouseId: { in: scope } } : {}),
    },
    _sum: { valueDelta: true, dOnHand: true, dBlocked: true, dDamaged: true, dExpired: true },
  });
  const lines = rows.map((r) => {
    const qty = dec(r._sum.dOnHand).plus(dec(r._sum.dBlocked)).plus(dec(r._sum.dDamaged)).plus(dec(r._sum.dExpired));
    const value = dec(r._sum.valueDelta);
    return { variantId: r.variantId, warehouseId: r.warehouseId, qty: qty.toString(), value: value.toString(), wac: wac(qty, value) };
  });
  // Doc 11 §5: in transit = −Σ(transfer_out + transfer_in) + Σ transfer_variance.
  const [t] = await db.$queryRaw<{ v: string | null }[]>`
    SELECT SUM(CASE WHEN m.type = 'transfer_variance' THEN m.value_delta ELSE -m.value_delta END)::text v
    FROM inventory_movement m JOIN transfer t ON t.id = split_part(m.source_id, ':', 1)
    WHERE m.company_id = ${ctx.companyId} AND m.created_at <= ${at}
      AND m.source_type IN ('transfer_shipment', 'transfer_receipt', 'transfer_variance')
      AND (${scope}::text[] IS NULL OR t.from_warehouse_id = ANY(${scope}::text[]) OR t.to_warehouse_id = ANY(${scope}::text[]))`;
  const inTransit = dec(t?.v ?? 0);
  return { at, total: lines.reduce((s, l) => s.plus(l.value), inTransit).toString(), inTransit: inTransit.toString(), lines };
}

// Live valuation from the cost layer + open transfer lines (what valueAt(now) must equal).
export async function liveValue(ctx: Ctx, input: { warehouseId?: string } = {}) {
  await requirePermission(ctx, ["inventory.view", "reports.view"], { warehouseId: input.warehouseId });
  const scope = scopeOf(ctx, input.warehouseId);
  const [rows, open] = await Promise.all([
    db.variantCost.findMany({ where: { companyId: ctx.companyId, ...(scope ? { warehouseId: { in: scope } } : {}) } }),
    db.transferLine.findMany({
      where: {
        transfer: {
          companyId: ctx.companyId,
          ...(scope ? { OR: [{ fromWarehouseId: { in: scope } }, { toWarehouseId: { in: scope } }] } : {}),
        },
      },
      select: { shippedValue: true, settledValue: true },
    }),
  ]);
  const lines = rows.map((r) => ({
    variantId: r.variantId, warehouseId: r.warehouseId,
    qty: dec(r.qty).toString(), value: dec(r.value).toString(), wac: wac(dec(r.qty), dec(r.value)),
  }));
  const inTransit = open.reduce((s, l) => s.plus(dec(l.shippedValue)).minus(dec(l.settledValue)), dec(0));
  return { total: lines.reduce((s, l) => s.plus(l.value), inTransit).toString(), inTransit: inTransit.toString(), lines };
}

const scopeOf = (ctx: Ctx, warehouseId?: string) =>
  warehouseId ? [warehouseId] : ctx.warehouseIds === "all" ? null : ctx.warehouseIds;

const wac = (qty: ReturnType<typeof dec>, value: ReturnType<typeof dec>) =>
  qty.isZero() ? "0" : value.div(qty).toDecimalPlaces(4).toString();
