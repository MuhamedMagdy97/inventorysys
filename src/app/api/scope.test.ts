import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { postMovements } from "@/server/inventory/post";
import { reserve } from "@/server/inventory/reservations";
import { seedCompany } from "@/server/seed";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { apiKeyHeaders, loginUser } from "@/test/auth";
import { GET as availability } from "./availability/route";
import { GET as balances } from "./balances/route";
import { GET as movements } from "./movements/route";
import { POST as act } from "./reservations/[id]/[action]/route";
import { POST as reservations } from "./reservations/route";

// Part 2 gate (INV-013/024): a user on warehouse A can't read or post warehouse B
// through any endpoint — via an API key and via a browser session.
let w: Awaited<ReturnType<typeof seedCompany>>;
let A: string, B: string, rsvB: string, variant: string;

beforeAll(async () => {
  w = await seedCompany(`scope-${crypto.randomUUID()}`);
  A = w.warehouse.id;
  const whB = await transaction((tx) => createWarehouse(tx, w.ctx, { code: "WH-B", name: "B" }));
  B = whB.id;
  variant = w.variants[0].id;
  await transaction((tx) => postMovements(tx, w.ctx, {
    sourceType: "opening", sourceId: "scope-ob",
    legs: [
      { type: "opening_balance", variantId: variant, warehouseId: A, binId: w.warehouse.bins[0].id, delta: { onHand: 5 }, unitCost: 1, line: 1, reasonCode: "opening" },
      { type: "opening_balance", variantId: variant, warehouseId: B, binId: whB.bins[0].id, delta: { onHand: 7 }, unitCost: 1, line: 2, reasonCode: "opening" },
    ],
  }));
  rsvB = (await transaction((tx) => reserve(tx, w.ctx, { variantId: variant, warehouseId: B, qty: 1 }))).reservation.id;
});
afterAll(() => db.$disconnect());

const url = (path: string, q: Record<string, string> = {}) => `http://localhost:3000/api/${path}?${new URLSearchParams(q)}`;

describe.each([
  ["API key (sales_staff on A)", async () => (await apiKeyHeaders(w, "sales_staff", [A])).headers],
  ["session (warehouse_manager on A)", async () => (await (await loginUser(w, "warehouse_manager", [A])).signIn()).headers],
])("%s", (_name, makeHeaders) => {
  let h: Record<string, string>;
  beforeAll(async () => { h = await makeHeaders(); });
  const get = (path: string, q: Record<string, string> = {}) => new Request(url(path, q), { headers: h });
  const post = (path: string, body: unknown) =>
    new Request(url(path), { method: "POST", body: JSON.stringify(body), headers: { ...h, "idempotency-key": crypto.randomUUID() } });
  const status = async (res: Response | Promise<Response>) => {
    const r = await res;
    return [r.status, r.status === 200 ? null : (await r.json()).details?.reason];
  };

  test("explicit warehouse B → 403 out_of_scope on every read", async () => {
    expect(await status(availability(get("availability", { variantId: variant, warehouseId: B })))).toEqual([403, "out_of_scope"]);
    expect(await status(balances(get("balances", { warehouseId: B })))).toEqual([403, "out_of_scope"]);
    expect(await status(movements(get("movements", { warehouseId: B })))).toEqual([403, "out_of_scope"]);
  });

  test("unfiltered reads only ever return warehouse A", async () => {
    const a = await (await availability(get("availability", { variantId: variant }))).json();
    expect(a.positions.map((p: { warehouseId: string }) => p.warehouseId)).toEqual([A]);
    expect(a.onHand).toBe("5");
    const bal = await (await balances(get("balances", { nonZero: "true" }))).json();
    expect(new Set(bal.items.map((i: { warehouseId: string }) => i.warehouseId))).toEqual(new Set([A]));
    const mv = await (await movements(get("movements"))).json();
    expect(mv.items.length).toBeGreaterThan(0);
    expect(new Set(mv.items.map((i: { warehouseId: string }) => i.warehouseId))).toEqual(new Set([A]));
  });

  test("posting to warehouse B → 403, nothing written", async () => {
    const before = await db.inventoryMovement.count({ where: { warehouseId: B } });
    const res = await reservations(post("reservations", { variantId: variant, warehouseId: B, qty: "1" }));
    expect(res.status).toBe(403);
    for (const action of ["fulfil", "release", "cancel"]) {
      const r = await act(post(`reservations/${rsvB}/${action}`, { version: 0 }), { params: Promise.resolve({ id: rsvB, action }) });
      expect(r.status).toBe(403);
    }
    expect(await db.inventoryMovement.count({ where: { warehouseId: B } })).toBe(before);
  });
});

test("every denial above was audited as access.denied on warehouse B", async () => {
  const denied = await db.auditLog.count({ where: { companyId: w.company.id, action: "access.denied", warehouseId: B } });
  expect(denied).toBe(2 * 7); // 3 reads + 1 reserve + 3 reservation actions, per auth path
});

test("every API route (except health/auth) builds ctx from the request", () => {
  const routes: string[] = [];
  const walk = (dir: string) => readdirSync(dir).forEach((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f === "route.ts") routes.push(p);
  });
  walk(join(process.cwd(), "src/app/api"));
  const open = routes.filter((r) => !/[\\/]api[\\/](health|auth)[\\/]/.test(r));
  expect(open.length).toBeGreaterThanOrEqual(5);
  for (const r of open) expect(readFileSync(r, "utf8"), r).toMatch(/requestCtx\(req, requestId\)/);
});
