import { afterAll, beforeAll, expect, test } from "vitest";
import { buildCtx } from "@/server/auth/session-ctx";
import { setVariantWarehouseSettings } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction, type Tx } from "@/server/db";
import { postMovements } from "@/server/inventory/post";
import { createLoginUser, seedCompany } from "@/server/seed";
import { createSupplier } from "@/server/suppliers/suppliers";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { createPo } from "./purchase-orders";
import { createReorderPos, listReorderSuggestions, suggestQty } from "./reorder";

// Doc 09 §6: RO-02 trigger, RO-03 qty, RO-04 supplier choice, RO-05 draft POs, RO-06 scope.
let w: Awaited<ReturnType<typeof seedCompany>>;
let A: string, B: string, v0: string, v1: string, s1: string, s2: string;
let buyerA: Ctx; // purchasing_staff scoped to A
const tx = <T>(fn: (tx: Tx) => Promise<T>) => transaction(fn);
const poCount = () => db.purchaseOrder.count({ where: { companyId: w.company.id } });

beforeAll(async () => {
  w = await seedCompany(`reorder-${crypto.randomUUID()}`);
  A = w.warehouse.id;
  [v0, v1] = w.variants.map((v) => v.id);
  const b = await tx((t) => createWarehouse(t, w.ctx, { code: "WH-B-01", name: "B" }));
  B = b.id;
  s1 = (await tx((t) => createSupplier(t, w.ctx, { name: "Pricey" }))).id;
  s2 = (await tx((t) => createSupplier(t, w.ctx, { name: "Cheap" }))).id;
  await db.supplierProduct.createMany({
    data: [
      { supplierId: s1, variantId: v0, lastPrice: 3, minOrderQty: 25 },
      { supplierId: s2, variantId: v0, lastPrice: 2.5, isPreferred: true },
      { supplierId: s1, variantId: v1, lastPrice: 4 },
    ],
  });
  await tx((t) => postMovements(t, w.ctx, {
    sourceType: "opening", sourceId: crypto.randomUUID(),
    legs: [{ type: "opening_balance", variantId: v0, warehouseId: A, binId: w.warehouse.bins[0].id, delta: { onHand: 8 }, unitCost: 1, line: 1, reasonCode: "opening" }],
  }));
  await tx(async (t) => {
    // v0@A: available 8 ≤ 10, warehouse prefers s1 (MOQ 25) over the globally preferred s2.
    await setVariantWarehouseSettings(t, w.ctx, { variantId: v0, warehouseId: A, reorderPoint: 10, reorderQty: 20, preferredSupplierId: s1 });
    await setVariantWarehouseSettings(t, w.ctx, { variantId: v1, warehouseId: A, reorderPoint: 5, maxStock: 30 }); // up to max
    await setVariantWarehouseSettings(t, w.ctx, { variantId: v0, warehouseId: B, reorderPoint: 3, reorderQty: 6 });
    await setVariantWarehouseSettings(t, w.ctx, { variantId: v1, warehouseId: B, reorderPoint: 3, reorderQty: 6 });
  });
  // v1@B already has 5 on a draft PO → position 5 > 3, not suggested.
  await tx((t) => createPo(t, w.ctx, { supplierId: s1, warehouseId: B, lines: [{ variantId: v1, qty: 5 }] }));
  const roleId = w.roles.find((r) => r.code === "purchasing_staff")!.id;
  const u = await tx((t) => createLoginUser(t, w.company.id, { name: "buyer", email: `b+${crypto.randomUUID()}@test.invalid`, password: "x", roleId, warehouseIds: [A] }));
  buyerA = await buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" });
});
afterAll(() => db.$disconnect());

test("RO-03 suggested qty", () => {
  const q = (r: Parameters<typeof suggestQty>[0]) => suggestQty(r).toString();
  expect(q({ position: 8, reorderPoint: 10, reorderQty: 20 })).toBe("20");
  expect(q({ position: -5, reorderPoint: 10, reorderQty: 5 })).toBe("15"); // shortfall beats reorder qty
  expect(q({ position: 4, reorderPoint: 5, maxStock: 30, reorderQty: 100 })).toBe("26"); // max wins
  expect(q({ position: 8, reorderPoint: 10, reorderQty: 20, minOrderQty: 25 })).toBe("25");
  expect(q({ position: 10, reorderPoint: 10 })).toBe("0");
  expect(q({ position: 1.5, reorderPoint: 3, serialized: true })).toBe("2");
});

test("RO-02/04 suggestions: trigger, open POs, supplier choice + price order", async () => {
  const before = await poCount();
  const rows = await listReorderSuggestions(w.ctx);
  expect(rows.map((r) => [r.warehouseCode, r.sku, r.suggestedQty, r.supplierId])).toEqual([
    ["WH-B-01", "TSHIRT-RED-M", "6", s2], // no warehouse preference → global is_preferred
    ["WH-MAIN-01", "TSHIRT-BLUE-M", "30", s1],
    ["WH-MAIN-01", "TSHIRT-RED-M", "25", s1], // warehouse preference, raised to its MOQ
  ]);
  const red = rows[2];
  expect([red.available, red.onOrder, red.position]).toEqual(["8", "0", "8"]);
  expect(red.suppliers.map((o) => [o.name, o.lastPrice])).toEqual([["Cheap", "2.5"], ["Pricey", "3"]]);
  expect(await poCount()).toBe(before); // INV-016: listing never creates a PO
});

test("RO-06 scope: a buyer sees only their warehouses", async () => {
  expect((await listReorderSuggestions(buyerA)).every((r) => r.warehouseId === A)).toBe(true);
  await expect(listReorderSuggestions(buyerA, { warehouseId: B })).rejects.toMatchObject({ code: "forbidden" });
  const before = await poCount();
  await expect(tx((t) => createReorderPos(t, buyerA, { lines: [
    { variantId: v0, warehouseId: A, supplierId: s1, qty: 1 },
    { variantId: v0, warehouseId: B, supplierId: s1, qty: 1 },
  ] }))).rejects.toMatchObject({ code: "forbidden" });
  expect(await poCount()).toBe(before);
  await expect(listReorderSuggestions({ ...w.ctx, permissions: new Set(["purchases.view"]) })).rejects.toMatchObject({ code: "forbidden" });
});

test("RO-05 selected suggestions → one draft PO per supplier + warehouse; suggestion clears", async () => {
  await expect(tx((t) => createReorderPos(t, buyerA, { lines: [
    { variantId: v0, warehouseId: A, supplierId: s1, qty: 1 }, { variantId: v0, warehouseId: A, supplierId: s2, qty: 1 },
  ] }))).rejects.toMatchObject({ code: "validation_error" });
  const pos = await tx((t) => createReorderPos(t, buyerA, { lines: [
    { variantId: v0, warehouseId: A, supplierId: s1, qty: 25 },
    { variantId: v1, warehouseId: A, supplierId: s1, qty: "30" },
  ] }));
  expect(pos).toHaveLength(1);
  expect(pos[0]).toMatchObject({ status: "draft", supplierId: s1, warehouseId: A, createdBy: buyerA.userId, notes: "Created from reorder suggestions" });
  expect(pos[0].lines.map((l) => [l.sku, l.qtyOrderedBase.toString(), l.unitPrice.toString()])).toEqual([["TSHIRT-RED-M", "25", "3"], ["TSHIRT-BLUE-M", "30", "4"]]);
  expect(pos[0].total.toString()).toBe("195");
  expect((await listReorderSuggestions(buyerA)).filter((r) => r.warehouseId === A)).toEqual([]); // drafts count as on order
});
