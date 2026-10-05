import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { reconcile } from "@/server/inventory/reconcile";
import { seedCompany } from "@/server/seed";
import { addSupplierAddress, addSupplierContact, createSupplier } from "@/server/suppliers/suppliers";
import { apiKeyHeaders, loginUser } from "@/test/auth";
import { GET as availability } from "./availability/route";
import { POST as posSale } from "./pos-sales/route";
import { POST as poAction } from "./purchase-orders/[id]/[action]/route";
import { POST as postPo } from "./purchase-orders/route";
import { POST as postReceipt } from "./receipts/route";
import { POST as rsvAction } from "./reservations/[id]/[action]/route";
import { GET as listRsv, POST as reserve } from "./reservations/route";
import { POST as cancelOrder } from "./sales-orders/[id]/cancel/route";
import { GET as getOrder } from "./sales-orders/[id]/route";

// Part 5 gate: buy → receive → reserve → fulfil end to end through the HTTP API, with a
// web-shop API key (service user bound to the `web` channel) and a POS till key.
let w: Awaited<ReturnType<typeof seedCompany>>;
let buyer: Record<string, string>, approver: Record<string, string>, receiver: Record<string, string>;
let shop: Record<string, string>, till: Record<string, string>;
const url = (p: string) => `http://localhost:3000/api/${p}`;
const send = (h: Record<string, string>, method: string, p: string, body?: unknown) =>
  new Request(url(p), { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <P>(p: P) => ({ params: Promise.resolve(p) });
const idem = (h: Record<string, string>) => ({ ...h, "idempotency-key": crypto.randomUUID() });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

beforeAll(async () => {
  w = await seedCompany(`api-sales-${crypto.randomUUID()}`);
  const wh = [w.warehouse.id];
  [buyer, approver, receiver] = await Promise.all([
    loginUser(w, "purchasing_staff").then((u) => u.signIn()).then((s) => s.headers),
    loginUser(w, "purchasing_manager").then((u) => u.signIn()).then((s) => s.headers),
    loginUser(w, "warehouse_staff", wh).then((u) => u.signIn()).then((s) => s.headers),
  ]);
  shop = (await apiKeyHeaders(w, "sales_staff", wh, "web")).headers;
  till = (await apiKeyHeaders(w, "sales_staff", wh, "pos")).headers;
});
afterAll(() => db.$disconnect());

test("buy → receive → reserve → fulfil through the API", async () => {
  // Buy + receive 10.
  const supplierId = await transaction(async (tx) => {
    const s = await createSupplier(tx, w.ctx, { name: "Alpha Supplies" });
    await addSupplierContact(tx, w.ctx, { supplierId: s.id, name: "C" });
    await addSupplierAddress(tx, w.ctx, { supplierId: s.id, type: "billing", line1: "1", city: "X", country: "AE" });
    return s.id;
  });
  const v = w.variants[0].id;
  const po = (await json(await postPo(send(buyer, "POST", "purchase-orders", {
    supplierId, warehouseId: w.warehouse.id, lines: [{ variantId: v, qty: "10", unitPrice: "4" }],
  })))).body;
  const act = (h: Record<string, string>, action: string, version: number) =>
    poAction(send(h, "POST", `purchase-orders/${po.id}/${action}`, { version }), params({ id: po.id, action }));
  expect((await act(buyer, "submit", 0)).status).toBe(200);
  expect((await act(approver, "approve", 1)).status).toBe(200);
  expect((await act(approver, "order", 2)).status).toBe(200);
  const grn = await postReceipt(send(idem(receiver), "POST", "receipts", { poId: po.id, lines: [{ poLineId: po.lines[0].id, accepted: "10" }] }));
  expect(grn.status).toBe(200);

  // ATP → reserve (web key; idempotent retry) → partial fulfil → fulfil the rest.
  const atp = await json(await availability(send(shop, "GET", `availability?variantId=${v}&warehouseId=${w.warehouse.id}`)));
  expect([atp.status, atp.body.available]).toEqual([200, "10"]);
  const h = idem(shop);
  const body = { variantId: v, warehouseId: w.warehouse.id, qty: "4", externalOrderId: "WEB-1001", channel: "pos" };
  const r1 = await json(await reserve(send(h, "POST", "reservations", body)));
  const r2 = await json(await reserve(send(h, "POST", "reservations", body)));
  expect(r1.status).toBe(200);
  expect(r2.body).toEqual(r1.body); // replayed, not reserved twice
  const rid = r1.body.reservation.id;
  const orderId = r1.body.reservation.salesOrderRefId;
  expect((await json(await availability(send(shop, "GET", `availability?variantId=${v}`)))).body.available).toBe("6");

  const step = (action: string, b: object, hh = shop) =>
    rsvAction(send(idem(hh), "POST", `reservations/${rid}/${action}`, b), params({ id: rid, action })).then(json);
  const ext = await step("extend", { version: 0 });
  expect(ext.status).toBe(200);
  expect((await step("extend", { version: 1 })).body.code).toBe("invalid_transition"); // max 1 extension
  expect((await step("fulfil", { version: 1, qty: "1" })).body.reservation.status).toBe("partially_fulfilled");
  expect((await step("fulfil", { version: 1 })).body.code).toBe("version_conflict");
  const done = await step("fulfil", { version: 2 });
  expect([done.status, done.body.reservation.status]).toEqual([200, "fulfilled"]);

  const order = await json(await getOrder(send(shop, "GET", `sales-orders/${orderId}`), params({ id: orderId })));
  expect(order.body).toMatchObject({ externalOrderId: "WEB-1001", channel: "web", status: "fulfilled" });
  const stock = await db.stockBalance.aggregate({ where: { variantId: v }, _sum: { onHand: true } });
  expect(stock._sum.onHand!.toString()).toBe("6");
  expect(await reconcile(w.ctx)).toEqual([]);
});

test("POS till sale, order cancel on payment failure, list + scope", async () => {
  const v = w.variants[0].id;
  const sale = await json(await posSale(send(idem(till), "POST", "pos-sales", { variantId: v, warehouseId: w.warehouse.id, qty: "2", externalOrderId: "T-1" })));
  expect([sale.status, sale.body.reservation.status, sale.body.movementIds.length]).toEqual([200, "fulfilled", 2]);
  const short = await json(await posSale(send(idem(till), "POST", "pos-sales", { variantId: v, warehouseId: w.warehouse.id, qty: "99" })));
  expect([short.status, short.body.code]).toEqual([409, "insufficient_stock"]);

  const r = (await json(await reserve(send(idem(shop), "POST", "reservations", { variantId: v, warehouseId: w.warehouse.id, qty: "3", externalOrderId: "WEB-1002" })))).body;
  expect(r.reservation.ttlSeconds).toBe(172800);
  const orderId = r.reservation.salesOrderRefId;
  const c = await json(await cancelOrder(send(idem(shop), "POST", `sales-orders/${orderId}/cancel`, { reason: "payment_failed" }), params({ id: orderId })));
  expect([c.status, c.body.reservations[0].status]).toEqual([200, "cancelled"]);
  expect((await json(await getOrder(send(shop, "GET", `sales-orders/${orderId}`), params({ id: orderId })))).body.status).toBe("cancelled");

  const list = await json(await listRsv(send(shop, "GET", "reservations?q=WEB-100")));
  expect([list.status, list.body.total]).toEqual([200, 2]);
  // A key scoped to no warehouse sees nothing and can't reserve.
  const blind = (await apiKeyHeaders(w, "sales_staff", [], "web")).headers;
  expect((await json(await listRsv(send(blind, "GET", "reservations")))).body.total).toBe(0);
  const denied = await reserve(send(idem(blind), "POST", "reservations", { variantId: v, warehouseId: w.warehouse.id, qty: "1" }));
  expect(denied.status).toBe(403);
  expect(await reconcile(w.ctx)).toEqual([]);
});
