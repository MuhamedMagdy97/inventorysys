import { writeAudit } from "@/server/core/audit";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction } from "@/server/db";
import { notify } from "@/server/notifications/notify";
import { dec, lockPositions, postMovements, type Leg } from "./post";
import { reconcile } from "./reconcile";
import { expireBatchLines, expireReservation, utcToday } from "./reservations";

// Background jobs (SO-11), run by src/worker. Each item (reservation / batch) is its own
// transaction and re-checks its state under lock, so a run killed at any point leaves
// whole items done or untouched, and the next run finishes the rest. `companyId` narrows
// a run to one tenant (tests); the worker runs all companies.

const JOB_GRANTS: ReadonlySet<string> = new Set(["sales.cancel", "inventory.view"]);

export async function systemCtx(companyId: string): Promise<Ctx> {
  const u = await db.user.findFirst({ where: { companyId, isSystem: true }, select: { id: true } });
  if (!u) throw new Error(`Company ${companyId} has no system user`);
  return { companyId, userId: u.id, warehouseIds: "all", permissions: JOB_GRANTS, requestId: crypto.randomUUID(), channel: "system" };
}

type RunOpts = { asOf?: Date; companyId?: string; limit?: number };

// One failing item must not block the rest of the run; it is retried next run.
async function each<T>(items: T[], fn: (item: T) => Promise<boolean>) {
  let done = 0, failed = 0;
  for (const item of items) {
    try {
      if (await fn(item)) done++;
    } catch (e) {
      failed++;
      console.error("job item failed", item, e);
    }
  }
  return { done, failed };
}

// Doc 12 §3 Expiry: release reservations past their TTL (every minute).
export async function expireDueReservations(opts: RunOpts = {}) {
  const asOf = opts.asOf ?? new Date();
  const due = await db.reservation.findMany({
    where: { companyId: opts.companyId, status: { in: ["active", "partially_fulfilled"] }, expiresAt: { lte: asOf } },
    orderBy: { expiresAt: "asc" }, take: opts.limit ?? 1000, select: { id: true, companyId: true },
  });
  return each(due, async (r) => {
    const ctx = await systemCtx(r.companyId);
    return transaction(async (tx) => {
      const res = await expireReservation(tx, ctx, { reservationId: r.id, asOf });
      if (!res) return false; // fulfilled / cancelled meanwhile, or extended
      await notify(tx, ctx, {
        type: "reservation.expired", entityType: "reservation", entityId: r.id, userId: res.reservation.createdBy,
        warehouseId: res.reservation.warehouseId, message: `Reservation expired; ${res.reservation.qtyReleased.toString()} released`,
        link: `/sales-orders?reservation=${r.id}`,
      });
      return true;
    });
  });
}

// B-05, nightly, one transaction per expired batch: (1) release reservation lines pinned to
// it, (2) move the remaining on_hand to `expired` in place. Serialized batches are skipped.
// ponytail: serialized expiry + open transfers carrying the batch (edge #34) come with Part 6.
export async function sweepExpiredBatches(opts: RunOpts = {}) {
  const today = utcToday(opts.asOf);
  const batches = await db.$queryRaw<{ id: string; company_id: string }[]>`
    SELECT b.id, b.company_id FROM batch b
      JOIN product_variant v ON v.id = b.variant_id JOIN product p ON p.id = v.product_id
    WHERE b.expiry_date <= ${today} AND NOT p.is_serialized
      AND (${opts.companyId ?? null}::text IS NULL OR b.company_id = ${opts.companyId ?? null})
      AND (EXISTS (SELECT 1 FROM stock_balance s WHERE s.batch_id = b.id AND s.on_hand > 0)
        OR EXISTS (SELECT 1 FROM reservation_line l JOIN reservation r ON r.id = l.reservation_id
                   WHERE l.batch_id = b.id AND r.status IN ('active', 'partially_fulfilled')
                     AND l.qty - l.qty_fulfilled - l.qty_released > 0))
    ORDER BY b.expiry_date, b.id
    LIMIT ${opts.limit ?? 1000}`;
  return each(batches, async (b) => {
    const ctx = await systemCtx(b.company_id);
    return transaction(async (tx) => {
      const batch = await tx.batch.findUniqueOrThrow({ where: { id: b.id } });
      // (1) Reservations first (lock order: reservation → allocation → bins).
      const lines = await tx.reservationLine.findMany({
        where: { batchId: batch.id, reservation: { status: { in: ["active", "partially_fulfilled"] } } },
        distinct: ["reservationId"], orderBy: { reservationId: "asc" }, select: { reservationId: true },
      });
      for (const { reservationId } of lines) {
        const res = await expireBatchLines(tx, ctx, { reservationId, batchId: batch.id });
        if (res) {
          await notify(tx, ctx, {
            type: "reservation.batch_expired", entityType: "reservation", entityId: reservationId, userId: res.reservation.createdBy,
            warehouseId: res.reservation.warehouseId, message: `Batch ${batch.batchNo} expired; its reserved units were released`,
            link: `/sales-orders?reservation=${reservationId}`,
          });
        }
      }
      // (2) Lock the positions, then read on_hand under the lock (no posting can slip in).
      const where = { batchId: batch.id, onHand: { gt: 0 } };
      const positions = await tx.stockBalance.findMany({ where, distinct: ["warehouseId"], select: { warehouseId: true } });
      if (positions.length === 0) return lines.length > 0;
      await lockPositions(tx, ctx, positions.map((p) => [batch.variantId, p.warehouseId, batch.id] as const));
      const rows = await tx.stockBalance.findMany({ where, orderBy: { binId: "asc" } });
      const legs: Leg[] = rows.map((s, i) => ({
        type: "expiry", variantId: s.variantId, warehouseId: s.warehouseId, binId: s.binId, batchId: batch.id,
        delta: { onHand: dec(s.onHand).neg(), expired: s.onHand }, line: i + 1, reasonCode: "batch_expired",
      }));
      await postMovements(tx, ctx, { sourceType: "batch_expiry", sourceId: `${batch.id}:${crypto.randomUUID()}`, action: "expire", legs });
      for (const warehouseId of new Set(rows.map((r) => r.warehouseId))) {
        const qty = rows.filter((r) => r.warehouseId === warehouseId).reduce((t, r) => t.plus(dec(r.onHand)), dec(0));
        await notify(tx, ctx, {
          type: "batch.expired", entityType: "batch", entityId: batch.id, warehouseId,
          message: `Batch ${batch.batchNo} expired: ${qty.toString()} moved to expired`,
        });
      }
      return true;
    });
  });
}

// Doc 07 §4 nightly reconciler: drift → audit `reconcile.drift` (actor = system) + alert.
export async function runReconciler(opts: Pick<RunOpts, "companyId"> = {}) {
  const companies = await db.company.findMany({ where: { id: opts.companyId }, select: { id: true } });
  const out: { companyId: string; drift: number }[] = [];
  for (const c of companies) {
    const ctx = await systemCtx(c.id);
    const drift = await reconcile(ctx);
    if (drift.length) {
      await transaction(async (tx) => {
        await writeAudit(tx, ctx, {
          action: "reconcile.drift", entityType: "company", entityId: c.id, after: drift.slice(0, 200), reason: `${drift.length} drift row(s)`,
        });
        await notify(tx, ctx, {
          type: "reconcile.drift", entityType: "company", entityId: c.id,
          message: `Ledger reconciler found ${drift.length} drift row(s)`, link: "/admin/audit",
        });
      });
    }
    out.push({ companyId: c.id, drift: drift.length });
  }
  return out;
}
