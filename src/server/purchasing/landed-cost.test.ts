import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { listInbox } from "@/server/approvals/inbox";
import { buildCtx } from "@/server/auth/session-ctx";
import { createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction, type Tx } from "@/server/db";
import { postMovements } from "@/server/inventory/post";
import { reconcile } from "@/server/inventory/reconcile";
import { liveValue, valueAt } from "@/server/inventory/valuation";
import { createLoginUser, seedCompany } from "@/server/seed";
import { addSupplierAddress, addSupplierContact, createSupplier } from "@/server/suppliers/suppliers";
import { allocate, approveLandedCost, createLandedCost, rejectLandedCost } from "./landed-cost";
import { approvePo, createPo, orderPo, submitPo } from "./purchase-orders";
import { postReceipt, reverseReceipt } from "./receipts";

// T11.3 (doc 15 §1.1): allocation math, prospective WAC, valuation + reconciler, SoD/scope.

let w: Awaited<ReturnType<typeof seedCompany>>;
let owner: Ctx, invMgr: Ctx, pm: Ctx, outsider: Ctx;
let supplierId: string;
const tx = <T>(fn: (tx: Tx) => Promise<T>) => transaction(fn);

async function userCtx(role: string, warehouseIds: string[] = []) {
  const roleId = w.roles.find((r) => r.code === role)!.id;
  const u = await tx((t) => createLoginUser(t, w.company.id, { name: role, email: `${role}+${crypto.randomUUID()}@test.invalid`, password: "x", roleId, warehouseIds }));
  return buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
}

beforeAll(async () => {
  w = await seedCompany(`lc-${crypto.randomUUID()}`);
  [owner, invMgr, pm, outsider] = await Promise.all([
    userCtx("owner"), userCtx("inventory_manager", [w.warehouse.id]), userCtx("purchasing_manager"), userCtx("warehouse_manager"),
  ]);
  supplierId = (await tx((t) => createSupplier(t, w.ctx, { name: "Freight Co" }))).id;
  await tx((t) => addSupplierContact(t, w.ctx, { supplierId, name: "Ann" }));
  await tx((t) => addSupplierAddress(t, w.ctx, { supplierId, type: "billing", line1: "1 Road", city: "Dubai", country: "AE" }));
});
afterAll(() => db.$disconnect());

const newVariant = async () =>
  (await tx((t) => createProduct(t, w.ctx, { name: `Item ${crypto.randomUUID().slice(0, 8)}`, variants: [{ sku: `LC-${crypto.randomUUID().slice(0, 8)}` }] }))).variants[0];

// Receipt of 10 × A @ 10 and 30 × B @ 5 (value 100 / 150).
async function receipt() {
  const [a, b] = [await newVariant(), await newVariant()];
  const po = await tx((t) => createPo(t, w.ctx, {
    supplierId, warehouseId: w.warehouse.id, shipping: "50",
    lines: [{ variantId: a.id, qty: 10, unitPrice: "10" }, { variantId: b.id, qty: 30, unitPrice: "5" }],
  }));
  await tx((t) => submitPo(t, w.ctx, { id: po.id, version: 0 }));
  await tx((t) => approvePo(t, pm, { id: po.id, version: 1 }));
  await tx((t) => orderPo(t, w.ctx, { id: po.id, version: 2 }));
  const lines = (await db.poLine.findMany({ where: { poId: po.id }, orderBy: { lineNo: "asc" } }));
  const r = await tx((t) => postReceipt(t, w.ctx, { poId: po.id, lines: lines.map((l) => ({ poLineId: l.id, accepted: l.qtyOrdered.toString() })) }));
  return { a, b, receipt: r.receipt };
}

const cost = (variantId: string) => db.variantCost.findUniqueOrThrow({ where: { variantId_warehouseId: { variantId, warehouseId: w.warehouse.id } } });
const wacOf = async (variantId: string) => { const c = await cost(variantId); return c.value.div(c.qty).toString(); };

async function consistent() {
  expect(await reconcile(w.ctx)).toEqual([]);
  const [at, live] = await Promise.all([valueAt(w.ctx, new Date()), liveValue(w.ctx)]);
  expect(at.total).toBe(live.total);
}

describe("allocation math (Decimal, residual to last line)", () => {
  test("thirds, zero-basis lines, residual, no basis", () => {
    expect(allocate("100", [1, 1, 1]).map(String)).toEqual(["33.3333", "33.3333", "33.3334"]);
    expect(allocate("10", [3, 0, 7, 0]).map(String)).toEqual(["3", "0", "7", "0"]); // residual to the last line with basis
    expect(allocate("0.0001", [1, 1]).map(String)).toEqual(["0.0001", "0"]); // ROUND_HALF_UP 0.00005 → 0.0001, last takes −0 → 0
    const big = allocate("999999.9999", ["0.3333", "0.3333", "0.3334"]);
    expect(big.reduce((s, x) => s.plus(x)).toString()).toBe("999999.9999");
    expect(() => allocate("10", [0, 0])).toThrow(/basis is 0/);
  });
});

describe("landed cost → WAC (doc 15 §1.1)", () => {
  test("by value; part already gone is expensed; WAC moves prospectively; valuation + reconciler consistent", async () => {
    const { a, b, receipt: r } = await receipt();
    const lc = await tx((t) => createLandedCost(t, w.ctx, { receiptId: r.id, charges: [{ kind: "shipping", amount: "30" }, { kind: "duty", amount: "20" }] }));
    expect(lc.number).toMatch(/^LC-\d{4}-\d{5}$/);
    expect(lc.status).toBe("submitted");
    expect(lc.lines.map((l) => l.allocated.toString())).toEqual(["20", "30"]); // 50 × 100/250, 50 × 150/250

    // Half of A leaves before the approval.
    const bin = (await db.receiptLine.findFirstOrThrow({ where: { receiptId: r.id, variantId: a.id } })).binId;
    await tx((t) => postMovements(t, w.ctx, { sourceType: "test", sourceId: crypto.randomUUID(), legs: [{ type: "adjustment_out", variantId: a.id, warehouseId: w.warehouse.id, binId: bin, delta: { onHand: -5 }, line: 1, reasonCode: "loss" }] }));
    const before = await db.inventoryMovement.findMany({ where: { variantId: { in: [a.id, b.id] } }, orderBy: { id: "asc" } });

    // SoD: creator can't approve; over-limit (1000) passes here (50).
    await expect(tx((t) => approveLandedCost(t, w.ctx, { id: lc.id, version: 0 }))).rejects.toMatchObject({ code: "forbidden", details: { reason: "creator_is_approver" } });
    const res = await tx((t) => approveLandedCost(t, invMgr, { id: lc.id, version: 0, comment: "freight invoice 991" }));
    expect(res).toMatchObject({ status: "posted", capitalized: "40.0000", expensed: "10.0000" });

    const lines = await db.landedCostLine.findMany({ where: { landedCostId: lc.id }, orderBy: { basisValue: "asc" } });
    expect(lines.map((l) => [l.capitalized!.toString(), l.expensed!.toString()])).toEqual([["10", "10"], ["30", "0"]]);
    expect(await wacOf(a.id)).toBe("12"); // (50 + 10) / 5
    expect(await wacOf(b.id)).toBe("6"); // (150 + 30) / 30

    const moves = await db.inventoryMovement.findMany({ where: { sourceType: "landed_cost", sourceId: lc.id }, orderBy: { valueDelta: "asc" } });
    expect(moves.map((m) => [m.type, m.dOnHand.toString(), m.binId, m.valueDelta.toString(), m.unitCost!.toString()])).toEqual([
      ["cost_correction", "0", null, "10", "12"], ["cost_correction", "0", null, "30", "6"],
    ]);
    // History untouched (append-only): every earlier movement is byte-for-byte the same.
    expect(await db.inventoryMovement.findMany({ where: { id: { in: before.map((m) => m.id) } }, orderBy: { id: "asc" } })).toEqual(before);
    await consistent();

    // Posted is terminal; inbox no longer lists it.
    await expect(tx((t) => rejectLandedCost(t, invMgr, { id: lc.id, version: 1, comment: "x" }))).rejects.toMatchObject({ code: "invalid_transition" });
  });

  test("by qty; everything gone → fully expensed, no movement", async () => {
    const { a, b, receipt: r } = await receipt();
    const lc = await tx((t) => createLandedCost(t, w.ctx, { receiptId: r.id, method: "qty", charges: [{ kind: "other", amount: "50" }] }));
    expect(lc.lines.map((l) => l.allocated.toString())).toEqual(["12.5", "37.5"]);
    const rl = await db.receiptLine.findMany({ where: { receiptId: r.id }, orderBy: { lineNo: "asc" } });
    await tx((t) => postMovements(t, w.ctx, { sourceType: "test", sourceId: crypto.randomUUID(), legs: [
      { type: "adjustment_out", variantId: a.id, warehouseId: w.warehouse.id, binId: rl[0].binId, delta: { onHand: -10 }, line: 1, reasonCode: "loss" },
      { type: "adjustment_out", variantId: b.id, warehouseId: w.warehouse.id, binId: rl[1].binId, delta: { onHand: -30 }, line: 2, reasonCode: "loss" },
    ] }));
    const res = await tx((t) => approveLandedCost(t, owner, { id: lc.id, version: 0 }));
    expect(res).toMatchObject({ capitalized: "0.0000", expensed: "50.0000", movementIds: [] });
    await consistent();
  });

  test("scope, limit, reject, inbox, reversed receipt", async () => {
    const { receipt: r } = await receipt();
    await expect(tx((t) => createLandedCost(t, outsider, { receiptId: r.id, charges: [{ kind: "shipping", amount: "5" }] })))
      .rejects.toMatchObject({ code: "forbidden", details: { reason: "out_of_scope" } });
    await expect(tx((t) => createLandedCost(t, w.ctx, { receiptId: r.id, charges: [{ kind: "shipping", amount: "0" }] }))).rejects.toMatchObject({ code: "validation_error" });

    const big = await tx((t) => createLandedCost(t, w.ctx, { receiptId: r.id, charges: [{ kind: "duty", amount: "2000" }] }));
    expect((await listInbox(invMgr)).items.find((i) => i.id === big.id)).toMatchObject({ type: "landed_cost", overLimit: true, amount: "2000.00" });
    expect((await listInbox(w.ctx)).items.find((i) => i.id === big.id)).toBeUndefined(); // creator never sees own doc
    await expect(tx((t) => approveLandedCost(t, invMgr, { id: big.id, version: 0 }))).rejects.toMatchObject({ code: "forbidden", details: { reason: "over_limit" } });
    await expect(tx((t) => rejectLandedCost(t, invMgr, { id: big.id, version: 0, comment: " " }))).rejects.toMatchObject({ code: "validation_error" });
    await tx((t) => rejectLandedCost(t, invMgr, { id: big.id, version: 0, comment: "wrong invoice" }));
    await expect(tx((t) => approveLandedCost(t, owner, { id: big.id, version: 1 }))).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await db.inventoryMovement.count({ where: { sourceType: "landed_cost", sourceId: big.id } })).toBe(0);

    const rev = await tx((t) => reverseReceipt(t, owner, { receiptId: r.id, reason: "mistake" }));
    await expect(tx((t) => createLandedCost(t, w.ctx, { receiptId: r.id, charges: [{ kind: "shipping", amount: "5" }] }))).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(tx((t) => createLandedCost(t, w.ctx, { receiptId: rev.reversal.id, charges: [{ kind: "shipping", amount: "5" }] }))).rejects.toMatchObject({ code: "invalid_transition" });
    await consistent();
  });

  test("postMovements guards cost_correction shape", async () => {
    const v = await newVariant();
    const leg = { type: "cost_correction" as const, variantId: v.id, warehouseId: w.warehouse.id, delta: {}, value: "5", line: 1, reasonCode: "x" };
    await expect(tx((t) => postMovements(t, w.ctx, { sourceType: "test", sourceId: crypto.randomUUID(), legs: [leg] }))).rejects.toThrow(/needs stock on hand/);
    await expect(tx((t) => postMovements(t, w.ctx, { sourceType: "test", sourceId: crypto.randomUUID(), legs: [{ ...leg, delta: { onHand: 1 } }] }))).rejects.toThrow(/cannot change onHand/);
  });
});
