import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { postMovements } from "@/server/inventory/post";
import { seedCompany } from "@/server/seed";
import { GET as availability } from "./availability/route";
import { GET as balances } from "./balances/route";
import { GET as movements } from "./movements/route";
import { POST as act } from "./reservations/[id]/[action]/route";
import { POST as reservations } from "./reservations/route";

// T1.10: the HTTP surface, called as Next would call it.
let w: Awaited<ReturnType<typeof seedCompany>>;
const url = (path: string, q: Record<string, string> = {}) => `http://t/api/${path}?${new URLSearchParams(q)}`;
const post = (path: string, body: unknown, key?: string) =>
  new Request(url(path), { method: "POST", body: JSON.stringify(body), headers: key ? { "idempotency-key": key } : {} });
const params = (id: string, action: string) => ({ params: Promise.resolve({ id, action }) });

beforeAll(async () => {
  w = await seedCompany("Demo Company"); // the dev request ctx acts as this company's admin
  await transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "opening", sourceId: "ob",
    legs: [{ type: "opening_balance", variantId: w.variants[0].id, warehouseId: w.warehouse.id, binId: w.warehouse.bins[0].id, delta: { onHand: 5 }, unitCost: 2, line: 1, reasonCode: "opening" }],
  }));
});
afterAll(() => db.$disconnect());

test("reserve → retry → availability → fulfil, over HTTP", async () => {
  const body = { variantId: w.variants[0].id, warehouseId: w.warehouse.id, qty: "3" };
  const r1 = await reservations(post("reservations", body, "k1"));
  expect(r1.status).toBe(200);
  const j1 = await r1.json();
  expect(j1).toMatchObject({ reservation: { status: "active", qty: "3" }, auditId: expect.any(String) });
  expect(j1.movementIds).toHaveLength(1);
  expect(j1.balances[0]).toMatchObject({ reservedAfter: "3" });

  const r2 = await reservations(post("reservations", body, "k1"));
  expect(await r2.json()).toEqual(j1); // retry → original response, no second reservation

  const a = await (await availability(new Request(url("availability", { variantId: body.variantId, warehouseId: body.warehouseId })))).json();
  expect([a.onHand, a.reserved, a.available]).toEqual(["5", "3", "2"]);

  const over = await reservations(post("reservations", { ...body, qty: 3 }, "k2"));
  expect(over.status).toBe(409);
  expect(await over.json()).toMatchObject({ code: "insufficient_stock", details: { available: "2" }, trace_id: expect.any(String) });

  const id = j1.reservation.id;
  const f = await act(post(`reservations/${id}/fulfil`, { version: 0, qty: 2 }, "k3"), params(id, "fulfil"));
  expect(f.status).toBe(200);
  expect((await f.json()).reservation.status).toBe("partially_fulfilled");
  const stale = await act(post(`reservations/${id}/cancel`, { version: 0 }, "k4"), params(id, "cancel"));
  expect([stale.status, (await stale.json()).code]).toEqual([409, "version_conflict"]);
  const c = await act(post(`reservations/${id}/cancel`, { version: 1 }, "k5"), params(id, "cancel"));
  expect((await c.json()).reservation.status).toBe("cancelled");

  const led = await (await movements(new Request(url("movements", { variantId: body.variantId, per_page: "10" })))).json();
  expect(led.items.map((m: { type: string }) => m.type)).toEqual(["reservation_release", "sale_fulfilment", "reservation", "opening_balance"]);
  const bal = await (await balances(new Request(url("balances", { variantId: body.variantId, nonZero: "true" })))).json();
  expect(bal.items).toHaveLength(1);
  expect(bal.items[0].onHand).toBe("3");
});

test("input errors: missing Idempotency-Key, bad body, unknown action", async () => {
  const body = { variantId: w.variants[0].id, warehouseId: w.warehouse.id, qty: "1" };
  expect((await reservations(post("reservations", body))).status).toBe(422);
  const bad = await reservations(post("reservations", { ...body, qty: "-1" }, "k6"));
  expect([bad.status, (await bad.json()).code]).toEqual([422, "validation_error"]);
  const id = crypto.randomUUID();
  expect((await act(post(`reservations/${id}/explode`, { version: 0 }, "k7"), params(id, "explode"))).status).toBe(404);
  expect((await act(post(`reservations/${id}/toString`, { version: 0 }, "k8"), params(id, "toString"))).status).toBe(404);
});
