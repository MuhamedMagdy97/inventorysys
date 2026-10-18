import type { InventoryMovement, Prisma, SerialStatus } from "@/generated/prisma/client";
import { inScope, requirePermission, scopeFilter, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";
import { readSettings } from "@/server/settings/settings";
import { dec } from "./post";
import { fefoBatches, fefoOrder, utcToday } from "./reservations";

// Read views for batch + serial tracking (doc 14 §6, T11.5).

export type ExpiryStatus = "expired" | "expiring" | "ok" | "none";
const DAY = 86_400_000;

// Batches holding stock per warehouse in scope, in FEFO order, with buckets, expiry status
// and the pick rank reserve/fulfil would use (reservable batches only).
export async function fefoView(ctx: Ctx, input: { variantId: string; warehouseId?: string }) {
  await requirePermission(ctx, "inventory.view", { warehouseId: input.warehouseId });
  const variant = await db.productVariant.findFirst({
    where: { id: input.variantId, companyId: ctx.companyId }, select: { id: true, sku: true, product: { select: { requiresBatch: true } } },
  });
  if (!variant) throw new AppError("not_found", "Variant not found");
  const where = { companyId: ctx.companyId, variantId: variant.id, warehouseId: scopeFilter(ctx, input.warehouseId), batchId: { not: null } };
  const [balances, allocations, settings] = await Promise.all([
    db.stockBalance.groupBy({ by: ["warehouseId", "batchId"], where, _sum: { onHand: true, blocked: true, damaged: true, expired: true } }),
    db.stockAllocation.findMany({ where, include: { batch: true, warehouse: { select: { code: true } } } }),
    readSettings(db, ctx.companyId),
  ]);
  const today = utcToday();
  const horizon = new Date(today.getTime() + settings.expiryAlertDays * DAY);
  const warehouseIds = [...new Set(allocations.map((a) => a.warehouseId))].filter((w) => inScope(ctx, w));
  const ranks = new Map(await Promise.all(warehouseIds.map(async (w) =>
    [w, (await fefoBatches(db, ctx.companyId, variant.id, w)).map((b) => b.id)] as const)));

  const rows = allocations.filter((a) => inScope(ctx, a.warehouseId)).map((a) => {
    const b = balances.find((x) => x.warehouseId === a.warehouseId && x.batchId === a.batchId)?._sum;
    const [onHand, blocked, damaged, expired] = [b?.onHand, b?.blocked, b?.damaged, b?.expired].map((v) => dec(v ?? 0));
    const reserved = dec(a.qtyReserved);
    const batch = a.batch!;
    const status: ExpiryStatus = !batch.expiryDate ? "none" : batch.expiryDate <= today ? "expired" : batch.expiryDate <= horizon ? "expiring" : "ok";
    const rank = ranks.get(a.warehouseId)!.indexOf(batch.id) + 1;
    return {
      warehouseId: a.warehouseId, warehouseCode: a.warehouse.code,
      batchId: batch.id, batchNo: batch.batchNo, expiryDate: batch.expiryDate, mfgDate: batch.mfgDate,
      daysLeft: batch.expiryDate ? Math.round((batch.expiryDate.getTime() - today.getTime()) / DAY) : null,
      status, pickRank: rank || null,
      onHand: onHand.toString(), reserved: reserved.toString(), available: (status === "expired" ? dec(0) : onHand.minus(reserved)).toString(),
      blocked: blocked.toString(), damaged: damaged.toString(), expired: expired.toString(),
    };
  }).filter((r) => [r.onHand, r.reserved, r.blocked, r.damaged, r.expired].some((v) => v !== "0"));
  rows.sort((x, y) => x.warehouseCode.localeCompare(y.warehouseCode) || fefoOrder(x, y));
  return { variantId: variant.id, sku: variant.sku, requiresBatch: variant.product.requiresBatch, expiryAlertDays: settings.expiryAlertDays, rows };
}

// Serial search: by serial no (contains) or SKU; scoped to the caller's warehouses.
export async function listSerials(
  ctx: Ctx,
  input: { q?: string; variantId?: string; status?: SerialStatus; warehouseId?: string; page: number; perPage: number },
) {
  await requirePermission(ctx, "inventory.view", { warehouseId: input.warehouseId });
  const where: Prisma.SerialUnitWhereInput = {
    companyId: ctx.companyId, warehouseId: scopeFilter(ctx, input.warehouseId), variantId: input.variantId, status: input.status,
    ...(input.q && {
      OR: [
        { serialNo: { contains: input.q, mode: "insensitive" } },
        { variant: { sku: { contains: input.q, mode: "insensitive" } } },
      ],
    }),
  };
  const [total, items] = await Promise.all([
    db.serialUnit.count({ where }),
    db.serialUnit.findMany({
      where, skip: (input.page - 1) * input.perPage, take: input.perPage, orderBy: [{ serialNo: "asc" }, { id: "asc" }],
      include: {
        variant: { select: { sku: true, productId: true } }, batch: { select: { batchNo: true, expiryDate: true } },
        warehouse: { select: { code: true } }, bin: { select: { code: true } },
      },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

// One unit's lifecycle: its events (trigger-written, doc 14 §6), each with the movements
// posted for the unit's variant in the same transaction (matched on xmin; both tables are
// append-only, so xmin is the inserting transaction). Movements outside scope are hidden.
export async function getSerialHistory(ctx: Ctx, serialUnitId: string) {
  await requirePermission(ctx, "inventory.view");
  const unit = await db.serialUnit.findFirst({
    where: { id: serialUnitId, companyId: ctx.companyId },
    include: {
      variant: { select: { sku: true, productId: true } }, batch: { select: { batchNo: true, expiryDate: true } },
      warehouse: { select: { code: true } }, bin: { select: { code: true } },
    },
  });
  if (!unit) throw new AppError("not_found", "Serial unit not found");
  await requirePermission(ctx, "inventory.view", { warehouseId: unit.warehouseId });

  // ponytail: xmin wraps after ~4B transactions; the variant + time window keeps a stale match out.
  const rows = await db.$queryRaw<{ event_id: string; movement_id: string | null }[]>`
    SELECT e.id AS event_id, m.id AS movement_id
    FROM serial_unit_event e
    LEFT JOIN inventory_movement m
      ON m.xmin = e.xmin AND m.company_id = e.company_id AND m.variant_id = ${unit.variantId}
     AND m.created_at BETWEEN e.at - interval '1 hour' AND e.at + interval '1 hour'
    WHERE e.serial_unit_id = ${unit.id}
    ORDER BY e.id, m.id`;
  const [events, movements] = await Promise.all([
    db.serialUnitEvent.findMany({ where: { serialUnitId: unit.id }, orderBy: { id: "asc" } }),
    db.inventoryMovement.findMany({
      where: { id: { in: rows.flatMap((r) => (r.movement_id ? [r.movement_id] : [])) }, warehouseId: scopeFilter(ctx) },
      include: { warehouse: { select: { code: true } }, bin: { select: { code: true } } },
    }),
  ]);
  const whIds = [...new Set(events.map((e) => e.warehouseId))];
  const binIds = [...new Set(events.flatMap((e) => (e.binId ? [e.binId] : [])))];
  const [whs, bins] = await Promise.all([
    db.warehouse.findMany({ where: { id: { in: whIds }, companyId: ctx.companyId }, select: { id: true, code: true } }),
    db.bin.findMany({ where: { id: { in: binIds } }, select: { id: true, code: true } }),
  ]);
  const byId = new Map(movements.map((m) => [m.id, m]));
  return {
    unit,
    // Doc 02 §3: steps in warehouses outside scope keep their status change, not where they happened.
    events: events.map((e) => ({
      ...e,
      ...(inScope(ctx, e.warehouseId)
        ? { warehouseCode: whs.find((w) => w.id === e.warehouseId)?.code ?? null, binCode: bins.find((b) => b.id === e.binId)?.code ?? null }
        : { warehouseId: null, binId: null, warehouseCode: null, binCode: null }),
      movements: rows.filter((r) => r.event_id === e.id && r.movement_id && byId.has(r.movement_id))
        .map((r) => byId.get(r.movement_id!)!) as (InventoryMovement & { warehouse: { code: string }; bin: { code: string } | null })[],
    })),
  };
}
