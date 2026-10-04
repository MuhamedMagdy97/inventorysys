import type { MovementType } from "@/generated/prisma/client";
import { requirePermission, scopeFilter, type Ctx } from "@/server/core/ctx";
import { db } from "@/server/db";

type Page = { page: number; perPage: number };
const paging = ({ page, perPage }: Page) => ({ skip: (page - 1) * perPage, take: perPage });

// Physical buckets per bin, scoped by company + warehouses.
export async function listBalances(
  ctx: Ctx,
  input: Page & { variantId?: string; warehouseId?: string; binId?: string; batchId?: string; nonZero?: boolean },
) {
  await requirePermission(ctx, "inventory.view", { warehouseId: input.warehouseId });
  const where = {
    companyId: ctx.companyId,
    warehouseId: scopeFilter(ctx, input.warehouseId),
    variantId: input.variantId,
    binId: input.binId,
    batchId: input.batchId,
    ...(input.nonZero
      ? { OR: [{ onHand: { gt: 0 } }, { blocked: { gt: 0 } }, { damaged: { gt: 0 } }, { expired: { gt: 0 } }] }
      : {}),
  };
  const [total, items] = await Promise.all([
    db.stockBalance.count({ where }),
    db.stockBalance.findMany({
      where, ...paging(input),
      orderBy: [{ variantId: "asc" }, { warehouseId: "asc" }, { binId: "asc" }],
      include: { variant: { select: { sku: true } }, bin: { select: { code: true, type: true } }, batch: { select: { batchNo: true, expiryDate: true } } },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

// The ledger, newest first, filterable.
export async function listMovements(
  ctx: Ctx,
  input: Page & {
    variantId?: string; warehouseId?: string; type?: MovementType;
    sourceType?: string; sourceId?: string; from?: Date; to?: Date;
  },
) {
  await requirePermission(ctx, "inventory.view", { warehouseId: input.warehouseId });
  const where = {
    companyId: ctx.companyId,
    warehouseId: scopeFilter(ctx, input.warehouseId),
    variantId: input.variantId,
    type: input.type,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    createdAt: input.from || input.to ? { gte: input.from, lte: input.to } : undefined,
  };
  const [total, items] = await Promise.all([
    db.inventoryMovement.count({ where }),
    db.inventoryMovement.findMany({ where, ...paging(input), orderBy: { id: "desc" } }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

// Per (variant, warehouse) in the caller's scope: physical buckets, reserved, available
// and the reorder flag from variant_warehouse_settings (edge #37). For catalog screens.
// ponytail: available here ignores the expired-batch rule (B-04); getAvailability is exact.
export async function stockSummary(ctx: Ctx, variantIds: string[]) {
  await requirePermission(ctx, "inventory.view");
  const where = { companyId: ctx.companyId, variantId: { in: variantIds }, warehouseId: scopeFilter(ctx) };
  const [balances, allocations, settings] = await Promise.all([
    db.stockBalance.groupBy({ by: ["variantId", "warehouseId"], where, _sum: { onHand: true, blocked: true, damaged: true, expired: true } }),
    db.stockAllocation.groupBy({ by: ["variantId", "warehouseId"], where, _sum: { qtyReserved: true } }),
    db.variantWarehouseSettings.findMany({ where }),
  ]);
  const key = (r: { variantId: string; warehouseId: string }) => `${r.variantId}|${r.warehouseId}`;
  const rows = new Map<string, { variantId: string; warehouseId: string; onHand: number; blocked: number; damaged: number; expired: number; reserved: number; reorderPoint: number | null }>();
  const row = (r: { variantId: string; warehouseId: string }) => {
    const k = key(r);
    if (!rows.has(k)) rows.set(k, { variantId: r.variantId, warehouseId: r.warehouseId, onHand: 0, blocked: 0, damaged: 0, expired: 0, reserved: 0, reorderPoint: null });
    return rows.get(k)!;
  };
  // Display only: Number is fine for rendering; posting math stays Decimal.
  for (const b of balances) Object.assign(row(b), { onHand: Number(b._sum.onHand ?? 0), blocked: Number(b._sum.blocked ?? 0), damaged: Number(b._sum.damaged ?? 0), expired: Number(b._sum.expired ?? 0) });
  for (const a of allocations) row(a).reserved = Number(a._sum.qtyReserved ?? 0);
  for (const s of settings) row(s).reorderPoint = s.reorderPoint === null ? null : Number(s.reorderPoint);
  return [...rows.values()].map((r) => {
    const available = r.onHand - r.reserved;
    return { ...r, available, belowReorder: r.reorderPoint !== null && available <= r.reorderPoint };
  });
}
