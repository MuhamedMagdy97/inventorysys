import type { Tx } from "@/server/db";
import { writeAudit } from "@/server/core/audit";
import { authorize, type Ctx } from "@/server/core/ctx";

// WH-01/WH-05: every warehouse gets a default sellable, receiving, quarantine and damaged bin.
export const DEFAULT_BINS = [
  { code: "MAIN", type: "sellable", isDefaultSellable: true },
  { code: "RECV", type: "receiving", isDefaultReceiving: true },
  { code: "QUAR", type: "quarantine" },
  { code: "DMG", type: "damaged" },
] as const;

// ponytail: minimal create for Part 1; full warehouse/bin admin is Part 3 (T3.3).
export async function createWarehouse(tx: Tx, ctx: Ctx, input: { code: string; name: string }) {
  authorize(ctx, "warehouses.create");
  const warehouse = await tx.warehouse.create({
    data: {
      companyId: ctx.companyId,
      code: input.code,
      name: input.name,
      bins: { create: DEFAULT_BINS.map((b) => ({ ...b, companyId: ctx.companyId })) },
    },
    include: { bins: true },
  });
  await writeAudit(tx, ctx, {
    action: "create", entityType: "warehouse", entityId: warehouse.id, warehouseId: warehouse.id, after: warehouse,
  });
  return warehouse;
}
