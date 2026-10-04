import type { MovementType } from "@/generated/prisma/client";
import { authorize, type Ctx } from "@/server/core/ctx";
import { db } from "@/server/db";

type Page = { page: number; perPage: number };
const paging = ({ page, perPage }: Page) => ({ skip: (page - 1) * perPage, take: perPage });
const scopeFilter = (ctx: Ctx, warehouseId?: string) =>
  warehouseId ?? (ctx.warehouseIds === "all" ? undefined : { in: ctx.warehouseIds });

// Physical buckets per bin, scoped by company + warehouses.
export async function listBalances(
  ctx: Ctx,
  input: Page & { variantId?: string; warehouseId?: string; binId?: string; batchId?: string; nonZero?: boolean },
) {
  authorize(ctx, "inventory.view", input.warehouseId);
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
  authorize(ctx, "inventory.view", input.warehouseId);
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
