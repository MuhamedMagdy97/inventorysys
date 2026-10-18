import { afterAll, beforeAll, expect, test } from "vitest";
import { buildCtx } from "@/server/auth/session-ctx";
import { createProduct } from "@/server/catalog/catalog";
import type { Ctx } from "@/server/core/ctx";
import { db, transaction } from "@/server/db";
import { approvePo, createPo, orderPo, submitPo } from "@/server/purchasing/purchase-orders";
import { postReceipt } from "@/server/purchasing/receipts";
import { createLoginUser, seedCompany } from "@/server/seed";
import { addSupplierAddress, addSupplierContact, createSupplier } from "@/server/suppliers/suppliers";
import { createWarehouse } from "@/server/warehouses/warehouses";
import { getLabels, LabelQuery } from "./labels";

let w: Awaited<ReturnType<typeof seedCompany>>;
const q = (raw: Record<string, string>) => LabelQuery.parse(raw);

beforeAll(async () => { w = await seedCompany(`labels-${crypto.randomUUID()}`); });
afterAll(() => db.$disconnect());

test("variant labels: EAN-13 when valid, SKU as Code 128 otherwise; copies; price only on request", async () => {
  const [a, b] = w.variants;
  await db.productVariant.update({ where: { id: a.id }, data: { barcode: "4006381333931", sellPrice: "12.5" } });
  const labels = await getLabels(w.ctx, q({ kind: "variant", ids: `${a.id},${b.id}`, copies: "2", price: "1" }));
  expect(labels.map((l) => l.value)).toEqual(["4006381333931", "4006381333931", b.sku, b.sku]);
  expect(labels[0].modules).toHaveLength(95);
  expect(labels[0].lines).toEqual([a.sku, "12.50 USD"]);
  expect((await getLabels(w.ctx, q({ kind: "variant", ids: a.id })))[0].lines).toEqual([a.sku]);
});

test("bin labels: whole warehouse in tree order; out-of-scope warehouse is not found", async () => {
  const labels = await getLabels(w.ctx, q({ kind: "bin", warehouse: w.warehouse.id }));
  expect(labels.map((l) => l.value).sort()).toEqual(["DMG", "MAIN", "QUAR", "RECV"]);
  const other = await transaction((tx) => createWarehouse(tx, w.ctx, { code: `L-${Date.now()}`, name: "Other" }));
  const scoped: Ctx = { ...w.ctx, warehouseIds: [w.warehouse.id], permissions: new Set(["warehouses.view"]) };
  await expect(getLabels(scoped, q({ kind: "bin", ids: other.bins[0].id }))).rejects.toMatchObject({ code: "not_found" });
  expect(await getLabels(scoped, q({ kind: "bin", ids: w.warehouse.bins[0].id }))).toHaveLength(1);
});

test("permission per kind; caps → validation_error", async () => {
  const noView: Ctx = { ...w.ctx, permissions: new Set(["warehouses.view"]) };
  await expect(getLabels(noView, q({ kind: "variant", ids: w.variants[0].id }))).rejects.toMatchObject({ code: "forbidden" });
  await expect(getLabels(noView, q({ kind: "batch", ids: crypto.randomUUID() }))).rejects.toMatchObject({ code: "forbidden" });
  await expect(getLabels(w.ctx, q({ kind: "variant" }))).rejects.toMatchObject({ code: "validation_error" });
  expect(LabelQuery.safeParse({ kind: "variant", ids: "x", copies: "101" }).success).toBe(false);
  const many = Array.from({ length: 30 }, () => w.variants[0].id).join(","); // deduped to 1
  expect(await getLabels(w.ctx, q({ kind: "variant", ids: many, copies: "100" }))).toHaveLength(100);
});

test("receipt labels: one per kept unit; batch lines get batch labels; scope via the GRN", async () => {
  const pm = await transaction((t) => createLoginUser(t, w.company.id, {
    name: "pm", email: `pm+${crypto.randomUUID()}@test.invalid`, password: "x", roleId: w.roles.find((r) => r.code === "purchasing_manager")!.id, warehouseIds: [],
  })).then((u) => buildCtx(u.id, { requestId: crypto.randomUUID(), channel: "system" }));
  const s = await transaction((t) => createSupplier(t, w.ctx, { name: "Label Supply" }));
  await transaction((t) => addSupplierContact(t, w.ctx, { supplierId: s.id, name: "Ann" }));
  await transaction((t) => addSupplierAddress(t, w.ctx, { supplierId: s.id, type: "billing", line1: "1 Road", city: "Dubai", country: "AE" }));
  const p = await transaction((t) => createProduct(t, w.ctx, { name: "Lot item", requiresBatch: true, variants: [{ sku: `LOT-${Date.now()}` }] }));
  const po = await transaction((t) => createPo(t, w.ctx, { supplierId: s.id, warehouseId: w.warehouse.id, lines: [{ variantId: w.variants[0].id, qty: 3, unitPrice: 1 }, { variantId: p.variants[0].id, qty: 2, unitPrice: 1 }] }));
  await transaction((t) => submitPo(t, w.ctx, { id: po.id, version: 0 }));
  await transaction((t) => approvePo(t, pm, { id: po.id, version: 1 }));
  const ordered = await transaction((t) => orderPo(t, w.ctx, { id: po.id, version: 2 }));
  const r = await transaction((t) => postReceipt(t, w.ctx, { poId: po.id, lines: [
    { poLineId: ordered.lines[0].id, accepted: 2, damaged: 1 }, { poLineId: ordered.lines[1].id, accepted: 2, batchNo: "RB-1" },
  ] }));
  const labels = await getLabels(w.ctx, q({ kind: "receipt", ids: r.receipt.id }));
  expect(labels.map((l) => [l.lines[0], l.value === "RB-1"])).toEqual([[w.variants[0].sku, false], [w.variants[0].sku, false], [p.variants[0].sku, true], [p.variants[0].sku, true]]);
  const elsewhere: Ctx = { ...w.ctx, warehouseIds: [crypto.randomUUID()], permissions: new Set(["inventory.receive"]) };
  await expect(getLabels(elsewhere, q({ kind: "receipt", ids: r.receipt.id }))).rejects.toMatchObject({ code: "forbidden" });
});

test("batch labels: batch no + SKU + expiry", async () => {
  const batch = await db.batch.create({ data: { companyId: w.company.id, variantId: w.variants[1].id, batchNo: "LOT-2026-01", expiryDate: new Date("2027-03-31") } });
  const [l] = await getLabels(w.ctx, q({ kind: "batch", ids: batch.id }));
  expect(l).toMatchObject({ value: "LOT-2026-01", lines: [w.variants[1].sku, "EXP 2027-03-31"] });
});
