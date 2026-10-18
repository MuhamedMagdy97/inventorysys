import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { buildCtx } from "@/server/auth/session-ctx";
import { createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction } from "@/server/db";
import { applyCount, approveCount, enterCounts, openCount, submitCount } from "@/server/inventory/counts";
import { postMovements } from "@/server/inventory/post";
import { reconcile } from "@/server/inventory/reconcile";
import { fulfil, reserve } from "@/server/inventory/reservations";
import { approveTransfer, createTransfer, receiveTransfer, shipTransfer, submitTransfer } from "@/server/inventory/transfers";
import { approvePo, createPo, orderPo, submitPo } from "@/server/purchasing/purchase-orders";
import { postReceipt } from "@/server/purchasing/receipts";
import { createSalesReturn } from "@/server/returns/sales-returns";
import { createLoginUser, seedCompany } from "@/server/seed";
import { updateSettings } from "@/server/settings/settings";
import { addSupplierAddress, addSupplierContact, createSupplier } from "@/server/suppliers/suppliers";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { exportReport, ReportFilters, runReport, type ReportName } from "./reports";

// T11.1 (doc 16 §4, RP-11…RP-15): V1.5 reports — numbers, warehouse scope, export audit.

let w: Awaited<ReturnType<typeof seedCompany>>;
let A: string, B: string, v1: string, v2: string, vb: string, vx: string, vs: string;
let mgr: Ctx, pm: Ctx, bMgr: Ctx;
let n = 0;
const V15: ReportName[] = ["turnover", "dead-slow", "warehouse-performance", "traceability", "expiring"];
const F = (o: Record<string, string> = {}) => ReportFilters.parse(o);
const rowsOf = (r: Awaited<ReturnType<typeof runReport>>, title?: string) => (title ? r.sections.find((x) => x.title === title)! : r.sections[0]).rows;
const DAY = 86_400_000;
const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

async function userCtx(role: string, warehouseIds: string[] = []) {
  const roleId = w.roles.find((r) => r.code === role)!.id;
  const u = await transaction((t) => createLoginUser(t, w.company.id, { name: role, email: `${role}+${crypto.randomUUID()}@test.invalid`, password: "x", roleId, warehouseIds }));
  return buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
}
const bin = async (wh: string, code = "MAIN") => (await db.bin.findFirstOrThrow({ where: { warehouseId: wh, code } })).id;
const variant = async (flags: { requiresBatch?: boolean; requiresExpiry?: boolean; isSerialized?: boolean }) =>
  (await transaction((t) => createProduct(t, w.ctx, { name: `Item ${++n}`, ...flags, variants: [{ sku: `SKU-${n}` }] }))).variants[0].id;
async function sell(variantId: string, qty: number) {
  const r = await transaction((t) => reserve(t, w.ctx, { variantId, warehouseId: A, qty }));
  await transaction((t) => fulfil(t, w.ctx, { reservationId: r.reservation.id, version: 0 }));
  return r.reservation.id;
}

beforeAll(async () => {
  w = await seedCompany(`rep15-${crypto.randomUUID()}`);
  A = w.warehouse.id;
  B = (await transaction((t) => createWarehouse(t, w.ctx, { code: "WH-B", name: "Branch" }))).id;
  [v1, v2] = w.variants.map((v) => v.id);
  [mgr, pm, bMgr] = await Promise.all([userCtx("inventory_manager"), userCtx("purchasing_manager"), userCtx("warehouse_manager", [B])]);
  vb = await variant({ requiresBatch: true, requiresExpiry: true });
  vx = await variant({ requiresBatch: true, requiresExpiry: true });
  vs = await variant({ isSerialized: true });
  const main = await bin(A);

  // One PO into A: a damaged batch line (discrepant), a clean line, a serial.
  const sup = await transaction((t) => createSupplier(t, w.ctx, { name: "Acme" }));
  await transaction((t) => addSupplierContact(t, w.ctx, { supplierId: sup.id, name: "Ann" }));
  await transaction((t) => addSupplierAddress(t, w.ctx, { supplierId: sup.id, type: "billing", line1: "1 Rd", city: "Dubai", country: "AE" }));
  const po0 = await transaction((t) => createPo(t, w.ctx, { supplierId: sup.id, warehouseId: A, lines: [{ variantId: vb, qty: 10, unitPrice: "4" }, { variantId: v2, qty: 8, unitPrice: "3" }, { variantId: vs, qty: 1, unitPrice: "50" }] }));
  await transaction((t) => submitPo(t, w.ctx, { id: po0.id, version: 0 }));
  await transaction((t) => approvePo(t, pm, { id: po0.id, version: 1 }));
  const po = await transaction((t) => orderPo(t, w.ctx, { id: po0.id, version: 2 }));
  const line = (v: string) => po.lines.find((l) => l.variantId === v)!.id;
  await transaction((t) => postReceipt(t, w.ctx, { poId: po.id, lines: [
    { poLineId: line(vb), accepted: 9, damaged: 1, batchNo: "LOT-1", expiryDate: new Date(today.getTime() + 20 * DAY), binId: main },
    { poLineId: line(v2), accepted: 8, binId: main },
    { poLineId: line(vs), accepted: 1, serials: ["SN-1"], binId: main },
  ] }));

  // v1: 20 in at 5, 5 sold → COGS 25.
  await transaction((tx) => postMovements(tx, w.ctx, { sourceType: "test", sourceId: `r-${++n}`, legs: [{ type: "purchase_receipt", variantId: v1, warehouseId: A, binId: main, delta: { onHand: 20 }, unitCost: 5, line: 1, reasonCode: "t" }] }));
  await sell(v1, 5);
  const res = await sell(vb, 2);
  await transaction((t) => createSalesReturn(t, w.ctx, { reasonCode: "faulty", lines: [{ reservationId: res, qty: 1 }] }));

  // vx: an on-hand batch already past its expiry.
  const bx = await db.batch.create({ data: { companyId: w.company.id, variantId: vx, batchNo: "OLD-1", expiryDate: new Date(today.getTime() + 5 * DAY) } });
  await transaction((tx) => postMovements(tx, w.ctx, { sourceType: "opening", sourceId: `ob-${++n}`, legs: [{ type: "opening_balance", variantId: vx, warehouseId: A, binId: main, batchId: bx.id, delta: { onHand: 2 }, unitCost: 1.5, line: 1, reasonCode: "opening" }] }));
  await db.batch.update({ where: { id: bx.id }, data: { expiryDate: new Date(today.getTime() - DAY) } });

  // LOT-1: 4 to B, 3 received + 1 reported missing → transit discrepancy 25 %.
  const lot = await db.batch.findFirstOrThrow({ where: { variantId: vb, batchNo: "LOT-1" } });
  const t = await transaction((x) => createTransfer(x, w.ctx, { fromWarehouseId: A, toWarehouseId: B, lines: [{ variantId: vb, qty: 4, batchId: lot.id }] }));
  await transaction((x) => submitTransfer(x, w.ctx, { id: t.id, version: 0 }));
  await transaction((x) => approveTransfer(x, mgr, { id: t.id, version: 1 }));
  const shipped = await transaction((x) => shipTransfer(x, w.ctx, { id: t.id, version: 2 }));
  await transaction((x) => receiveTransfer(x, w.ctx, { id: t.id, version: shipped.version, lines: [{ lineId: shipped.lines[0].id, received: 3, missing: 1 }] }));

  // A count of v2 at A with no variance.
  const c = await transaction((x) => openCount(x, w.ctx, { warehouseId: A, variantIds: [v2] }));
  await transaction((x) => enterCounts(x, w.ctx, { id: c.id, entries: [{ lineId: c.lines[0].id, countedQty: 8 }] }));
  const sub = await transaction((x) => submitCount(x, w.ctx, { id: c.id, version: 1 }));
  const appr = await transaction((x) => approveCount(x, mgr, { id: c.id, version: sub.version }));
  await transaction((x) => applyCount(x, mgr, { id: c.id, version: appr.version }));
});
afterAll(async () => {
  vi.useRealTimers();
  expect(await reconcile(w.ctx)).toEqual([]);
  await db.$disconnect();
});

describe("V1.5 report numbers", () => {
  test("turnover: COGS ÷ average replayed value, days of inventory (RP-11)", async () => {
    const r = await runReport(w.ctx, "turnover", F());
    expect(rowsOf(r).find((x) => x.sku === "TSHIRT-RED-M")).toMatchObject({ warehouse: "WH-MAIN-01", units_sold: "5", cogs: "25", opening_value: "0", closing_value: "75", avg_value: "37.5", turns: "0.67", days_of_inventory: "547.5" });
    expect(rowsOf(r).find((x) => x.sku === "SKU-1" && x.warehouse === "WH-MAIN-01")).toMatchObject({ cogs: "8", closing_value: "16", turns: "1", days_of_inventory: "365" });
    expect(r.sections[0].total).toMatchObject({ cogs: "33" });
    const past = await runReport(w.ctx, "turnover", F({ from: "2000-01-01", to: "2000-12-31" }));
    expect(rowsOf(past)).toEqual([]);
  });

  test("dead / slow from company settings (RP-12)", async () => {
    expect(rowsOf(await runReport(w.ctx, "dead-slow", F()))).toEqual([]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 100 * DAY);
      const slow = await runReport(w.ctx, "dead-slow", F({ warehouseId: A }));
      expect(rowsOf(slow).find((x) => x.sku === "TSHIRT-RED-M")).toMatchObject({ status: "slow", qty: "15", value: "75", idle_days: 100 });
      expect(rowsOf(slow).every((x) => x.status === "slow")).toBe(true);
      await transaction((t) => updateSettings(t, w.ctx, { slowStockDays: 30, deadStockDays: 60 }));
      await expect(transaction((t) => updateSettings(t, w.ctx, { slowStockDays: 61 }))).rejects.toMatchObject({ code: "validation_error" });
      const dead = await runReport(w.ctx, "dead-slow", F({ warehouseId: A }));
      expect(rowsOf(dead).every((x) => x.status === "dead")).toBe(true);
      expect(dead.notes[0]).toMatch(/≥ 30 days.*≥ 60 days/);
    } finally {
      vi.useRealTimers();
      await transaction((t) => updateSettings(t, w.ctx, { slowStockDays: 90, deadStockDays: 180 }));
    }
  });

  test("warehouse performance: cycle counts and discrepancy rates (RP-13)", async () => {
    const r = await runReport(w.ctx, "warehouse-performance", F());
    expect(rowsOf(r, "Receiving")).toEqual([
      expect.objectContaining({ warehouse: "WH-B", receipts: 0, transfers_in: 1, transit_pct: "25", transit_days: "0.0" }),
      expect.objectContaining({ warehouse: "WH-MAIN-01", receipts: 1, receive_days: "0.0", lines: 3, bad_lines: 1, receipt_pct: "33.3", transfers_in: 0 }),
    ]);
    expect(rowsOf(r, "Shipping")).toEqual([expect.objectContaining({ warehouse: "WH-MAIN-01", transfers_out: 1, orders: 2 })]);
    expect(rowsOf(r, "Count accuracy")).toEqual([expect.objectContaining({ warehouse: "WH-MAIN-01", counted: 1, varied: 0, variance_pct: "0" })]);
    const none = await runReport(w.ctx, "warehouse-performance", F({ from: "2000-01-01", to: "2000-12-31" }));
    expect(none.sections.every((s) => s.rows.length === 0)).toBe(true);
  });

  test("lot traceability: batch and serial trails (RP-14)", async () => {
    const r = await runReport(w.ctx, "traceability", F({ batchNo: "LOT-1" }));
    expect(rowsOf(r, "Lot")).toEqual([expect.objectContaining({ kind: "Batch", sku: "SKU-1", expiry: new Date(today.getTime() + 20 * DAY).toISOString().slice(0, 10) })]);
    expect(rowsOf(r, "Supply (PO + receipt)")).toEqual([expect.objectContaining({ supplier: "Acme", warehouse: "WH-MAIN-01", accepted: "9", damaged: "1", kind: "receipt" })]);
    expect(rowsOf(r, "Transfers")).toEqual([expect.objectContaining({ route: "WH-MAIN-01 → WH-B", shipped: "4", received: "3", missing: "1" })]);
    expect(rowsOf(r, "Reservations & fulfilments")).toEqual([expect.objectContaining({ warehouse: "WH-MAIN-01", qty: "2", fulfilled: "2" })]);
    expect(rowsOf(r, "Returns")).toEqual([expect.objectContaining({ kind: "Customer return", qty: "1" })]);
    expect(rowsOf(r, "Ledger (batch)").map((x) => x.type)).toEqual(expect.arrayContaining(["purchase_receipt", "reservation", "sale_fulfilment", "transfer_out", "transfer_in"]));

    const sn = await runReport(w.ctx, "traceability", F({ serialNo: "SN-1" }));
    expect(rowsOf(sn, "Lot")).toEqual([expect.objectContaining({ kind: "Serial", sku: "SKU-3", status: "in_stock", warehouse: "WH-MAIN-01" })]);
    expect(rowsOf(sn, "Supply (PO + receipt)")).toEqual([expect.objectContaining({ sku: "SKU-3", accepted: "1" })]);
    expect((await runReport(w.ctx, "traceability", F())).notes).toEqual(["Enter a batch number or a serial number."]);
    expect((await runReport(w.ctx, "traceability", F({ batchNo: "NOPE" }))).notes[0]).toMatch(/No batch or serial/);
  });

  test("expiring buckets (RP-15)", async () => {
    const r = await runReport(w.ctx, "expiring", F());
    expect(rowsOf(r, "By bucket").map((x) => [x.bucket, x.positions, x.on_hand, x.value])).toEqual([
      ["expired", 1, "2", "3"], ["0–7 days", 0, "0", "0"], ["8–30 days", 2, "6", "24"], ["31–60 days", 0, "0", "0"], ["61–90 days", 0, "0", "0"],
    ]);
    expect(rowsOf(r, "Batch positions")[0]).toMatchObject({ bucket: "expired", batch: "OLD-1", days_left: -1, warehouse: "WH-MAIN-01" });
    expect(r.sections[0].total).toMatchObject({ positions: 3, value: "27" });
  });
});

describe("V1.5 scope and export", () => {
  test("a B-only user sees only B rows and is refused A", async () => {
    for (const name of V15) {
      const r = await runReport(bMgr, name, F({ batchNo: "LOT-1" }));
      for (const sec of r.sections) for (const row of sec.rows) expect(row.warehouse ?? "WH-B").toBe("WH-B");
      await expect(runReport(bMgr, name, F({ warehouseId: A }))).rejects.toMatchObject({ code: "forbidden" });
    }
    const tr = await runReport(bMgr, "traceability", F({ batchNo: "LOT-1" }));
    expect(rowsOf(tr, "Supply (PO + receipt)")).toEqual([]); // received at A
    expect(rowsOf(tr, "Transfers")).toHaveLength(1); // into B (TR-06)
    expect(rowsOf(tr, "Reservations & fulfilments")).toEqual([]);
    expect(rowsOf(await runReport(bMgr, "expiring", F()), "Batch positions")).toEqual([expect.objectContaining({ warehouse: "WH-B", on_hand: "3" })]);
    expect((await runReport(bMgr, "traceability", F({ serialNo: "SN-1" }))).notes[0]).toMatch(/No batch or serial/);
  });

  test("export: CSV, one audited export row; needs reports.export", async () => {
    const out = await exportReport(w.ctx, "expiring", F({ warehouseId: B }));
    expect(out.csv).toContain("By bucket\r\n");
    expect(out.rowCount).toBe(6);
    const audit = await db.auditLog.findMany({ where: { companyId: w.company.id, action: "export", entityType: "report", entityId: "expiring" } });
    expect(audit).toHaveLength(1);
    expect(audit[0].warehouseId).toBe(B);
    await expect(exportReport(bMgr, "turnover", F())).rejects.toMatchObject({ code: "forbidden" });
  });
});
