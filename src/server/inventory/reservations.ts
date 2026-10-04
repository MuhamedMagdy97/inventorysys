import type { InventoryMovement, Reservation, ReservationLine } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import { requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import type { Tx } from "@/server/db";
import { readSettings } from "@/server/settings/settings";
import { dec, lockPositions, postMovements, type Dec, type DecValue, type Leg } from "./post";

// Reservations (doc 12). Lock order everywhere: reservation row → allocation rows → bin rows.

const MAX_TTL_SECONDS = 30 * 24 * 3600;

type WithLines = Reservation & { lines: ReservationLine[] };

export async function reserve(
  tx: Tx,
  ctx: Ctx,
  input: {
    variantId: string;
    warehouseId: string;
    qty: DecValue;
    batchId?: string;
    allowPartial?: boolean;
    allowSubstitution?: boolean;
    ttlSeconds?: number;
    orderRef?: string;
  },
) {
  await requirePermission(ctx, "sales.reserve", { warehouseId: input.warehouseId });
  const qty = dec(input.qty);
  if (!qty.gt(0)) throw new AppError("validation_error", "qty must be > 0");
  // ponytail: one company-wide default TTL (settings); per-channel TTLs come with channels in Part 5.
  const ttl = input.ttlSeconds ?? (await readSettings(tx, ctx.companyId)).reservationTtlSeconds;
  if (ttl < 60 || ttl > MAX_TTL_SECONDS) throw new AppError("validation_error", "ttlSeconds out of range");

  const [variant, warehouse] = await Promise.all([
    tx.productVariant.findFirst({ where: { id: input.variantId, companyId: ctx.companyId }, include: { product: true } }),
    tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: ctx.companyId } }),
  ]);
  if (!variant || !warehouse) throw new AppError("not_found", "Variant or warehouse not found");
  // INV-019
  if (warehouse.status !== "active" || variant.status === "archived" || variant.product.status === "archived") {
    throw new AppError("archived_conflict", "Variant or warehouse is not active");
  }
  if (variant.status === "discontinued" || variant.product.status === "discontinued") {
    throw new AppError("discontinued_conflict", "Variant is discontinued");
  }

  // Candidate positions, FEFO (expiry ASC, then batch_no); expired batches are unreservable (B-04).
  let candidates: (string | null)[] = [null];
  if (variant.product.requiresBatch) {
    const today = new Date(new Date().toISOString().slice(0, 10));
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

  const reservation = await tx.reservation.create({
    data: {
      companyId: ctx.companyId, variantId: variant.id, warehouseId: warehouse.id,
      qty: take.toFixed(4), expiresAt: new Date(Date.now() + ttl * 1000),
      orderRef: input.orderRef ?? null, createdBy: ctx.userId,
      lines: { create: lines.map((l) => ({ batchId: l.batchId, qty: l.qty.toFixed(4) })) },
    },
    include: { lines: true },
  });
  const posted = await postMovements(tx, ctx, {
    sourceType: "reservation", sourceId: reservation.id, action: "reserve",
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
  input: { reservationId: string; version: number; qty?: DecValue },
) {
  const r = await lockReservation(tx, ctx, input.reservationId, input.version, "sales.fulfil");
  if (r.expiresAt <= new Date()) throw new AppError("reservation_expired", "Reservation has expired", { id: r.id });
  const open = remaining(r);
  const qty = input.qty === undefined ? open : dec(input.qty);
  if (!qty.gt(0) || qty.gt(open)) throw new AppError("validation_error", "qty must be > 0 and ≤ the open quantity", { open: open.toString() });

  // Lines are already FEFO-ordered by batch expiry at reserve time; keep that order.
  const lines = await fefoLines(tx, r.lines);
  await lockPositions(tx, ctx, lines.map((l) => [r.variantId, r.warehouseId, l.batchId] as const));

  const legs: Leg[] = [];
  const lineTake = new Map<string, Dec>();
  let left = qty;
  for (const line of lines) {
    if (!left.gt(0)) break;
    let n = Dec_min(remaining(line), left);
    if (!n.gt(0)) continue;
    lineTake.set(line.id, n);
    left = left.minus(n);
    // SO-05: pick bins — default sellable first, then sellable, then by code.
    const bins = await tx.stockBalance.findMany({
      where: { variantId: r.variantId, warehouseId: r.warehouseId, batchId: line.batchId, onHand: { gt: 0 } },
      include: { bin: true },
    });
    bins.sort((a, b) =>
      Number(b.bin.isDefaultSellable) - Number(a.bin.isDefaultSellable) ||
      Number(b.bin.type === "sellable") - Number(a.bin.type === "sellable") ||
      a.bin.code.localeCompare(b.bin.code));
    for (const b of bins) {
      if (!n.gt(0)) break;
      const pick = Dec_min(dec(b.onHand), n);
      legs.push({
        type: "sale_fulfilment", variantId: r.variantId, warehouseId: r.warehouseId, binId: b.binId,
        batchId: line.batchId, delta: { onHand: pick.neg(), reserved: pick.neg() },
        line: legs.length + 1, reasonCode: "fulfil",
      });
      n = n.minus(pick);
    }
    if (n.gt(0)) throw new AppError("insufficient_stock", "Reserved stock is not physically in any bin", { batchId: line.batchId });
  }

  // Each fulfil of a given version is a distinct source; a replay of the same version is a version_conflict above.
  const posted = await postMovements(tx, ctx, {
    sourceType: "fulfilment", sourceId: `${r.id}:v${r.version}`, action: "fulfil", legs,
  });
  for (const [id, n] of lineTake) {
    const l = r.lines.find((x) => x.id === id)!;
    await tx.reservationLine.update({ where: { id }, data: { qtyFulfilled: dec(l.qtyFulfilled).plus(n).toFixed(4) } });
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

// Called by the TTL job (Part 5) with the system ctx. `asOf` = the job's sweep time.
// Returns null when the reservation is not due or no longer open (fulfil won).
export async function expireReservation(tx: Tx, ctx: Ctx, input: { reservationId: string; asOf?: Date }) {
  let r: WithLines;
  try {
    r = await lockReservation(tx, ctx, input.reservationId, undefined, "sales.cancel");
  } catch (e) {
    if (e instanceof AppError && (e.code === "invalid_transition" || e.code === "reservation_expired")) return null;
    throw e;
  }
  if (r.expiresAt > (input.asOf ?? new Date())) return null;
  return releaseOpen(tx, ctx, r, undefined, "expire", "expired");
}

async function releaseOpen(tx: Tx, ctx: Ctx, r: WithLines, qty: Dec | undefined, action: "release" | "cancel" | "expire", reason: string) {
  const open = remaining(r);
  const want = qty ?? open;
  if (!want.gt(0) || want.gt(open)) throw new AppError("validation_error", "qty must be > 0 and ≤ the open quantity", { open: open.toString() });

  // Release latest-expiry lines first, so the FEFO-earliest pins stay reserved.
  const lines = (await fefoLines(tx, r.lines)).reverse();
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

// Lines ordered by batch expiry ASC (nulls last), then batch_no — FEFO (B-03).
async function fefoLines(tx: Tx, lines: ReservationLine[]) {
  const ids = lines.map((l) => l.batchId).filter((b): b is string => !!b);
  if (ids.length === 0) return lines;
  const batches = new Map((await tx.batch.findMany({ where: { id: { in: ids } } })).map((b) => [b.id, b]));
  const k = (l: ReservationLine) => batches.get(l.batchId!)!;
  return [...lines].sort((a, b) =>
    (k(a).expiryDate?.getTime() ?? Infinity) - (k(b).expiryDate?.getTime() ?? Infinity) ||
    k(a).batchNo.localeCompare(k(b).batchNo));
}

// Mutating responses carry movement ids + resulting balances (doc 24).
const ledger = (movements: InventoryMovement[]) => ({
  movementIds: movements.map((m) => m.id),
  balances: movements.map((m) => ({
    variantId: m.variantId, warehouseId: m.warehouseId, binId: m.binId, batchId: m.batchId,
    onHandAfter: m.onHandAfter, reservedAfter: m.reservedAfter,
  })),
});
