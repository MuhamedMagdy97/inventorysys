import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { seedCompany } from "@/server/seed";
import { addSupplierAddress, addSupplierContact, createSupplier } from "@/server/suppliers/suppliers";
import { loginUser } from "@/test/auth";
import { POST as poAction } from "./purchase-orders/[id]/[action]/route";
import { GET as getPo } from "./purchase-orders/[id]/route";
import { POST as postPo } from "./purchase-orders/route";
import { POST as reverse } from "./receipts/[id]/reverse/route";
import { POST as postReceipt } from "./receipts/route";

// Part 4 API: buyer → approver → receiver through HTTP, idempotent GRN, scope, spec codes.
let w: Awaited<ReturnType<typeof seedCompany>>;
let buyer: Record<string, string>, approver: Record<string, string>, receiver: Record<string, string>;
let supplierId: string;
const url = (p: string) => `http://localhost:3000/api/${p}`;
const send = (h: Record<string, string>, method: string, p: string, body?: unknown) =>
  new Request(url(p), { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <P>(p: P) => ({ params: Promise.resolve(p) });

beforeAll(async () => {
  w = await seedCompany(`api-po-${crypto.randomUUID()}`);
  [buyer, approver, receiver] = await Promise.all([
    loginUser(w, "purchasing_staff").then((u) => u.signIn()).then((s) => s.headers),
    loginUser(w, "purchasing_manager").then((u) => u.signIn()).then((s) => s.headers),
    loginUser(w, "warehouse_staff", [w.warehouse.id]).then((u) => u.signIn()).then((s) => s.headers),
  ]);
  supplierId = await transaction(async (tx) => {
    const s = await createSupplier(tx, w.ctx, { name: "HTTP Supplies" });
    await addSupplierContact(tx, w.ctx, { supplierId: s.id, name: "C" });
    await addSupplierAddress(tx, w.ctx, { supplierId: s.id, type: "billing", line1: "1", city: "X", country: "AE" });
    return s.id;
  });
});
afterAll(() => db.$disconnect());

test("buy → approve → order → receive (idempotent) → reverse is forbidden for staff", async () => {
  const res = await postPo(send(buyer, "POST", "purchase-orders", {
    supplierId, warehouseId: w.warehouse.id, lines: [{ variantId: w.variants[0].id, qty: "5", unitPrice: "2.5" }],
  }));
  expect(res.status).toBe(200);
  const po = await res.json();
  expect(po.total).toBe("12.5");

  const act = (h: Record<string, string>, action: string, body: object) =>
    poAction(send(h, "POST", `purchase-orders/${po.id}/${action}`, body), params({ id: po.id, action }));
  expect((await act(buyer, "submit", { version: 0 })).status).toBe(200);
  expect((await act(buyer, "approve", { version: 1 })).status).toBe(403); // no grant + creator
  expect((await act(approver, "approve", { version: 1 })).status).toBe(200);
  const stale = await act(approver, "order", { version: 1 });
  expect([stale.status, (await stale.json()).code]).toEqual([409, "version_conflict"]);
  expect((await act(approver, "order", { version: 2 })).status).toBe(200);
  expect((await act(approver, "fly", { version: 3 })).status).toBe(404);

  // The receiver sees the receivable PO (inventory.receive, own warehouse) and posts the GRN.
  const view = await getPo(send(receiver, "GET", `purchase-orders/${po.id}`), params({ id: po.id }));
  expect((await view.json()).canReceive).toBe(true);
  const body = { poId: po.id, lines: [{ poLineId: po.lines[0].id, accepted: "5" }] };
  expect((await postReceipt(send(receiver, "POST", "receipts", body))).status).toBe(422); // Idempotency-Key required
  const key = { ...receiver, "idempotency-key": crypto.randomUUID() };
  const first = await postReceipt(send(key, "POST", "receipts", body));
  const again = await postReceipt(send(key, "POST", "receipts", body));
  const [a, b] = [await first.json(), await again.json()];
  expect(first.status).toBe(200);
  expect(b).toEqual(a);
  expect(a.poStatus).toBe("fully_received");
  expect(await db.goodsReceipt.count({ where: { poId: po.id } })).toBe(1);
  const after = await getPo(send(receiver, "GET", `purchase-orders/${po.id}`), params({ id: po.id }));
  expect([after.status, (await after.json()).canReceive]).toEqual([200, false]); // still visible once fully received

  const rev = await reverse(send({ ...receiver, "idempotency-key": crypto.randomUUID() }, "POST", `receipts/${a.receipt.id}/reverse`, { reason: "oops" }), params({ id: a.receipt.id }));
  expect(rev.status).toBe(403);
});

test("validation: zero quantity and both poLineId + variantId rejected as 422", async () => {
  const key = { ...receiver, "idempotency-key": crypto.randomUUID() };
  const res = await postReceipt(send(key, "POST", "receipts", {
    poId: crypto.randomUUID(), lines: [{ poLineId: crypto.randomUUID(), variantId: crypto.randomUUID(), accepted: "1" }],
  }));
  expect([res.status, (await res.json()).code]).toEqual([422, "validation_error"]);
  const bad = await postPo(send(buyer, "POST", "purchase-orders", { supplierId, warehouseId: w.warehouse.id, lines: [{ variantId: w.variants[0].id, qty: "0" }] }));
  expect(bad.status).toBe(422);
});
