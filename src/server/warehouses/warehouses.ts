import type { BinType, MasterStatus } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import { inScope, requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { db, type Tx } from "@/server/db";
import { OPEN_TRANSFER } from "@/server/inventory/transfers";

// Doc 06. WH-01/WH-05: every warehouse gets a default sellable, receiving, quarantine and damaged bin.
export const DEFAULT_BINS = [
  { code: "MAIN", type: "sellable", isDefaultSellable: true },
  { code: "RECV", type: "receiving", isDefaultReceiving: true },
  { code: "QUAR", type: "quarantine" },
  { code: "DMG", type: "damaged" },
] as const;

const code = (raw: string, what: string) => {
  const c = raw.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,29}$/.test(c)) throw new AppError("validation_error", `${what} code: 1–30 of A–Z, 0–9, '-', '_'`, { field: "code" });
  return c;
};
const level = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim().toUpperCase() || null);

// Master-data admins (warehouses.update, a global grant) manage every warehouse's bins;
// a location manager only those in their scope (doc 02: warehouse_manager "own warehouses").
const requireLocations = (ctx: Ctx, warehouseId: string) =>
  requirePermission(ctx, "locations.manage", { warehouseId: ctx.permissions.has("warehouses.update") ? undefined : warehouseId });

async function findWarehouse(tx: Tx | typeof db, ctx: Ctx, id: string) {
  const w = await tx.warehouse.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!w) throw new AppError("not_found", "Warehouse not found");
  return w;
}

// A manager is an active person of this company; they also get the warehouse in scope.
async function assignManager(tx: Tx, ctx: Ctx, warehouseId: string, userId: string | null | undefined) {
  if (!userId) return;
  const u = await tx.user.findFirst({ where: { id: userId, companyId: ctx.companyId, status: "active", isSystem: false, isService: false } });
  if (!u) throw new AppError("validation_error", "Manager must be an active user", { field: "managerUserId" });
  await tx.userWarehouse.createMany({ data: [{ companyId: ctx.companyId, userId, warehouseId }], skipDuplicates: true });
}

// Flow 5: warehouse → default bins → manager.
export async function createWarehouse(
  tx: Tx,
  ctx: Ctx,
  input: { code: string; name: string; address?: string | null; managerUserId?: string | null },
) {
  await requirePermission(ctx, "warehouses.create");
  const name = input.name.trim();
  if (!name || name.length > 100) throw new AppError("validation_error", "Name: 1–100 characters", { field: "name" });
  const warehouse = await tx.warehouse.create({
    data: {
      companyId: ctx.companyId, code: code(input.code, "Warehouse"), name, address: input.address?.trim() || null,
      bins: { create: DEFAULT_BINS.map((b) => ({ ...b, companyId: ctx.companyId })) },
    },
    include: { bins: true },
  });
  if (input.managerUserId) {
    await assignManager(tx, ctx, warehouse.id, input.managerUserId);
    await tx.warehouse.update({ where: { id: warehouse.id }, data: { managerUserId: input.managerUserId } });
  }
  await writeAudit(tx, ctx, {
    action: "create", entityType: "warehouse", entityId: warehouse.id, warehouseId: warehouse.id, after: warehouse,
  });
  return { ...warehouse, managerUserId: input.managerUserId ?? null };
}

const NEXT: Record<MasterStatus, MasterStatus[]> = { active: ["inactive", "archived"], inactive: ["active", "archived"], archived: [] };

export async function updateWarehouse(
  tx: Tx,
  ctx: Ctx,
  input: { id: string; version: number; name?: string; address?: string | null; managerUserId?: string | null; status?: MasterStatus },
) {
  await requirePermission(ctx, input.status === "archived" ? "warehouses.archive" : "warehouses.update");
  // Waits out in-flight postings (they hold FOR SHARE); later ones see `archived`.
  if (input.status === "archived") await tx.$executeRaw`SELECT 1 FROM warehouse WHERE id = ${input.id} FOR UPDATE`;
  const before = await findWarehouse(tx, ctx, input.id);
  if (input.status && input.status !== before.status && !NEXT[before.status].includes(input.status)) {
    throw new AppError("invalid_transition", `Warehouse can't go from ${before.status} to ${input.status}`, { from: before.status, to: input.status });
  }
  if (before.status === "archived") throw new AppError("archived_conflict", "Warehouse is archived");
  if (input.status === "archived") await assertWarehouseEmpty(tx, before.id);
  if (input.managerUserId !== before.managerUserId) await assignManager(tx, ctx, before.id, input.managerUserId);
  const name = input.name?.trim();
  if (name !== undefined && (!name || name.length > 100)) throw new AppError("validation_error", "Name: 1–100 characters", { field: "name" });

  assertVersion(await tx.warehouse.updateMany({
    where: { id: before.id, version: input.version },
    data: {
      name, address: input.address === undefined ? undefined : input.address?.trim() || null,
      managerUserId: input.managerUserId, status: input.status, version: { increment: 1 },
    },
  }), "Warehouse", before.version);
  const after = await tx.warehouse.findUniqueOrThrow({ where: { id: before.id } });
  await writeAudit(tx, ctx, {
    action: input.status === "archived" ? "archive" : "update", entityType: "warehouse", entityId: after.id, warehouseId: after.id, before, after,
  });
  return after;
}

// WH-02 / edge #5. Open POs stand for expected receipts; open transfers either way incl. in-transit (edge #25). Part 8 adds counts.
async function assertWarehouseEmpty(tx: Tx, warehouseId: string) {
  const [stock, reserved, reservations, openPos, openTransfers] = await Promise.all([
    tx.stockBalance.count({ where: { warehouseId, OR: [{ onHand: { gt: 0 } }, { blocked: { gt: 0 } }, { damaged: { gt: 0 } }, { expired: { gt: 0 } }] } }),
    tx.stockAllocation.count({ where: { warehouseId, qtyReserved: { gt: 0 } } }),
    tx.reservation.count({ where: { warehouseId, status: { in: ["active", "partially_fulfilled"] } } }),
    tx.purchaseOrder.count({ where: { warehouseId, status: { in: ["draft", "submitted", "approved", "ordered", "partially_received"] } } }),
    tx.transfer.count({ where: { OR: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }], status: { in: OPEN_TRANSFER } } }),
  ]);
  if (stock || reserved || reservations || openPos || openTransfers) {
    throw new AppError("conflict", "Warehouse still holds stock, open reservations, POs or transfers; empty and close it first (WH-02)", {
      reason: "not_empty", stockPositions: stock, reservedPositions: reserved, openReservations: reservations, openPos, openTransfers,
    });
  }
}

// ───────────── Bins ─────────────

export async function createBin(
  tx: Tx,
  ctx: Ctx,
  input: { warehouseId: string; code: string; type: BinType; zone?: string | null; rack?: string | null; shelf?: string | null },
) {
  await requireLocations(ctx, input.warehouseId);
  const w = await findWarehouse(tx, ctx, input.warehouseId);
  if (w.status === "archived") throw new AppError("archived_conflict", "Warehouse is archived");
  const bin = await tx.bin.create({
    data: {
      companyId: ctx.companyId, warehouseId: w.id, code: code(input.code, "Bin"), type: input.type,
      zone: level(input.zone), rack: level(input.rack), shelf: level(input.shelf),
    },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "bin", entityId: bin.id, warehouseId: w.id, after: bin });
  return bin;
}

// Rename / relocate / make default / archive. WH-01: defaults can't be archived and a
// warehouse keeps ≥1 active quarantine and damaged bin. WH-03: no archive while stocked.
export async function updateBin(
  tx: Tx,
  ctx: Ctx,
  input: {
    id: string; version: number; code?: string; zone?: string | null; rack?: string | null; shelf?: string | null;
    makeDefault?: "sellable" | "receiving"; archived?: boolean;
  },
) {
  if (input.archived) await tx.$executeRaw`SELECT 1 FROM bin WHERE id = ${input.id} FOR UPDATE`; // see updateWarehouse
  const before = await tx.bin.findFirst({ where: { id: input.id, companyId: ctx.companyId } });
  if (!before) throw new AppError("not_found", "Bin not found");
  await requireLocations(ctx, before.warehouseId);

  if (input.makeDefault) {
    if (before.archived) throw new AppError("archived_conflict", "Bin is archived");
    if (before.type !== input.makeDefault) throw new AppError("validation_error", `Only a ${input.makeDefault} bin can be the default ${input.makeDefault} bin`);
    const flag = input.makeDefault === "sellable" ? "isDefaultSellable" : "isDefaultReceiving";
    await tx.bin.updateMany({ where: { warehouseId: before.warehouseId, [flag]: true, id: { not: before.id } }, data: { [flag]: false, version: { increment: 1 } } });
  }
  if (input.archived && !before.archived) {
    if (before.isDefaultSellable || before.isDefaultReceiving) {
      throw new AppError("conflict", "Make another bin the default first (WH-01)", { reason: "default_bin" });
    }
    if (before.type === "quarantine" || before.type === "damaged") {
      const others = await tx.bin.count({ where: { warehouseId: before.warehouseId, type: before.type, archived: false, id: { not: before.id } } });
      if (!others) throw new AppError("conflict", `A warehouse needs at least one active ${before.type} bin (WH-01)`, { reason: "last_special_bin" });
    }
    const stocked = await tx.stockBalance.count({
      where: { binId: before.id, OR: [{ onHand: { gt: 0 } }, { blocked: { gt: 0 } }, { damaged: { gt: 0 } }, { expired: { gt: 0 } }] },
    });
    if (stocked) throw new AppError("conflict", "Bin still holds stock; move it first (WH-03)", { reason: "not_empty" });
  }

  assertVersion(await tx.bin.updateMany({
    where: { id: before.id, version: input.version },
    data: {
      code: input.code === undefined ? undefined : code(input.code, "Bin"),
      zone: level(input.zone), rack: level(input.rack), shelf: level(input.shelf), archived: input.archived,
      ...(input.makeDefault === "sellable" ? { isDefaultSellable: true } : input.makeDefault === "receiving" ? { isDefaultReceiving: true } : {}),
      version: { increment: 1 },
    },
  }), "Bin", before.version);
  const after = await tx.bin.findUniqueOrThrow({ where: { id: before.id } });
  const action = input.archived === true && !before.archived ? "archive" : input.archived === false && before.archived ? "unarchive" : input.makeDefault ? "make_default" : "update";
  await writeAudit(tx, ctx, { action, entityType: "bin", entityId: after.id, warehouseId: after.warehouseId, before, after });
  return after;
}

// ───────────── Staff ─────────────

// No escalation (doc 02 §4): you can only hand out a warehouse you hold yourself.
export async function setWarehouseStaff(tx: Tx, ctx: Ctx, input: { warehouseId: string; userId: string; assigned: boolean }) {
  await requirePermission(ctx, "warehouses.assign_staff", { warehouseId: input.warehouseId });
  const w = await findWarehouse(tx, ctx, input.warehouseId);
  const user = await tx.user.findFirst({ where: { id: input.userId, companyId: ctx.companyId, isSystem: false } });
  if (!user) throw new AppError("not_found", "User not found");
  if (!input.assigned && w.managerUserId === user.id) {
    throw new AppError("conflict", "Assign another manager before removing this one", { reason: "is_manager" });
  }
  const key = { companyId: ctx.companyId, userId: user.id, warehouseId: w.id };
  if (input.assigned) await tx.userWarehouse.createMany({ data: [key], skipDuplicates: true });
  else await tx.userWarehouse.deleteMany({ where: key });
  await tx.user.update({ where: { id: user.id }, data: { version: { increment: 1 } } }); // access changed (INV-023)
  await writeAudit(tx, ctx, { action: input.assigned ? "staff_assign" : "staff_unassign", entityType: "warehouse", entityId: w.id, warehouseId: w.id, after: { userId: user.id } });
}

// ───────────── Reads ─────────────

// Master-data admins see every warehouse; everyone else their scope (doc 02 §3).
const visible = (ctx: Ctx) =>
  ctx.warehouseIds === "all" || ["warehouses.create", "warehouses.update", "warehouses.archive"].some((p) => ctx.permissions.has(p))
    ? {}
    : { id: { in: ctx.warehouseIds } };

// Selector list, limited to the caller's scope (doc 02 §3).
export async function listWarehouses(ctx: Ctx) {
  await requirePermission(ctx, ["warehouses.view", "users.manage"]);
  return db.warehouse.findMany({
    where: { companyId: ctx.companyId, ...(ctx.warehouseIds === "all" ? {} : { id: { in: ctx.warehouseIds } }) },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, status: true },
  });
}

export async function listWarehouseCards(ctx: Ctx) {
  await requirePermission(ctx, "warehouses.view");
  return db.warehouse.findMany({
    where: { companyId: ctx.companyId, ...visible(ctx) },
    orderBy: [{ status: "asc" }, { code: "asc" }],
    include: { manager: { select: { name: true } }, _count: { select: { bins: { where: { archived: false } }, userWarehouses: true } } },
  });
}

// Warehouse + bin tree (zone/rack/shelf order) + staff; per-bin totals only with inventory.view in scope.
export async function getWarehouse(ctx: Ctx, id: string) {
  await requirePermission(ctx, "warehouses.view");
  const w = await db.warehouse.findFirst({
    where: { id, companyId: ctx.companyId, ...visible(ctx) },
    include: {
      manager: { select: { id: true, name: true } },
      bins: { orderBy: [{ archived: "asc" }, { zone: "asc" }, { rack: "asc" }, { shelf: "asc" }, { code: "asc" }] },
      userWarehouses: { include: { user: { select: { id: true, name: true, email: true, status: true } } } },
    },
  });
  if (!w) throw new AppError("not_found", "Warehouse not found");
  const canSeeStock = ctx.permissions.has("inventory.view") && inScope(ctx, w.id);
  const totals = canSeeStock
    ? await db.stockBalance.groupBy({ by: ["binId"], where: { warehouseId: w.id }, _sum: { onHand: true, blocked: true, damaged: true, expired: true } })
    : null;
  return { ...w, binTotals: totals && Object.fromEntries(totals.map((t) => [t.binId, t._sum])) };
}

// People who can be made manager or staff (no service/system accounts).
export async function listAssignableUsers(ctx: Ctx) {
  await requirePermission(ctx, ["warehouses.assign_staff", "warehouses.update"]);
  return db.user.findMany({
    where: { companyId: ctx.companyId, status: "active", isSystem: false, isService: false },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true },
  });
}
