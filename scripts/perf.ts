// T10.2 perf harness — NOT part of `npm test`. Seeds a sizeable dataset into the DB in
// DATABASE_URL, then measures the doc 28 targets on the real domain functions:
//   ATP p95 < 300 ms (single warehouse), ledger list < 500 ms,
//   reserve p95 < 500 ms at 50 concurrent same-SKU (the locked path).
// HTTP/JSON overhead is not included (a few ms); the DB path is what the targets guard.
//
//   PERF_CONFIRM_DB=inventory_p10 npx tsx --env-file=.env scripts/perf.ts [--variants=20000] [--receipts=100] [--skip-seed]
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
import { reserve } from "@/server/inventory/reservations";
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

async function main() {
  const s = process.argv.includes("--skip-seed") ? await latest() : await seed();
  await db.$executeRawUnsafe("ANALYZE");
  console.log(JSON.stringify(await measure(s), null, 2));
  if (process.argv.includes("--explain")) await explain(s);
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
