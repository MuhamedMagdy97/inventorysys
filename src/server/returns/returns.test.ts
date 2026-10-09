import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { decide, listInbox } from "@/server/approvals/inbox";
import { buildCtx } from "@/server/auth/session-ctx";
import { createBatch, createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction, type Tx } from "@/server/db";
import { attachEvidence, uploadEvidence } from "@/server/evidence/evidence";
import { inspectLot, listQuarantine } from "@/server/inventory/inspection";
import { postMovements } from "@/server/inventory/post";
import { reconcile } from "@/server/inventory/reconcile";
import { fulfil, reserve } from "@/server/inventory/reservations";
import { approvePo, createPo, orderPo, submitPo, type PoLineInput } from "@/server/purchasing/purchase-orders";
import { decideExcess, postReceipt, reverseReceipt, type ReceiptLineInput } from "@/server/purchasing/receipts";
import { createLoginUser, seedCompany } from "@/server/seed";
import { addSupplierAddress, addSupplierContact, createSupplier } from "@/server/suppliers/suppliers";
import { updateWarehouse } from "@/server/warehouses/warehouses";
import {
  approvePurchaseReturn, closePurchaseReturn, confirmPurchaseReturn, createPurchaseReturn, shipPurchaseReturn,
  submitPurchaseReturn, supplierRejectPurchaseReturn,
} from "./purchase-returns";
import { approveSalesReturn, createSalesReturn, receiveSalesReturn } from "./sales-returns";

// Part 7 gate (doc 06-execution P7): return > fulfilled/received blocked, restock only
// after an inspection pass, linked cost relieved correctly, reconciler clean.

let w: Awaited<ReturnType<typeof seedCompany>>;
let pm: Ctx; // purchasing_manager: return_approve ≤ 5000
let whMgr: Ctx; // warehouse_manager on the main warehouse: return_ship, inspect, return_receive
let invMgr: Ctx; // inventory_manager: sales.return_approve
let salesStaff: Ctx; // sales.return_create
let supplierId: string;
let bins: Record<string, string>;
let n = 0;
const tx = <T>(fn: (tx: Tx) => Promise<T>) => transaction(fn);

async function userCtx(role: string, warehouseIds: string[] = []) {
  const roleId = w.roles.find((r) => r.code === role)!.id;
  const u = await tx((t) => createLoginUser(t, w.company.id, { name: role, email: `${role}+${crypto.randomUUID()}@test.invalid`, password: "x", roleId, warehouseIds }));
  return buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
}
async function newVariant(flags: { isSerialized?: boolean; requiresBatch?: boolean; requiresExpiry?: boolean } = {}) {
  const p = await tx((t) => createProduct(t, w.ctx, { name: `Item ${crypto.randomUUID().slice(0, 8)}`, ...flags, variants: [{ sku: `SKU-${crypto.randomUUID().slice(0, 8)}` }] }));
  return p.variants[0];
}
async function orderedPo(lines: PoLineInput[], supplier = supplierId) {
  const po = await tx((t) => createPo(t, w.ctx, { supplierId: supplier, warehouseId: w.warehouse.id, lines }));
  await tx((t) => submitPo(t, w.ctx, { id: po.id, version: 0 }));
  await tx((t) => approvePo(t, pm, { id: po.id, version: 1 }));
  return tx((t) => orderPo(t, w.ctx, { id: po.id, version: 2 }));
}
const receive = (poId: string, lines: ReceiptLineInput[]) => tx((t) => postReceipt(t, w.ctx, { poId, lines }));
const opening = (variantId: string, qty: number, unitCost: number, batchId: string | null = null) =>
  tx((t) => postMovements(t, w.ctx, {
    sourceType: "opening", sourceId: `ob-${++n}`,
    legs: [{ type: "opening_balance", variantId, warehouseId: w.warehouse.id, binId: bins.MAIN, batchId, delta: { onHand: qty }, unitCost, line: 1, reasonCode: "opening" }],
  }));
async function stock(variantId: string) {
  const rows = await db.stockBalance.findMany({ where: { variantId }, include: { bin: true } });
  const out: Record<string, string> = {};
  for (const r of rows) for (const k of ["onHand", "blocked", "damaged", "expired"] as const) if (!r[k].isZero()) out[`${r.bin.code}.${k}`] = r[k].toString();
  return out;
}
const cost = (variantId: string) => db.variantCost.findUniqueOrThrow({ where: { variantId_warehouseId: { variantId, warehouseId: w.warehouse.id } } }).then((c) => [c.qty.toString(), c.value.toString()]);
const lotOf = (sourceId: string) => db.quarantineLot.findFirstOrThrow({ where: { sourceId, qtyOpen: { gt: 0 } } });

// draft → submitted → approved (pm)
async function approvedReturn(input: Parameters<typeof createPurchaseReturn>[2]) {
  const pr = await tx((t) => createPurchaseReturn(t, w.ctx, input));
  await tx((t) => submitPurchaseReturn(t, w.ctx, { id: pr.id, version: 0 }));
  await tx((t) => approvePurchaseReturn(t, pm, { id: pr.id, version: 1 }));
  return pr;
}
// fulfilled sale of `qty` at the current WAC
async function sold(variantId: string, qty: number, serials?: string[]) {
  const r = await tx((t) => reserve(t, w.ctx, { variantId, warehouseId: w.warehouse.id, qty }));
  await tx((t) => fulfil(t, w.ctx, { reservationId: r.reservation.id, version: 0, serials }));
  return r.reservation.id;
}

beforeAll(async () => {
  w = await seedCompany(`ret-${crypto.randomUUID()}`);
  bins = Object.fromEntries(w.warehouse.bins.map((b) => [b.code, b.id]));
  [pm, whMgr, invMgr, salesStaff] = await Promise.all([
    userCtx("purchasing_manager"), userCtx("warehouse_manager", [w.warehouse.id]), userCtx("inventory_manager"), userCtx("sales_staff", [w.warehouse.id]),
  ]);
  const s = await tx((t) => createSupplier(t, w.ctx, { name: "Acme" }));
  await tx((t) => addSupplierContact(t, w.ctx, { supplierId: s.id, name: "Ann" }));
  await tx((t) => addSupplierAddress(t, w.ctx, { supplierId: s.id, type: "billing", line1: "1 Rd", city: "Dubai", country: "AE" }));
  supplierId = s.id;
});
afterAll(async () => {
  expect(await reconcile(w.ctx)).toEqual([]);
  await db.$disconnect();
});

describe("purchase returns (T7.1, flow 8)", () => {
  test("linked cost relieved (not WAC), oldest receipt first with notice, override, PR-02", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 10, unitPrice: "10" }]);
    const line = po.lines[0].id;
    const g1 = await receive(po.id, [{ poLineId: line, accepted: 3 }]);
    const g2 = await receive(po.id, [{ poLineId: line, accepted: 7 }]);
    await opening(v.id, 10, 20); // WAC = (100 + 200) / 20 = 15
    expect(await cost(v.id)).toEqual(["20", "300"]);

    // edge #12: more than received
    await expect(tx((t) => createPurchaseReturn(t, w.ctx, { poId: po.id, reasonCode: "faulty", lines: [{ variantId: v.id, qty: 11 }] })))
      .rejects.toMatchObject({ code: "validation_error", details: { returnable: "10" } });
    // the shipper re-points a line at another lot (edge #35 override)
    const pr0 = await approvedReturn({ poId: po.id, reasonCode: "faulty", lines: [{ variantId: v.id, qty: 1, receiptLineId: g2.receipt.lines[0].id }] });
    await tx((t) => shipPurchaseReturn(t, whMgr, { id: pr0.id, version: 2, lines: [{ lineId: pr0.lines[0].id, receiptLineId: g1.receipt.lines[0].id }] }));
    expect((await db.inventoryMovement.findFirstOrThrow({ where: { sourceId: pr0.id } })).linkedReceiptId).toBe(g1.receipt.id);
    expect(await cost(v.id)).toEqual(["19", "290"]);

    // edge #35: no lot named → oldest receipt first, with a notice
    const pr = await approvedReturn({ poId: po.id, reasonCode: "faulty", lines: [{ variantId: v.id, qty: 5 }] });
    expect(pr.lines.map((l) => [l.receiptId, l.qty.toString()])).toEqual([[g1.receipt.id, "2"], [g2.receipt.id, "3"]]);
    expect(pr.warnings[0]).toMatch(/oldest receipt first/);
    // PR-02 counts returns in flight: 10 − 1 − 5 left
    await expect(tx((t) => createPurchaseReturn(t, w.ctx, { poId: po.id, reasonCode: "x", lines: [{ variantId: v.id, qty: 5 }] })))
      .rejects.toMatchObject({ code: "validation_error", details: { returnable: "4" } });
    await expect(tx((t) => createPurchaseReturn(t, w.ctx, { poId: po.id, reasonCode: "x", lines: [{ variantId: v.id, qty: 1, receiptLineId: g1.receipt.lines[0].id }] })))
      .rejects.toMatchObject({ code: "validation_error" }); // GRN1's 3 are all spoken for

    await expect(tx((t) => shipPurchaseReturn(t, salesStaff, { id: pr.id, version: 2 }))).rejects.toMatchObject({ code: "forbidden" });
    const shipped = await tx((t) => shipPurchaseReturn(t, whMgr, { id: pr.id, version: 2 }));
    expect(shipped.status).toBe("shipped");
    expect(shipped.value).toBe("50"); // 5 × 10 linked, not 5 × 15 WAC (INV-022)
    expect(await cost(v.id)).toEqual(["14", "240"]);
    const moves = await db.inventoryMovement.findMany({ where: { sourceId: pr.id }, orderBy: { id: "asc" } });
    expect(moves.map((m) => [m.type, m.linkedReceiptId, m.unitCost?.toString()])).toEqual([
      ["purchase_return", g1.receipt.id, "10"], ["purchase_return", g2.receipt.id, "10"],
    ]);
    expect((await db.poLine.findUniqueOrThrow({ where: { id: line } })).qtyReturnedBase.toString()).toBe("6");
    // a receipt with returns can't be reversed (would un-receive twice)
    await expect(tx((t) => reverseReceipt(t, w.ctx, { receiptId: g1.receipt.id, reason: "oops" }))).rejects.toMatchObject({ code: "conflict" });

    const c = await tx((t) => confirmPurchaseReturn(t, w.ctx, { id: pr.id, version: 3, creditNoteRef: "CN-1" }));
    expect([c.status, c.creditNoteRef]).toEqual(["supplier_confirmed", "CN-1"]);
    expect((await tx((t) => closePurchaseReturn(t, w.ctx, { id: pr.id, version: 4 }))).status).toBe("closed");
  });

  test("I-07: shipping can't take reserved units", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 4, unitPrice: "5" }]);
    await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 4 }]);
    await tx((t) => reserve(t, w.ctx, { variantId: v.id, warehouseId: w.warehouse.id, qty: 3 }));
    const pr = await approvedReturn({ poId: po.id, reasonCode: "x", lines: [{ variantId: v.id, qty: 2 }] });
    await expect(tx((t) => shipPurchaseReturn(t, whMgr, { id: pr.id, version: 2 }))).rejects.toMatchObject({ code: "reserved_conflict" });
  });

  test("supplier rejects → blocked_in at the shipped value → inspection pass (SR-02) → sellable", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 4, unitPrice: "10" }]);
    await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 4 }]);
    const pr = await approvedReturn({ poId: po.id, reasonCode: "x", lines: [{ variantId: v.id, qty: 2 }] });
    await tx((t) => shipPurchaseReturn(t, whMgr, { id: pr.id, version: 2 }));
    await expect(tx((t) => supplierRejectPurchaseReturn(t, whMgr, { id: pr.id, version: 3, note: "" }))).rejects.toMatchObject({ code: "validation_error" });
    const rj = await tx((t) => supplierRejectPurchaseReturn(t, whMgr, { id: pr.id, version: 3, note: "not ours" }));
    expect(rj.status).toBe("supplier_rejected");
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "2", "QUAR.blocked": "2" });
    expect(await cost(v.id)).toEqual(["4", "40"]);
    expect((await db.poLine.findUniqueOrThrow({ where: { id: po.lines[0].id } })).qtyReturnedBase.toString()).toBe("0");

    const lot = await lotOf(pr.id);
    expect(lot.reason).toBe("supplier_rejected");
    expect((await listQuarantine(whMgr, { reason: "supplier_rejected" })).map((l) => l.id)).toContain(lot.id);
    // SR-02: whMgr received these units back and another inspector (the admin) exists
    await expect(tx((t) => inspectLot(t, whMgr, { lotId: lot.id, disposition: "restockable", qty: 2 })))
      .rejects.toMatchObject({ code: "forbidden", details: { reason: "receiver_is_inspector" } });
    const ok = await tx((t) => inspectLot(t, w.ctx, { lotId: lot.id, disposition: "restockable", qty: 2 }));
    expect([ok.outcome, ok.sodWaived, ok.lot.qtyOpen.toString()]).toEqual(["pass", false, "0"]);
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "2", "MAIN.onHand": "2" }); // putaway out of quarantine
    expect((await tx((t) => closePurchaseReturn(t, w.ctx, { id: pr.id, version: 4 }))).status).toBe("closed");
  });

  test("receipt quarantine lots: excess passes only once the over-delivery is approved; RC-05 lot passes", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 2, unitPrice: "10" }]);
    const g = await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 3 }]); // 1 excess blocked
    const lot = await lotOf(g.receipt.id);
    expect(lot.reason).toBe("excess");
    await expect(tx((t) => inspectLot(t, w.ctx, { lotId: lot.id, disposition: "restockable", qty: 1 }))).rejects.toMatchObject({ code: "invalid_transition" });
    await tx((t) => decideExcess(t, pm, { receiptLineId: g.receipt.lines[0].id, approve: true }));
    expect((await db.quarantineLot.findUniqueOrThrow({ where: { id: lot.id } })).qtyOpen.toString()).toBe("0"); // released exactly this lot

    const s = await tx((t) => createSupplier(t, w.ctx, { name: "Inspected", requiresInspection: true }));
    await tx((t) => addSupplierContact(t, w.ctx, { supplierId: s.id, name: "Bo" }));
    await tx((t) => addSupplierAddress(t, w.ctx, { supplierId: s.id, type: "billing", line1: "2 Rd", city: "Dubai", country: "AE" }));
    const po2 = await orderedPo([{ variantId: v.id, qty: 2, unitPrice: "10" }], s.id);
    const g2 = await receive(po2.id, [{ poLineId: po2.lines[0].id, accepted: 2 }]);
    const l2 = await lotOf(g2.receipt.id);
    expect(l2.reason).toBe("inspection");
    await tx((t) => inspectLot(t, whMgr, { lotId: l2.id, disposition: "restockable", qty: 1 }));
    await expect(tx((t) => inspectLot(t, whMgr, { lotId: l2.id, disposition: "damaged", qty: 1 }))).rejects.toMatchObject({ code: "validation_error" }); // needs a note
    await tx((t) => inspectLot(t, whMgr, { lotId: l2.id, disposition: "damaged", qty: 1, note: "dented" }));
    expect(await stock(v.id)).toEqual({ "RECV.onHand": "4", "RECV.damaged": "1" });
  });
});

describe("sales returns (T7.2, flow 16)", () => {
  test("return > fulfilled blocked; restock only after inspection pass; re-admitted at the fulfil cost", async () => {
    const v = await newVariant();
    await opening(v.id, 10, 10);
    const res = await sold(v.id, 4); // fulfilled at WAC 10
    await opening(v.id, 6, 30); // WAC now (60 + 180) / 12 = 20
    await expect(tx((t) => createSalesReturn(t, salesStaff, { reasonCode: "changed_mind", lines: [{ reservationId: res, qty: 5 }] })))
      .rejects.toMatchObject({ code: "validation_error", details: { returnable: "4" } }); // edge #12 / SR-01
    const sr = await tx((t) => createSalesReturn(t, salesStaff, { reasonCode: "changed_mind", lines: [{ reservationId: res, qty: 3 }] }));
    await expect(tx((t) => createSalesReturn(t, salesStaff, { reasonCode: "x", lines: [{ reservationId: res, qty: 2 }] })))
      .rejects.toMatchObject({ code: "validation_error" }); // 4 − 3 in flight

    // inbox: the request waits on someone with sales.return_approve, not its creator
    const item = (await listInbox(invMgr)).items.find((i) => i.id === sr.id)!;
    expect(item).toMatchObject({ type: "sales_return", amount: "30.00" });
    await expect(tx((t) => approveSalesReturn(t, salesStaff, { id: sr.id, version: 0 }))).rejects.toMatchObject({ code: "forbidden" });
    await tx((t) => decide(t, invMgr, { type: item.type, id: item.id, version: item.version, approve: true }));

    const before = await stock(v.id);
    const rcv = await tx((t) => receiveSalesReturn(t, whMgr, { id: sr.id, version: 1 }));
    expect(rcv.status).toBe("received");
    expect(await stock(v.id)).toEqual({ ...before, "QUAR.blocked": "3" }); // INV-009: never straight to sellable
    const q = await db.inventoryMovement.findFirstOrThrow({ where: { sourceType: "sales_return", sourceId: sr.id } });
    expect([q.type, q.unitCost?.toString(), q.valueDelta.toString()]).toEqual(["sale_return_quarantine", "10", "30"]);
    expect(q.linkedFulfilmentRef).toBe(sr.lines[0].fulfilmentMovementId);
    expect(await cost(v.id)).toEqual(["15", "270"]);

    const lot = await lotOf(sr.id);
    await expect(tx((t) => inspectLot(t, whMgr, { lotId: lot.id, disposition: "restockable", qty: 2 })))
      .rejects.toMatchObject({ code: "forbidden", details: { reason: "receiver_is_inspector" } }); // SR-02
    await expect(tx((t) => inspectLot(t, w.ctx, { lotId: lot.id, disposition: "restockable", qty: 4 }))).rejects.toMatchObject({ code: "validation_error" });
    const pass = await tx((t) => inspectLot(t, w.ctx, { lotId: lot.id, disposition: "restockable", qty: 2 }));
    expect(pass.returnStatus).toBe("received");
    const fail = await tx((t) => inspectLot(t, w.ctx, { lotId: lot.id, disposition: "defective", qty: 1, note: "won't power on" }));
    expect(fail.returnStatus).toBe("restocked");
    expect(await stock(v.id)).toEqual({ "MAIN.onHand": "14", "QUAR.damaged": "1" });
    const done = await db.salesReturnLine.findFirstOrThrow({ where: { returnId: sr.id } });
    expect([done.qtyReceived, done.qtyRestocked, done.qtyRejected].map(String)).toEqual(["3", "2", "1"]);
    const types = (await db.inventoryMovement.findMany({ where: { sourceType: "inspection", sourceId: { in: [pass.inspection.id, fail.inspection.id] } }, orderBy: { id: "asc" } })).map((m) => m.type);
    expect(types).toEqual(["sale_return_restock", "putaway_out", "putaway_in", "blocked_reject"]);
  });

  test("SR-03: an expired original batch → new inspection batch; an unexpired one is rejoined", async () => {
    const v = await newVariant({ requiresBatch: true, requiresExpiry: true });
    const future = new Date(Date.now() + 90 * 864e5);
    const b1 = await tx((t) => createBatch(t, w.ctx, { variantId: v.id, batchNo: `B1-${n}`, expiryDate: future }));
    await opening(v.id, 5, 8, b1.id);
    const res = await sold(v.id, 3);
    const sr1 = await tx((t) => createSalesReturn(t, w.ctx, { reasonCode: "x", lines: [{ reservationId: res, qty: 1 }] }));
    await tx((t) => approveSalesReturn(t, invMgr, { id: sr1.id, version: 0 }));
    await tx((t) => receiveSalesReturn(t, whMgr, { id: sr1.id, version: 1 }));
    expect((await lotOf(sr1.id)).batchId).toBe(b1.id);

    const sr2 = await tx((t) => createSalesReturn(t, w.ctx, { reasonCode: "x", lines: [{ reservationId: res, qty: 2 }] }));
    await tx((t) => approveSalesReturn(t, invMgr, { id: sr2.id, version: 0 }));
    await db.batch.update({ where: { id: b1.id }, data: { expiryDate: new Date(Date.now() - 864e5) } }); // the batch has since expired
    await expect(tx((t) => receiveSalesReturn(t, whMgr, { id: sr2.id, version: 1 }))).rejects.toMatchObject({ code: "validation_error", details: { field: "expiryDate" } });
    await tx((t) => receiveSalesReturn(t, whMgr, { id: sr2.id, version: 1, lines: [{ lineId: sr2.lines[0].id, expiryDate: future }] }));
    const lot = await lotOf(sr2.id);
    const nb = await db.batch.findUniqueOrThrow({ where: { id: lot.batchId! } });
    expect([nb.id === b1.id, nb.batchNo]).toEqual([false, `${sr2.number}-1`]);
    // the old lot sits on an expired batch: can't pass, only reject as expired
    const old = await lotOf(sr1.id);
    await expect(tx((t) => inspectLot(t, w.ctx, { lotId: old.id, disposition: "restockable", qty: 1 }))).rejects.toMatchObject({ code: "validation_error" });
    await tx((t) => inspectLot(t, w.ctx, { lotId: old.id, disposition: "expired", qty: 1, note: "expired" }));
    await tx((t) => inspectLot(t, w.ctx, { lotId: lot.id, disposition: "dispose", qty: 2, note: "seal broken" }));
    expect((await db.salesReturn.findUniqueOrThrow({ where: { id: sr2.id } })).status).toBe("written_off");
  });

  test("serialized: reserve, fulfil names units (S-02), returned unit comes back through inspection", async () => {
    const v = await newVariant({ isSerialized: true });
    await tx((t) => postMovements(t, w.ctx, {
      sourceType: "opening", sourceId: `ob-${++n}`,
      legs: [{ type: "opening_balance", variantId: v.id, warehouseId: w.warehouse.id, binId: bins.MAIN, delta: { onHand: 2 }, unitCost: 50, line: 1, reasonCode: "opening", serialized: true }],
    }));
    await db.serialUnit.createMany({ data: ["S1", "S2"].map((serialNo) => ({ companyId: w.company.id, variantId: v.id, serialNo, status: "in_stock" as const, warehouseId: w.warehouse.id, binId: bins.MAIN })) });
    const r = await tx((t) => reserve(t, w.ctx, { variantId: v.id, warehouseId: w.warehouse.id, qty: 1 }));
    await expect(tx((t) => fulfil(t, w.ctx, { reservationId: r.reservation.id, version: 0 }))).rejects.toMatchObject({ code: "validation_error" });
    await tx((t) => fulfil(t, w.ctx, { reservationId: r.reservation.id, version: 0, serials: ["S1"] }));
    const units = async () => Object.fromEntries((await db.serialUnit.findMany({ where: { variantId: v.id } })).map((u) => [u.serialNo, u.status]));
    expect(await units()).toEqual({ S1: "sold", S2: "in_stock" });
    expect(await reconcile(w.ctx)).toEqual([]); // I-06

    await expect(tx((t) => createSalesReturn(t, w.ctx, { reasonCode: "x", lines: [{ reservationId: r.reservation.id, qty: 1, serials: ["S2"] }] })))
      .rejects.toMatchObject({ code: "validation_error" }); // not sold on this line
    const sr = await tx((t) => createSalesReturn(t, w.ctx, { reasonCode: "x", lines: [{ reservationId: r.reservation.id, qty: 1, serials: ["S1"] }] }));
    await tx((t) => approveSalesReturn(t, invMgr, { id: sr.id, version: 0 }));
    await tx((t) => receiveSalesReturn(t, whMgr, { id: sr.id, version: 1 }));
    expect(await units()).toEqual({ S1: "quarantine", S2: "in_stock" });
    const lot = await lotOf(sr.id);
    await expect(tx((t) => inspectLot(t, w.ctx, { lotId: lot.id, disposition: "restockable", qty: 1 }))).rejects.toMatchObject({ code: "validation_error" }); // name the unit
    await tx((t) => inspectLot(t, w.ctx, { lotId: lot.id, disposition: "restockable", qty: 1, serials: ["S1"] }));
    expect(await units()).toEqual({ S1: "in_stock", S2: "in_stock" });
    expect(await stock(v.id)).toEqual({ "MAIN.onHand": "2" });
  });
});

describe("evidence uploads (T7.3, edge #28)", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  test("allowlist by content, size cap, rejected uploads audited, attached once", async () => {
    const e = await tx((t) => uploadEvidence(t, whMgr, { warehouseId: w.warehouse.id, fileName: "../../etc/photo.png", bytes: png }));
    expect([e.mimeType, e.fileName, e.sizeBytes]).toEqual(["image/png", "photo.png", 11]);
    await expect(tx((t) => uploadEvidence(t, whMgr, { warehouseId: w.warehouse.id, fileName: "x.png", bytes: new TextEncoder().encode("<script>") })))
      .rejects.toMatchObject({ code: "validation_error" });
    await expect(tx((t) => uploadEvidence(t, whMgr, { warehouseId: w.warehouse.id, fileName: "big.png", bytes: new Uint8Array(10 * 1024 * 1024 + 1).fill(0x89, 0, 1) })))
      .rejects.toMatchObject({ code: "validation_error" });
    expect(await db.auditLog.count({ where: { companyId: w.company.id, action: "upload.rejected" } })).toBe(2);
    await expect(tx((t) => uploadEvidence(t, salesStaff, { warehouseId: w.warehouse.id, fileName: "a.png", bytes: png }))).rejects.toMatchObject({ code: "forbidden" });

    const v = await newVariant();
    await opening(v.id, 1, 5);
    await tx((t) => postMovements(t, w.ctx, {
      sourceType: "test_hold", sourceId: `h-${++n}`,
      legs: [{ type: "blocked_in", variantId: v.id, warehouseId: w.warehouse.id, binId: bins.QUAR, delta: { blocked: 1 }, unitCost: 5, line: 1, reasonCode: "suspect" }],
    }));
    const lot = await db.quarantineLot.findFirstOrThrow({ where: { variantId: v.id } });
    const done = await tx((t) => inspectLot(t, w.ctx, { lotId: lot.id, disposition: "dispose", qty: 1, evidenceIds: [e.id] }));
    expect(done.evidenceIds).toEqual([e.id]);
    await expect(tx((t) => attachEvidence(t, w.ctx, [e.id], { type: "stock_adjustment", id: "x", warehouseId: w.warehouse.id }))).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("warehouse archive (WH-02)", () => {
  test("an open purchase return blocks warehouse archive", async () => {
    const v = await newVariant();
    const po = await orderedPo([{ variantId: v.id, qty: 2, unitPrice: "5" }]);
    await receive(po.id, [{ poLineId: po.lines[0].id, accepted: 2 }]);
    await approvedReturn({ poId: po.id, reasonCode: "faulty", lines: [{ variantId: v.id, qty: 1 }] });
    const wh = await db.warehouse.findUniqueOrThrow({ where: { id: w.warehouse.id } });
    const err = await tx((t) => updateWarehouse(t, w.ctx, { id: wh.id, version: wh.version, status: "archived" })).catch((e) => e);
    expect(err).toMatchObject({ code: "conflict", details: { reason: "not_empty" } });
    expect(err.details.openReturns).toBeGreaterThan(0);
  });
});
