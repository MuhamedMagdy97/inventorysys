// T10.2 perf harness — NOT part of `npm test`. Seeds a sizeable dataset into the DB in
// DATABASE_URL, then measures the doc 28 targets on the real domain functions:
//   ATP p95 < 300 ms (single warehouse), ledger list < 500 ms,
//   reserve p95 < 500 ms at 50 concurrent same-SKU (the locked path).
// HTTP/JSON overhead is not included (a few ms); the DB path is what the targets guard.
//
//   PERF_CONFIRM_DB=inventory_p10 npx tsx --env-file=.env scripts/perf.ts [--variants=20000] [--receipts=100] [--skip-seed]
//     [--fuzz=40] [--no-measure]   T10.1 fuzz phase: rounds of 50 concurrent ops, then reconcile
//
// The seed writes stock only through postMovements (ledger rule); catalog rows use
// createMany for speed. Re-running without --skip-seed adds another company.
import { performance } from "node:perf_hooks";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { execute } from "@/server/core/execute";
import { db, transaction } from "@/server/db";
import { getAvailability } from "@/server/inventory/availability";
import { postMovements, type Leg } from "@/server/inventory/post";
import { listMovements } from "@/server/inventory/queries";
import { reconcile } from "@/server/inventory/reconcile";
import { cancel, expireReservation, fulfil, release, reserve } from "@/server/inventory/reservations";
import { AppError } from "@/server/core/errors";
import { seedCompany } from "@/server/seed";
import { buildCtx } from "@/server/auth/session-ctx";

const arg = (name: string, def: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? def);
const VARIANTS = arg("variants", 20_000);
const RECEIPT_DOCS = arg("receipts", 100); // extra 500-leg receipt documents → ledger volume
const ROUNDS = arg("rounds", 10); // reserve rounds of 50 concurrent
const LEGS_PER_DOC = 500;

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname.slice(1);
if (process.env.PERF_CONFIRM_DB !== dbName || dbName === "inventory" || dbName.endsWith("_test")) {
  console.error(`Refusing: set PERF_CONFIRM_DB=${dbName} (never the shared dev/test DBs).`);
  process.exit(1);
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stats = (xs: number[]) =>
  ({ n: xs.length, p50: +pct(xs, 50).toFixed(1), p95: +pct(xs, 95).toFixed(1), p99: +pct(xs, 99).toFixed(1), max: +Math.max(...xs).toFixed(1) });
async function timed<T>(fn: () => Promise<T>): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

type Seeded = { companyId: string; adminId: string; warehouses: { id: string; mainBin: string }[]; variantIds: string[]; hotVariant: string };

async function seed(): Promise<Seeded> {
  const t0 = performance.now();
  const w = await seedCompany(`perf-${new Date().toISOString()}`);
  const wh2 = await transaction((tx) => createWarehouse(tx, w.ctx, { code: "WH-PERF-02", name: "Perf warehouse 2" }));
  const warehouses = [w.warehouse, wh2].map((x) => ({ id: x.id, mainBin: x.bins.find((b) => b.code === "MAIN")!.id }));

  const variantIds: string[] = [];
  for (let i = 0; i < VARIANTS; i += 5000) {
    const n = Math.min(5000, VARIANTS - i);
    const products = await db.product.createManyAndReturn({
      data: Array.from({ length: n }, (_, k) => ({ companyId: w.company.id, name: `Perf product ${i + k}` })),
      select: { id: true },
    });
    const vs = await db.productVariant.createManyAndReturn({
      data: products.map((p, k) => ({ companyId: w.company.id, productId: p.id, sku: `PERF-${String(i + k).padStart(7, "0")}` })),
      select: { id: true },
    });
    variantIds.push(...vs.map((v) => v.id));
  }
  console.log(`catalog: ${VARIANTS} variants in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  // Opening balance per variant × warehouse, 500 legs per document.
  let docs = 0;
  const t1 = performance.now();
  for (const wh of warehouses) {
    for (let i = 0; i < variantIds.length; i += LEGS_PER_DOC) {
      const legs: Leg[] = variantIds.slice(i, i + LEGS_PER_DOC).map((variantId, k) => ({
        type: "opening_balance", variantId, warehouseId: wh.id, binId: wh.mainBin,
        delta: { onHand: 100 + (k % 50) }, unitCost: 5, line: k + 1, reasonCode: "opening",
      }));
      await transaction((tx) => postMovements(tx, w.ctx, { sourceType: "perf_opening", sourceId: `${wh.id}-${i}`, legs }));
      docs++;
    }
  }
  // Extra receipts (random variants) to grow the ledger.
  for (let d = 0; d < RECEIPT_DOCS; d++) {
    const wh = warehouses[d % warehouses.length];
    const legs: Leg[] = Array.from({ length: LEGS_PER_DOC }, (_, k) => ({
      type: "purchase_receipt", variantId: variantIds[(d * 7919 + k * 104729) % variantIds.length], warehouseId: wh.id,
      binId: wh.mainBin, delta: { onHand: 3 }, unitCost: 6, line: k + 1, reasonCode: "grn",
    }));
    await transaction((tx) => postMovements(tx, w.ctx, { sourceType: "perf_receipt", sourceId: `r-${d}`, legs }));
    docs++;
  }
  // Hot SKU: plenty of stock so the reserve rounds never run out.
  const hotVariant = variantIds[0];
  await transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "perf_receipt", sourceId: "hot",
    legs: [{ type: "purchase_receipt", variantId: hotVariant, warehouseId: warehouses[0].id, binId: warehouses[0].mainBin, delta: { onHand: 1_000_000 }, unitCost: 5, line: 1, reasonCode: "grn" }],
  }));
  console.log(`ledger: ${docs} documents in ${((performance.now() - t1) / 1000).toFixed(1)} s`);
  return { companyId: w.company.id, adminId: w.admin.id, warehouses, variantIds, hotVariant };
}

async function latest(): Promise<Seeded> {
  const company = await db.company.findFirstOrThrow({ where: { name: { startsWith: "perf-" } }, orderBy: { createdAt: "desc" } });
  const admin = await db.user.findFirstOrThrow({ where: { companyId: company.id, name: "Admin" } });
  const whs = await db.warehouse.findMany({ where: { companyId: company.id }, include: { bins: true }, orderBy: { code: "asc" } });
  const variants = await db.productVariant.findMany({ where: { companyId: company.id, sku: { startsWith: "PERF-" } }, select: { id: true }, orderBy: { sku: "asc" } });
  return {
    companyId: company.id, adminId: admin.id,
    warehouses: whs.map((x) => ({ id: x.id, mainBin: x.bins.find((b) => b.code === "MAIN")!.id })),
    variantIds: variants.map((v) => v.id), hotVariant: variants[0].id,
  };
}

async function measure(s: Seeded) {
  const ctx = await buildCtx(s.adminId, { requestId: "perf", channel: "system" });
  const wh = s.warehouses[0].id;
  const rnd = () => s.variantIds[Math.floor(Math.random() * s.variantIds.length)];
  const counts = await db.$queryRaw<{ movements: bigint; balances: bigint; audit: bigint }[]>`
    SELECT (SELECT count(*) FROM inventory_movement) AS movements, (SELECT count(*) FROM stock_balance) AS balances, (SELECT count(*) FROM audit_log) AS audit`;
  console.log("dataset (whole DB):", Object.fromEntries(Object.entries(counts[0]).map(([k, v]) => [k, Number(v)])));

  for (let i = 0; i < 20; i++) await getAvailability(ctx, { variantId: rnd(), warehouseId: wh }); // warm-up
  const atp: number[] = [];
  for (let i = 0; i < 500; i++) atp.push(await timed(() => getAvailability(ctx, { variantId: rnd(), warehouseId: wh })));
  const atpConc: number[] = [];
  for (let r = 0; r < 20; r++) {
    atpConc.push(...(await Promise.all(Array.from({ length: 20 }, () => timed(() => getAvailability(ctx, { variantId: rnd(), warehouseId: wh }))))));
  }

  const ledger: number[] = [], ledgerVariant: number[] = [];
  for (let i = 0; i < 30; i++) {
    ledger.push(await timed(() => listMovements(ctx, { page: 1 + (i % 5), perPage: 50 })));
    ledgerVariant.push(await timed(() => listMovements(ctx, { page: 1, perPage: 50, variantId: rnd(), warehouseId: wh })));
  }

  // Uncontended reserve ≈ how long one reserve holds the position lock.
  const reserveOnce = (tag: string) => {
    const body = { variantId: s.hotVariant, warehouseId: wh, qty: "1" };
    return execute(ctx, { scope: "reservations.create", idempotencyKey: `perf-${tag}-${crypto.randomUUID()}`, request: body },
      (tx) => reserve(tx, ctx, body));
  };
  const reserveSeq: number[] = [];
  for (let i = 0; i < 50; i++) reserveSeq.push(await timed(() => reserveOnce("seq")));

  // 50 concurrent same-SKU reserves per round, through execute() with an Idempotency-Key like the route.
  const reserveMs: number[] = [];
  let failed = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const res = await Promise.allSettled(Array.from({ length: 50 }, () => {
      const t = performance.now();
      return reserveOnce(`c${r}`).then(() => reserveMs.push(performance.now() - t));
    }));
    failed += res.filter((x) => x.status === "rejected").length;
    if (r === 0) res.filter((x) => x.status === "rejected").slice(0, 1).forEach((x) => console.error((x as PromiseRejectedResult).reason));
  }

  return {
    atp_sequential: stats(atp),
    atp_20_concurrent: stats(atpConc),
    ledger_list_company_page: stats(ledger),
    ledger_list_variant_page: stats(ledgerVariant),
    reserve_sequential: stats(reserveSeq),
    reserve_50_concurrent_same_sku: { ...stats(reserveMs), failed },
  };
}

async function explain(s: Seeded) {
  const v = s.variantIds[Math.floor(s.variantIds.length / 2)], wh = s.warehouses[0].id, c = s.companyId;
  const queries: Record<string, string> = {
    atp_balances: `SELECT * FROM stock_balance WHERE company_id='${c}' AND variant_id='${v}' AND warehouse_id='${wh}'`,
    atp_allocations: `SELECT a.*, b.* FROM stock_allocation a LEFT JOIN batch b ON b.id=a.batch_id WHERE a.company_id='${c}' AND a.variant_id='${v}' AND a.warehouse_id='${wh}'`,
    lock_sum_on_hand: `SELECT s.variant_id, s.warehouse_id, s.batch_id, SUM(s.on_hand) FROM stock_balance s JOIN unnest(ARRAY['${v}'], ARRAY['${wh}'], ARRAY[NULL]::text[]) AS t(v,w,b) ON s.variant_id=t.v AND s.warehouse_id=t.w AND s.batch_id IS NOT DISTINCT FROM t.b GROUP BY 1,2,3`,
    ledger_count_company: `SELECT count(*) FROM inventory_movement WHERE company_id='${c}'`,
    ledger_page_company: `SELECT * FROM inventory_movement WHERE company_id='${c}' ORDER BY id DESC LIMIT 50 OFFSET 200`,
    ledger_page_variant: `SELECT * FROM inventory_movement WHERE company_id='${c}' AND variant_id='${v}' AND warehouse_id='${wh}' ORDER BY id DESC LIMIT 50`,
    reservation_expiry_scan: `SELECT id FROM reservation WHERE company_id='${c}' AND status='active' AND expires_at < now() LIMIT 100`,
  };
  for (const [name, sql] of Object.entries(queries)) {
    const rows = await db.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
    const plan = rows.map((r) => r["QUERY PLAN"]);
    console.log(`\n-- ${name}\n${plan.join("\n")}`);
  }
}

// T10.1 fuzz at volume: random concurrent reserve/fulfil/release/cancel/expire/adjust/
// putaway on a small hot set (max contention) inside the big ledger, plus simulated
// crashes after a posting (must roll back whole). Pass = only spec error codes and the
// reconciler (ledger replay, reserved = open lines, I-02 no oversell) is clean.
async function fuzz(s: Seeded, rounds: number) {
  const ctx = await buildCtx(s.adminId, { requestId: "fuzz", channel: "system" });
  let seed = 7_654_321; // seeded → a failure is reproducible
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const qty = () => String(1 + Math.floor(rnd() * 4));
  const bins = await db.bin.findMany({ where: { warehouseId: { in: s.warehouses.map((w) => w.id) }, code: { in: ["MAIN", "RECV"] } } });
  const bin = (wh: string, code: string) => bins.find((b) => b.warehouseId === wh && b.code === code)!.id;
  const hot = s.variantIds.slice(1, 21).flatMap((v) => s.warehouses.map((w) => ({ v, wh: w.id })));
  const open: string[] = [];
  const crash = new Error("simulated crash");

  const ops: (() => Promise<unknown>)[] = [
    async () => {
      const p = pick(hot);
      const r = await transaction((tx) => reserve(tx, ctx, { variantId: p.v, warehouseId: p.wh, qty: qty(), allowPartial: rnd() < 0.5 }));
      open.push(r.reservation.id);
    },
    async () => {
      const id = pick(open); if (!id) return;
      const { version } = await db.reservation.findUniqueOrThrow({ where: { id } });
      await transaction((tx) => fulfil(tx, ctx, { reservationId: id, version, qty: rnd() < 0.5 ? undefined : "1" }));
    },
    async () => {
      const id = pick(open); if (!id) return;
      const { version } = await db.reservation.findUniqueOrThrow({ where: { id } });
      await transaction((tx) => (rnd() < 0.5 ? release(tx, ctx, { reservationId: id, version, qty: "1" }) : cancel(tx, ctx, { reservationId: id, version })));
    },
    async () => {
      const id = pick(open); if (!id) return;
      await transaction((tx) => expireReservation(tx, ctx, { reservationId: id, asOf: new Date(Date.now() + 86_400_000) }));
    },
    async () => {
      const p = pick(hot);
      const type = pick(["adjustment_in", "adjustment_out", "damage", "purchase_receipt"] as const);
      const q = qty();
      const delta = type === "damage" ? { onHand: `-${q}`, damaged: q } : { onHand: type === "adjustment_out" ? `-${q}` : q };
      await transaction(async (tx) => {
        await postMovements(tx, ctx, {
          sourceType: "fuzz", sourceId: crypto.randomUUID(),
          legs: [{ type, variantId: p.v, warehouseId: p.wh, binId: bin(p.wh, pick(["MAIN", "RECV"])), delta, unitCost: type === "purchase_receipt" ? String(1 + Math.floor(rnd() * 9)) : undefined, line: 1, reasonCode: "fuzz" }],
        });
        if (rnd() < 0.15) throw crash; // killed after the posting, before COMMIT
      });
    },
    async () => {
      const p = pick(hot);
      const q = qty();
      await transaction((tx) => postMovements(tx, ctx, {
        sourceType: "fuzz_putaway", sourceId: crypto.randomUUID(),
        legs: [
          { type: "putaway_out", variantId: p.v, warehouseId: p.wh, binId: bin(p.wh, "RECV"), delta: { onHand: `-${q}` }, line: 1, reasonCode: "fuzz" },
          { type: "putaway_in", variantId: p.v, warehouseId: p.wh, binId: bin(p.wh, "MAIN"), delta: { onHand: q }, line: 2, reasonCode: "fuzz" },
        ],
      }));
    },
  ];

  const ALLOWED = new Set(["ok", "crash", "insufficient_stock", "reserved_conflict", "version_conflict", "invalid_transition", "reservation_expired", "validation_error"]);
  const tally: Record<string, number> = {};
  const t0 = performance.now();
  for (let r = 0; r < rounds; r++) {
    const res = await Promise.allSettled(Array.from({ length: 50 }, () => pick(ops)()));
    for (const x of res) {
      const code = x.status === "fulfilled" ? "ok" : x.reason === crash ? "crash" : x.reason instanceof AppError ? x.reason.code : `UNEXPECTED: ${x.reason}`;
      tally[code] = (tally[code] ?? 0) + 1;
    }
  }
  const t1 = performance.now();
  const drift = await reconcile(ctx);
  const unexpected = Object.keys(tally).filter((c) => !ALLOWED.has(c));
  console.log(JSON.stringify({ fuzz: { rounds, ops: rounds * 50, seconds: +((t1 - t0) / 1000).toFixed(1), tally, reconcile_seconds: +((performance.now() - t1) / 1000).toFixed(1), drift: drift.slice(0, 5), driftCount: drift.length } }, null, 2));
  if (unexpected.length || drift.length) throw new Error(`FUZZ FAILED: unexpected=${unexpected.join(",")} drift=${drift.length}`);
}

async function main() {
  const s = process.argv.includes("--skip-seed") ? await latest() : await seed();
  await db.$executeRawUnsafe("ANALYZE");
  if (!process.argv.includes("--no-measure")) console.log(JSON.stringify(await measure(s), null, 2));
  if (process.argv.includes("--explain")) await explain(s);
  if (arg("fuzz", 0) > 0) await fuzz(s, arg("fuzz", 0));
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
