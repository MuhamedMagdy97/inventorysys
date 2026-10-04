import { PERMISSIONS, ROLE_SEEDS, WAREHOUSE_SCOPED } from "@/server/auth/grants";
import { writeAudit } from "@/server/core/audit";
import { deny, requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db, type Tx } from "@/server/db";

// Idempotent (T2.2): the canonical permission rows + this company's 12 seed roles.
// Re-running only adds what's missing; it never overwrites grants an admin edited.
export async function seedRoles(tx: Tx, companyId: string) {
  await tx.permission.createMany({
    data: PERMISSIONS.map((code) => ({ code, warehouseScoped: WAREHOUSE_SCOPED.has(code) })),
    skipDuplicates: true,
  });
  const existing = new Set((await tx.role.findMany({ where: { companyId }, select: { code: true } })).map((r) => r.code));
  for (const [code, seed] of Object.entries(ROLE_SEEDS)) {
    if (existing.has(code)) continue;
    await tx.role.create({
      data: {
        companyId, code, name: seed.name, isSystem: true,
        allWarehouses: seed.allWarehouses ?? false, requires2fa: seed.requires2fa ?? false,
        permissions: {
          // Map dedupes overlaps like `*.view` + `reports.*`; a limited entry is listed explicitly once.
          create: [...new Map(seed.grants.map((g) => (Array.isArray(g) ? [g[0], g[1]] : [g, null]))).entries()]
            .map(([permissionCode, limitAmount]) => ({ permissionCode, limitAmount })),
        },
      },
    });
  }
  return tx.role.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } });
}

export async function listRoles(ctx: Ctx) {
  await requirePermission(ctx, ["roles.manage", "users.view"]);
  return db.role.findMany({
    where: { companyId: ctx.companyId },
    orderBy: { createdAt: "asc" },
    include: { permissions: { orderBy: { permissionCode: "asc" } }, _count: { select: { users: true } } },
  });
}

type Grant = { code: string; limitAmount?: string | number | null };

export async function createRole(
  tx: Tx,
  ctx: Ctx,
  input: { code: string; name: string; allWarehouses?: boolean; requires2fa?: boolean; grants: Grant[] },
) {
  await requirePermission(ctx, "roles.manage");
  await assertGrantable(ctx, input.grants.map((g) => g.code));
  if (await tx.role.findFirst({ where: { companyId: ctx.companyId, code: input.code } })) {
    throw new AppError("duplicate", "Role code already exists", { code: input.code });
  }
  const role = await tx.role.create({
    data: {
      companyId: ctx.companyId, code: input.code, name: input.name,
      allWarehouses: input.allWarehouses ?? false, requires2fa: input.requires2fa ?? false,
      permissions: { create: input.grants.map((g) => ({ permissionCode: g.code, limitAmount: g.limitAmount ?? null })) },
    },
    include: { permissions: true },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "role", entityId: role.id, after: auditShape(role) });
  return role;
}

// Replaces a role's grants (the permission-matrix editor). Version-checked (INV-023).
export async function setRoleGrants(
  tx: Tx,
  ctx: Ctx,
  input: { roleId: string; version: number; name?: string; allWarehouses?: boolean; requires2fa?: boolean; grants: Grant[] },
) {
  await requirePermission(ctx, "roles.manage");
  const before = await tx.role.findFirst({ where: { id: input.roleId, companyId: ctx.companyId }, include: { permissions: true } });
  if (!before) throw new AppError("not_found", "Role not found");
  // Only the grants being added must be ones the editor holds; removals are always allowed.
  const had = new Set(before.permissions.map((p) => p.permissionCode));
  await assertGrantable(ctx, input.grants.map((g) => g.code).filter((c) => !had.has(c)));
  const flagUp = input.allWarehouses && !before.allWarehouses;
  if (flagUp && ctx.warehouseIds !== "all") {
    throw await deny(ctx, "Cannot grant all-warehouse scope you don't have", { reason: "escalation" }, { type: "role", id: before.id });
  }

  const bumped = await tx.role.updateMany({
    where: { id: before.id, version: input.version },
    data: {
      version: { increment: 1 }, name: input.name ?? before.name,
      allWarehouses: input.allWarehouses ?? before.allWarehouses, requires2fa: input.requires2fa ?? before.requires2fa,
    },
  });
  if (bumped.count === 0) throw new AppError("version_conflict", "Role was changed by someone else", { currentVersion: before.version });
  await tx.rolePermission.deleteMany({ where: { roleId: before.id } });
  await tx.rolePermission.createMany({
    data: input.grants.map((g) => ({ roleId: before.id, permissionCode: g.code, limitAmount: g.limitAmount ?? null })),
  });
  const after = await tx.role.findUniqueOrThrow({ where: { id: before.id }, include: { permissions: true } });
  await writeAudit(tx, ctx, { action: "update", entityType: "role", entityId: before.id, before: auditShape(before), after: auditShape(after) });
  return after;
}

// No privilege escalation: you can only hand out grants you hold yourself.
export async function assertGrantable(ctx: Ctx, codes: string[]) {
  const unknown = codes.filter((c) => !(PERMISSIONS as readonly string[]).includes(c));
  if (unknown.length) throw new AppError("validation_error", "Unknown permission", { unknown });
  const missing = codes.filter((c) => !ctx.permissions.has(c));
  if (missing.length) throw await deny(ctx, "Cannot grant permissions you don't hold", { reason: "escalation", missing }, { type: "permission", id: missing.join("|") });
}

// Grants as {code: limit} so the audit diff shows exactly which grant/limit changed.
type RoleWithGrants = { code: string; name: string; allWarehouses: boolean; requires2fa: boolean; version: number;
  permissions: { permissionCode: string; limitAmount: { toString(): string } | null }[] };
const auditShape = (r: RoleWithGrants) => ({
  code: r.code, name: r.name, allWarehouses: r.allWarehouses, requires2fa: r.requires2fa, version: r.version,
  grants: Object.fromEntries(r.permissions.map((p) => [p.permissionCode, p.limitAmount?.toString() ?? null])),
});
