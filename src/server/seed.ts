import { createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { transaction } from "@/server/db";
import { createWarehouse } from "@/server/warehouses/warehouses";

// Canonical grants used by Part 1 domain code (doc 02 §2). Part 2 replaces this
// with seeded roles; until then the seed/system ctx holds all of them.
export const PART1_PERMISSIONS = [
  "warehouses.create", "products.create", "products.update",
  "inventory.view", "inventory.receive", "inventory.adjust_apply",
  "sales.view", "sales.reserve", "sales.fulfil", "sales.cancel",
] as const;

// One company with a system user, an admin, one warehouse (default bins) and 2 variants.
// Used by `prisma db seed` and by tests (each test file gets its own company → isolation).
export async function seedCompany(name: string) {
  return transaction(async (tx) => {
    const company = await tx.company.create({ data: { name } });
    const system = await tx.user.create({ data: { companyId: company.id, name: "system", isSystem: true } });
    const admin = await tx.user.create({ data: { companyId: company.id, name: "Admin" } });
    const ctx: Ctx = {
      companyId: company.id,
      userId: admin.id,
      warehouseIds: "all",
      permissions: new Set(PART1_PERMISSIONS),
      requestId: crypto.randomUUID(),
      channel: "system",
    };
    const warehouse = await createWarehouse(tx, ctx, { code: "WH-MAIN-01", name: "Main warehouse" });
    const product = await createProduct(tx, ctx, {
      name: "Demo T-shirt",
      variants: [{ sku: "TSHIRT-RED-M" }, { sku: "TSHIRT-BLUE-M" }],
    });
    return { company, system, admin, ctx, warehouse, variants: product.variants };
  });
}
