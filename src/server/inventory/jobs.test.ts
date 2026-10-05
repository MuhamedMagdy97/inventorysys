import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { buildCtx } from "@/server/auth/session-ctx";
import { createBatch, createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction } from "@/server/db";
import * as notifications from "@/server/notifications/notify";
import { seedCompany } from "@/server/seed";
import { getSalesOrder } from "@/server/sales/orders";
import { expireDueReservations, runReconciler, sweepExpiredBatches } from "./jobs";
import { postMovements } from "./post";
import { reconcile } from "./reconcile";
import { cancelOrder, extend, fulfil, posSale, reserve } from "./reservations";

// Part 5: jobs (TTL expiry, B-05 batch sweep, reconciler), extension, POS sale, order refs.
let w: Awaited<ReturnType<typeof seedCompany>>;
let main: string;
let n = 0;
const run = { companyId: "" };

const stock = (variantId: string, qty: number, batchId: string | null = null) =>
  transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "opening", sourceId: `ob-${++n}`,
    legs: [{ type: "opening_balance", variantId, warehouseId: w.warehouse.id, binId: main, batchId, delta: { onHand: qty }, unitCost: 2, line: 1, reasonCode: "opening" }],
  }));
const sum = async (variantId: string) => {
  const [b, a] = await Promise.all([
    db.stockBalance.aggregate({ where: { variantId }, _sum: { onHand: true, expired: true } }),
    db.stockAllocation.aggregate({ where: { variantId }, _sum: { qtyReserved: true } }),
  ]);
  return { onHand: b._sum.onHand!.toString(), expired: b._sum.expired!.toString(), reserved: a._sum.qtyReserved!.toString() };
};
const rsv = (input: Partial<Parameters<typeof reserve>[2]> & { qty: number | string }, ctx: Ctx = w.ctx) =>
  transaction((tx) => reserve(tx, ctx, { variantId: w.variants[0].id, warehouseId: w.warehouse.id, ...input }));
const past = (id: string) => db.reservation.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
const clean = async () => expect(await reconcile(w.ctx)).toEqual([]);

beforeAll(async () => {
  w = await seedCompany(`jobs-${crypto.randomUUID()}`);
  run.companyId = w.company.id;
  main = w.warehouse.bins.find((b) => b.code === "MAIN")!.id;
  await stock(w.variants[0].id, 100);
});
afterAll(() => db.$disconnect());

test("TTL job: releases due reservations + notifies the owner; killed mid-run → re-run finishes, nothing twice", async () => {
  const before = await sum(w.variants[0].id);
  const [a, b, c, keep] = [await rsv({ qty: 1 }), await rsv({ qty: 2 }), await rsv({ qty: 3 }), await rsv({ qty: 4 })];
  for (const r of [a, b, c]) await past(r.reservation.id);

  // Crash inside an item: its transaction rolls back whole (release + notification).
  const spy = vi.spyOn(notifications, "notify").mockRejectedValueOnce(new Error("worker killed"));
  expect(await expireDueReservations({ ...run, limit: 1 })).toEqual({ done: 0, failed: 1 });
  spy.mockRestore();
  expect((await db.reservation.findUniqueOrThrow({ where: { id: a.reservation.id } })).status).toBe("active");

  // Crash between items: only the first one done.
  expect(await expireDueReservations({ ...run, limit: 1 })).toEqual({ done: 1, failed: 0 });
  // Re-run finishes the rest; a third run finds nothing.
  expect(await expireDueReservations(run)).toEqual({ done: 2, failed: 0 });
  expect(await expireDueReservations(run)).toEqual({ done: 0, failed: 0 });

  const st = await db.reservation.findMany({ where: { id: { in: [a, b, c, keep].map((r) => r.reservation.id) } }, orderBy: { id: "asc" } });
  expect(st.map((r) => r.status)).toEqual(["expired", "expired", "expired", "active"]);
  expect(await db.inventoryMovement.count({ where: { sourceType: "reservation_release", sourceId: { startsWith: a.reservation.id } } })).toBe(1);
  const notes = await db.notification.findMany({ where: { companyId: w.company.id, type: "reservation.expired" } });
  expect(notes.map((x) => x.userId)).toEqual([w.admin.id, w.admin.id, w.admin.id]);
  expect((await sum(w.variants[0].id)).reserved).toBe(String(Number(before.reserved) + 4));
  await clean();
});

test("expiry vs fulfil race: exactly one winner, never a half-post", async () => {
  for (let i = 0; i < 5; i++) {
    const { reservation } = await rsv({ qty: 1 });
    // The job sees it as due (asOf in the future); fulfil still sees it live.
    const [job, ship] = await Promise.allSettled([
      expireDueReservations({ ...run, asOf: new Date(Date.now() + 3600_000) }),
      transaction((tx) => fulfil(tx, w.ctx, { reservationId: reservation.id, version: 0 })),
    ]);
    const r = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    if (ship.status === "fulfilled") {
      expect(r.status).toBe("fulfilled");
    } else {
      expect(["reservation_expired", "version_conflict"]).toContain((ship.reason as { code: string }).code);
      expect(r.status).toBe("expired");
      expect(job).toMatchObject({ status: "fulfilled", value: { done: 1 } });
    }
    expect(await db.inventoryMovement.count({ where: { sourceId: { startsWith: reservation.id } } })).toBe(2); // reserve + one outcome
  }
  await clean();
});

test("B-05 sweep: releases lines on the expired batch, then on_hand → expired; fulfil skips it; re-run is a no-op", async () => {
  const p = await transaction((tx) => createProduct(tx, w.ctx, { name: "Milk", requiresBatch: true, requiresExpiry: true, variants: [{ sku: `MILK-${n}` }] }));
  const v = p.variants[0].id;
  const soon = await transaction((tx) => createBatch(tx, w.ctx, { variantId: v, batchNo: "SOON", expiryDate: new Date("2030-01-01") }));
  const later = await transaction((tx) => createBatch(tx, w.ctx, { variantId: v, batchNo: "LATER", expiryDate: new Date("2031-01-01") }));
  await stock(v, 5, soon.id);
  await stock(v, 5, later.id);
  const { reservation } = await rsv({ variantId: v, qty: 7 }); // FEFO: SOON 5 + LATER 2

  await db.batch.update({ where: { id: soon.id }, data: { expiryDate: new Date("2020-01-01") } }); // time passes
  await expect(transaction((tx) => fulfil(tx, w.ctx, { reservationId: reservation.id, version: 0 })))
    .rejects.toMatchObject({ code: "reservation_expired", details: { fulfillable: "2" } }); // edge #18
  const f = await transaction((tx) => fulfil(tx, w.ctx, { reservationId: reservation.id, version: 0, qty: 1 }));
  const moved = await db.inventoryMovement.findMany({ where: { id: { in: f.movementIds } } });
  expect(moved.map((m) => m.batchId)).toEqual([later.id]);

  expect(await sweepExpiredBatches(run)).toMatchObject({ done: 1, failed: 0 });
  const r = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { lines: true } });
  expect([r.status, r.qtyFulfilled.toString(), r.qtyReleased.toString()]).toEqual(["partially_fulfilled", "1", "5"]);
  expect(await sum(v)).toEqual({ onHand: "4", expired: "5", reserved: "1" });
  const expiry = await db.inventoryMovement.findMany({ where: { batchId: soon.id, type: "expiry" } });
  expect(expiry.map((m) => [m.dOnHand.toString(), m.dExpired.toString(), m.actorId])).toEqual([["-5", "5", w.system.id]]);
  const notes = await db.notification.findMany({ where: { companyId: w.company.id, type: { in: ["batch.expired", "reservation.batch_expired"] } } });
  expect(notes.map((x) => x.type).sort()).toEqual(["batch.expired", "reservation.batch_expired"]);

  expect(await sweepExpiredBatches(run)).toEqual({ done: 0, failed: 0 });
  await clean();
});

test("reconciler job: clean → nothing; drift → audit reconcile.drift + notification", async () => {
  expect(await runReconciler(run)).toEqual([{ companyId: w.company.id, drift: 0 }]);
  const row = await db.stockBalance.findFirstOrThrow({ where: { variantId: w.variants[0].id, binId: main } });
  await db.stockBalance.update({ where: { id: row.id }, data: { onHand: row.onHand.plus(1) } });
  try {
    expect(await runReconciler(run)).toEqual([{ companyId: w.company.id, drift: 1 }]); // the bin row no longer matches its movements
    const audit = await db.auditLog.findFirstOrThrow({ where: { companyId: w.company.id, action: "reconcile.drift" } });
    expect(audit.actorId).toBe(w.system.id);
    expect(await db.notification.count({ where: { companyId: w.company.id, type: "reconcile.drift" } })).toBe(1);
  } finally {
    await db.stockBalance.update({ where: { id: row.id }, data: { onHand: row.onHand } });
  }
  await clean();
});

test("extension: once, to now + the reservation's TTL", async () => {
  const { reservation } = await rsv({ qty: 1, ttlSeconds: 600 });
  await db.reservation.update({ where: { id: reservation.id }, data: { expiresAt: new Date(Date.now() + 60_000) } });
  const e = await transaction((tx) => extend(tx, w.ctx, { reservationId: reservation.id, version: 0 }));
  expect(Math.round((e.reservation.expiresAt.getTime() - Date.now()) / 1000)).toBeGreaterThan(590);
  await expect(transaction((tx) => extend(tx, w.ctx, { reservationId: reservation.id, version: 1 }))).rejects.toMatchObject({ code: "invalid_transition" });
  await past(reservation.id);
  await expect(transaction((tx) => extend(tx, w.ctx, { reservationId: reservation.id, version: 1 }))).rejects.toMatchObject({ code: "reservation_expired" });
});

test("POS sale: reserve + fulfil in one transaction; short stock posts nothing", async () => {
  await stock(w.variants[1].id, 3);
  const s = await transaction((tx) => posSale(tx, w.ctx, { variantId: w.variants[1].id, warehouseId: w.warehouse.id, qty: 2, externalOrderId: "TILL-1" }));
  expect([s.reservation.status, s.movementIds.length]).toEqual(["fulfilled", 2]);
  expect(await sum(w.variants[1].id)).toEqual({ onHand: "1", expired: "0", reserved: "0" });
  const count = await db.inventoryMovement.count({ where: { variantId: w.variants[1].id } });
  await expect(transaction((tx) => posSale(tx, w.ctx, { variantId: w.variants[1].id, warehouseId: w.warehouse.id, qty: 2 })))
    .rejects.toMatchObject({ code: "insufficient_stock" });
  expect(await db.inventoryMovement.count({ where: { variantId: w.variants[1].id } })).toBe(count);
});

test("order refs: channel from the key's service user + per-channel TTL; cancel order releases all", async () => {
  const svc = await db.user.create({
    data: { companyId: w.company.id, name: "web shop", email: `web+${crypto.randomUUID()}@test.invalid`, isService: true, salesChannel: "web" },
  });
  await db.userRole.create({ data: { companyId: w.company.id, userId: svc.id, roleId: w.roles.find((r) => r.code === "sales_staff")!.id } });
  await db.userWarehouse.create({ data: { companyId: w.company.id, userId: svc.id, warehouseId: w.warehouse.id } });
  const ctx = await buildCtx(svc.id, { requestId: crypto.randomUUID(), channel: "api" });
  expect(ctx.salesChannel).toBe("web");

  const a = await rsv({ qty: 1, externalOrderId: "W-1", channel: "pos" }, ctx); // body channel ignored
  const b = await rsv({ qty: 2, externalOrderId: "W-1", variantId: w.variants[0].id }, ctx);
  expect(a.reservation.salesOrderRefId).toBe(b.reservation.salesOrderRefId);
  const order = await db.salesOrderRef.findUniqueOrThrow({ where: { id: a.reservation.salesOrderRefId! } });
  expect(order.channel).toBe("web");
  expect(a.reservation.ttlSeconds).toBe(172800); // web has no entry → company default
  const pos = await rsv({ qty: 1, externalOrderId: "P-1", channel: "pos" });
  expect(pos.reservation.ttlSeconds).toBe(900);

  await transaction((tx) => fulfil(tx, ctx, { reservationId: a.reservation.id, version: 0 }));
  const c = await transaction((tx) => cancelOrder(tx, ctx, { orderId: order.id, reason: "payment_failed" }));
  expect(c.reservations.map((r) => r.status)).toEqual(["cancelled"]);
  expect((await getSalesOrder(ctx, order.id)).status).toBe("fulfilled");
  await expect(transaction((tx) => cancelOrder(tx, ctx, { orderId: order.id }))).rejects.toMatchObject({ code: "invalid_transition" });
  await clean();
});
