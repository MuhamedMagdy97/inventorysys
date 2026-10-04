import { afterAll, beforeAll, expect, test } from "vitest";
import { diff, listAudit } from "@/server/audit/queries";
import { auth } from "@/server/auth/auth";
import { ROLE_SEEDS } from "@/server/auth/grants";
import { buildCtx, requestCtx, sessionCtx } from "@/server/auth/session-ctx";
import { requireNotCreator, requirePermission, type Ctx } from "@/server/core/ctx";
import { db, transaction } from "@/server/db";
import { postMovements } from "@/server/inventory/post";
import { fulfil, reserve } from "@/server/inventory/reservations";
import { seedCompany } from "@/server/seed";
import { getSettings, updateSettings } from "@/server/settings/settings";
import { seedRoles, setRoleGrants } from "@/server/users/roles";
import { createUser, unlockUser, updateUserAccess } from "@/server/users/users";
import { loginUser } from "@/test/auth";

let w: Awaited<ReturnType<typeof seedCompany>>;
const role = (code: string) => w.roles.find((r) => r.code === code)!;
const ctxOf = (userId: string) => buildCtx(userId, { requestId: crypto.randomUUID(), channel: "system" });
const audits = (entityId: string, action?: string) =>
  db.auditLog.findMany({ where: { companyId: w.company.id, entityId, action }, orderBy: { id: "asc" } });
const forbidden = (reason: string) => expect.objectContaining({ code: "forbidden", details: expect.objectContaining({ reason }) });

beforeAll(async () => {
  w = await seedCompany(`auth-${crypto.randomUUID()}`);
});
afterAll(() => db.$disconnect());

test("T2.2: 12 seed roles; re-seeding is idempotent and keeps admin edits", async () => {
  expect(w.roles.map((r) => r.code).sort()).toEqual(Object.keys(ROLE_SEEDS).sort());
  const viewer = role("viewer");
  await transaction((tx) => setRoleGrants(tx, w.ctx, { roleId: viewer.id, version: 0, grants: [{ code: "products.view" }] }));
  const again = await transaction((tx) => seedRoles(tx, w.company.id));
  expect(again).toHaveLength(12);
  const grants = await db.rolePermission.findMany({ where: { roleId: viewer.id } });
  expect(grants.map((g) => g.permissionCode)).toEqual(["products.view"]);
  const pm = await db.rolePermission.findUniqueOrThrow({
    where: { roleId_permissionCode: { roleId: role("purchasing_manager").id, permissionCode: "purchases.approve" } },
  });
  expect(pm.limitAmount?.toString()).toBe("5000");
});

test("T2.1: email+password sign-in → session → web ctx", async () => {
  const u = await loginUser(w, "inventory_manager");
  const s = await u.signIn();
  expect(s.status).toBe(200);
  const ctx = await sessionCtx(new Headers(s.headers), "r1");
  expect(ctx).toMatchObject({ userId: u.user.id, companyId: w.company.id, warehouseIds: "all", channel: "web" });
  expect(ctx.permissions.has("inventory.adjust_create")).toBe(true);
  expect((await audits(u.user.id, "auth.login")).length).toBe(1);
});

test("T2.1: lockout after 5 failed passwords; admin unlock restores access", async () => {
  const u = await loginUser(w, "viewer");
  for (let i = 0; i < 5; i++) expect((await u.signIn("wrong-password!")).status).toBe(401);
  const locked = await u.signIn();
  expect(locked.status).toBe(403); // right password, still locked
  expect((await audits(u.user.id, "auth.login_failed")).length).toBe(4);
  expect((await audits(u.user.id, "auth.locked")).length).toBe(1);
  expect((await db.user.findUniqueOrThrow({ where: { id: u.user.id } })).lockedUntil!.getTime()).toBeGreaterThan(Date.now());

  await transaction((tx) => unlockUser(tx, w.ctx, u.user.id));
  expect((await u.signIn()).status).toBe(200);
});

test("T2.1: 2FA is required for owner/admin/super_admin web sessions", async () => {
  const u = await loginUser(w, "owner");
  const s = await u.signIn();
  await expect(sessionCtx(new Headers(s.headers), "r")).rejects.toEqual(forbidden("2fa_required"));
  await db.user.update({ where: { id: u.user.id }, data: { twoFactorEnabled: true } });
  await expect(sessionCtx(new Headers(s.headers), "r")).resolves.toMatchObject({ userId: u.user.id });
});

test("T2.1: disabling a user revokes sessions and blocks sign-in", async () => {
  const u = await loginUser(w, "viewer");
  const s = await u.signIn();
  const before = await db.user.findUniqueOrThrow({ where: { id: u.user.id } });
  await transaction((tx) => updateUserAccess(tx, w.ctx, {
    userId: u.user.id, version: before.version, status: "disabled", roleIds: [role("viewer").id], warehouseIds: [],
  }));
  await expect(sessionCtx(new Headers(s.headers), "r")).rejects.toEqual(forbidden("unauthenticated"));
  expect((await u.signIn()).status).toBe(401);
});

test("T2.3: missing grant, out-of-scope warehouse, over-limit → forbidden + access.denied audit", async () => {
  const other = await transaction((tx) => tx.warehouse.create({ data: { companyId: w.company.id, code: `WH-B-${Date.now()}`, name: "B" } }));
  const staff = await loginUser(w, "warehouse_staff", [w.warehouse.id]);
  const ctx = await ctxOf(staff.user.id);

  await expect(requirePermission(ctx, "inventory.adjust_approve")).rejects.toEqual(forbidden("missing_grant"));
  await expect(requirePermission(ctx, "inventory.receive", { warehouseId: other.id })).rejects.toEqual(forbidden("out_of_scope"));
  await requirePermission(ctx, "inventory.receive", { warehouseId: w.warehouse.id });
  const denied = await db.auditLog.findMany({ where: { companyId: w.company.id, actorId: staff.user.id, action: "access.denied" } });
  expect(denied.map((d) => d.entityId).sort()).toEqual(["inventory.adjust_approve", "inventory.receive"]);
  expect(denied.find((d) => d.entityId === "inventory.receive")!.warehouseId).toBe(other.id);

  // INV-020: limit_amount on the grant; highest/unlimited across roles wins.
  const pm = await loginUser(w, "purchasing_manager");
  const pmCtx = await ctxOf(pm.user.id);
  await requirePermission(pmCtx, "purchases.approve", { amount: "5000" });
  await expect(requirePermission(pmCtx, "purchases.approve", { amount: "5000.01" })).rejects.toEqual(forbidden("over_limit"));
  await db.userRole.create({ data: { companyId: w.company.id, userId: pm.user.id, roleId: role("owner").id } });
  await requirePermission(await ctxOf(pm.user.id), "purchases.approve", { amount: "1000000" });
});

test("gate: creator ≠ approver helper", async () => {
  await expect(requireNotCreator(w.ctx, w.ctx.userId, { type: "purchase_order", id: "po-1" })).rejects.toEqual(forbidden("creator_is_approver"));
  await requireNotCreator(w.ctx, crypto.randomUUID(), { type: "purchase_order", id: "po-1" });
  expect((await audits("po-1", "access.denied")).length).toBe(1);
});

test("gate: permissions are re-checked at post time (revoked between reserve and fulfil)", async () => {
  await transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "opening", sourceId: "auth-ob",
    legs: [{ type: "opening_balance", variantId: w.variants[1].id, warehouseId: w.warehouse.id, binId: w.warehouse.bins[0].id, delta: { onHand: 10 }, unitCost: 1, line: 1, reasonCode: "opening" }],
  }));
  const customRole = await db.role.create({
    data: {
      companyId: w.company.id, code: `seller-${Date.now()}`, name: "Seller",
      permissions: { create: ["sales.reserve", "sales.fulfil"].map((permissionCode) => ({ permissionCode })) },
    },
  });
  const u = await transaction((tx) => createUser(tx, w.ctx, {
    name: "Seller", email: `seller+${crypto.randomUUID()}@test.invalid`, password: "long-enough-pw",
    roleIds: [customRole.id], warehouseIds: [w.warehouse.id],
  }));
  const { reservation } = await transaction(async (tx) => reserve(tx, await ctxOf(u.id), { variantId: w.variants[1].id, warehouseId: w.warehouse.id, qty: 2 }));

  await transaction((tx) => setRoleGrants(tx, w.ctx, { roleId: customRole.id, version: 0, grants: [{ code: "sales.reserve" }] }));
  const fresh = await ctxOf(u.id); // the next request builds its ctx from the DB
  await expect(transaction((tx) => fulfil(tx, fresh, { reservationId: reservation.id, version: 0 }))).rejects.toEqual(forbidden("missing_grant"));
});

test("no privilege escalation: an admin can't grant what they don't hold", async () => {
  const admin = await loginUser(w, "admin");
  const ctx: Ctx = await ctxOf(admin.user.id);
  const input = { name: "X", email: `x+${crypto.randomUUID()}@test.invalid`, password: "long-enough-pw", warehouseIds: [] };
  await expect(transaction((tx) => createUser(tx, ctx, { ...input, roleIds: [role("super_admin").id] }))).rejects.toEqual(forbidden("escalation"));
  await expect(transaction((tx) => setRoleGrants(tx, ctx, { roleId: role("viewer").id, version: 1, grants: [{ code: "inventory.adjust_apply" }] })))
    .rejects.toEqual(forbidden("escalation"));
  const catalogRole = await db.role.create({
    data: { companyId: w.company.id, code: `cat-${Date.now()}`, name: "Catalog", permissions: { create: [{ permissionCode: "products.view" }] } },
  });
  await transaction((tx) => createUser(tx, ctx, { ...input, roleIds: [catalogRole.id] })); // within their own grants
});

test("users/roles are company-bound by the DB (composite FKs)", async () => {
  const other = await seedCompany(`auth-other-${crypto.randomUUID()}`);
  const foreignRole = other.roles[0];
  await expect(db.userRole.create({ data: { companyId: w.company.id, userId: w.admin.id, roleId: foreignRole.id } })).rejects.toThrow();
  await expect(db.userWarehouse.create({ data: { companyId: w.company.id, userId: w.admin.id, warehouseId: other.warehouse.id } })).rejects.toThrow();
  await expect(transaction((tx) => updateUserAccess(tx, w.ctx, { userId: other.admin.id, version: 0, roleIds: [], warehouseIds: [] })))
    .rejects.toMatchObject({ code: "not_found" });
});

test("T2.6 + audit: settings defaults, validation, update audited; reserve uses the TTL", async () => {
  expect(await getSettings(w.ctx)).toEqual({ currency: "USD", timezone: "UTC", reservationTtlSeconds: 172800, receiptTolerancePct: 0, barcodeAliasDays: 30 });
  await expect(transaction((tx) => updateSettings(tx, w.ctx, { currency: "usd" }))).rejects.toThrow();
  await transaction((tx) => updateSettings(tx, w.ctx, { currency: "EUR", timezone: "Africa/Cairo", reservationTtlSeconds: 3600 }));
  const [a] = await audits(w.company.id, "update");
  expect(a).toMatchObject({ entityType: "settings", before: { currency: "USD" }, after: { currency: "EUR", timezone: "Africa/Cairo" } });

  const { reservation } = await transaction((tx) => reserve(tx, w.ctx, { variantId: w.variants[1].id, warehouseId: w.warehouse.id, qty: 1 }));
  const ttl = (reservation.expiresAt.getTime() - reservation.createdAt.getTime()) / 1000;
  expect(Math.round(ttl)).toBe(3600);
});

test("audit completeness: user + role changes carry before/after", async () => {
  const u = await transaction((tx) => createUser(tx, w.ctx, {
    name: "Aud", email: `aud+${crypto.randomUUID()}@test.invalid`, password: "long-enough-pw", roleIds: [role("viewer").id], warehouseIds: [],
  }));
  await transaction((tx) => updateUserAccess(tx, w.ctx, { userId: u.id, version: 0, roleIds: [role("auditor").id], warehouseIds: [w.warehouse.id] }));
  const [create, update] = await audits(u.id);
  expect(create).toMatchObject({ action: "create", after: { email: u.email, roleIds: [role("viewer").id] } });
  expect(create.after).not.toHaveProperty("password");
  expect(update).toMatchObject({ action: "update", before: { roleIds: [role("viewer").id] }, after: { roleIds: [role("auditor").id], warehouseIds: [w.warehouse.id] } });
  expect(await requestCtx(new Request("http://t/"), "r").catch((e) => e.code)).toBe("forbidden");
});

test("audit explorer: role grant changes diff down to the changed limit", async () => {
  const pm = await db.role.findUniqueOrThrow({ where: { id: role("purchasing_manager").id }, include: { permissions: true } });
  const grants = pm.permissions.map((p) => ({ code: p.permissionCode, limitAmount: p.permissionCode === "purchases.approve" ? "7500" : p.limitAmount?.toString() }));
  await transaction((tx) => setRoleGrants(tx, w.ctx, { roleId: pm.id, version: pm.version, grants }));
  const [entry] = await audits(pm.id, "update");
  expect(diff(entry.before, entry.after)).toEqual([
    { path: "grants.purchases.approve", before: "5000", after: "7500" },
    { path: "version", before: 0, after: 1 },
  ]);
  const page = await listAudit(w.ctx, { page: 1, perPage: 10, entityType: "role", entityId: pm.id });
  expect(page.items[0]).toMatchObject({ action: "update", actor: { id: w.admin.id } });
});

test("self-service profile/key endpoints are closed over HTTP", async () => {
  const u = await loginUser(w, "viewer");
  const { headers } = await u.signIn();
  for (const path of ["/update-user", "/api-key/create"]) {
    const res = await auth.handler(new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST", headers: { ...headers, "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "renamed" }),
    }));
    expect(res.status, path).toBe(404);
  }
  expect((await db.user.findUniqueOrThrow({ where: { id: u.user.id } })).name).toBe("viewer");
  expect(await db.apikey.count({ where: { referenceId: u.user.id } })).toBe(0);
});
