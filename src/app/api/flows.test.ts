import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { expireDueReservations, sweepExpiredBatches } from "@/server/inventory/jobs";
import { reconcile } from "@/server/inventory/reconcile";
import { seedCompany } from "@/server/seed";
import { addSupplierAddress, addSupplierContact } from "@/server/suppliers/suppliers";
import { createUser, updateUserAccess } from "@/server/users/users";
import { apiKeyHeaders, loginUser, signIn } from "@/test/auth";
import { POST as adjAction } from "./adjustments/[id]/[action]/route";
import { POST as postAdj } from "./adjustments/route";
import { POST as postCategory } from "./categories/route";
import { PATCH as patchProduct } from "./products/[id]/route";
import { POST as postProduct } from "./products/route";
import { POST as prAction } from "./purchase-returns/[id]/[action]/route";
import { POST as postPr } from "./purchase-returns/route";
import { POST as poAction } from "./purchase-orders/[id]/[action]/route";
import { POST as postPo } from "./purchase-orders/route";
import { POST as postReceipt } from "./receipts/route";
import { POST as rsvAction } from "./reservations/[id]/[action]/route";
import { POST as reserve } from "./reservations/route";
import { POST as postSupplier } from "./suppliers/route";
import { POST as trAction } from "./transfers/[id]/[action]/route";
import { POST as postTr } from "./transfers/route";
import { POST as postWarehouse } from "./warehouses/route";

// T10.1: doc 20 flows end to end over HTTP in one company, chained, then the ledger
// reconciles and every movement has its audit row. Flows already walked over HTTP in
// their Part gate files (16 returns.test, 19–21 counts.test, 6/13/15 sales.test) are not
// repeated here; the flow → test map is in 07-build/01-build-plan.md (T10.1).
let w: Awaited<ReturnType<typeof seedCompany>>;
let A: string, B: string;
let admin: H, buyer: H, purchMgr: H, staffA: H, whMgrA: H, staffB: H, mgrA: H, mgrB: H, shop: H;
let shirt: string, milk: string, shirtProduct: string, supplierId: string;
type H = Record<string, string>;
const url = (p: string) => `http://localhost:3000/api/${p}`;
const send = (h: H, method: string, p: string, body?: unknown) =>
  new Request(url(p), { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <P>(p: P) => ({ params: Promise.resolve(p) });
const idem = (h: H) => ({ ...h, "idempotency-key": crypto.randomUUID() });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const ok = async (res: Response | Promise<Response>) => {
  const r = await json(await res);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const sign = (role: string, wh: string[] = []) => loginUser(w, role, wh).then((u) => u.signIn()).then((s) => s.headers);
const stock = async (variantId: string, warehouseId = A) => {
  const b = await db.stockBalance.aggregate({ where: { variantId, warehouseId }, _sum: { onHand: true, damaged: true, expired: true } });
  return { onHand: b._sum.onHand?.toString() ?? "0", damaged: b._sum.damaged?.toString() ?? "0", expired: b._sum.expired?.toString() ?? "0" };
};
// Adjustment-family document (flows 12/17/26/27/28): create → submit → approve (posts
// damage/repair/disposal/opening; an adjustment additionally needs apply).
async function adjust(creator: H, approver: H, body: object) {
  const a = await ok(postAdj(send(creator, "POST", "adjustments", body)));
  const act = (h: H, action: string, b: object) => adjAction(send(h, "POST", `adjustments/${a.id}/${action}`, b), params({ id: a.id, action }));
  const sub = await ok(act(creator, "submit", { version: a.version }));
  return { id: a.id as string, act, approved: await ok(act(idem(approver), "approve", { version: sub.version })) };
}

beforeAll(async () => {
  w = await seedCompany(`flows-${crypto.randomUUID()}`);
  A = w.warehouse.id;
  admin = (await apiKeyHeaders(w, "admin")).headers; // admins need 2FA on web sessions
  [buyer, purchMgr, staffA, whMgrA, mgrA, mgrB] = await Promise.all([
    sign("purchasing_staff"), sign("purchasing_manager"), sign("warehouse_staff", [A]), sign("warehouse_manager", [A]),
    sign("inventory_manager"), sign("inventory_manager"),
  ]);
  shop = (await apiKeyHeaders(w, "sales_staff", [A], "web")).headers;
});
afterAll(() => db.$disconnect());

test("flows 1, 2, 4, 5: product, edit, supplier, warehouse", async () => {
  const cat = await ok(postCategory(send(admin, "POST", "categories", { name: "Apparel" })));
  const sku = `FL-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const p = await ok(postProduct(send(admin, "POST", "products", { name: "Flow shirt", categoryId: cat.id, status: "active", variants: [{ sku, costPrice: "3" }] })));
  [shirtProduct, shirt] = [p.id, p.variants[0].id];
  const dup = await json(await postProduct(send(admin, "POST", "products", { name: "Dup", variants: [{ sku: sku.toLowerCase() }] })));
  expect([dup.status, dup.body.code]).toEqual([409, "duplicate"]);
  const m = await ok(postProduct(send(admin, "POST", "products", {
    name: "Flow milk", status: "active", requiresBatch: true, requiresExpiry: true, variants: [{ sku: `${sku}-MILK` }],
  })));
  milk = m.variants[0].id;

  await ok(patchProduct(send(admin, "PATCH", `products/${p.id}`, { version: p.version, name: "Flow shirt v2" }), params({ id: p.id })));
  const edit = await db.auditLog.findFirstOrThrow({ where: { companyId: w.company.id, entityType: "product", entityId: p.id, action: "update" } });
  expect([(edit.before as { name: string }).name, (edit.after as { name: string }).name]).toEqual(["Flow shirt", "Flow shirt v2"]);

  const s = await ok(postSupplier(send(purchMgr, "POST", "suppliers", { name: "Flow Supplies" })));
  supplierId = s.id;
  await transaction(async (tx) => { // contact/address are UI-only (no HTTP route); SUP-02 needs both before ordering
    await addSupplierContact(tx, w.ctx, { supplierId, name: "C" });
    await addSupplierAddress(tx, w.ctx, { supplierId, type: "billing", line1: "1", city: "X", country: "AE" });
  });

  const wh = await ok(postWarehouse(send(admin, "POST", "warehouses", { code: "wh-flow-b", name: "Branch" })));
  expect([wh.code, wh.bins.length]).toEqual(["WH-FLOW-B", 4]);
  B = wh.id;
  staffB = await sign("warehouse_staff", [B]);
});

test("flows 6, 7, 8, 24: buy, partial + full receive, return to supplier", async () => {
  const po = await ok(postPo(send(buyer, "POST", "purchase-orders", { supplierId, warehouseId: A, lines: [{ variantId: shirt, qty: "20", unitPrice: "3" }] })));
  const act = (h: H, action: string, body: object) => poAction(send(h, "POST", `purchase-orders/${po.id}/${action}`, body), params({ id: po.id, action }));
  let v = (await ok(act(buyer, "submit", { version: po.version }))).version;
  v = (await ok(act(purchMgr, "approve", { version: v }))).version;
  await ok(act(purchMgr, "order", { version: v }));

  const grn = (accepted: string) => ok(postReceipt(send(idem(staffA), "POST", "receipts", { poId: po.id, lines: [{ poLineId: po.lines[0].id, accepted }] })));
  expect((await grn("8")).poStatus).toBe("partially_received");
  expect((await grn("12")).poStatus).toBe("fully_received");
  expect(await stock(shirt)).toMatchObject({ onHand: "20" });

  const over = await json(await postPr(send(buyer, "POST", "purchase-returns", { poId: po.id, reasonCode: "faulty", lines: [{ variantId: shirt, qty: "21" }] })));
  expect([over.status, over.body.code]).toEqual([422, "validation_error"]); // more than received
  const pr = await ok(postPr(send(buyer, "POST", "purchase-returns", { poId: po.id, reasonCode: "faulty", lines: [{ variantId: shirt, qty: "2" }] })));
  const pra = (h: H, action: string, body: object) => prAction(send(h, "POST", `purchase-returns/${pr.id}/${action}`, body), params({ id: pr.id, action }));
  v = (await ok(pra(buyer, "submit", { version: pr.version }))).version;
  v = (await ok(pra(purchMgr, "approve", { version: v }))).version;
  const shipped = await ok(pra(idem(whMgrA), "ship", { version: v }));
  expect(shipped.status).toBe("shipped");
  v = (await ok(pra(purchMgr, "confirm", { version: shipped.version, creditNoteRef: "CN-FLOW" }))).version;
  expect((await ok(pra(purchMgr, "close", { version: v }))).status).toBe("closed");
  expect(await stock(shirt)).toMatchObject({ onHand: "18" });
});

test("flows 9, 10, 11: transfer A → B, approved by someone else, received in full", async () => {
  const t = await ok(postTr(send(whMgrA, "POST", "transfers", { fromWarehouseId: A, toWarehouseId: B, lines: [{ variantId: shirt, qty: "3" }] })));
  const act = (h: H, action: string, body: object) => trAction(send(h, "POST", `transfers/${t.id}/${action}`, body), params({ id: t.id, action }));
  let v = (await ok(act(whMgrA, "submit", { version: t.version }))).version;
  expect((await json(await act(whMgrA, "approve", { version: v }))).body.code).toBe("forbidden"); // creator ≠ approver
  v = (await ok(act(mgrA, "approve", { version: v }))).version;
  v = (await ok(act(idem(whMgrA), "ship", { version: v }))).version;
  const rcv = await ok(act(idem(staffB), "receive", { version: v, lines: [{ lineId: t.lines[0].id, received: "3" }] }));
  expect(rcv.status).not.toBe("partially_received");
  expect([(await stock(shirt)).onHand, (await stock(shirt, B)).onHand]).toEqual(["15", "3"]);
});

test("flows 13, 14, 15: reserve (short → 409 + available), fulfil part, release the remainder", async () => {
  const short = await json(await reserve(send(idem(shop), "POST", "reservations", { variantId: shirt, warehouseId: A, qty: "99" })));
  expect([short.status, short.body.code, short.body.details.available]).toEqual([409, "insufficient_stock", "15"]);
  const r = (await ok(reserve(send(idem(shop), "POST", "reservations", { variantId: shirt, warehouseId: A, qty: "4" })))).reservation;
  const step = (action: string, body: object) => ok(rsvAction(send(idem(shop), "POST", `reservations/${r.id}/${action}`, body), params({ id: r.id, action })));
  const f = await step("fulfil", { version: r.version, qty: "3" });
  expect(f.reservation.status).toBe("partially_fulfilled");
  expect((await step("release", { version: f.reservation.version })).reservation.status).toBe("fulfilled");
  expect(await stock(shirt)).toMatchObject({ onHand: "12" });
});

test("flows 12, 24, 25: adjustment rejected → edited by resubmit → approved → applied", async () => {
  const a = await ok(postAdj(send(mgrA, "POST", "adjustments", { kind: "adjustment", warehouseId: A, reasonCode: "count_error", lines: [{ variantId: shirt, qty: "-1" }] })));
  const act = (h: H, action: string, b: object) => adjAction(send(h, "POST", `adjustments/${a.id}/${action}`, b), params({ id: a.id, action }));
  let v = (await ok(act(mgrA, "submit", { version: a.version }))).version;
  expect((await json(await act(idem(mgrA), "approve", { version: v }))).body.code).toBe("forbidden"); // own document
  expect((await json(await act(mgrB, "reject", { version: v }))).body.code).toBe("validation_error"); // comment required
  const rej = await ok(act(mgrB, "reject", { version: v, comment: "attach the count sheet" }));
  expect(rej.status).toBe("draft");
  v = (await ok(act(mgrA, "submit", { version: rej.version }))).version;
  v = (await ok(act(idem(mgrB), "approve", { version: v }))).version;
  expect((await ok(act(idem(mgrA), "apply", { version: v }))).status).toBe("applied");
  expect(await stock(shirt)).toMatchObject({ onHand: "11" });
});

test("flows 26, 18, 28: opening balance with a batch → batch expires → disposed", async () => {
  const asOf = new Date(Date.now() - 86_400_000);
  const ob = await adjust(mgrA, mgrB, {
    kind: "opening", warehouseId: A, reasonCode: "opening", asOf,
    lines: [{ variantId: milk, qty: "5", unitCost: "2", batchNo: "L-1", expiryDate: "2031-01-01" }],
  });
  expect(ob.approved.status).toBe("applied");
  const posted = await db.inventoryMovement.findFirstOrThrow({ where: { sourceId: ob.id } });
  expect([posted.type, posted.createdAt.getTime()]).toEqual(["opening_balance", asOf.getTime()]);

  await db.batch.updateMany({ where: { variantId: milk }, data: { expiryDate: new Date("2020-01-01") } }); // time passes
  expect(await sweepExpiredBatches({ companyId: w.company.id })).toMatchObject({ done: 1, failed: 0 });
  expect(await stock(milk)).toEqual({ onHand: "0", damaged: "0", expired: "5" });
  const batchId = posted.batchId;
  const d = await adjust(mgrA, mgrB, { kind: "disposal", warehouseId: A, reasonCode: "expired", lines: [{ variantId: milk, qty: "5", batchId, bucket: "expired" }] });
  expect(d.approved.status).toBe("applied");
  expect(await stock(milk)).toEqual({ onHand: "0", damaged: "0", expired: "0" });
});

test("flows 17, 27: damage marked by staff → approved; repaired back to stock", async () => {
  expect((await adjust(staffA, mgrB, { kind: "damage", warehouseId: A, reasonCode: "dropped", lines: [{ variantId: shirt, qty: "2" }] })).approved.status).toBe("applied");
  expect(await stock(shirt)).toMatchObject({ onHand: "9", damaged: "2" });
  expect((await adjust(mgrA, mgrB, { kind: "repair", warehouseId: A, reasonCode: "repaired", lines: [{ variantId: shirt, qty: "1" }] })).approved.status).toBe("applied");
  expect(await stock(shirt)).toMatchObject({ onHand: "10", damaged: "1" });
});

test("flows 22, 23: admin creates a user who can reserve; a role change takes effect on the next request", async () => {
  // Users/roles are managed from the admin UI's server actions, which call these same functions.
  const adminCtx = w.ctx;
  const role = (code: string) => w.roles.find((r) => r.code === code)!.id;
  const email = `seller+${crypto.randomUUID()}@test.invalid`;
  const user = await transaction((tx) => createUser(tx, adminCtx, { name: "Seller", email, password: "a-long-password", roleIds: [role("sales_staff")], warehouseIds: [A] }));
  const s = (await signIn(email, "a-long-password")).headers;
  const body = { variantId: shirt, warehouseId: A, qty: "1" };
  expect((await reserve(send(idem(s), "POST", "reservations", body))).status).toBe(200);

  await transaction((tx) => updateUserAccess(tx, adminCtx, { userId: user.id, version: user.version, roleIds: [role("viewer")], warehouseIds: [A] }));
  const denied = await json(await reserve(send(idem(s), "POST", "reservations", body)));
  expect([denied.status, denied.body.code]).toEqual([403, "forbidden"]);
  const audits = await db.auditLog.findMany({ where: { companyId: w.company.id, entityType: "user", entityId: user.id }, orderBy: { at: "asc" } });
  expect(audits.map((x) => x.action)).toEqual(["create", "auth.login", "update"]);
});

test("flows 14, 3: TTL expiry releases the open reservation; only then can the product be archived", async () => {
  const archive = async () => {
    const { version } = await db.product.findUniqueOrThrow({ where: { id: shirtProduct } });
    return json(await patchProduct(send(admin, "PATCH", `products/${shirtProduct}`, { version, status: "archived" }), params({ id: shirtProduct })));
  };
  const blocked = await archive(); // flow 22's reservation is still open
  expect([blocked.status, blocked.body.details?.reason]).toEqual([409, "open_reservations"]);
  expect(await expireDueReservations({ companyId: w.company.id, asOf: new Date(Date.now() + 30 * 86_400_000) })).toMatchObject({ done: 1, failed: 0 });
  expect((await archive()).status).toBe(200);
  expect(await stock(shirt)).toMatchObject({ onHand: "10" }); // stock stays; sell/transfer/write off separately
});

test("gate: ledger reconciles; every movement has its audit row (audit completeness)", async () => {
  expect(await reconcile(w.ctx)).toEqual([]);
  const [{ movements, orphans }] = await db.$queryRaw<{ movements: bigint; orphans: bigint }[]>`
    SELECT count(*) AS movements, count(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM audit_log a WHERE a.company_id = m.company_id AND a.entity_type = m.source_type AND a.entity_id = m.source_id
        AND (a.after->'movementIds' @> jsonb_build_array(m.id::text) OR a.after->'movementIds' @> jsonb_build_array(m.id))
    )) AS orphans
    FROM inventory_movement m WHERE m.company_id = ${w.company.id}`;
  expect(Number(movements)).toBeGreaterThan(10);
  expect(Number(orphans)).toBe(0);
});
