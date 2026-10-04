import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildCtx } from "@/server/auth/session-ctx";
import { createProduct, setUomConversion, updateVariant } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { execute } from "@/server/core/execute";
import { db, transaction, type Tx } from "@/server/db";
import { reserve } from "@/server/inventory/reservations";
import { reconcile } from "@/server/inventory/reconcile";
import { createLoginUser, seedCompany } from "@/server/seed";
import { addSupplierAddress, addSupplierContact, createSupplier, updateSupplier } from "@/server/suppliers/suppliers";
import { updateWarehouse } from "@/server/warehouses/warehouses";
import {
  approvePo, cancelPo, closePo, createPo, orderPo, reducePoLine, rejectPo, submitPo, updatePo, type PoLineInput,
} from "./purchase-orders";
import { decideExcess, postReceipt, reverseReceipt, type ReceiptLineInput } from "./receipts";

// Part 4 gate (doc 06-execution P5): full / partial / over / under / wrong / damaged /
// duplicate-retry / close, plus reversal, UOM, batch, serial, SoD and archive guards.

let w: Awaited<ReturnType<typeof seedCompany>>;
let pm: Ctx; // purchasing_manager, approve ≤ 5000
let owner: Ctx;
let invMgr: Ctx; // inventory_manager, adjust_approve ≤ 1000 (reversals)
let supplierId: string;
const tx = <T>(fn: (tx: Tx) => Promise<T>) => transaction(fn);

async function userCtx(role: string, warehouseIds: string[] = []) {
  const roleId = w.roles.find((r) => r.code === role)!.id;
  const u = await tx((t) => createLoginUser(t, w.company.id, { name: role, email: `${role}+${crypto.randomUUID()}@test.invalid`, password: "x", roleId, warehouseIds }));
  return buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
}

beforeAll(async () => {
  w = await seedCompany(`po-${crypto.randomUUID()}`);
  [pm, owner, invMgr] = await Promise.all([userCtx("purchasing_manager"), userCtx("owner"), userCtx("inventory_manager", [w.warehouse.id])]);
  const s = await tx((t) => createSupplier(t, w.ctx, { name: "Acme Supply" }));
  await tx((t) => addSupplierContact(t, w.ctx, { supplierId: s.id, name: "Ann" }));
  await tx((t) => addSupplierAddress(t, w.ctx, { supplierId: s.id, type: "billing", line1: "1 Road", city: "Dubai", country: "AE" }));
  supplierId = s.id;
});
afterAll(() => db.$disconnect());

// draft → submitted → approved (by pm) → ordered.
async function orderedPo(lines: PoLineInput[], opts: { supplier?: string } = {}) {
  const po = await tx((t) => createPo(t, w.ctx, { supplierId: opts.supplier ?? supplierId, warehouseId: w.warehouse.id, lines }));
  await tx((t) => submitPo(t, w.ctx, { id: po.id, version: 0 }));
  await tx((t) => approvePo(t, pm, { id: po.id, version: 1 }));
  return tx((t) => orderPo(t, w.ctx, { id: po.id, version: 2 }));
}
const receive = (poId: string, lines: ReceiptLineInput[], ctx = w.ctx) => tx((t) => postReceipt(t, ctx, { poId, lines }));
const poOf = (id: string) => db.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });

async function stock(variantId: string) {
  const rows = await db.stockBalance.findMany({ where: { variantId, warehouseId: w.warehouse.id }, include: { bin: true } });
  const out: Record<string, string> = {};
  for (const r of rows) {
    for (const k of ["onHand", "blocked", "damaged", "expired"] as const) {
      if (!r[k].isZero()) out[`${r.bin.code}.${k}`] = r[k].toString();
    }
  }
  return out;
}

async function newVariant(opts: { requiresBatch?: boolean; requiresExpiry?: boolean; isSerialized?: boolean; costPrice?: string } = {}) {
  const { costPrice, ...flags } = opts;
  const p = await tx((t) => createProduct(t, w.ctx, { name: `Item ${crypto.randomUUID().slice(0, 8)}`, ...flags, variants: [{ sku: `SKU-${crypto.randomUUID().slice(0, 8)}`, costPrice }] }));
  return p.variants[0];
}

describe("PO lifecycle (doc 23)", () => {
  test("totals, SoD, approval limit, reject → draft with comment, invalid transitions", async () => {
    const v = await newVariant();
    const po = await tx((t) => createPo(t, w.ctx, {
      supplierId, warehouseId: w.warehouse.id, shipping: "10", discount: "5",
      lines: [{ variantId: v.id, qty: 10, unitPrice: "100", discountPct: "10", taxPct: "5" }],
    }));
    expect(po.number).toMatch(/^PO-\d{4}-\d{5}$/);
    expect(po.lines[0].lineTotal.toString()).toBe("945"); // 10 × 100 − 10% + 5%
    expect(po.total.toString()).toBe("950"); // 945 − 5 + 10

    await expect(tx((t) => orderPo(t, w.ctx, { id: po.id, version: 0 }))).rejects.toMatchObject({ code: "invalid_transition" });
    await tx((t) => submitPo(t, w.ctx, { id: po.id, version: 0 }));
    await expect(tx((t) => updatePo(t, w.ctx, { id: po.id, version: 1, notes: "x" }))).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(tx((t) => approvePo(t, w.ctx, { id: po.id, version: 1 }))).rejects.toMatchObject({ code: "forbidden" }); // creator ≠ approver
    await expect(tx((t) => rejectPo(t, pm, { id: po.id, version: 1, comment: " " }))).rejects.toMatchObject({ code: "validation_error" });
    await tx((t) => rejectPo(t, pm, { id: po.id, version: 1, comment: "price too high" }));
    const edited = await tx((t) => updatePo(t, w.ctx, { id: po.id, version: 2, lines: [{ id: po.lines[0].id, variantId: v.id, qty: 100, unitPrice: "100" }] }));
    expect(edited.total.toString()).toBe("10005");
    await tx((t) => submitPo(t, w.ctx, { id: po.id, version: 3 }));
    await expect(tx((t) => approvePo(t, pm, { id: po.id, version: 4 }))).rejects.toMatchObject({ code: "forbidden", details: { reason: "over_limit" } });
    await expect(tx((t) => approvePo(t, owner, { id: po.id, version: 3 }))).rejects.toMatchObject({ code: "version_conflict" });
    await tx((t) => approvePo(t, owner, { id: po.id, version: 4 }));
    expect(await db.poApproval.count({ where: { poId: po.id } })).toBe(2); // reject + approve
    await tx((t) => cancelPo(t, w.ctx, { id: po.id, version: 5 }));
    expect((await poOf(po.id)).status).toBe("cancelled");
  });

  test("draft line removal flags instead of deleting; SUP-02 needs contact + address", async () => {
    const [a, b] = [await newVariant(), await newVariant()];
    const po = await tx((t) => createPo(t, w.ctx, { supplierId, warehouseId: w.warehouse.id, lines: [{ variantId: a.id, qty: 1, unitPrice: 1 }, { variantId: b.id, qty: 1, unitPrice: 2 }] }));
    const after = await tx((t) => updatePo(t, w.ctx, { id: po.id, version: 0, lines: [{ id: po.lines[1].id, variantId: b.id, qty: 3, unitPrice: 2 }] }));
    expect(after.lines.map((l) => [l.removed, l.qtyOrdered.toString()])).toEqual([[true, "1"], [false, "3"]]);
    expect(after.total.toString()).toBe("6");

    const bare = await tx((t) => createSupplier(t, w.ctx, { name: "Bare Ltd" }));
    const po2 = await tx((t) => createPo(t, w.ctx, { supplierId: bare.id, warehouseId: w.warehouse.id, lines: [{ variantId: a.id, qty: 1, unitPrice: 1 }] }));
    await tx((t) => submitPo(t, w.ctx, { id: po2.id, version: 0 }));
    await expect(tx((t) => approvePo(t, pm, { id: po2.id, version: 1 }))).rejects.toMatchObject({ details: { reason: "supplier_incomplete" } });
  });

  test("default price from supplier last price / cost price; discontinued variants can't be ordered", async () => {
    const v = await newVariant({ costPrice: "7.5" });
    const po = await tx((t) => createPo(t, w.ctx, { supplierId, warehouseId: w.warehouse.id, lines: [{ variantId: v.id, qty: 2 }] }));
    expect(po.lines[0].unitPrice.toString()).toBe("7.5");
    await tx((t) => updateVariant(t, w.ctx, { id: v.id, version: 0, status: "discontinued" }));
    await expect(tx((t) => createPo(t, w.ctx, { supplierId, warehouseId: w.warehouse.id, lines: [{ variantId: v.id, qty: 1, unitPrice: 1 }] })))
      .rejects.toMatchObject({ code: "discontinued_conflict" });
  });
});

describe("receiving (doc 10, P5 gate)", () => {
  test("full receipt: one transaction posts stock at net cost, PO → fully_received; cancel then forbidden", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 10, unitPrice: "20", discountPct: "10", taxPct: "15" }]);
    const res = await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 10 }]);
    expect(res.receipt.number).toMatch(/^GRN-\d{4}-\d{5}$/);
    expect(res.poStatus).toBe("fully_received");
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "10" });
    const m = await db.inventoryMovement.findFirstOrThrow({ where: { sourceId: res.receipt.id } });
    expect([m.type, m.unitCost?.toString(), m.valueDelta.toString()]).toEqual(["purchase_receipt", "18", "180"]); // 20 − 10%, tax excluded
    expect((await poOf(po.id)).lines[0].qtyReceivedBase.toString()).toBe("10");
    await expect(tx((t) => cancelPo(t, w.ctx, { id: po.id, version: 4 }))).rejects.toMatchObject({ code: "invalid_transition" });
  });

  test("partial → partially_received, remainder stays open; qty can't drop below received (edge #9); close needs a reason", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 10, unitPrice: 1 }]);
    expect((await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 4 }])).poStatus).toBe("partially_received");
    await expect(tx((t) => reducePoLine(t, w.ctx, { poId: po.id, version: 4, lineId: po.lines[0].id, qty: 3 }))).rejects.toMatchObject({ code: "validation_error" });
    await tx((t) => reducePoLine(t, w.ctx, { poId: po.id, version: 4, lineId: po.lines[0].id, qty: 6 }));
    expect((await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 2 }])).poStatus).toBe("fully_received");

    const po2 = await orderedPo([{ variantId: v.id, qty: 5, unitPrice: 1 }]);
    await receive(po2.id, [{ poLineId: po2.lines[0].id, accepted: 2 }]);
    await expect(tx((t) => closePo(t, w.ctx, { id: po2.id, version: 4 }))).rejects.toMatchObject({ code: "validation_error" });
    await tx((t) => closePo(t, w.ctx, { id: po2.id, version: 4, reason: "supplier out of stock" }));
    await expect(receive(po2.id, [{ poLineId: po2.lines[0].id, accepted: 1 }])).rejects.toMatchObject({ code: "invalid_transition" });
  });

  test("over-delivery: tolerance accepted, excess blocked pending a decision; approve = re-approval (edge #22)", async () => {
    const s = await tx((t) => createSupplier(t, w.ctx, { name: "Tolerant Co", receiptTolerancePct: 10 }));
    await tx((t) => addSupplierContact(t, w.ctx, { supplierId: s.id, name: "T" }));
    await tx((t) => addSupplierAddress(t, w.ctx, { supplierId: s.id, type: "billing", line1: "1", city: "C", country: "AE" }));
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 10, unitPrice: 2 }], { supplier: s.id });
    const res = await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 13 }]);
    expect(res.poStatus).toBe("fully_received");
    expect(res.receipt.lines[0]).toMatchObject({ excessStatus: "pending" });
    expect([res.receipt.lines[0].qtyAccepted.toString(), res.receipt.lines[0].qtyExcessBlocked.toString()]).toEqual(["11", "2"]);
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "11", "RECV.blocked": "2" });
    await expect(tx((t) => closePo(t, w.ctx, { id: po.id, version: 4 }))).rejects.toMatchObject({ details: { reason: "pending_excess" } });

    const lineId = res.receipt.lines[0].id;
    await expect(tx((t) => decideExcess(t, w.ctx, { receiptLineId: lineId, approve: true }))).rejects.toMatchObject({ code: "forbidden" }); // PO creator
    await tx((t) => decideExcess(t, pm, { receiptLineId: lineId, approve: true }));
    await expect(tx((t) => decideExcess(t, owner, { receiptLineId: lineId, approve: false, comment: "late" }))).rejects.toMatchObject({ code: "version_conflict" });
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "13" });
    const line = (await poOf(po.id)).lines[0];
    expect([line.qtyOrderedBase.toString(), line.qtyReceivedBase.toString()]).toEqual(["12", "13"]);
    await tx((t) => closePo(t, w.ctx, { id: po.id, version: 5 }));
  });

  test("damaged / expired / short: separate buckets and bins, qty_received counts accepted only (RC-03)", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 10, unitPrice: 1 }]);
    const res = await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 6, damaged: 2, expired: 1, missing: 1 }]);
    expect(res.poStatus).toBe("partially_received");
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "6", "DMG.damaged": "2", "QUAR.expired": "1" });
    expect((await poOf(po.id)).lines[0].qtyReceivedBase.toString()).toBe("6");
    expect(res.receipt.lines[0].qtyMissing.toString()).toBe("1");
  });

  test("wrong product: held → blocked at current WAC, no PO effect; not held → recorded, no movement", async () => {
    const [ordered, arrived] = [await newVariant(), await newVariant()];
    const po = await orderedPo([{ variantId: ordered.id, qty: 5, unitPrice: 3 }]);
    const res = await receive(po.id, [{ variantId: arrived.id, qty: 4, note: "sent blue not red" }, { variantId: arrived.id, qty: 1, held: false }]);
    expect(res.poStatus).toBe("ordered");
    expect(await stock(arrived.id)).toEqual({ "RECV.blocked": "4" });
    expect(res.receipt.lines.map((l) => l.wrongProduct)).toEqual([true, true]);
    expect(res.movementIds).toHaveLength(1);
  });

  test("duplicate retry with one Idempotency-Key → one GRN, identical response (RC-01, edge #16)", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 3, unitPrice: 1 }]);
    const key = crypto.randomUUID();
    const body = { poId: po.id, lines: [{ poLineId: po.lines[0].id, accepted: 3 }] };
    const run = () => execute(w.ctx, { scope: "receipts.create", idempotencyKey: key, request: body }, (t) => postReceipt(t, w.ctx, body, key));
    const [a, b] = [await run(), await run()];
    expect(b).toEqual(a);
    expect(await db.goodsReceipt.count({ where: { poId: po.id } })).toBe(1);
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "3" });
  });

  test("two people receive the same delivery concurrently: never double sellable (edge #1)", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 5, unitPrice: 1 }]);
    const results = await Promise.allSettled([1, 2].map(() => receive(po.id, [{ poLineId: po.lines[0].id, accepted: 5 }])));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "invalid_transition" } }); // PO already fully_received
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "5" });
    expect((await poOf(po.id)).lines[0].qtyReceivedBase.toString()).toBe("5");
  });

  test("UOM: ordered in boxes, factor snapshotted, ledger posts base units at price ÷ factor (RC-06)", async () => {
    const v = await newVariant();
    await tx((t) => setUomConversion(t, w.ctx, { productId: v.productId, uom: "box", factor: 12 }));
    const po = await orderedPo([{ variantId: v.id, qty: 2, uom: "box", unitPrice: "120", discountPct: "10" }]);
    expect([po.lines[0].uomFactor.toString(), po.lines[0].qtyOrderedBase.toString()]).toEqual(["12", "24"]);
    const res = await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 2 }]);
    expect(res.poStatus).toBe("fully_received");
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "24" });
    const m = await db.inventoryMovement.findFirstOrThrow({ where: { sourceId: res.receipt.id } });
    expect(m.unitCost?.toString()).toBe("9");
  });

  test("batch + expiry capture: required, future, consistent (B-01/B-02, RC-10)", async () => {
    const v = await newVariant({ requiresBatch: true, requiresExpiry: true });
    const po = await orderedPo([{ variantId: v.id, qty: 10, unitPrice: 1 }]);
    const L = po.lines[0].id;
    await expect(receive(po.id, [{ poLineId: L, accepted: 1 }])).rejects.toMatchObject({ code: "validation_error", details: { field: "batchNo" } });
    await expect(receive(po.id, [{ poLineId: L, accepted: 1, batchNo: "B1", expiryDate: new Date("2020-01-01") }])).rejects.toMatchObject({ details: { field: "expiryDate" } });
    await receive(po.id, [{ poLineId: L, accepted: 4, batchNo: "B1", expiryDate: new Date("2099-01-01") }, { poLineId: L, accepted: 3, batchNo: "B2", expiryDate: new Date("2098-06-30") }]);
    expect(await db.batch.count({ where: { variantId: v.id } })).toBe(2);
    await expect(receive(po.id, [{ poLineId: L, accepted: 1, batchNo: "B1", expiryDate: new Date("2099-02-02") }])).rejects.toMatchObject({ details: { field: "expiryDate" } });
    expect((await poOf(po.id)).lines[0].qtyReceivedBase.toString()).toBe("7");
  });

  test("serial capture: exact count, globally unique, no partial post (RC-11, edge #19, I-06)", async () => {
    const v = await newVariant({ isSerialized: true });
    const po = await orderedPo([{ variantId: v.id, qty: 3, unitPrice: 50 }]);
    const L = po.lines[0].id;
    await expect(receive(po.id, [{ poLineId: L, accepted: 2, serials: ["S1"] }])).rejects.toMatchObject({ code: "validation_error", details: { field: "serials" } });
    await receive(po.id, [{ poLineId: L, accepted: 2, serials: ["SN-A", "SN-B"] }]);
    await expect(receive(po.id, [{ poLineId: L, accepted: 1, serials: ["SN-A"] }])).rejects.toMatchObject({ code: "duplicate" });
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "2" }); // the failed receipt left nothing behind
    expect(await db.serialUnit.count({ where: { variantId: v.id, status: "in_stock" } })).toBe(2);
    expect((await reconcile(w.ctx)).filter((d) => d.check === "serials")).toEqual([]);
  });
});

describe("receipt reversal (RC-08, MV-05)", () => {
  test("mirrors the movements, rolls PO back, frees serials; once only; needs adjust_approve", async () => {
    const v = await newVariant({ isSerialized: true });
    const po = await orderedPo([{ variantId: v.id, qty: 2, unitPrice: 10 }]);
    const res = await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 1, damaged: 1, serials: ["RV-1"], damagedSerials: ["RV-2"] }]);
    const whMgr = await userCtx("warehouse_manager", [w.warehouse.id]);
    await expect(tx((t) => reverseReceipt(t, whMgr, { receiptId: res.receipt.id, reason: "keyed wrong PO" }))).rejects.toMatchObject({ code: "forbidden" });
    const rev = await tx((t) => reverseReceipt(t, invMgr, { receiptId: res.receipt.id, reason: "keyed wrong PO" }));
    expect(rev.poStatus).toBe("ordered");
    expect(await stock(v.id)).toEqual({});
    const legs = await db.inventoryMovement.findMany({ where: { sourceId: rev.reversal.id } });
    expect(legs.every((m) => m.reversesMovementId)).toBe(true);
    expect(legs.reduce((t, m) => t + Number(m.valueDelta), 0)).toBe(-20);
    expect(await db.serialUnit.count({ where: { variantId: v.id, status: "reversed" } })).toBe(2);
    await expect(tx((t) => reverseReceipt(t, invMgr, { receiptId: res.receipt.id, reason: "again" }))).rejects.toMatchObject({ code: "duplicate" });
    await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 1, serials: ["RV-1"] }]); // the number is free again
    expect(await db.receiptLine.count({ where: { receiptId: rev.reversal.id } })).toBe(1); // mirrored line, original untouched
  });

  test("reserved units can't be reversed away (I-07); approved excess is undone too", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 4, unitPrice: 1 }]);
    const res = await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 4 }]);
    const r = await tx((t) => reserve(t, w.ctx, { variantId: v.id, warehouseId: w.warehouse.id, qty: "2" }));
    expect(r).toBeTruthy();
    await expect(tx((t) => reverseReceipt(t, invMgr, { receiptId: res.receipt.id, reason: "x" }))).rejects.toMatchObject({ code: "reserved_conflict" });

    const po2 = await orderedPo([{ variantId: v.id, qty: 1, unitPrice: 1 }]);
    const res2 = await receive(po2.id, [{ poLineId: po2.lines[0].id, accepted: 3 }]);
    await tx((t) => decideExcess(t, pm, { receiptLineId: res2.receipt.lines[0].id, approve: true }));
    const rev = await tx((t) => reverseReceipt(t, invMgr, { receiptId: res2.receipt.id, reason: "duplicate keying" }));
    expect(rev.poStatus).toBe("ordered");
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "4" });
  });
});

describe("guards", () => {
  test("receiving needs inventory.receive in the PO's warehouse; archived variants never receive (RC-04)", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 2, unitPrice: 1 }]);
    const outsider = await userCtx("warehouse_staff");
    await expect(receive(po.id, [{ poLineId: po.lines[0].id, accepted: 1 }], outsider)).rejects.toMatchObject({ code: "forbidden" });
    const staff = await userCtx("warehouse_staff", [w.warehouse.id]);
    await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 1 }], staff);
    await db.productVariant.update({ where: { id: v.id }, data: { status: "archived" } }); // bypass the open-PO guard on purpose
    await expect(receive(po.id, [{ poLineId: po.lines[0].id, accepted: 1 }], staff)).rejects.toMatchObject({ code: "archived_conflict" });
  });

  test("archive guards: supplier (SUP-01), variant with open PO lines (flow 3), warehouse (WH-02)", async () => {
    const s = await tx((t) => createSupplier(t, w.ctx, { name: "Guarded" }));
    const v = await newVariant();
    const po = await tx((t) => createPo(t, w.ctx, { supplierId: s.id, warehouseId: w.warehouse.id, lines: [{ variantId: v.id, qty: 1, unitPrice: 1 }] }));
    await expect(tx((t) => updateSupplier(t, w.ctx, { id: s.id, version: 0, status: "archived" }))).rejects.toMatchObject({ details: { reason: "open_pos" } });
    await expect(tx((t) => updateVariant(t, w.ctx, { id: v.id, version: 0, status: "archived" }))).rejects.toMatchObject({ details: { reason: "open_po_lines" } });
    const wh = await db.warehouse.findUniqueOrThrow({ where: { id: w.warehouse.id } });
    await expect(tx((t) => updateWarehouse(t, w.ctx, { id: wh.id, version: wh.version, status: "archived" }))).rejects.toMatchObject({ details: { reason: "not_empty" } });
    await tx((t) => cancelPo(t, w.ctx, { id: po.id, version: 0 }));
    await tx((t) => updateSupplier(t, w.ctx, { id: s.id, version: 0, status: "archived" }));
  });

  test("ledger stays reconciled", async () => {
    expect(await reconcile(w.ctx)).toEqual([]);
  });
});
