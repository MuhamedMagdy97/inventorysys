import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { postMovements } from "@/server/inventory/post";
import { reconcile } from "@/server/inventory/reconcile";
import { seedCompany } from "@/server/seed";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { loginUser } from "@/test/auth";
import { POST as adjAction } from "./adjustments/[id]/[action]/route";
import { POST as postAdj } from "./adjustments/route";
import { GET as inbox } from "./approvals/route";
import { POST as trAction } from "./transfers/[id]/[action]/route";
import { GET as getTr } from "./transfers/[id]/route";
import { POST as postTr } from "./transfers/route";

// Part 6 gate through HTTP: request at A → approve → ship → partial receive at B with
// damage and a missing report → variance approved from the inbox; damage mark at B.
let w: Awaited<ReturnType<typeof seedCompany>>;
let A: string, B: string;
let whA: Record<string, string>, staffB: Record<string, string>, mgr: Record<string, string>;
const url = (p: string) => `http://localhost:3000/api/${p}`;
const send = (h: Record<string, string>, method: string, p: string, body?: unknown) =>
  new Request(url(p), { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <P>(p: P) => ({ params: Promise.resolve(p) });
const idem = (h: Record<string, string>) => ({ ...h, "idempotency-key": crypto.randomUUID() });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

beforeAll(async () => {
  w = await seedCompany(`api-tr-${crypto.randomUUID()}`);
  A = w.warehouse.id;
  B = (await transaction((tx) => createWarehouse(tx, w.ctx, { code: "WH-B", name: "Branch" }))).id;
  [whA, staffB, mgr] = await Promise.all([
    loginUser(w, "warehouse_manager", [A]).then((u) => u.signIn()).then((s) => s.headers),
    loginUser(w, "warehouse_staff", [B]).then((u) => u.signIn()).then((s) => s.headers),
    loginUser(w, "inventory_manager").then((u) => u.signIn()).then((s) => s.headers),
  ]);
  await transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "opening", sourceId: "ob-1",
    legs: [{ type: "opening_balance", variantId: w.variants[0].id, warehouseId: A, binId: w.warehouse.bins.find((b) => b.code === "MAIN")!.id, delta: { onHand: 10 }, unitCost: 5, line: 1, reasonCode: "opening" }],
  }));
});
afterAll(() => db.$disconnect());

test("transfer A → B with damaged + missing, variance decided from the inbox", async () => {
  const v = w.variants[0].id;
  const created = await json(await postTr(send(whA, "POST", "transfers", { fromWarehouseId: A, toWarehouseId: B, lines: [{ variantId: v, qty: "6" }] })));
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  const lineId = created.body.lines[0].id as string;
  const act = (h: Record<string, string>, action: string, body: object) =>
    trAction(send(h, "POST", `transfers/${id}/${action}`, body), params({ id, action }));

  expect((await act(whA, "submit", { version: 0 })).status).toBe(200);
  expect((await json(await act(whA, "approve", { version: 1 }))).body.code).toBe("forbidden"); // creator ≠ approver
  expect((await act(mgr, "approve", { version: 1 })).status).toBe(200);
  expect((await json(await act(whA, "ship", { version: 2 }))).body.code).toBe("validation_error"); // Idempotency-Key required
  expect((await act(idem(whA), "ship", { version: 2 })).status).toBe(200);
  // staff at B can't ship from A (scope), can receive at B
  expect((await json(await act(idem(staffB), "receive", { version: 3, lines: [{ lineId, received: "7" }] }))).body.code).toBe("validation_error"); // TR-03
  const rcv = await json(await act(idem(staffB), "receive", { version: 3, lines: [{ lineId, received: "4", damaged: "1", missing: "1" }] }));
  expect([rcv.status, rcv.body.status]).toEqual([200, "partially_received"]);

  const box = (await json(await inbox(send(mgr, "GET", "approvals")))).body;
  const item = box.items.find((i: { id: string }) => i.id === id);
  expect(item).toMatchObject({ type: "transfer_variance", amount: "5.00" });
  const ok = await json(await act(idem(mgr), "variance", { version: item.version, approve: true, comment: "carrier claim" }));
  expect([ok.status, ok.body.status]).toEqual([200, "closed_with_variance"]);

  const t = (await json(await getTr(send(staffB, "GET", `transfers/${id}`), params({ id })))).body;
  expect(t.lines[0]).toMatchObject({ qtyShipped: "6", qtyReceived: "4", qtyDamaged: "1", qtyMissing: "1", inTransit: "0" });
  expect(t.movements.map((m: { type: string }) => m.type)).toEqual(["transfer_out", "transfer_in", "transfer_in", "transfer_variance"]);
  expect(await reconcile(w.ctx)).toEqual([]);
});

test("damage mark at B by staff → approved by the manager → applied", async () => {
  const v = w.variants[0].id;
  const created = await json(await postAdj(send(staffB, "POST", "adjustments", { kind: "damage", warehouseId: B, reasonCode: "dropped", lines: [{ variantId: v, qty: "1" }] })));
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  const act = (h: Record<string, string>, action: string, body: object) =>
    adjAction(send(h, "POST", `adjustments/${id}/${action}`, body), params({ id, action }));
  expect((await act(staffB, "submit", { version: 0 })).status).toBe(200);
  expect((await json(await act(idem(staffB), "approve", { version: 1 }))).body.code).toBe("forbidden"); // no damage_approve
  const ok = await json(await act(idem(mgr), "approve", { version: 1 }));
  expect([ok.status, ok.body.status]).toEqual([200, "applied"]);
  const b = await db.stockBalance.aggregate({ where: { variantId: v, warehouseId: B }, _sum: { onHand: true, damaged: true } });
  expect([b._sum.onHand!.toString(), b._sum.damaged!.toString()]).toEqual(["3", "2"]);
});
