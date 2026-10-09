import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildCtx } from "@/server/auth/session-ctx";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction } from "@/server/db";
import { dec, postMovements, type Leg } from "@/server/inventory/post";
import { reconcile } from "@/server/inventory/reconcile";
import { reserve } from "@/server/inventory/reservations";
import { approveTransfer, createTransfer, shipTransfer, submitTransfer } from "@/server/inventory/transfers";
import { liveValue, valueAt } from "@/server/inventory/valuation";
import { search } from "@/server/search/search";
import { createLoginUser, seedCompany } from "@/server/seed";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { getDashboard } from "./dashboard";
import { exportReport, REPORTS, ReportFilters, runReport, type ReportName } from "./reports";

// Part 9 gate (P8): every report respects warehouse scope, and its numbers reconcile with
// the ledger (balances, cost layer, valueAt replay, in-transit line).

let w: Awaited<ReturnType<typeof seedCompany>>;
let A: string, B: string, v1: string, v2: string;
let mgr: Ctx; // inventory_manager, all warehouses — approves the admin's transfer
let bMgr: Ctx; // warehouse_manager on B only: reports.view, no reports.export
let n = 0;
const names = Object.keys(REPORTS) as ReportName[];
const F = (o: Record<string, string> = {}) => ReportFilters.parse(o);

async function userCtx(role: string, warehouseIds: string[] = []) {
  const roleId = w.roles.find((r) => r.code === role)!.id;
  const u = await transaction((t) => createLoginUser(t, w.company.id, { name: role, email: `${role}+${crypto.randomUUID()}@test.invalid`, password: "x", roleId, warehouseIds }));
  return buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
}
const main = async (wh: string) => (await db.bin.findFirstOrThrow({ where: { warehouseId: wh, code: "MAIN" } })).id;
async function post(warehouseId: string, leg: Omit<Leg, "warehouseId" | "line" | "reasonCode" | "binId">, reasonCode = "t") {
  const binId = await main(warehouseId);
  return transaction((tx) => postMovements(tx, w.ctx, { sourceType: "test", sourceId: `r-${++n}`, legs: [{ ...leg, warehouseId, binId, line: 1, reasonCode }] }));
}
const rowsOf = (r: Awaited<ReturnType<typeof runReport>>, i = 0) => r.sections[i].rows;

beforeAll(async () => {
  w = await seedCompany(`rep-${crypto.randomUUID()}`);
  A = w.warehouse.id;
  B = (await transaction((t) => createWarehouse(t, w.ctx, { code: "WH-B", name: "Branch" }))).id;
  [v1, v2] = w.variants.map((v) => v.id);
  mgr = await userCtx("inventory_manager");
  bMgr = await userCtx("warehouse_manager", [B]);

  await post(A, { type: "purchase_receipt", variantId: v1, delta: { onHand: 20 }, unitCost: 5 });
  await post(B, { type: "purchase_receipt", variantId: v1, delta: { onHand: 10 }, unitCost: 7 });
  await post(A, { type: "purchase_receipt", variantId: v2, delta: { onHand: 8 }, unitCost: 3 });
  await post(A, { type: "damage", variantId: v1, delta: { onHand: -2, damaged: 2 } }, "dropped");
  await transaction((tx) => reserve(tx, w.ctx, { variantId: v1, warehouseId: A, qty: 3 }));
  await db.variantWarehouseSettings.create({ data: { companyId: w.company.id, variantId: v2, warehouseId: A, reorderPoint: 100, reorderQty: 50 } });
  const t = await transaction((x) => createTransfer(x, w.ctx, { fromWarehouseId: A, toWarehouseId: B, lines: [{ variantId: v1, qty: 4 }] }));
  await transaction((x) => submitTransfer(x, w.ctx, { id: t.id, version: 0 }));
  await transaction((x) => approveTransfer(x, mgr, { id: t.id, version: 1 }));
  await transaction((x) => shipTransfer(x, w.ctx, { id: t.id, version: 2 }));
});
afterAll(async () => {
  expect(await reconcile(w.ctx)).toEqual([]);
  await db.$disconnect();
});

describe("numbers reconcile with the ledger", () => {
  test("summary = stock_balance + stock_allocation + variant_cost; value + in transit = liveValue = valueAt(now)", async () => {
    const r = await runReport(w.ctx, "summary", F());
    const a1 = rowsOf(r).find((x) => x.sku === "TSHIRT-RED-M" && x.warehouse === "WH-MAIN-01")!;
    expect(a1).toMatchObject({ on_hand: "14", reserved: "3", available: "11", damaged: "2", value: "80", wac: "5" });
    const bal = await db.stockBalance.aggregate({ where: { companyId: w.company.id }, _sum: { onHand: true, damaged: true } });
    expect(r.sections[0].total).toMatchObject({ on_hand: bal._sum.onHand!.toString(), damaged: bal._sum.damaged!.toString(), reserved: "3" });

    const [live, replay, val, tr] = await Promise.all([liveValue(w.ctx), valueAt(w.ctx, new Date()), runReport(w.ctx, "valuation", F()), runReport(w.ctx, "transfers", F())]);
    expect(replay.total).toBe(live.total);
    expect(val.sections[0].total!.value).toBe(live.total);
    expect(live.inTransit).toBe("20"); // 4 × WAC 5
    expect(rowsOf(val).at(-1)!.value).toBe(live.inTransit);
    expect(tr.sections[0].total!.value).toBe(live.inTransit);
    expect(rowsOf(tr)[0]).toMatchObject({ shipped: "4", in_transit: "4", route: "WH-MAIN-01 → WH-B" });
    expect(dec(r.sections[0].total!.value as string).plus(live.inTransit).toString()).toBe(live.total);

    const byWh = await runReport(w.ctx, "valuation", F({ groupBy: "warehouse" }));
    expect(rowsOf(byWh).map((x) => [x.label, x.value])).toEqual([["WH-B", "70"], ["WH-MAIN-01", "104"], [expect.stringContaining("In transit"), "20"]]);
  });

  test("movement net = physical qty per position; ledger lists every movement; damaged at WAC; low/out", async () => {
    const [mv, sum, led, dmg, low] = await Promise.all(
      (["movement", "summary", "ledger", "damaged", "low-stock"] as const).map((x) => runReport(w.ctx, x, F())));
    for (const s of rowsOf(sum)) {
      const m = rowsOf(mv).find((x) => x.sku === s.sku && x.warehouse === s.warehouse)!;
      const physical = ["on_hand", "blocked", "damaged", "expired"].reduce((t, k) => t.plus(s[k] as string), dec(0));
      expect(m.net).toBe(physical.toString());
    }
    expect(rowsOf(led)).toHaveLength(await db.inventoryMovement.count({ where: { companyId: w.company.id } }));
    expect(rowsOf(dmg)).toEqual([expect.objectContaining({ sku: "TSHIRT-RED-M", damaged: "2", value: "10", damaged_in_period: "2", reasons: "dropped: 2" })]);
    expect(rowsOf(low)).toEqual([expect.objectContaining({ status: "low", sku: "TSHIRT-BLUE-M", available: "8", reorder_point: "100" })]);
    const lim = await runReport(w.ctx, "ledger", F({ limit: "2", type: "purchase_receipt" }));
    expect(rowsOf(lim)).toHaveLength(2);
    expect(lim.notes[0]).toMatch(/newest 2 of 3/);
  });

  test("point-in-time valuation and product filters", async () => {
    const before = await runReport(w.ctx, "valuation", F({ asOf: "2000-01-01" }));
    expect(before.sections[0].total!.value).toBe("0");
    const one = await runReport(w.ctx, "valuation", F({ variantId: v2 }));
    expect(one.sections[0].total!.value).toBe("24");
    expect(one.notes.join()).toMatch(/In-transit value is shown only without/);
  });
});

describe("warehouse scope (every report)", () => {
  test("a B-only user sees only B rows and is refused A", async () => {
    for (const name of names) {
      const r = await runReport(bMgr, name, F());
      for (const sec of r.sections) for (const row of sec.rows) expect(row.warehouse ?? "WH-B").toBe("WH-B");
      await expect(runReport(bMgr, name, F({ warehouseId: A }))).rejects.toMatchObject({ code: "forbidden" });
    }
    const sum = await runReport(bMgr, "summary", F());
    expect(rowsOf(sum).map((x) => [x.sku, x.on_hand])).toEqual([["TSHIRT-RED-M", "10"]]);
    // The transfer into B is in transit for B too (TR-06), so B sees its line…
    expect((await runReport(bMgr, "transfers", F())).sections[0].total!.value).toBe("20");
    // …and the ledger never shows A's movements.
    expect(rowsOf(await runReport(bMgr, "ledger", F())).every((x) => x.warehouse === "WH-B")).toBe(true);
    const val = await runReport(bMgr, "valuation", F());
    expect(val.sections[0].total!.value).toBe((await liveValue(bMgr)).total);
  });

  test("export: CSV of the same rows, audited; needs reports.export", async () => {
    const out = await exportReport(w.ctx, "summary", F({ warehouseId: B }));
    expect(out.csv.split("\r\n")[0]).toBe("SKU,Name,Warehouse,On hand,Reserved,Available,Blocked,Damaged,Expired,WAC,Value");
    expect(out.rowCount).toBe(1);
    const audit = await db.auditLog.findFirstOrThrow({ where: { companyId: w.company.id, action: "export", entityType: "report", entityId: "summary" } });
    expect(audit.warehouseId).toBe(B);
    await expect(exportReport(bMgr, "summary", F())).rejects.toMatchObject({ code: "forbidden" });
    const multi = await exportReport(w.ctx, "transfers", F());
    expect(multi.csv).toContain("In transit\r\n");
  });

  test("dashboard is scope-aware and matches the valuation", async () => {
    const all = await getDashboard(w.ctx);
    expect(all.kpis.inventoryValue).toBe(dec((await liveValue(w.ctx)).total).toFixed(2));
    expect(all.kpis).toMatchObject({ lowStock: 1, outOfStock: 0, pendingTransfers: 1, damagedValue: "10.00", totalUnits: "32" });
    expect(all.charts.movements30d).toHaveLength(30);
    const b = await getDashboard(bMgr);
    expect(b.charts.valueByWarehouse.map((x) => x.label)).toEqual(["WH-B"]);
    expect(b.kpis).toMatchObject({ lowStock: 0, totalUnits: "10" });
    expect(b.recent.every((x) => x.kind === "audit" || x.text.includes("WH-B"))).toBe(true);
  });

  test("global search: grouped, granted and scoped", async () => {
    const hits = (await search(w.ctx, { q: "tshirt-red" })).hits;
    expect(hits).toContainEqual(expect.objectContaining({ group: "Products", label: "TSHIRT-RED-M" }));
    expect((await search(w.ctx, { q: "WH-MAIN" })).hits.map((h) => h.group)).toContain("Warehouses");
    expect((await search(bMgr, { q: "WH-MAIN" })).hits.filter((h) => h.group === "Warehouses")).toEqual([]);
    expect((await search(bMgr, { q: "admin" })).hits.filter((h) => h.group === "Users")).toEqual([]); // no users.view
    await expect(search(w.ctx, { q: "x" })).rejects.toMatchObject({ code: "validation_error" });
  });
});

