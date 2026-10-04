import { afterAll, beforeAll, expect, test } from "vitest";
import { createBatch, createProduct } from "@/server/catalog/catalog";
import { AppError } from "@/server/core/errors";
import { db, transaction } from "@/server/db";
import { seedCompany } from "@/server/seed";
import { postMovements, type Leg } from "./post";
import { reconcile } from "./reconcile";
import { cancel, expireReservation, fulfil, release, reserve } from "./reservations";

// T1.8 — the Part 1 gate. Real Postgres, real parallel transactions.
let w: Awaited<ReturnType<typeof seedCompany>>;
let bins: Record<string, string>;
let n = 0;

const opening = (variantId: string, qty: number, batchId: string | null = null) =>
  transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "opening", sourceId: `ob-${++n}`,
    legs: [{ type: "opening_balance", variantId, warehouseId: w.warehouse.id, binId: bins.MAIN, batchId, delta: { onHand: qty }, unitCost: 4, line: 1, reasonCode: "opening" }],
  }));
const newVariant = async (sku: string, requiresBatch = false) =>
  (await transaction((tx) => createProduct(tx, w.ctx, { name: sku, requiresBatch, variants: [{ sku }] }))).variants[0].id;
const settle = <T>(ps: Promise<T>[]) => Promise.allSettled(ps);
const codeOf = (r: PromiseSettledResult<unknown>) =>
  r.status === "fulfilled" ? "ok" : r.reason instanceof AppError ? r.reason.code : `UNEXPECTED: ${r.reason}`;

beforeAll(async () => {
  w = await seedCompany(`conc-${crypto.randomUUID()}`);
  bins = Object.fromEntries(w.warehouse.bins.map((b) => [b.code, b.id]));
});
afterAll(() => db.$disconnect());

test("50 parallel reserves for the last 10 units → exactly 10 succeed", async () => {
  const v = await newVariant("LAST-10");
  await opening(v, 10);
  const results = await settle(Array.from({ length: 50 }, () =>
    transaction((tx) => reserve(tx, w.ctx, { variantId: v, warehouseId: w.warehouse.id, qty: 1 }))));
  const codes = results.map(codeOf);
  expect(codes.filter((c) => c === "ok")).toHaveLength(10);
  expect(codes.filter((c) => c === "insufficient_stock")).toHaveLength(40);
  const a = await db.stockAllocation.findFirstOrThrow({ where: { variantId: v } });
  expect(a.qtyReserved.toString()).toBe("10");
}, 60_000);

test("fulfil vs expire race → exactly one winner, never a half-post", async () => {
  const v = await newVariant("RACE");
  await opening(v, 20);
  for (let i = 0; i < 10; i++) {
    const { reservation } = await transaction((tx) => reserve(tx, w.ctx, { variantId: v, warehouseId: w.warehouse.id, qty: 2 }));
    const [f, e] = await settle([
      transaction((tx) => fulfil(tx, w.ctx, { reservationId: reservation.id, version: 0 })),
      // the TTL job has decided it's due (asOf in the future)
      transaction((tx) => expireReservation(tx, w.ctx, { reservationId: reservation.id, asOf: new Date(Date.now() + 86_400_000) })),
    ]);
    const fulfilWon = f.status === "fulfilled";
    const expireWon = e.status === "fulfilled" && e.value !== null;
    expect(fulfilWon !== expireWon).toBe(true);
    if (!fulfilWon) expect(codeOf(f)).toBe("reservation_expired");
    const after = await db.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.status).toBe(fulfilWon ? "fulfilled" : "expired");
  }
  const a = await db.stockAllocation.findFirstOrThrow({ where: { variantId: v } });
  expect(a.qtyReserved.toString()).toBe("0");
}, 60_000);

test("double-post of the same receipt (concurrent) → one effect", async () => {
  const v = await newVariant("DOUBLE");
  const legs: Leg[] = [{ type: "purchase_receipt", variantId: v, warehouseId: w.warehouse.id, binId: bins.RECV, delta: { onHand: 7 }, unitCost: 3, line: 1, reasonCode: "grn" }];
  const results = await settle(Array.from({ length: 8 }, () =>
    transaction((tx) => postMovements(tx, w.ctx, { sourceType: "purchase_receipt", sourceId: "GRN-1", legs }))));
  expect(results.map(codeOf).every((c) => c === "ok")).toBe(true);
  const replays = results.filter((r) => r.status === "fulfilled" && r.value.replayed);
  expect(replays).toHaveLength(7);
  expect(await db.inventoryMovement.count({ where: { variantId: v } })).toBe(1);
  expect((await db.stockBalance.findFirstOrThrow({ where: { variantId: v } })).onHand.toString()).toBe("7");
}, 60_000);

test("random mixed operations in parallel → no invariant broken, reconciler clean", async () => {
  // Seeded PRNG so a failure is reproducible.
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const qty = () => String(1 + Math.floor(rnd() * 4));

  const plain = await newVariant("MIX-PLAIN");
  const tracked = await newVariant("MIX-BATCH", true);
  const batchIds = [];
  for (const [no, exp] of [["A", "2031-01-01"], ["B", "2030-06-01"]]) {
    const b = await transaction((tx) => createBatch(tx, w.ctx, { variantId: tracked, batchNo: no, expiryDate: new Date(exp) }));
    batchIds.push(b.id);
    await opening(tracked, 15, b.id);
  }
  await opening(plain, 30);
  const positions = [{ v: plain, b: null as string | null }, ...batchIds.map((b) => ({ v: tracked, b }))];
  const open: string[] = [];

  const ALLOWED = new Set(["ok", "insufficient_stock", "reserved_conflict", "version_conflict", "invalid_transition", "reservation_expired", "validation_error"]);
  const ops: (() => Promise<unknown>)[] = [
    async () => {
      const p = pick(positions);
      const r = await transaction((tx) => reserve(tx, w.ctx, { variantId: p.v, warehouseId: w.warehouse.id, qty: qty(), allowPartial: rnd() < 0.5 }));
      open.push(r.reservation.id);
    },
    async () => {
      const id = pick(open); if (!id) return;
      const r = await db.reservation.findUniqueOrThrow({ where: { id } });
      await transaction((tx) => fulfil(tx, w.ctx, { reservationId: id, version: r.version, qty: rnd() < 0.5 ? undefined : "1" }));
    },
    async () => {
      const id = pick(open); if (!id) return;
      const r = await db.reservation.findUniqueOrThrow({ where: { id } });
      await transaction((tx) => (rnd() < 0.5
        ? release(tx, w.ctx, { reservationId: id, version: r.version, qty: "1" })
        : cancel(tx, w.ctx, { reservationId: id, version: r.version })));
    },
    async () => {
      const id = pick(open); if (!id) return;
      await transaction((tx) => expireReservation(tx, w.ctx, { reservationId: id, asOf: new Date(Date.now() + 86_400_000) }));
    },
    async () => {
      const p = pick(positions);
      const type = pick(["adjustment_in", "adjustment_out", "damage", "purchase_receipt"] as const);
      const q = qty();
      const delta = type === "damage" ? { onHand: `-${q}`, damaged: q } : { onHand: type === "adjustment_out" ? `-${q}` : q };
      await transaction((tx) => postMovements(tx, w.ctx, {
        sourceType: "adjustment", sourceId: crypto.randomUUID(),
        legs: [{ type, variantId: p.v, warehouseId: w.warehouse.id, binId: pick([bins.MAIN, bins.RECV]), batchId: p.b, delta, unitCost: type === "purchase_receipt" ? String(1 + Math.floor(rnd() * 9)) : undefined, line: 1, reasonCode: "fuzz" }],
      }));
    },
    async () => {
      const p = pick(positions);
      const q = qty();
      await transaction((tx) => postMovements(tx, w.ctx, {
        sourceType: "putaway", sourceId: crypto.randomUUID(),
        legs: [
          { type: "putaway_out", variantId: p.v, warehouseId: w.warehouse.id, binId: bins.RECV, batchId: p.b, delta: { onHand: `-${q}` }, line: 1, reasonCode: "fuzz" },
          { type: "putaway_in", variantId: p.v, warehouseId: w.warehouse.id, binId: bins.MAIN, batchId: p.b, delta: { onHand: q }, line: 2, reasonCode: "fuzz" },
        ],
      }));
    },
  ];

  const tally: Record<string, number> = {};
  for (let round = 0; round < 25; round++) {
    const results = await settle(Array.from({ length: 12 }, () => pick(ops)()));
    for (const r of results) {
      const c = codeOf(r);
      tally[c] = (tally[c] ?? 0) + 1;
      if (!ALLOWED.has(c)) throw r.status === "rejected" ? r.reason : new Error(c);
    }
  }
  expect(tally.ok).toBeGreaterThan(50);
  expect(await reconcile(w.ctx)).toEqual([]);
}, 120_000);
