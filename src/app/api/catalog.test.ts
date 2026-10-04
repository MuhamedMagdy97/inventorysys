import { afterAll, beforeAll, expect, test } from "vitest";
import { db } from "@/server/db";
import { seedCompany } from "@/server/seed";
import { apiKeyHeaders, loginUser } from "@/test/auth";
import { PATCH as patchCategory } from "./categories/[id]/route";
import { POST as postCategory } from "./categories/route";
import { POST as lookup } from "./products/lookup/route";
import { GET as listProducts, POST as postProduct } from "./products/route";

// Part 3 API: thin routes over the catalog domain, spec error codes, permissions.
let w: Awaited<ReturnType<typeof seedCompany>>;
let mgr: Record<string, string>;
const url = (p: string) => `http://localhost:3000/api/${p}`;
const send = (h: Record<string, string>, method: string, p: string, body?: unknown) =>
  new Request(url(p), { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  w = await seedCompany(`api-cat-${crypto.randomUUID()}`);
  mgr = (await (await loginUser(w, "inventory_manager")).signIn()).headers;
});
afterAll(() => db.$disconnect());

test("create → duplicate SKU (any case) is 409 duplicate/sku; list finds it", async () => {
  const res = await postProduct(send(mgr, "POST", "products", { name: "Widget", variants: [{ sku: "wid-1", barcode: "4006381333931" }] }));
  expect(res.status).toBe(200);
  const dup = await postProduct(send(mgr, "POST", "products", { name: "Widget 2", variants: [{ sku: "WID-1" }] }));
  expect(dup.status).toBe(409);
  expect(await dup.json()).toMatchObject({ code: "duplicate", details: { field: "sku" }, trace_id: expect.any(String) });
  const list = await (await listProducts(send(mgr, "GET", "products?q=wid"))).json();
  expect(list.items.map((p: { name: string }) => p.name)).toEqual(["Widget"]);
});

test("lookup by SKU (case-insensitive) and barcode; sales channel key may scan", async () => {
  const { headers } = await apiKeyHeaders(w, "sales_staff");
  const res = await lookup(send(headers, "POST", "products/lookup", { codes: ["wid-1", "4006381333931", "nope"] }));
  const { results } = await res.json();
  expect(results.map((r: { result: string }) => r.result)).toEqual(["found", "found", "not_found"]);
  expect(results[1].matches[0]).toMatchObject({ sku: "WID-1", matchedBy: "barcode" });
});

test("no grant → 403; category cycle via API → 422", async () => {
  const staff = (await (await loginUser(w, "warehouse_staff", [w.warehouse.id])).signIn()).headers;
  expect((await postProduct(send(staff, "POST", "products", { name: "Nope", variants: [{ sku: "NOPE-1" }] }))).status).toBe(403);

  const admin = (await apiKeyHeaders(w, "admin")).headers;
  const a = await (await postCategory(send(admin, "POST", "categories", { name: "A" }))).json();
  const b = await (await postCategory(send(admin, "POST", "categories", { name: "B", parentId: a.id }))).json();
  const res = await patchCategory(send(admin, "PATCH", `categories/${a.id}`, { version: 0, parentId: b.id }), { params: Promise.resolve({ id: a.id }) });
  expect(res.status).toBe(422);
  expect((await res.json()).details.reason).toBe("cycle");
});
