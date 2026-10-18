import { afterAll, beforeAll, expect, test } from "vitest";
import { db, transaction } from "@/server/db";
import { setVariantWarehouseSettings } from "@/server/catalog/catalog";
import { seedCompany } from "@/server/seed";
import { createSupplier } from "@/server/suppliers/suppliers";
import { loginUser } from "@/test/auth";
import { GET, POST } from "./reorder/route";

// Doc 09 §6 over HTTP: suggestions need purchases.create; POST creates drafts only on request.
let w: Awaited<ReturnType<typeof seedCompany>>;
let buyer: Record<string, string>, staff: Record<string, string>, supplierId: string;
const send = (h: Record<string, string>, method: string, body?: unknown) =>
  new Request("http://localhost:3000/api/reorder", { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  w = await seedCompany(`api-reorder-${crypto.randomUUID()}`);
  [buyer, staff] = await Promise.all([
    loginUser(w, "purchasing_staff", [w.warehouse.id]).then((u) => u.signIn()).then((s) => s.headers),
    loginUser(w, "warehouse_staff", [w.warehouse.id]).then((u) => u.signIn()).then((s) => s.headers),
  ]);
  supplierId = await transaction(async (tx) => {
    const s = await createSupplier(tx, w.ctx, { name: "HTTP Supplies" });
    await tx.supplierProduct.create({ data: { supplierId: s.id, variantId: w.variants[0].id, lastPrice: 2 } });
    await setVariantWarehouseSettings(tx, w.ctx, { variantId: w.variants[0].id, warehouseId: w.warehouse.id, reorderPoint: 1, reorderQty: 4 });
    return s.id;
  });
});
afterAll(() => db.$disconnect());

test("GET suggestions → POST selection → one draft PO", async () => {
  expect((await GET(send(staff, "GET"))).status).toBe(403);
  const rows = await (await GET(send(buyer, "GET"))).json();
  expect(rows).toMatchObject([{ variantId: w.variants[0].id, suggestedQty: "4", supplierId }]);
  expect(await db.purchaseOrder.count({ where: { companyId: w.company.id } })).toBe(0);
  const bad = await POST(send(buyer, "POST", { lines: [] }));
  expect([bad.status, (await bad.json()).code]).toEqual([422, "validation_error"]);
  const res = await POST(send(buyer, "POST", { lines: [{ variantId: rows[0].variantId, warehouseId: rows[0].warehouseId, supplierId, qty: rows[0].suggestedQty }] }));
  expect(res.status).toBe(200);
  const [po] = await res.json();
  expect([po.status, po.total]).toEqual(["draft", "8"]);
  expect(await (await GET(send(buyer, "GET"))).json()).toEqual([]);
});
