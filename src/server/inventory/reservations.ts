import type { InventoryMovement, Reservation, ReservationLine, SalesChannel, SerialUnit } from "@/generated/prisma/client";
import { assertTransactable } from "@/server/catalog/catalog";
import { writeAudit } from "@/server/core/audit";
import { requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import type { Tx } from "@/server/db";
import { readSettings } from "@/server/settings/settings";
import { checkRefs, dec, lockPositions, pickBins, postMovements, type Dec, type DecValue, type Leg } from "./post";
import { perBin, takeSerials } from "./serials";

// Reservations (doc 12). Lock order everywhere: reservation row → allocation rows → bin rows.

const MAX_TTL_SECONDS = 30 * 24 * 3600;

type WithLines = Reservation & { lines: ReservationLine[] };

// Batches with expiry_date <= today (UTC, server clock — edge #29) are expired.
export const utcToday = (now = new Date()) => new Date(now.toISOString().slice(0, 10));

export type ReserveInput = {
  variantId: string;
  warehouseId: string;
  qty: DecValue;
  batchId?: string;
  allowPartial?: boolean;
  allowSubstitution?: boolean;
  ttlSeconds?: number;
  externalOrderId?: string; // SO-07: groups reservations under one sales_order_ref
  channel?: SalesChannel; // ignored for API keys: ctx.salesChannel wins (SO-06)
  serials?: string[]; // POS sale of serialized items: the units sold
};

export async function reserve(tx: Tx, ctx: Ctx, input: ReserveInput) {
  await requirePermission(ctx, "sales.reserve", { warehouseId: input.warehouseId });
  const qty = dec(input.qty);
  if (!qty.gt(0)) throw new AppError("validation_error", "qty must be > 0");
  const channel = ctx.salesChannel ?? input.channel; // none: company default TTL, order filed under pos
  const settings = await readSettings(tx, ctx.companyId);
  const ttl = input.ttlSeconds ?? (channel && settings.channelTtlSeconds[channel]) ?? settings.reservationTtlSeconds; // SO-08
  if (ttl < 60 || ttl > MAX_TTL_SECONDS) throw new AppError("validation_error", "ttlSeconds out of range");

  const [variant, warehouse] = await Promise.all([
    tx.productVariant.findFirst({ where: { id: input.variantId, companyId: ctx.companyId }, include: { product: true } }),
    tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: ctx.companyId } }),
  ]);
  if (!variant || !warehouse) throw new AppError("not_found", "Variant or warehouse not found");
  // INV-019, P-CAT-06/07/09
  if (warehouse.status !== "active") throw new AppError("archived_conflict", "Warehouse is not active");
  assertTransactable(variant);
  const serialized = variant.product.isSerialized;
  if (serialized && !qty.isInteger()) throw new AppError("validation_error", "Serialized items are reserved in whole units");

  // Candidate positions, FEFO (expiry ASC, then batch_no); expired batches are unreservable (B-04).
  let candidates: (string | null)[] = [null];
  if (variant.product.requiresBatch) {
    const today = utcToday();
    const batches = await tx.batch.findMany({
      where: {
        companyId: ctx.companyId, variantId: variant.id,
        stockAllocations: { some: { warehouseId: warehouse.id } },
        OR: [{ expiryDate: null }, { expiryDate: { gt: today } }],
      },
      orderBy: [{ expiryDate: { sort: "asc", nulls: "last" } }, { batchNo: "asc" }],
    });
    candidates = batches.map((b) => b.id);
    if (input.batchId) {
      if (!candidates.includes(input.batchId)) throw new AppError("batch_insufficient", "Batch has no reservable stock", { batchId: input.batchId });
      candidates = [input.batchId, ...(input.allowSubstitution ? candidates.filter((c) => c !== input.batchId) : [])];
    }
  } else if (input.batchId) {
    throw new AppError("validation_error", "Product is not batch-tracked");
  }
  if (candidates.length === 0) throw new AppError("insufficient_stock", "Not enough available stock", { available: "0" });

  // T10.2: everything that doesn't need the position lock happens before it, so the
  // same-SKU queue moves faster (refs + warehouse share lock, as postMovements would).
  const order = input.externalOrderId ? await orderRef(tx, ctx, channel ?? "pos", input.externalOrderId) : null;
  await checkRefs(tx, ctx, candidates.map((b) => ({ variantId: variant.id, warehouseId: warehouse.id, binId: null, batchId: b })));
  const pos = await lockPositions(tx, ctx, candidates.map((b) => [variant.id, warehouse.id, b] as const));
  const ordered = candidates.map((b) => [...pos.values()].find((p) => p.batchId === b)!);
  const available = ordered.reduce((s, p) => s.plus(p.onHand.minus(p.reserved)), dec(0));

  if (input.batchId && !input.allowSubstitution && available.lt(qty)) {
    throw new AppError("batch_insufficient", "Requested batch can't cover the quantity", { batchId: input.batchId, available: available.toString() });
  }
  if (available.lt(qty) && !(input.allowPartial && available.gt(0))) {
    throw new AppError("insufficient_stock", "Not enough available stock", { available: available.toString(), requested: qty.toString() });
  }
  const take = available.lt(qty) ? available : qty;

  // Pin FEFO.
  const lines: { batchId: string | null; qty: Dec }[] = [];
  let left = take;
  for (const p of ordered) {
    if (!left.gt(0)) break;
    const n = Dec_min(p.onHand.minus(p.reserved), left);
    if (n.gt(0)) lines.push({ batchId: p.batchId, qty: n });
    left = left.minus(n);
  }

  // Two statements instead of a nested create (+2 reads) while the lock is held.
  const header = await tx.reservation.create({
    data: {
      companyId: ctx.companyId, variantId: variant.id, warehouseId: warehouse.id,
      qty: take.toFixed(4), expiresAt: new Date(Date.now() + ttl * 1000), ttlSeconds: ttl,
      salesOrderRefId: order?.id ?? null, createdBy: ctx.userId,
    },
  });
  const reservation = {
    ...header,
    lines: await tx.reservationLine.createManyAndReturn({
      data: lines.map((l) => ({ reservationId: header.id, batchId: l.batchId, qty: l.qty.toFixed(4) })),
    }),
  };
  const posted = await postMovements(tx, ctx, {
    sourceType: "reservation", sourceId: reservation.id, action: "reserve", prelocked: pos,
    legs: reservation.lines.map((l, i) => ({
      type: "reservation", variantId: variant.id, warehouseId: warehouse.id, batchId: l.batchId,
      delta: { reserved: l.qty }, line: i + 1, reasonCode: "reserve",
    })),
  });
  const audit = await writeAudit(tx, ctx, {
    action: "create", entityType: "reservation", entityId: reservation.id, warehouseId: warehouse.id, after: reservation,
  });
  return {
    reservation,
    requested: qty.toString(),
    remainder: qty.minus(take).toString(), // > 0 only with allowPartial
    ...ledger(posted.movements),
    auditId: audit.id,
  };
}

const Dec_min = (a: Dec, b: Dec) => (a.lt(b) ? a : b);

// SO-07: one row per (company, channel, external order id); concurrent first reserves race safely.
async function orderRef(tx: Tx, ctx: Ctx, channel: SalesChannel, externalOrderId: string) {
  await tx.salesOrderRef.createMany({
    data: [{ companyId: ctx.companyId, channel, externalOrderId, createdBy: ctx.userId }], skipDuplicates: true,
  });
  return tx.salesOrderRef.findUniqueOrThrow({
    where: { companyId_channel_externalOrderId: { companyId: ctx.companyId, channel, externalOrderId } },
  });
}

// SO-09: POS immediate sale — reserve + fulfil the whole qty in one transaction.
export async function posSale(tx: Tx, ctx: Ctx, input: Omit<ReserveInput, "allowPartial" | "ttlSeconds">) {
  await requirePermission(ctx, "sales.fulfil", { warehouseId: input.warehouseId });
  const r = await reserve(tx, ctx, { ...input, allowPartial: false });
  const f = await fulfil(tx, ctx, { reservationId: r.reservation.id, version: r.reservation.version, serials: input.serials });
  return { reservation: f.reservation, movementIds: [...r.movementIds, ...f.movementIds], balances: f.balances, auditId: f.auditId };
}

// SO-08: one extension, to now + the reservation's TTL (never shortens).
export async function extend(tx: Tx, ctx: Ctx, input: { reservationId: string; version: number }) {
  const r = await lockReservation(tx, ctx, input.reservationId, input.version, "sales.reserve");
  const now = new Date();
  if (r.expiresAt <= now) throw new AppError("reservation_expired", "Reservation has expired", { id: r.id });
  if (r.extendedAt) throw new AppError("invalid_transition", "Reservation was already extended once", { id: r.id });
  const reservation = await tx.reservation.update({
    where: { id: r.id },
    data: {
      expiresAt: new Date(Math.max(r.expiresAt.getTime(), now.getTime() + r.ttlSeconds * 1000)),
      extendedAt: now, version: { increment: 1 },
    },
    include: { lines: true },
  });
  const audit = await writeAudit(tx, ctx, {
    action: "extend", entityType: "reservation", entityId: r.id, warehouseId: r.warehouseId,
    before: { expiresAt: r.expiresAt, version: r.version }, after: { expiresAt: reservation.expiresAt, version: reservation.version },
  });
  return { reservation, auditId: audit.id };
}

// SO-07: cancel every open reservation of an order (e.g. reason `payment_failed`).
export async function cancelOrder(tx: Tx, ctx: Ctx, input: { orderId: string; reason?: string }) {
  const order = await tx.salesOrderRef.findFirst({ where: { id: input.orderId, companyId: ctx.companyId } });
  if (!order) throw new AppError("not_found", "Order not found");
  const open = await tx.reservation.findMany({
    where: { salesOrderRefId: order.id, status: { in: ["active", "partially_fulfilled"] } },
    orderBy: { id: "asc" }, select: { id: true },
  });
  const done = [];
  for (const { id } of open) {
    const r = await lockOpen(tx, ctx, id, "sales.cancel");
    if (r) done.push(await releaseOpen(tx, ctx, r, undefined, "cancel", input.reason ?? "cancel"));
  }
  if (done.length === 0) throw new AppError("invalid_transition", "Order has no open reservations", { id: order.id });
  return {
    order, reservations: done.map((d) => d.reservation),
    movementIds: done.flatMap((d) => d.movementIds), balances: done.flatMap((d) => d.balances),
  };
}

// lockReservation for jobs/bulk paths: null when the reservation is no longer open.
async function lockOpen(tx: Tx, ctx: Ctx, id: string, permission: string) {
  try {
    return await lockReservation(tx, ctx, id, undefined, permission);
  } catch (e) {
    if (e instanceof AppError && (e.code === "invalid_transition" || e.code === "reservation_expired")) return null;
    throw e;
  }
}

// Locks the reservation row (first in the lock order) and checks state + version.
async function lockReservation(tx: Tx, ctx: Ctx, id: string, version: number | undefined, permission: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM reservation WHERE id = ${id} AND company_id = ${ctx.companyId} FOR UPDATE`;
  if (rows.length === 0) throw new AppError("not_found", "Reservation not found");
  const r = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { id: "asc" } } } });
  await requirePermission(ctx, permission, { warehouseId: r.warehouseId });
  if (r.status === "expired") throw new AppError("reservation_expired", "Reservation has expired", { id });
  if (r.status !== "active" && r.status !== "partially_fulfilled") {
    throw new AppError("invalid_transition", `Reservation is ${r.status}`, { id, status: r.status });
  }
  if (version !== undefined && version !== r.version) {
    throw new AppError("version_conflict", "Reservation was changed by someone else", { id, version: r.version });
  }
  return r;
}

const remaining = (l: { qty: DecValue; qtyFulfilled: DecValue; qtyReleased: DecValue }) =>
  dec(l.qty).minus(dec(l.qtyFulfilled)).minus(dec(l.qtyReleased));

// Fulfil (ship): on_hand −n at FEFO-picked bins AND reserved −n, one transaction.
export async function fulfil(
  tx: Tx,
  ctx: Ctx,
  input: { reservationId: string; version: number; qty?: DecValue; serials?: string[] },
) {
  const r = await lockReservation(tx, ctx, input.reservationId, input.version, "sales.fulfil");
  const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: r.variantId }, include: { product: true } });
  if (r.expiresAt <= new Date()) throw new AppError("reservation_expired", "Reservation has expired", { id: r.id });
  const open = remaining(r);
  const qty = input.qty === undefined ? open : dec(input.qty);
  if (!qty.gt(0) || qty.gt(open)) throw new AppError("validation_error", "qty must be > 0 and ≤ the open quantity", { open: open.toString() });

  // Lines are already FEFO-ordered by batch expiry at reserve time; keep that order.
  // SO-10: lines on an expired batch are never picked (the nightly sweep releases them).
  const today = utcToday();
  const lines = (await fefoLines(tx, r.lines)).filter((l) => !l.expiry || l.expiry > today);
  const live = lines.reduce((s, l) => s.plus(remaining(l)), dec(0));
  if (qty.gt(live)) {
    throw new AppError("reservation_expired", "Part of this reservation is on an expired batch", { id: r.id, fulfillable: live.toString() });
  }
  await lockPositions(tx, ctx, lines.map((l) => [r.variantId, r.warehouseId, l.batchId] as const));

  const legs: Leg[] = [];
  const lineTake = new Map<string, Dec>();
  const push = (line: { batchId: string | null }, binId: string, n: Dec, serialized?: true) =>
    legs.push({
      type: "sale_fulfilment", variantId: r.variantId, warehouseId: r.warehouseId, binId,
      batchId: line.batchId, delta: { onHand: n.neg(), reserved: n.neg() },
      line: legs.length + 1, reasonCode: "fulfil", ...(serialized ? { serialized } : {}),
    });
  let units: SerialUnit[] = [];
  if (variant.product.isSerialized) {
    // S-02: the shipped units are named; each must sit on an open line of its batch.
    units = await takeSerials(tx, ctx, {
      sku: variant.sku, variantId: r.variantId, warehouseId: r.warehouseId, batchId: undefined, qty, serials: input.serials, status: ["in_stock"],
    });
    for (const [batchId, group] of Map.groupBy(units, (u) => u.batchId)) {
      let need = dec(group.length);
      for (const line of lines.filter((l) => l.batchId === batchId)) {
        const n = Dec_min(remaining(line).minus(lineTake.get(line.id) ?? 0), need);
        if (n.gt(0)) lineTake.set(line.id, (lineTake.get(line.id) ?? dec(0)).plus(n));
        need = need.minus(n);
      }
      if (need.gt(0)) throw new AppError("validation_error", `${variant.sku}: serial(s) are not from the reserved batch`, { field: "serials" });
      for (const b of perBin(group)) push({ batchId }, b.binId, dec(b.qty), true);
    }
  } else {
    if (input.serials?.length) throw new AppError("validation_error", `${variant.sku} is not serialized`, { field: "serials" });
    let left = qty;
    for (const line of lines) {
      if (!left.gt(0)) break;
      const n = Dec_min(remaining(line), left);
      if (!n.gt(0)) continue;
      lineTake.set(line.id, n);
      left = left.minus(n);
      for (const b of await pickBins(tx, ctx, { variantId: r.variantId, warehouseId: r.warehouseId, batchId: line.batchId, qty: n })) push(line, b.binId, b.qty);
    }
  }

  // Each fulfil of a given version is a distinct source; a replay of the same version is a version_conflict above.
  const posted = await postMovements(tx, ctx, {
    sourceType: "fulfilment", sourceId: `${r.id}:v${r.version}`, action: "fulfil", legs,
  });
  for (const [id, n] of lineTake) {
    const l = r.lines.find((x) => x.id === id)!;
    await tx.reservationLine.update({ where: { id }, data: { qtyFulfilled: dec(l.qtyFulfilled).plus(n).toFixed(4) } });
  }
  if (units.length) {
    await tx.serialUnit.updateMany({ where: { id: { in: units.map((u) => u.id) } }, data: { status: "sold", reservationId: r.id, version: { increment: 1 } } });
  }
  return finish(tx, ctx, r, { fulfilled: qty }, "fulfil", posted.movements);
}

// Release part (or all) of the unfulfilled remainder; status unchanged unless nothing stays open.
export async function release(
  tx: Tx,
  ctx: Ctx,
  input: { reservationId: string; version: number; qty?: DecValue; reason?: string },
) {
  const r = await lockReservation(tx, ctx, input.reservationId, input.version, "sales.cancel");
  return releaseOpen(tx, ctx, r, input.qty === undefined ? undefined : dec(input.qty), "release", input.reason ?? "release");
}

// SO-04: cancel releases only the unfulfilled remainder.
export async function cancel(
  tx: Tx,
  ctx: Ctx,
  input: { reservationId: string; version: number; reason?: string },
) {
  const r = await lockReservation(tx, ctx, input.reservationId, input.version, "sales.cancel");
  return releaseOpen(tx, ctx, r, undefined, "cancel", input.reason ?? "cancel");
}

// Called by the TTL job with the system ctx. `asOf` = the job's sweep time.
// Returns null when the reservation is not due or no longer open (fulfil won).
export async function expireReservation(tx: Tx, ctx: Ctx, input: { reservationId: string; asOf?: Date }) {
  const r = await lockOpen(tx, ctx, input.reservationId, "sales.cancel");
  if (!r || r.expiresAt > (input.asOf ?? new Date())) return null;
  return releaseOpen(tx, ctx, r, undefined, "expire", "expired");
}

// B-05 step 1 / SO-10: release only the open lines pinned to an expired batch.
// Null when nothing on that batch is still open (re-run safe).
export async function expireBatchLines(tx: Tx, ctx: Ctx, input: { reservationId: string; batchId: string }) {
  const r = await lockOpen(tx, ctx, input.reservationId, "sales.cancel");
  if (!r) return null;
  const open = r.lines.filter((l) => l.batchId === input.batchId).reduce((s, l) => s.plus(remaining(l)), dec(0));
  if (!open.gt(0)) return null;
  return releaseOpen(tx, ctx, r, open, "batch_expire", "batch_expired", input.batchId);
}

async function releaseOpen(
  tx: Tx, ctx: Ctx, r: WithLines, qty: Dec | undefined,
  action: "release" | "cancel" | "expire" | "batch_expire", reason: string, onlyBatchId?: string,
) {
  const open = remaining(r);
  const want = qty ?? open;
  if (!want.gt(0) || want.gt(open)) throw new AppError("validation_error", "qty must be > 0 and ≤ the open quantity", { open: open.toString() });

  // Release latest-expiry lines first, so the FEFO-earliest pins stay reserved.
  const lines = (await fefoLines(tx, r.lines)).reverse().filter((l) => onlyBatchId === undefined || l.batchId === onlyBatchId);
  const legs: Leg[] = [];
  let left = want;
  for (const line of lines) {
    const n = Dec_min(remaining(line), left);
    if (!n.gt(0)) continue;
    left = left.minus(n);
    legs.push({
      type: "reservation_release", variantId: r.variantId, warehouseId: r.warehouseId, batchId: line.batchId,
      delta: { reserved: n.neg() }, line: legs.length + 1, reasonCode: reason,
    });
    await tx.reservationLine.update({ where: { id: line.id }, data: { qtyReleased: dec(line.qtyReleased).plus(n).toFixed(4) } });
  }
  const posted = await postMovements(tx, ctx, {
    sourceType: "reservation_release", sourceId: `${r.id}:v${r.version}`, action, legs,
  });
  return finish(tx, ctx, r, { released: want }, action, posted.movements);
}

async function finish(
  tx: Tx, ctx: Ctx, r: WithLines, d: { fulfilled?: Dec; released?: Dec }, action: string, movements: InventoryMovement[],
) {
  const qtyFulfilled = dec(r.qtyFulfilled).plus(d.fulfilled ?? 0);
  const qtyReleased = dec(r.qtyReleased).plus(d.released ?? 0);
  const open = dec(r.qty).minus(qtyFulfilled).minus(qtyReleased);
  const status =
    action === "expire" ? "expired"
    : action === "cancel" ? "cancelled"
    : open.gt(0) ? (qtyFulfilled.gt(0) ? "partially_fulfilled" : "active")
    : action === "batch_expire" ? "expired"
    : qtyFulfilled.gt(0) ? "fulfilled" : "cancelled";
  const reservation = await tx.reservation.update({
    where: { id: r.id },
    data: { qtyFulfilled: qtyFulfilled.toFixed(4), qtyReleased: qtyReleased.toFixed(4), status, version: { increment: 1 } },
    include: { lines: true },
  });
  const audit = await writeAudit(tx, ctx, {
    action, entityType: "reservation", entityId: r.id, warehouseId: r.warehouseId,
    before: { ...r, lines: undefined }, after: { ...reservation, lines: undefined },
  });
  return { reservation, ...ledger(movements), auditId: audit.id };
}

// Lines ordered by batch expiry ASC (nulls last), then batch_no — FEFO (B-03) — with the batch expiry.
async function fefoLines(tx: Tx, lines: ReservationLine[]) {
  const ids = lines.map((l) => l.batchId).filter((b): b is string => !!b);
  if (ids.length === 0) return lines.map((l) => ({ ...l, expiry: null }));
  const batches = new Map((await tx.batch.findMany({ where: { id: { in: ids } } })).map((b) => [b.id, b]));
  const k = (l: ReservationLine) => batches.get(l.batchId!)!;
  return [...lines].sort((a, b) =>
    (k(a).expiryDate?.getTime() ?? Infinity) - (k(b).expiryDate?.getTime() ?? Infinity) ||
    k(a).batchNo.localeCompare(k(b).batchNo)).map((l) => ({ ...l, expiry: k(l).expiryDate }));
}

// Mutating responses carry movement ids + resulting balances (doc 24).
const ledger = (movements: InventoryMovement[]) => ({
  movementIds: movements.map((m) => m.id),
  balances: movements.map((m) => ({
    variantId: m.variantId, warehouseId: m.warehouseId, binId: m.binId, batchId: m.batchId,
    onHandAfter: m.onHandAfter, reservedAfter: m.reservedAfter,
  })),
});
