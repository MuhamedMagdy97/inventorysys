import { hashPassword } from "better-auth/crypto";
import type { SalesChannel } from "@/generated/prisma/client";
import { auth } from "@/server/auth/auth";
import { writeAudit } from "@/server/core/audit";
import { deny, requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db, type Tx } from "@/server/db";
import { assertGrantable } from "./roles";

const MIN_PASSWORD = 10; // doc 02 §6

export async function listUsers(ctx: Ctx) {
  await requirePermission(ctx, "users.view");
  return db.user.findMany({
    where: { companyId: ctx.companyId, isSystem: false },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, name: true, email: true, status: true, isService: true, twoFactorEnabled: true, lockedUntil: true, version: true,
      roles: { select: { role: { select: { id: true, code: true, name: true } } } },
      warehouses: { select: { warehouse: { select: { id: true, code: true } } } },
    },
  });
}

type Access = { roleIds: string[]; warehouseIds: string[] };

// Admin-created accounts only (no self sign-up). Service users (sales channels) get no password.
export async function createUser(
  tx: Tx,
  ctx: Ctx,
  input: Access & { name: string; email: string; password?: string; isService?: boolean; salesChannel?: SalesChannel },
) {
  await requirePermission(ctx, "users.manage");
  const email = input.email.trim().toLowerCase();
  if (!input.isService && (input.password?.length ?? 0) < MIN_PASSWORD) {
    throw new AppError("validation_error", `Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (await tx.user.findUnique({ where: { email } })) throw new AppError("duplicate", "Email already in use", { email });
  await checkAccess(tx, ctx, input, "new");

  const user = await tx.user.create({
    data: {
      companyId: ctx.companyId, name: input.name, email, isService: input.isService ?? false,
      salesChannel: input.isService ? (input.salesChannel ?? "api") : null,
    },
  });
  if (!input.isService) {
    await tx.account.create({
      data: { userId: user.id, accountId: user.id, providerId: "credential", password: await hashPassword(input.password!) },
    });
  }
  await writeAccess(tx, ctx, user.id, input);
  const after = { ...pick(user), ...input, password: undefined };
  await writeAudit(tx, ctx, { action: "create", entityType: "user", entityId: user.id, after });
  return user;
}

// Roles, warehouses and status in one version-checked update (doc 02 §4: effective on next request).
export async function updateUserAccess(
  tx: Tx,
  ctx: Ctx,
  input: Access & { userId: string; version: number; name?: string; status?: "active" | "disabled" },
) {
  await requirePermission(ctx, "users.manage");
  const before = await tx.user.findFirst({
    where: { id: input.userId, companyId: ctx.companyId, isSystem: false },
    include: { roles: true, warehouses: true },
  });
  if (!before) throw new AppError("not_found", "User not found");
  if (before.id === ctx.userId && input.status === "disabled") {
    throw new AppError("validation_error", "You cannot disable your own account");
  }
  if (input.status === "disabled" && before.status !== "disabled") {
    // Doc 06 §4: a warehouse manager who leaves is replaced first.
    const managed = await tx.warehouse.findMany({ where: { managerUserId: before.id, status: { not: "archived" } }, select: { code: true } });
    if (managed.length) {
      throw new AppError("conflict", `Assign a new manager to ${managed.map((w) => w.code).join(", ")} first`, { reason: "is_manager" });
    }
  }
  await checkAccess(tx, ctx, input, before.id);

  const bumped = await tx.user.updateMany({
    where: { id: before.id, version: input.version },
    data: { version: { increment: 1 }, name: input.name ?? before.name, status: input.status ?? before.status },
  });
  if (bumped.count === 0) throw new AppError("version_conflict", "User was changed by someone else", { currentVersion: before.version });
  await tx.userRole.deleteMany({ where: { userId: before.id } });
  await tx.userWarehouse.deleteMany({ where: { userId: before.id } });
  await writeAccess(tx, ctx, before.id, input);
  if (input.status === "disabled") await tx.session.deleteMany({ where: { userId: before.id } }); // revoke (doc 02 §6)

  await writeAudit(tx, ctx, {
    action: "update", entityType: "user", entityId: before.id,
    before: { ...pick(before), roleIds: before.roles.map((r) => r.roleId), warehouseIds: before.warehouses.map((w) => w.warehouseId) },
    after: { name: input.name ?? before.name, status: input.status ?? before.status, roleIds: input.roleIds, warehouseIds: input.warehouseIds },
  });
  return tx.user.findUniqueOrThrow({ where: { id: before.id } });
}

// Admin unlock after lockout (doc 02 §6).
export async function unlockUser(tx: Tx, ctx: Ctx, userId: string) {
  await requirePermission(ctx, "users.manage");
  const u = await tx.user.findFirst({ where: { id: userId, companyId: ctx.companyId } });
  if (!u) throw new AppError("not_found", "User not found");
  await tx.user.update({ where: { id: u.id }, data: { lockedUntil: null, failedLoginCount: 0 } });
  await writeAudit(tx, ctx, { action: "unlock", entityType: "user", entityId: u.id, before: { lockedUntil: u.lockedUntil } });
}

// API key for a sales-channel service user (doc 02 §6). The plaintext key is returned once.
export async function createChannelKey(ctx: Ctx, input: { userId: string; name: string }) {
  await requirePermission(ctx, "users.manage");
  const u = await db.user.findFirst({ where: { id: input.userId, companyId: ctx.companyId } });
  if (!u) throw new AppError("not_found", "User not found");
  if (!u.isService) throw new AppError("validation_error", "API keys are only issued to service users");
  const key = await auth.api.createApiKey({ body: { userId: u.id, name: input.name } });
  await writeAudit(db, ctx, { action: "create", entityType: "api_key", entityId: key.id, after: { userId: u.id, name: input.name, start: key.start } });
  return { id: key.id, key: key.key };
}

// Same-company refs (also enforced by composite FKs) + no escalation beyond the admin's own grants/scope.
async function checkAccess(tx: Tx, ctx: Ctx, input: Access, userId: string) {
  const roles = await tx.role.findMany({
    where: { id: { in: input.roleIds }, companyId: ctx.companyId },
    include: { permissions: { select: { permissionCode: true } } },
  });
  if (roles.length !== new Set(input.roleIds).size) throw new AppError("not_found", "Role not found");
  const whs = await tx.warehouse.count({ where: { id: { in: input.warehouseIds }, companyId: ctx.companyId } });
  if (whs !== new Set(input.warehouseIds).size) throw new AppError("not_found", "Warehouse not found");
  await assertGrantable(ctx, [...new Set(roles.flatMap((r) => r.permissions.map((p) => p.permissionCode)))]);
  const outside = input.warehouseIds.filter((w) => ctx.warehouseIds !== "all" && !ctx.warehouseIds.includes(w));
  if (outside.length || (roles.some((r) => r.allWarehouses) && ctx.warehouseIds !== "all")) {
    throw await deny(ctx, "Cannot assign warehouses outside your scope", { reason: "escalation", warehouseIds: outside }, { type: "user", id: userId });
  }
}

async function writeAccess(tx: Tx, ctx: Ctx, userId: string, input: Access) {
  await tx.userRole.createMany({ data: [...new Set(input.roleIds)].map((roleId) => ({ companyId: ctx.companyId, userId, roleId })) });
  await tx.userWarehouse.createMany({
    data: [...new Set(input.warehouseIds)].map((warehouseId) => ({ companyId: ctx.companyId, userId, warehouseId })),
  });
}

const pick = (u: { name: string; email: string; status: string; isService: boolean }) =>
  ({ name: u.name, email: u.email, status: u.status, isService: u.isService });

export async function getUser(ctx: Ctx, id: string) {
  await requirePermission(ctx, "users.view");
  const u = await db.user.findFirst({
    where: { id, companyId: ctx.companyId, isSystem: false },
    select: {
      id: true, name: true, email: true, status: true, isService: true, twoFactorEnabled: true, lockedUntil: true, version: true,
      roles: { select: { roleId: true } }, warehouses: { select: { warehouseId: true } },
    },
  });
  if (!u) throw new AppError("not_found", "User not found");
  return u;
}
