import "dotenv/config";
import { execSync } from "node:child_process";
import { Client } from "pg";

// Fresh test DB every run (append-only tables can't be truncated, so drop the
// schema), then bring it to the latest migration before any test file runs.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  if (!new URL(url).pathname.endsWith("_test")) throw new Error("Refusing to reset a non-test database");
  const pg = new Client({ connectionString: url });
  await pg.connect();
  await pg.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pg.end();
  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url },
  });

  // T1.7 gate: after the whole suite, the ledger must replay to every cached
  // balance, allocation and cost row, in every company the tests created.
  return async function teardown() {
    process.env.DATABASE_URL = url;
    const { db } = await import("@/server/db");
    const { reconcile } = await import("@/server/inventory/reconcile");
    const drift = [];
    for (const { id } of await db.company.findMany({ select: { id: true } })) {
      const ctx = { companyId: id, userId: "reconciler", warehouseIds: "all" as const, permissions: new Set(["inventory.view"]), requestId: "teardown" };
      drift.push(...(await reconcile(ctx)).map((d) => ({ companyId: id, ...d })));
    }
    await db.$disconnect();
    if (drift.length) process.exitCode = 1;
    if (drift.length) throw new Error(`Reconciler found drift after the test suite:\n${JSON.stringify(drift, null, 2)}`);
    console.log("Reconciler: clean after test suite");
  };
}
