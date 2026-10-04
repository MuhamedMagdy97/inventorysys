import { inScope, requirePermission, scopeFilter, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";
import { dec, type Dec } from "./post";

// ATP (doc 07 §2): available(position) = SUM(on_hand over its bins) − qty_reserved.
// Batches with expiry_date <= today are not reservable (B-04), so they add nothing
// to `available` even before the expiry job moves them.
export async function getAvailability(ctx: Ctx, input: { variantId: string; warehouseId?: string }) {
  await requirePermission(ctx, ["inventory.view", "sales.view"], { warehouseId: input.warehouseId });
  const variant = await db.productVariant.findFirst({ where: { id: input.variantId, companyId: ctx.companyId } });
  if (!variant) throw new AppError("not_found", "Variant not found");

  const where = {
    companyId: ctx.companyId,
    variantId: variant.id,
    warehouseId: scopeFilter(ctx, input.warehouseId),
  };
  const [balances, allocations] = await Promise.all([
    db.stockBalance.findMany({ where }),
    db.stockAllocation.findMany({ where, include: { batch: true } }),
  ]);
  const today = new Date(new Date().toISOString().slice(0, 10));
  type Sums = Record<"onHand" | "reserved" | "available" | "blocked" | "damaged" | "expired", Dec>;
  const positions = allocations
    .filter((a) => inScope(ctx, a.warehouseId))
    .map((a) => {
      const bins = balances.filter((b) => b.warehouseId === a.warehouseId && b.batchId === a.batchId);
      const sum = (k: "onHand" | "blocked" | "damaged" | "expired") => bins.reduce((s, b) => s.plus(dec(b[k])), dec(0));
      const onHand = sum("onHand");
      const reserved = dec(a.qtyReserved);
      const reservable = !a.batch?.expiryDate || a.batch.expiryDate > today;
      const sums: Sums = {
        onHand, reserved, available: reservable ? onHand.minus(reserved) : dec(0),
        blocked: sum("blocked"), damaged: sum("damaged"), expired: sum("expired"),
      };
      return {
        meta: {
          warehouseId: a.warehouseId, batchId: a.batchId, batchNo: a.batch?.batchNo ?? null,
          expiryDate: a.batch?.expiryDate ?? null, reservable,
        },
        sums,
      };
    });
  const keys = ["onHand", "reserved", "available", "blocked", "damaged", "expired"] as const;
  const str = (s: Sums) => Object.fromEntries(keys.map((k) => [k, s[k].toString()])) as Record<keyof Sums, string>;
  const total = Object.fromEntries(keys.map((k) => [k, positions.reduce((s, p) => s.plus(p.sums[k]), dec(0))])) as Sums;
  return {
    variantId: variant.id,
    sku: variant.sku,
    warehouseId: input.warehouseId ?? null,
    ...str(total),
    positions: positions.map((p) => ({ ...p.meta, ...str(p.sums) })),
  };
}
