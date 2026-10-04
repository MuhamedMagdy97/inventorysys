import type { Tx } from "@/server/db";
import { writeAudit } from "@/server/core/audit";
import { authorize, type Ctx } from "@/server/core/ctx";

// ponytail: minimal product/variant/batch creation for Part 1; full catalog is Part 3 (T3.1).
export async function createProduct(
  tx: Tx,
  ctx: Ctx,
  input: {
    name: string;
    requiresBatch?: boolean;
    requiresExpiry?: boolean;
    variants: { sku: string; barcode?: string }[];
  },
) {
  authorize(ctx, "products.create");
  const product = await tx.product.create({
    data: {
      companyId: ctx.companyId,
      name: input.name,
      requiresBatch: input.requiresBatch ?? false,
      requiresExpiry: input.requiresExpiry ?? false,
      variants: { create: input.variants.map((v) => ({ ...v, companyId: ctx.companyId })) },
    },
    include: { variants: true },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "product", entityId: product.id, after: product });
  return product;
}

export async function createBatch(
  tx: Tx,
  ctx: Ctx,
  input: { variantId: string; batchNo: string; expiryDate?: Date },
) {
  authorize(ctx, "products.update");
  await tx.productVariant.findFirstOrThrow({ where: { id: input.variantId, companyId: ctx.companyId } });
  const batch = await tx.batch.create({ data: { companyId: ctx.companyId, ...input } });
  await writeAudit(tx, ctx, { action: "create", entityType: "batch", entityId: batch.id, after: batch });
  return batch;
}
