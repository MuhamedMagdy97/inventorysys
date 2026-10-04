import { authorize, type Ctx } from "@/server/core/ctx";
import { db } from "@/server/db";
import { dec } from "./post";

// Point-in-time value (doc 15, INV-022): replay of every movement with
// created_at <= T, using each movement's snapshot (value_delta = qty × snapshot cost).
// ponytail: valued per warehouse incl. damaged/expired/blocked; the in-transit line
// arrives with transfers (Part 6).
export async function valueAt(ctx: Ctx, at: Date, input: { warehouseId?: string } = {}) {
  authorize(ctx, ["inventory.view", "reports.view"], input.warehouseId);
  const scope = input.warehouseId ? [input.warehouseId] : ctx.warehouseIds === "all" ? null : ctx.warehouseIds;
  const rows = await db.inventoryMovement.groupBy({
    by: ["variantId", "warehouseId"],
    where: { companyId: ctx.companyId, createdAt: { lte: at }, ...(scope ? { warehouseId: { in: scope } } : {}) },
    _sum: { valueDelta: true, dOnHand: true, dBlocked: true, dDamaged: true, dExpired: true },
  });
  const lines = rows.map((r) => {
    const qty = dec(r._sum.dOnHand).plus(dec(r._sum.dBlocked)).plus(dec(r._sum.dDamaged)).plus(dec(r._sum.dExpired));
    const value = dec(r._sum.valueDelta);
    return { variantId: r.variantId, warehouseId: r.warehouseId, qty: qty.toString(), value: value.toString(), wac: wac(qty, value) };
  });
  return { at, total: lines.reduce((s, l) => s.plus(l.value), dec(0)).toString(), lines };
}

// Live valuation from the cost layer (what valueAt(now) must equal).
export async function liveValue(ctx: Ctx, input: { warehouseId?: string } = {}) {
  authorize(ctx, ["inventory.view", "reports.view"], input.warehouseId);
  const scope = input.warehouseId ? [input.warehouseId] : ctx.warehouseIds === "all" ? null : ctx.warehouseIds;
  const rows = await db.variantCost.findMany({
    where: { companyId: ctx.companyId, ...(scope ? { warehouseId: { in: scope } } : {}) },
  });
  const lines = rows.map((r) => ({
    variantId: r.variantId, warehouseId: r.warehouseId,
    qty: dec(r.qty).toString(), value: dec(r.value).toString(), wac: wac(dec(r.qty), dec(r.value)),
  }));
  return { total: lines.reduce((s, l) => s.plus(l.value), dec(0)).toString(), lines };
}

const wac = (qty: ReturnType<typeof dec>, value: ReturnType<typeof dec>) =>
  qty.isZero() ? "0" : value.div(qty).toDecimalPlaces(4).toString();
