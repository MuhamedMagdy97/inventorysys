import { afterAll, beforeAll, expect, test } from "vitest";
import { createBatch, createProduct } from "@/server/catalog/catalog";
import { execute } from "@/server/core/execute";
import { db, transaction } from "@/server/db";
import { seedCompany } from "@/server/seed";
import { postMovements } from "./post";
import { cancel, expireReservation, fulfil, release, reserve } from "./reservations";

let w: Awaited<ReturnType<typeof seedCompany>>;
let main: string;
let n = 0;

const stock = (variantId: string, qty: number, batchId: string | null = null, binId = main) =>
  transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "opening", sourceId: `ob-${++n}`,
    legs: [{ type: "opening_balance", variantId, warehouseId: w.warehouse.id, binId, batchId, delta: { onHand: qty }, unitCost: 2, line: 1, reasonCode: "opening" }],
  }));
const reserved = async (variantId: string) =>
  (await db.stockAllocation.aggregate({ where: { variantId }, _sum: { qtyReserved: true } }))._sum.qtyReserved!.toString();
const onHand = async (variantId: string) =>
  (await db.stockBalance.aggregate({ where: { variantId }, _sum: { onHand: true } }))._sum.onHand!.toString();
const rsv = (input: Partial<Parameters<typeof reserve>[2]> & { qty: number | string }) =>
  transaction((tx) => reserve(tx, w.ctx, { variantId: w.variants[0].id, warehouseId: w.warehouse.id, ...input }));

beforeAll(async () => {
  w = await seedCompany(`rsv-${crypto.randomUUID()}`);
  main = w.warehouse.bins.find((b) => b.code === "MAIN")!.id;
  await stock(w.variants[0].id, 10);
});
afterAll(() => db.$disconnect());

test("reserve checks ATP; allow_partial reserves what is available", async () => {
  const r = await rsv({ qty: 4 });
  expect(r.reservation.status).toBe("active");
  await expect(rsv({ qty: 7 })).rejects.toMatchObject({ code: "insufficient_stock", details: { available: "6" } });
  const p = await rsv({ qty: 7, allowPartial: true });
  expect([p.reservation.qty.toString(), p.remainder]).toEqual(["6", "1"]);
  expect(await reserved(w.variants[0].id)).toBe("10");
  // free them up again
  for (const x of [r, p]) await transaction((tx) => cancel(tx, w.ctx, { reservationId: x.reservation.id, version: 0 }));
  expect(await reserved(w.variants[0].id)).toBe("0");
});

test("partial fulfil + remainder release", async () => {
  const { reservation } = await rsv({ qty: 5 });
  const f = await transaction((tx) => fulfil(tx, w.ctx, { reservationId: reservation.id, version: 0, qty: 2 }));
  expect(f.reservation.status).toBe("partially_fulfilled");
  expect([await onHand(w.variants[0].id), await reserved(w.variants[0].id)]).toEqual(["8", "3"]);
  const r = await transaction((tx) => release(tx, w.ctx, { reservationId: reservation.id, version: 1 }));
  expect(r.reservation.status).toBe("fulfilled");
  expect([r.reservation.qtyFulfilled.toString(), r.reservation.qtyReleased.toString()]).toEqual(["2", "3"]);
  expect(await reserved(w.variants[0].id)).toBe("0");
  // terminal now
  await expect(transaction((tx) => fulfil(tx, w.ctx, { reservationId: reservation.id, version: 2 }))).rejects.toMatchObject({ code: "invalid_transition" });
});

test("stale version → version_conflict, audited as transition.denied via execute", async () => {
  const { reservation } = await rsv({ qty: 1 });
  await transaction((tx) => fulfil(tx, w.ctx, { reservationId: reservation.id, version: 0, qty: "0.5" }));
  await expect(execute(w.ctx, { scope: "fulfil", entity: { type: "reservation", id: reservation.id } },
    (tx) => fulfil(tx, w.ctx, { reservationId: reservation.id, version: 0, qty: "0.5" }))).rejects.toMatchObject({ code: "version_conflict" });
  expect(await db.auditLog.count({ where: { entityId: reservation.id, action: "transition.denied" } })).toBe(1);
  // SO-04: cancel after partial fulfil releases only the remainder
  const c = await transaction((tx) => cancel(tx, w.ctx, { reservationId: reservation.id, version: 1 }));
  expect([c.reservation.status, c.reservation.qtyFulfilled.toString(), c.reservation.qtyReleased.toString()]).toEqual(["cancelled", "0.5", "0.5"]);
});

test("expired reservations release on expiry and can't be fulfilled", async () => {
  const { reservation } = await rsv({ qty: 2 });
  expect(await transaction((tx) => expireReservation(tx, w.ctx, { reservationId: reservation.id }))).toBeNull(); // not due
  await db.reservation.update({ where: { id: reservation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await expect(transaction((tx) => fulfil(tx, w.ctx, { reservationId: reservation.id, version: 0 }))).rejects.toMatchObject({ code: "reservation_expired" });
  const e = await transaction((tx) => expireReservation(tx, w.ctx, { reservationId: reservation.id }));
  expect(e?.reservation.status).toBe("expired");
  await expect(transaction((tx) => fulfil(tx, w.ctx, { reservationId: reservation.id, version: 1 }))).rejects.toMatchObject({ code: "reservation_expired" });
});

test("FEFO batch pinning, expired batches skipped, batch_insufficient / allow_substitution", async () => {
  const p = await transaction((tx) => createProduct(tx, w.ctx, { name: "Yoghurt", requiresBatch: true, requiresExpiry: true, variants: [{ sku: "YOG-1" }] }));
  const v = p.variants[0].id;
  const mk = (no: string, exp: string) => transaction((tx) => createBatch(tx, w.ctx, { variantId: v, batchNo: no, expiryDate: new Date(exp) }));
  const late = await mk("LATE", "2031-01-01"), early = await mk("EARLY", "2030-01-01"), old = await mk("OLD", "2020-01-01");
  for (const b of [late, early, old]) await stock(v, 5, b.id);

  const r = await rsv({ variantId: v, qty: 7 });
  const pinned = Object.fromEntries(r.reservation.lines.map((l) => [l.batchId, l.qty.toString()]));
  expect(pinned).toEqual({ [early.id]: "5", [late.id]: "2" });
  await expect(rsv({ variantId: v, qty: 1, batchId: early.id })).rejects.toMatchObject({ code: "batch_insufficient" });
  await expect(rsv({ variantId: v, qty: 4, batchId: late.id })).rejects.toMatchObject({ code: "batch_insufficient" });
  await expect(rsv({ variantId: v, qty: 1, batchId: old.id })).rejects.toMatchObject({ code: "batch_insufficient" });
  await transaction((tx) => cancel(tx, w.ctx, { reservationId: r.reservation.id, version: 0 }));
  const s = await rsv({ variantId: v, qty: 6, batchId: late.id, allowSubstitution: true });
  expect(Object.fromEntries(s.reservation.lines.map((l) => [l.batchId, l.qty.toString()]))).toEqual({ [late.id]: "5", [early.id]: "1" });

  // fulfil picks the pinned batches' bins
  const f = await transaction((tx) => fulfil(tx, w.ctx, { reservationId: s.reservation.id, version: 0 }));
  const legs = await db.inventoryMovement.findMany({ where: { id: { in: f.movementIds } } });
  expect(Object.fromEntries(legs.map((m) => [m.batchId, m.dOnHand.toString()]))).toEqual({ [late.id]: "-5", [early.id]: "-1" });
});

test("discontinued variant can't be reserved (INV-019)", async () => {
  await db.productVariant.update({ where: { id: w.variants[1].id }, data: { status: "discontinued" } });
  await expect(rsv({ variantId: w.variants[1].id, qty: 1 })).rejects.toMatchObject({ code: "discontinued_conflict" });
});

test("T1.6: same Idempotency-Key twice → one set of movements, identical response", async () => {
  const body = { variantId: w.variants[0].id, warehouseId: w.warehouse.id, qty: "1" };
  const call = (b = body) => execute(w.ctx, { scope: "reserve", idempotencyKey: "key-1", request: b }, (tx) => reserve(tx, w.ctx, b));
  const before = await db.inventoryMovement.count({ where: { companyId: w.company.id } });
  const [a, b] = [await call(), await call()];
  expect(b).toEqual(a);
  expect(await db.inventoryMovement.count({ where: { companyId: w.company.id } })).toBe(before + 1);
  await expect(call({ ...body, qty: "2" })).rejects.toMatchObject({ code: "conflict" });
  // concurrent duplicates: still exactly one effect
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    execute(w.ctx, { scope: "reserve", idempotencyKey: "key-2", request: body }, (tx) => reserve(tx, w.ctx, body))));
  expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  expect(await db.inventoryMovement.count({ where: { companyId: w.company.id } })).toBe(before + 2);
});
