"use server";

import type { VariantStatus } from "@/generated/prisma/client";
import { attributes, bool, clearable, int, str, version } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import {
  addProductImage, addVariant, createProduct, replaceSku, setUomConversion, setVariantWarehouseSettings, updateProduct, updateVariant,
} from "@/server/catalog/catalog";
import { createBrand, createCategory, createUom, mergeCategory, setCategoryArchived, updateBrand, updateCategory } from "@/server/catalog/taxonomy";

const prices = (f: FormData) => ({
  sellPrice: clearable(f, "sellPrice"), minSellPrice: clearable(f, "minSellPrice"), costPrice: clearable(f, "costPrice"),
});

export async function createProductAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("products.create", (tx, ctx) => createProduct(tx, ctx, {
    name: str(f, "name") ?? "",
    type: f.get("type") === "variant_parent" ? "variant_parent" : "simple",
    status: f.get("status") === "draft" ? "draft" : "active",
    brandId: str(f, "brandId"), categoryId: str(f, "categoryId"), baseUom: str(f, "baseUom"),
    requiresBatch: bool(f, "requiresBatch"), requiresExpiry: bool(f, "requiresExpiry"),
    isSerialized: bool(f, "isSerialized"), requiresInspection: bool(f, "requiresInspection"),
    variants: [{ sku: str(f, "sku") ?? "", barcode: str(f, "barcode"), name: str(f, "variantName"), attributes: attributes(f, "attributes"), ...prices(f) }],
  }), "Created", (p) => `/products/${p.id}`);
}

export async function updateProductAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("products.update", (tx, ctx) => updateProduct(tx, ctx, {
    id, version: version(f), name: str(f, "name"), description: clearable(f, "description"),
    brandId: clearable(f, "brandId"), categoryId: clearable(f, "categoryId"), baseUom: str(f, "baseUom"),
    type: f.get("type") === "variant_parent" ? "variant_parent" : "simple",
    requiresBatch: bool(f, "requiresBatch"), requiresExpiry: bool(f, "requiresExpiry"),
    isSerialized: bool(f, "isSerialized"), requiresInspection: bool(f, "requiresInspection"),
    trackExpiryDefaultDays: int(f, "trackExpiryDefaultDays") ?? null,
    tags: (str(f, "tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
  }));
}

export async function productStatusAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("products.status", (tx, ctx) => updateProduct(tx, ctx, { id, version: version(f), status: f.get("status") as VariantStatus }));
}

export async function addVariantAction(productId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("variants.create", (tx, ctx) => addVariant(tx, ctx, {
    productId, sku: str(f, "sku") ?? "", barcode: str(f, "barcode"), name: str(f, "variantName"), attributes: attributes(f, "attributes"), ...prices(f),
  }), "Variant added");
}

export async function updateVariantAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("variants.update", (tx, ctx) => updateVariant(tx, ctx, {
    id, version: version(f), sku: str(f, "sku"), barcode: clearable(f, "barcode"), name: clearable(f, "variantName"),
    attributes: attributes(f, "attributes") ?? {}, requiresInspection: bool(f, "requiresInspection"), ...prices(f),
    weightKg: clearable(f, "weightKg"), status: (str(f, "status") as VariantStatus | undefined),
  }));
}

export async function replaceSkuAction(variantId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("variants.replace_sku", (tx, ctx) => replaceSku(tx, ctx, { variantId, version: version(f), newSku: str(f, "newSku") ?? "" }),
    "Successor SKU created; the old SKU now scans as an alias");
}

export async function reorderAction(variantId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("variants.reorder", (tx, ctx) => setVariantWarehouseSettings(tx, ctx, {
    variantId, warehouseId: str(f, "warehouseId") ?? "",
    reorderPoint: clearable(f, "reorderPoint"), reorderQty: clearable(f, "reorderQty"), maxStock: clearable(f, "maxStock"),
  }));
}

export async function imageAction(variantId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("variants.image", (tx, ctx) => addProductImage(tx, ctx, { variantId, url: str(f, "url") ?? "" }), "Image added");
}

export async function conversionAction(productId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("products.uom", (tx, ctx) => setUomConversion(tx, ctx, { productId, uom: str(f, "uom") ?? "", factor: str(f, "factor") ?? "0" }));
}

// ───────────── Categories, brands, units ─────────────

export async function createCategoryAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("categories.create", (tx, ctx) => createCategory(tx, ctx, { name: str(f, "name") ?? "", parentId: str(f, "parentId") }), "Created");
}

export async function updateCategoryAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("categories.update", (tx, ctx) => updateCategory(tx, ctx, { id, version: version(f), name: str(f, "name"), parentId: str(f, "parentId") ?? null }));
}

export async function archiveCategoryAction(id: string, archived: boolean, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("categories.archive", (tx, ctx) => setCategoryArchived(tx, ctx, { id, version: version(f), archived }), archived ? "Archived" : "Re-activated");
}

export async function mergeCategoryAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("categories.merge", (tx, ctx) => mergeCategory(tx, ctx, { fromId: str(f, "fromId") ?? "", intoId: str(f, "intoId") ?? "" }), "Merged");
}

export async function createBrandAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("brands.create", (tx, ctx) => createBrand(tx, ctx, { name: str(f, "name") ?? "" }), "Created");
}

export async function updateBrandAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  const archived = f.get("archived");
  return runAction("brands.update", (tx, ctx) => updateBrand(tx, ctx, {
    id, version: version(f), name: str(f, "name"), archived: archived === null ? undefined : archived === "true",
  }));
}

export async function createUomAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("uom.create", (tx, ctx) => createUom(tx, ctx, {
    code: str(f, "code") ?? "", name: str(f, "name") ?? "", type: (str(f, "type") ?? "count") as "count" | "weight" | "volume" | "length",
  }), "Created");
}
