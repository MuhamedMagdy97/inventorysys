import { hashPassword } from "better-auth/crypto";
import { buildCtx } from "@/server/auth/session-ctx";
import { createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { transaction, type Tx } from "@/server/db";
import { seedRoles } from "@/server/users/roles";
import { seedUoms } from "@/server/catalog/taxonomy";
import { createWarehouse } from "@/server/warehouses/warehouses";

// One company with its 12 seed roles, a system user, a super_admin ("Admin"), one
// warehouse (default bins) and 2 variants. Used by `prisma db seed` and by tests
// (each test file gets its own company → isolation). `ctx` is the admin's, built
// the same way a request builds it (channel "system" skips the web-only 2FA rule).
export async function seedCompany(name: string, opts: { adminEmail?: string; adminPassword?: string } = {}) {
  const tag = crypto.randomUUID();
  const { company, system, admin, roles } = await transaction(async (tx) => {
    const company = await tx.company.create({ data: { name } });
    const roles = await seedRoles(tx, company.id);
    await seedUoms(tx, company.id);
    const system = await tx.user.create({
      data: { companyId: company.id, name: "system", email: `system+${company.id}@system.invalid`, isSystem: true },
    });
    const admin = await createLoginUser(tx, company.id, {
      name: "Admin", email: opts.adminEmail ?? `admin+${tag}@test.invalid`, password: opts.adminPassword ?? tag,
      roleId: roles.find((r) => r.code === "super_admin")!.id,
    });
    return { company, system, admin, roles };
  });
  const ctx: Ctx = await buildCtx(admin.id, { requestId: crypto.randomUUID(), channel: "system" });
  const { warehouse, variants } = await transaction(async (tx) => {
    const warehouse = await createWarehouse(tx, ctx, { code: "WH-MAIN-01", name: "Main warehouse" });
    const product = await createProduct(tx, ctx, {
      name: "Demo T-shirt", type: "variant_parent",
      variants: [{ sku: "TSHIRT-RED-M" }, { sku: "TSHIRT-BLUE-M" }],
    });
    return { warehouse, variants: product.variants };
  });
  return { company, system, admin, ctx, roles, warehouse, variants };
}

// Bootstrap only (seed/tests): the admin-facing path is users.createUser, which checks permissions.
export async function createLoginUser(
  tx: Tx,
  companyId: string,
  input: { name: string; email: string; password: string; roleId: string; warehouseIds?: string[] },
) {
  const user = await tx.user.create({ data: { companyId, name: input.name, email: input.email.toLowerCase() } });
  await tx.account.create({
    data: { userId: user.id, accountId: user.id, providerId: "credential", password: await hashPassword(input.password) },
  });
  await tx.userRole.create({ data: { companyId, userId: user.id, roleId: input.roleId } });
  for (const warehouseId of input.warehouseIds ?? []) {
    await tx.userWarehouse.create({ data: { companyId, userId: user.id, warehouseId } });
  }
  return user;
}
