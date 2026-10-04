import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execute } from "@/server/core/execute";
import { db, transaction, type Tx } from "@/server/db";
import { postMovements } from "@/server/inventory/post";
import { reserve } from "@/server/inventory/reservations";
import { seedCompany } from "@/server/seed";
import { updateSettings } from "@/server/settings/settings";
import {
  addVariant, checkBarcode, createProduct, lookupCodes, replaceSku, setUomConversion, setVariantWarehouseSettings,
  updateProduct, updateVariant, uomFactor,
} from "./catalog";
import { createBrand, createCategory, mergeCategory, setCategoryArchived, updateBrand, updateCategory } from "./taxonomy";

let w: Awaited<ReturnType<typeof seedCompany>>;
let n = 0;
const sku = (p = "SKU") => `${p}-${++n}`;
// execute() maps DB constraint errors to spec codes, like the API and Server Actions do.
const run = <T>(fn: (tx: Tx) => Promise<T>) => execute(w.ctx, { scope: "test" }, fn) as Promise<never>;
const tx = <T>(fn: (tx: Tx) => Promise<T>) => transaction(fn);
const simple = (s = sku(), extra = {}) => tx((t) => createProduct(t, w.ctx, { name: `P ${s}`, variants: [{ sku: s, ...extra }] }));
const stockIn = (variantId: string, qty = 3) => tx((t) => postMovements(t, w.ctx, {
  sourceType: "opening", sourceId: crypto.randomUUID(),
  legs: [{ type: "opening_balance", variantId, warehouseId: w.warehouse.id, binId: w.warehouse.bins[0].id, delta: { onHand: qty }, unitCost: 1, line: 1, reasonCode: "opening" }],
}));

beforeAll(async () => { w = await seedCompany(`catalog-${crypto.randomUUID()}`); });
afterAll(() => db.$disconnect());

describe("SKU (P-CAT-01, INV-012, edge #6)", () => {
  test("normalised to upper case; format enforced; duplicates rejected case-insensitively", async () => {
    const s = sku("ab");
    const p = await simple(s.toLowerCase());
    expect(p.variants[0].sku).toBe(s.toUpperCase());
    await expect(run((t) => createProduct(t, w.ctx, { name: "Dup", variants: [{ sku: s.toLowerCase() }] }))).rejects.toMatchObject({ code: "duplicate" });
    await expect(run((t) => createProduct(t, w.ctx, { name: "Dup", variants: [{ sku: s }] }))).rejects.toMatchObject({ code: "duplicate", details: { field: "sku" } });
    await expect(simple("x y")).rejects.toMatchObject({ code: "validation_error", details: { field: "sku" } });
  });

  test("editable before stock moves, frozen after; replaceSku → successor + alias, old discontinued", async () => {
    const p = await simple();
    const v = p.variants[0];
    const renamed = await tx((t) => updateVariant(t, w.ctx, { id: v.id, version: 0, sku: sku("NEW") }));
    expect(renamed.version).toBe(1);

    await stockIn(v.id);
    await expect(tx((t) => updateVariant(t, w.ctx, { id: v.id, version: 1, sku: sku() })))
      .rejects.toMatchObject({ code: "conflict", details: { reason: "sku_immutable" } });

    const next = sku("SUCC");
    const successor = await tx((t) => replaceSku(t, w.ctx, { variantId: v.id, version: 1, newSku: next }));
    expect(successor.sku).toBe(next);
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("discontinued");
    // The old SKU can't be reused, and scanning it finds both (old still has stock) → never auto-picked.
    await expect(simple(renamed.sku)).rejects.toMatchObject({ code: "duplicate" });
    const [hit] = await lookupCodes(w.ctx, [renamed.sku.toLowerCase()]);
    expect(hit.result).toBe("ambiguous");
    expect(hit.matches.map((m) => m.matchedBy).sort()).toEqual(["sku", "sku_alias"]);
    // Once the old variant is archived, the old SKU resolves to the successor alone.
    await tx((t) => updateVariant(t, w.ctx, { id: v.id, version: 2, status: "archived" }));
    const [after] = await lookupCodes(w.ctx, [renamed.sku]);
    expect(after).toMatchObject({ result: "found", matches: [{ variantId: successor.id, matchedBy: "sku_alias" }] });
  });

  test("simple product = exactly one live SKU (P-CAT-03)", async () => {
    const p = await simple();
    await expect(tx((t) => addVariant(t, w.ctx, { productId: p.id, sku: sku() }))).rejects.toMatchObject({ code: "validation_error" });
    await expect(tx((t) => createProduct(t, w.ctx, { name: "Two", variants: [{ sku: sku() }, { sku: sku() }] }))).rejects.toMatchObject({ code: "validation_error" });
    const parent = await tx((t) => createProduct(t, w.ctx, { name: "Shirt", type: "variant_parent", variants: [{ sku: sku(), attributes: { size: "S" } }] }));
    expect((await tx((t) => addVariant(t, w.ctx, { productId: parent.id, sku: sku(), attributes: { size: "M" } }))).attributes).toEqual({ size: "M" });
  });
});

describe("barcode (P-CAT-02, edge #7)", () => {
  test("check digit is a warning; duplicates are errors", async () => {
    expect(checkBarcode("4006381333931").warning).toBeUndefined();
    expect(checkBarcode("4006381333932").warning).toMatch(/check digit/);
    const p = await simple(sku(), { barcode: "4006381333931" });
    expect(p.warnings).toEqual([]);
    await expect(run((t) => createProduct(t, w.ctx, { name: "Dup", variants: [{ sku: sku(), barcode: "4006381333931" }] })))
      .rejects.toMatchObject({ code: "duplicate", details: { field: "barcode" } });
  });

  test("a changed barcode keeps scanning for barcodeAliasDays, then stops; nobody else can take it meanwhile", async () => {
    const old = `OLD${n}`, neu = `NEW${n}`;
    const p = await simple(sku(), { barcode: old });
    const v = p.variants[0];
    await tx((t) => updateVariant(t, w.ctx, { id: v.id, version: 0, barcode: neu }));
    const alias = await db.barcodeAlias.findFirstOrThrow({ where: { variantId: v.id } });
    const days = (alias.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    expect((await lookupCodes(w.ctx, [old]))[0]).toMatchObject({ result: "found", matches: [{ variantId: v.id, matchedBy: "barcode_alias" }] });
    expect((await lookupCodes(w.ctx, [neu]))[0]).toMatchObject({ result: "found", matches: [{ variantId: v.id, matchedBy: "barcode" }] });
    await expect(simple(sku(), { barcode: old })).rejects.toMatchObject({ code: "duplicate", details: { field: "barcode" } });
    // The variant itself may take its old barcode back.
    await tx((t) => updateVariant(t, w.ctx, { id: v.id, version: 1, barcode: old }));

    // Window over → no longer resolves.
    await db.barcodeAlias.updateMany({ where: { variantId: v.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await tx((t) => updateVariant(t, w.ctx, { id: v.id, version: 2, barcode: `X${neu}` }));
    await db.barcodeAlias.updateMany({ where: { variantId: v.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await lookupCodes(w.ctx, [old]))[0].result).toBe("not_found");
  });

  test("barcodeAliasDays = 0 → no alias", async () => {
    await tx((t) => updateSettings(t, w.ctx, { barcodeAliasDays: 0 }));
    const p = await simple(sku(), { barcode: `Z${n}` });
    await tx((t) => updateVariant(t, w.ctx, { id: p.variants[0].id, version: 0, barcode: `Y${n}` }));
    expect(await db.barcodeAlias.count({ where: { variantId: p.variants[0].id } })).toBe(0);
    await tx((t) => updateSettings(t, w.ctx, { barcodeAliasDays: 30 }));
  });
});

describe("lifecycle (doc 23, P-CAT-05/06/07/09)", () => {
  test("transitions follow the state machine; version is checked", async () => {
    const p = await tx((t) => createProduct(t, w.ctx, { name: "Draft", status: "draft", variants: [{ sku: sku() }] }));
    await expect(tx((t) => updateProduct(t, w.ctx, { id: p.id, version: 0, status: "discontinued" })))
      .rejects.toMatchObject({ code: "invalid_transition" });
    await tx((t) => updateProduct(t, w.ctx, { id: p.id, version: 0, status: "active" }));
    await expect(tx((t) => updateProduct(t, w.ctx, { id: p.id, version: 0, name: "Stale" }))).rejects.toMatchObject({ code: "version_conflict" });
  });

  test("draft/inactive/discontinued/archived variants can't be reserved", async () => {
    const reserveIt = (variantId: string) => tx((t) => reserve(t, w.ctx, { variantId, warehouseId: w.warehouse.id, qty: 1 }));
    const p = await simple();
    const v = p.variants[0];
    await stockIn(v.id);
    await tx((t) => updateVariant(t, w.ctx, { id: v.id, version: 0, status: "inactive" }));
    await expect(reserveIt(v.id)).rejects.toMatchObject({ code: "archived_conflict" });
    await tx((t) => updateVariant(t, w.ctx, { id: v.id, version: 1, status: "discontinued" }));
    await expect(reserveIt(v.id)).rejects.toMatchObject({ code: "discontinued_conflict" });
  });

  test("identity flags freeze after the first movement (immutable_flag)", async () => {
    const p = await simple();
    await tx((t) => updateProduct(t, w.ctx, { id: p.id, version: 0, requiresInspection: true, baseUom: "box" }));
    await tx((t) => updateProduct(t, w.ctx, { id: p.id, version: 1, baseUom: "each" }));
    await stockIn(p.variants[0].id);
    await expect(tx((t) => updateProduct(t, w.ctx, { id: p.id, version: 2, requiresBatch: true })))
      .rejects.toMatchObject({ code: "conflict", details: { reason: "immutable_flag", fields: ["requiresBatch"] } });
    await expect(tx((t) => updateProduct(t, w.ctx, { id: p.id, version: 2, baseUom: "kg" })))
      .rejects.toMatchObject({ details: { reason: "immutable_flag" } });
    // Other fields stay editable.
    expect((await tx((t) => updateProduct(t, w.ctx, { id: p.id, version: 2, name: "Renamed" }))).name).toBe("Renamed");
  });

  test("edge #3: archive with stock is allowed, with an open reservation it isn't", async () => {
    const p = await simple();
    const v = p.variants[0];
    await stockIn(v.id);
    const r = await tx((t) => reserve(t, w.ctx, { variantId: v.id, warehouseId: w.warehouse.id, qty: 1 }));
    await expect(tx((t) => updateProduct(t, w.ctx, { id: p.id, version: 0, status: "archived" })))
      .rejects.toMatchObject({ code: "conflict", details: { reason: "open_reservations" } });
    await db.$transaction(async (t) => {
      const { release } = await import("@/server/inventory/reservations");
      await release(t, w.ctx, { reservationId: r.reservation.id, version: r.reservation.version });
    });
    await tx((t) => updateProduct(t, w.ctx, { id: p.id, version: 0, status: "archived" }));
    expect(await db.stockBalance.aggregate({ where: { variantId: v.id }, _sum: { onHand: true } })).toMatchObject({ _sum: { onHand: expect.anything() } });
    expect((await lookupCodes(w.ctx, [v.sku]))[0].result).toBe("not_found"); // hidden (P-CAT-07)
    await expect(tx((t) => updateVariant(t, w.ctx, { id: v.id, version: 0, name: "x" }))).rejects.toMatchObject({ code: "archived_conflict" });
  });

  test("prices: ≥ 0 and min ≤ sell", async () => {
    await expect(simple(sku(), { sellPrice: "5", minSellPrice: "6" })).rejects.toMatchObject({ code: "validation_error", details: { field: "minSellPrice" } });
    await expect(simple(sku(), { sellPrice: "-1" })).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("UOM (P-CAT-04/08, edge #8)", () => {
  test("factor changes are new effective-dated rows; the old factor still answers for the past", async () => {
    const p = await simple();
    const t0 = new Date();
    await tx((t) => setUomConversion(t, w.ctx, { productId: p.id, uom: "box", factor: 12 }));
    const mid = new Date(Date.now() + 5);
    await new Promise((r) => setTimeout(r, 10));
    await tx((t) => setUomConversion(t, w.ctx, { productId: p.id, uom: "box", factor: 10 }));
    expect((await uomFactor(db, p.id, "box", mid)).toString()).toBe("12");
    expect((await uomFactor(db, p.id, "box")).toString()).toBe("10");
    expect((await uomFactor(db, p.id, "each")).toString()).toBe("1");
    await expect(uomFactor(db, p.id, "box", new Date(t0.getTime() - 1000))).rejects.toMatchObject({ code: "validation_error" });
    // History is append-only in the DB too.
    await expect(db.uomConversion.updateMany({ where: { productId: p.id }, data: { factor: 1 } })).rejects.toThrow();
  });

  test("serialized products: count base unit, whole factors", async () => {
    await expect(tx((t) => createProduct(t, w.ctx, { name: "Phone", isSerialized: true, baseUom: "kg", variants: [{ sku: sku() }] })))
      .rejects.toMatchObject({ details: { field: "baseUom" } });
    const p = await tx((t) => createProduct(t, w.ctx, { name: "Phone", isSerialized: true, variants: [{ sku: sku() }] }));
    await expect(tx((t) => setUomConversion(t, w.ctx, { productId: p.id, uom: "box", factor: "2.5" }))).rejects.toMatchObject({ details: { field: "factor" } });
    await tx((t) => setUomConversion(t, w.ctx, { productId: p.id, uom: "box", factor: 10 }));
  });
});

describe("categories (doc 04 §6, edge #24)", () => {
  test("paths follow renames and moves; cycles and depth > 5 are rejected", async () => {
    const mk = (name: string, parentId?: string) => tx((t) => createCategory(t, w.ctx, { name, parentId }));
    const a = await mk(`A${n}`);
    const b = await mk("B", a.id);
    const c = await mk("C", b.id);
    expect(c.path).toBe(`/A${n}/B/C/`);
    await expect(tx((t) => updateCategory(t, w.ctx, { id: a.id, version: 0, parentId: c.id })))
      .rejects.toMatchObject({ code: "validation_error", details: { reason: "cycle" } });
    await expect(tx((t) => updateCategory(t, w.ctx, { id: a.id, version: 0, parentId: a.id })))
      .rejects.toMatchObject({ details: { reason: "cycle" } });

    const d = await mk("D", c.id);
    const e = await mk("E", d.id);
    await expect(mk("F", e.id)).rejects.toMatchObject({ code: "validation_error" });
    const x = await mk(`X${n}`);
    await expect(tx((t) => updateCategory(t, w.ctx, { id: x.id, version: 0, parentId: e.id }))).rejects.toMatchObject({ code: "validation_error" });

    // Move B (with C, D, E below) to root and rename it: the subtree's paths and depths follow.
    await tx((t) => updateCategory(t, w.ctx, { id: b.id, version: 0, parentId: null, name: `B${n}` }));
    expect(await db.category.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ path: `/B${n}/C/D/E/`, depth: 4 });
    await expect(mk(`B${n}`)).rejects.toThrow(); // root sibling names unique
  });

  test("archive is blocked while products sit in the subtree; merge moves them and archives the loser", async () => {
    const root = await tx((t) => createCategory(t, w.ctx, { name: `R${n}` }));
    const leaf = await tx((t) => createCategory(t, w.ctx, { name: "L", parentId: root.id }));
    const other = await tx((t) => createCategory(t, w.ctx, { name: `O${n}` }));
    const p = await tx((t) => createProduct(t, w.ctx, { name: "In leaf", categoryId: leaf.id, variants: [{ sku: sku() }] }));
    await expect(tx((t) => setCategoryArchived(t, w.ctx, { id: root.id, version: 0, archived: true })))
      .rejects.toMatchObject({ code: "conflict", details: { reason: "has_products" } });
    await expect(tx((t) => mergeCategory(t, w.ctx, { fromId: root.id, intoId: other.id }))).rejects.toMatchObject({ details: { reason: "has_children" } });
    expect(await tx((t) => mergeCategory(t, w.ctx, { fromId: leaf.id, intoId: other.id }))).toEqual({ moved: 1 });
    expect((await db.product.findUniqueOrThrow({ where: { id: p.id } })).categoryId).toBe(other.id);
    await tx((t) => setCategoryArchived(t, w.ctx, { id: root.id, version: 0, archived: true }));
    await expect(tx((t) => createProduct(t, w.ctx, { name: "Nope", categoryId: root.id, variants: [{ sku: sku() }] })))
      .rejects.toMatchObject({ code: "archived_conflict" });
  });
});

test("brands: case-insensitive unique, archive hides from new products", async () => {
  const b = await tx((t) => createBrand(t, w.ctx, { name: `Acme${n}` }));
  await expect(run((t) => createBrand(t, w.ctx, { name: `ACME${n}` }))).rejects.toMatchObject({ code: "duplicate" });
  await tx((t) => updateBrand(t, w.ctx, { id: b.id, version: 0, archived: true }));
  await expect(tx((t) => createProduct(t, w.ctx, { name: "Nope", brandId: b.id, variants: [{ sku: sku() }] }))).rejects.toMatchObject({ code: "archived_conflict" });
});

test("reorder settings are per warehouse and scope-checked (edge #37)", async () => {
  const v = w.variants[0].id;
  const s = await tx((t) => setVariantWarehouseSettings(t, w.ctx, { variantId: v, warehouseId: w.warehouse.id, reorderPoint: 5, reorderQty: 20 }));
  expect(s.reorderPoint?.toString()).toBe("5");
  await expect(tx((t) => setVariantWarehouseSettings(t, w.ctx, { variantId: v, warehouseId: w.warehouse.id, reorderQty: 0 }))).rejects.toMatchObject({ code: "validation_error" });
  const scoped = { ...w.ctx, warehouseIds: [] as string[] };
  await expect(tx((t) => setVariantWarehouseSettings(t, scoped, { variantId: v, warehouseId: w.warehouse.id, reorderPoint: 1 }))).rejects.toMatchObject({ code: "forbidden" });
});
