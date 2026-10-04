import { Prisma, type ProductType, type VariantStatus } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import { requirePermission, type Ctx } from "@/server/core/ctx";
import { AppError, assertVersion } from "@/server/core/errors";
import { db, type Tx } from "@/server/db";
import { readSettings } from "@/server/settings/settings";

// Doc 04: products (parents), variants (the sellable SKUs), aliases, UOM conversions.

type Num = Prisma.Decimal | string | number;
type Money = Num | null | undefined;

export type VariantInput = {
  sku: string;
  barcode?: string | null;
  name?: string | null;
  attributes?: Record<string, string>;
  requiresInspection?: boolean;
  costPrice?: Money;
  sellPrice?: Money;
  minSellPrice?: Money;
  weightKg?: Money;
  lengthCm?: Money;
  widthCm?: Money;
  heightCm?: Money;
  status?: VariantStatus;
};

export type ProductInput = {
  name: string;
  description?: string | null;
  brandId?: string | null;
  categoryId?: string | null;
  type?: ProductType;
  status?: "draft" | "active";
  requiresBatch?: boolean;
  requiresExpiry?: boolean;
  isSerialized?: boolean;
  requiresInspection?: boolean;
  baseUom?: string;
  trackExpiryDefaultDays?: number | null;
  tags?: string[];
};

const SKU = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;

// P-CAT-01: stored upper-case; uniqueness is therefore case-insensitive.
export function normSku(sku: string) {
  const s = sku.trim().toUpperCase();
  if (!SKU.test(s)) throw new AppError("validation_error", "SKU: 3–40 of A–Z, 0–9, '-', '_' (starting with a letter or digit)", { field: "sku" });
  return s;
}

// P-CAT-02 / doc 04 §5: printable ASCII; a bad GTIN check digit is a warning, not an error.
export function checkBarcode(barcode: string | null | undefined): { barcode: string | null; warning?: string } {
  const b = barcode?.trim() || null;
  if (!b) return { barcode: null };
  if (!/^[\x21-\x7E]{1,48}$/.test(b)) throw new AppError("validation_error", "Barcode: 1–48 printable characters, no spaces", { field: "barcode" });
  if (/^(\d{8}|\d{12,14})$/.test(b)) {
    const digits = [...b].map(Number);
    const check = digits.pop()!;
    const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
    if ((10 - (sum % 10)) % 10 !== check) return { barcode: b, warning: `Barcode ${b} has an invalid EAN/UPC check digit` };
  }
  return { barcode: b };
}

// Doc 23: draft → active ↔ inactive → discontinued → archived (terminal).
const NEXT: Record<VariantStatus, VariantStatus[]> = {
  draft: ["active", "archived"],
  active: ["inactive", "discontinued", "archived"],
  inactive: ["active", "discontinued", "archived"],
  discontinued: ["archived"],
  archived: [],
};

function assertTransition(entity: string, from: VariantStatus, to: VariantStatus | undefined) {
  if (to === undefined || to === from) return;
  if (!NEXT[from].includes(to)) throw new AppError("invalid_transition", `${entity} can't go from ${from} to ${to}`, { from, to });
}

// P-CAT-06/07/09: the stricter of product and variant status decides what may happen next.
export function assertTransactable(
  v: { sku: string; status: VariantStatus; product: { status: VariantStatus } },
  kind: "new" | "existing" = "new",
) {
  const s = [v.status, v.product.status];
  if (s.includes("archived")) throw new AppError("archived_conflict", `${v.sku} is archived`, { sku: v.sku });
  if (kind === "existing") return; // P-CAT-06: open reservations still fulfil
  if (s.includes("discontinued")) throw new AppError("discontinued_conflict", `${v.sku} is discontinued`, { sku: v.sku });
  if (s.includes("draft") || s.includes("inactive")) throw new AppError("archived_conflict", `${v.sku} is not active`, { sku: v.sku });
}

const money = (v: Money, field: string) => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Prisma.Decimal(v);
  if (d.isNeg()) throw new AppError("validation_error", `${field} must be ≥ 0`, { field });
  return d;
};

function variantData(v: Omit<VariantInput, "sku" | "barcode" | "status">) {
  const sellPrice = money(v.sellPrice, "sellPrice");
  const minSellPrice = money(v.minSellPrice, "minSellPrice");
  if (sellPrice && minSellPrice && minSellPrice.gt(sellPrice)) {
    throw new AppError("validation_error", "Minimum sell price can't exceed the sell price", { field: "minSellPrice" });
  }
  return {
    name: v.name === undefined ? undefined : v.name?.trim() || null,
    attributes: v.attributes,
    requiresInspection: v.requiresInspection,
    costPrice: money(v.costPrice, "costPrice"),
    sellPrice,
    minSellPrice,
    weightKg: money(v.weightKg, "weightKg"),
    lengthCm: money(v.lengthCm, "lengthCm"),
    widthCm: money(v.widthCm, "widthCm"),
    heightCm: money(v.heightCm, "heightCm"),
  };
}

// A retired SKU (sku_alias) never comes back as a live SKU: scans would be ambiguous forever.
async function assertSkuFree(tx: Tx, ctx: Ctx, sku: string) {
  if (await tx.skuAlias.findUnique({ where: { companyId_oldSku: { companyId: ctx.companyId, oldSku: sku } } })) {
    throw new AppError("duplicate", `${sku} is a retired SKU alias`, { field: "sku" });
  }
}

// Edge #7: a new barcode may not collide with another variant's still-scanning old barcode.
async function assertBarcodeFree(tx: Tx, ctx: Ctx, barcode: string | null, variantId?: string) {
  if (!barcode) return;
  const alias = await tx.barcodeAlias.findFirst({
    where: { companyId: ctx.companyId, barcode, expiresAt: { gt: new Date() }, variantId: variantId ? { not: variantId } : undefined },
  });
  if (alias) throw new AppError("duplicate", `Barcode ${barcode} still scans as another item until ${alias.expiresAt.toISOString().slice(0, 10)}`, { field: "barcode" });
}

async function refs(tx: Tx, ctx: Ctx, input: { brandId?: string | null; categoryId?: string | null; baseUom?: string }) {
  if (input.brandId) {
    const b = await tx.brand.findFirst({ where: { id: input.brandId, companyId: ctx.companyId } });
    if (!b) throw new AppError("validation_error", "Unknown brand", { field: "brandId" });
    if (b.archived) throw new AppError("archived_conflict", "Brand is archived", { field: "brandId" });
  }
  if (input.categoryId) {
    const c = await tx.category.findFirst({ where: { id: input.categoryId, companyId: ctx.companyId } });
    if (!c) throw new AppError("validation_error", "Unknown category", { field: "categoryId" });
    if (c.archived) throw new AppError("archived_conflict", "Category is archived", { field: "categoryId" });
  }
  if (input.baseUom) {
    const u = await tx.uom.findUnique({ where: { companyId_code: { companyId: ctx.companyId, code: input.baseUom } } });
    if (!u) throw new AppError("validation_error", "Unknown unit of measure", { field: "baseUom" });
    return u;
  }
  return null;
}

function productRules(p: { name: string; type: ProductType; requiresBatch: boolean; requiresExpiry: boolean; isSerialized: boolean }, uomType?: string) {
  const name = p.name.trim();
  if (name.length < 2 || name.length > 200) throw new AppError("validation_error", "Name: 2–200 characters", { field: "name" });
  // Expiry lives on the batch, so expiry tracking needs batch tracking.
  if (p.requiresExpiry && !p.requiresBatch) throw new AppError("validation_error", "Expiry tracking requires batch tracking", { field: "requiresExpiry" });
  // P-CAT-04: serial-tracked units are discrete.
  if (p.isSerialized && uomType && uomType !== "count") throw new AppError("validation_error", "Serialized products need a count base unit", { field: "baseUom" });
  return name;
}

// Live = still sellable or about to be. P-CAT-03: a simple product has exactly one.
const LIVE: VariantStatus[] = ["draft", "active", "inactive"];

export async function createProduct(tx: Tx, ctx: Ctx, input: ProductInput & { variants: VariantInput[] }) {
  await requirePermission(ctx, "products.create");
  const type = input.type ?? "simple";
  const p = { name: input.name, type, requiresBatch: !!input.requiresBatch, requiresExpiry: !!input.requiresExpiry, isSerialized: !!input.isSerialized };
  const uom = await refs(tx, ctx, { ...input, baseUom: input.baseUom ?? "each" });
  const name = productRules(p, uom?.type);
  if (!input.variants.length || (type === "simple" && input.variants.length !== 1)) {
    throw new AppError("validation_error", type === "simple" ? "A simple product has exactly one SKU" : "Add at least one variant", { field: "variants" });
  }
  const warnings: string[] = [];
  const variants = [];
  for (const v of input.variants) {
    const sku = normSku(v.sku);
    await assertSkuFree(tx, ctx, sku);
    const { barcode, warning } = checkBarcode(v.barcode);
    if (warning) warnings.push(warning);
    await assertBarcodeFree(tx, ctx, barcode);
    variants.push({ ...variantData(v), companyId: ctx.companyId, sku, barcode, status: v.status ?? input.status ?? "active" });
  }
  const product = await tx.product.create({
    data: {
      ...p, name, companyId: ctx.companyId, status: input.status ?? "active",
      description: input.description?.trim() || null, brandId: input.brandId || null, categoryId: input.categoryId || null,
      requiresInspection: !!input.requiresInspection, baseUom: input.baseUom ?? "each",
      trackExpiryDefaultDays: input.trackExpiryDefaultDays ?? null, tags: input.tags ?? [],
      variants: { create: variants },
    },
    include: { variants: true },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "product", entityId: product.id, after: product });
  return { ...product, warnings };
}

// Has any variant of this product ever moved? Then the identity flags are frozen (P-CAT-05).
const transacted = async (tx: Tx, where: Prisma.InventoryMovementWhereInput) => !!(await tx.inventoryMovement.findFirst({ where, select: { id: true } }));

// Flow 2 + P-CAT-05. Flow 3: archiving needs no open reservations (edge #3: stock may remain).
export async function updateProduct(
  tx: Tx,
  ctx: Ctx,
  input: Omit<Partial<ProductInput>, "status"> & { id: string; version: number; status?: VariantStatus },
) {
  await requirePermission(ctx, input.status === "archived" ? "products.archive" : "products.update");
  const before = await tx.product.findFirst({ where: { id: input.id, companyId: ctx.companyId }, include: { variants: true } });
  if (!before) throw new AppError("not_found", "Product not found");
  if (before.status === "archived") throw new AppError("archived_conflict", "Product is archived");
  assertTransition("Product", before.status, input.status);

  const frozen = (["type", "baseUom", "isSerialized", "requiresBatch", "requiresExpiry"] as const)
    .filter((k) => input[k] !== undefined && input[k] !== before[k]);
  if (frozen.length && (await transacted(tx, { variant: { productId: before.id } }) || await tx.batch.count({ where: { variant: { productId: before.id } } }))) {
    throw new AppError("conflict", `${frozen.join(", ")} can't change after stock has moved (P-CAT-05)`, { reason: "immutable_flag", fields: frozen });
  }
  const next = {
    name: input.name ?? before.name, type: input.type ?? before.type,
    requiresBatch: input.requiresBatch ?? before.requiresBatch, requiresExpiry: input.requiresExpiry ?? before.requiresExpiry,
    isSerialized: input.isSerialized ?? before.isSerialized,
  };
  const uom = await refs(tx, ctx, { brandId: input.brandId, categoryId: input.categoryId, baseUom: input.baseUom ?? before.baseUom });
  const name = productRules(next, uom?.type);
  if (next.type === "simple" && before.variants.filter((v) => LIVE.includes(v.status)).length > 1) {
    throw new AppError("validation_error", "A simple product has exactly one SKU", { field: "type" });
  }
  if (input.status === "archived") await assertNoOpenReservations(tx, { variant: { productId: before.id } });

  assertVersion(await tx.product.updateMany({
    where: { id: before.id, version: input.version },
    data: {
      ...next, name, status: input.status, baseUom: input.baseUom,
      description: input.description === undefined ? undefined : input.description?.trim() || null,
      brandId: input.brandId === undefined ? undefined : input.brandId || null,
      categoryId: input.categoryId === undefined ? undefined : input.categoryId || null,
      requiresInspection: input.requiresInspection, trackExpiryDefaultDays: input.trackExpiryDefaultDays, tags: input.tags,
      version: { increment: 1 },
    },
  }), "Product", before.version);
  const after = await tx.product.findUniqueOrThrow({ where: { id: before.id } });
  await writeAudit(tx, ctx, { action: input.status === "archived" ? "archive" : "update", entityType: "product", entityId: after.id, before: { ...before, variants: undefined }, after });
  return after;
}

// Archiving must not strand reservations; Part 4/6 add open PO lines and transfers here.
async function assertNoOpenReservations(tx: Tx, where: Prisma.ReservationWhereInput) {
  const open = await tx.reservation.count({ where: { ...where, status: { in: ["active", "partially_fulfilled"] } } });
  if (open) throw new AppError("conflict", `Release or fulfil the ${open} open reservation(s) first`, { reason: "open_reservations", count: open });
}

async function findProduct(tx: Tx, ctx: Ctx, id: string) {
  const p = await tx.product.findFirst({ where: { id, companyId: ctx.companyId }, include: { variants: true } });
  if (!p) throw new AppError("not_found", "Product not found");
  if (p.status === "archived") throw new AppError("archived_conflict", "Product is archived");
  return p;
}

export async function addVariant(tx: Tx, ctx: Ctx, input: VariantInput & { productId: string }) {
  await requirePermission(ctx, "products.update");
  const product = await findProduct(tx, ctx, input.productId);
  if (product.type === "simple" && product.variants.some((v) => LIVE.includes(v.status))) {
    throw new AppError("validation_error", "A simple product has exactly one SKU; make it a variant product first", { field: "type" });
  }
  return createVariant(tx, ctx, product.id, input);
}

async function createVariant(tx: Tx, ctx: Ctx, productId: string, input: VariantInput) {
  const sku = normSku(input.sku);
  await assertSkuFree(tx, ctx, sku);
  const { barcode, warning } = checkBarcode(input.barcode);
  await assertBarcodeFree(tx, ctx, barcode);
  const variant = await tx.productVariant.create({
    data: { ...variantData(input), companyId: ctx.companyId, productId, sku, barcode, status: input.status ?? "active" },
  });
  await writeAudit(tx, ctx, { action: "create", entityType: "product_variant", entityId: variant.id, after: variant });
  return { ...variant, warnings: warning ? [warning] : [] };
}

// SKU is editable until the variant first moves (P-CAT-01); after that use replaceSku.
// A changed barcode keeps scanning as an alias for `barcodeAliasDays` (P-CAT-02, edge #7).
export async function updateVariant(tx: Tx, ctx: Ctx, input: Partial<VariantInput> & { id: string; version: number }) {
  await requirePermission(ctx, input.status === "archived" ? "products.archive" : "products.update");
  const before = await tx.productVariant.findFirst({ where: { id: input.id, companyId: ctx.companyId }, include: { product: true } });
  if (!before) throw new AppError("not_found", "Variant not found");
  if (before.status === "archived" || before.product.status === "archived") throw new AppError("archived_conflict", "Variant is archived");
  assertTransition("Variant", before.status, input.status);

  let sku: string | undefined;
  if (input.sku !== undefined && normSku(input.sku) !== before.sku) {
    sku = normSku(input.sku);
    if (await transacted(tx, { variantId: before.id })) {
      throw new AppError("conflict", "SKU can't change after stock has moved; replace the SKU instead (P-CAT-01)", { reason: "sku_immutable", field: "sku" });
    }
    await assertSkuFree(tx, ctx, sku);
  }
  const warnings: string[] = [];
  let barcode: string | null | undefined;
  if (input.barcode !== undefined) {
    const checked = checkBarcode(input.barcode);
    if (checked.warning) warnings.push(checked.warning);
    if (checked.barcode !== before.barcode) {
      barcode = checked.barcode;
      await assertBarcodeFree(tx, ctx, barcode, before.id);
      const days = (await readSettings(tx, ctx.companyId)).barcodeAliasDays;
      if (before.barcode && days > 0) {
        await tx.barcodeAlias.create({
          data: { companyId: ctx.companyId, barcode: before.barcode, variantId: before.id, expiresAt: new Date(Date.now() + days * 86_400_000) },
        });
      }
    }
  }
  if (input.status === "archived") await assertNoOpenReservations(tx, { variantId: before.id });

  assertVersion(await tx.productVariant.updateMany({
    where: { id: before.id, version: input.version },
    data: { ...variantData(input), sku, barcode, status: input.status, version: { increment: 1 } },
  }), "Variant", before.version);
  const after = await tx.productVariant.findUniqueOrThrow({ where: { id: before.id } });
  await writeAudit(tx, ctx, {
    action: input.status === "archived" ? "archive" : barcode !== undefined ? "barcode_change" : "update",
    entityType: "product_variant", entityId: after.id, before: { ...before, variants: undefined }, after,
  });
  return { ...after, warnings };
}

// P-CAT-01 "rename SKU" after stock has moved: a successor variant takes the new SKU,
// the old SKU becomes an alias of it, and the old variant is discontinued (it sells
// through; leftover stock moves with an adjustment, Part 6). Edge #6.
export async function replaceSku(tx: Tx, ctx: Ctx, input: { variantId: string; version: number; newSku: string }) {
  await requirePermission(ctx, ["products.create", "products.update"]);
  const old = await tx.productVariant.findFirst({ where: { id: input.variantId, companyId: ctx.companyId }, include: { product: true } });
  if (!old) throw new AppError("not_found", "Variant not found");
  if (old.status === "archived" || old.product.status === "archived") throw new AppError("archived_conflict", "Variant is archived");
  if (!(await transacted(tx, { variantId: old.id }))) {
    throw new AppError("validation_error", "This SKU has no stock history yet; just edit it", { field: "sku" });
  }
  assertVersion(await tx.productVariant.updateMany({
    where: { id: old.id, version: input.version },
    data: { status: old.status === "discontinued" ? undefined : "discontinued", version: { increment: 1 } },
  }), "Variant", old.version);
  const successor = await createVariant(tx, ctx, old.productId, {
    sku: input.newSku, name: old.name, attributes: old.attributes as Record<string, string>,
    requiresInspection: old.requiresInspection, costPrice: old.costPrice, sellPrice: old.sellPrice, minSellPrice: old.minSellPrice,
    weightKg: old.weightKg, lengthCm: old.lengthCm, widthCm: old.widthCm, heightCm: old.heightCm, status: "active",
  });
  await tx.skuAlias.create({ data: { companyId: ctx.companyId, oldSku: old.sku, variantId: successor.id } });
  await writeAudit(tx, ctx, {
    action: "sku_replace", entityType: "product_variant", entityId: old.id,
    before: { sku: old.sku, status: old.status }, after: { successorId: successor.id, sku: successor.sku, status: "discontinued" },
  });
  return successor;
}

// ───────────── UOM conversions (P-CAT-08, edge #8) ─────────────

// A new factor is a new effective-dated row; earlier rows (and movements that
// snapshot them) never change. Effective from now unless a future date is given.
export async function setUomConversion(
  tx: Tx,
  ctx: Ctx,
  input: { productId: string; uom: string; factor: Num; effectiveFrom?: Date },
) {
  await requirePermission(ctx, "products.update");
  const product = await findProduct(tx, ctx, input.productId);
  if (input.uom === product.baseUom) throw new AppError("validation_error", "The base unit always converts 1:1", { field: "uom" });
  const factor = new Prisma.Decimal(input.factor);
  if (factor.lte(0)) throw new AppError("validation_error", "Factor must be > 0", { field: "factor" });
  if (product.isSerialized && !factor.isInteger()) {
    throw new AppError("validation_error", "Serialized products need whole-number factors (P-CAT-04)", { field: "factor" });
  }
  const now = new Date();
  const effectiveFrom = input.effectiveFrom ?? now;
  if (effectiveFrom.getTime() < now.getTime() - 60_000) throw new AppError("validation_error", "Conversions can't be backdated", { field: "effectiveFrom" });
  if (!(await tx.uom.findUnique({ where: { companyId_code: { companyId: ctx.companyId, code: input.uom } } }))) {
    throw new AppError("validation_error", "Unknown unit of measure", { field: "uom" });
  }
  const conversion = await tx.uomConversion.create({
    data: { companyId: ctx.companyId, productId: product.id, uom: input.uom, factor, effectiveFrom, createdBy: ctx.userId },
  });
  await writeAudit(tx, ctx, { action: "uom_conversion", entityType: "product", entityId: product.id, after: conversion });
  return conversion;
}

// Base-units per 1 `uom` at time `at` (Part 4 snapshots this onto PO lines/movements).
export async function uomFactor(tx: Tx | typeof db, productId: string, uom: string, at = new Date()): Promise<Prisma.Decimal> {
  const p = await tx.product.findUniqueOrThrow({ where: { id: productId }, select: { baseUom: true } });
  if (uom === p.baseUom) return new Prisma.Decimal(1);
  const c = await tx.uomConversion.findFirst({ where: { productId, uom, effectiveFrom: { lte: at } }, orderBy: { effectiveFrom: "desc" } });
  if (!c) throw new AppError("validation_error", `No conversion from ${uom} to ${p.baseUom}`, { field: "uom" });
  return c.factor;
}

// ───────────── Per-warehouse settings, images ─────────────

// Reorder thresholds per (variant, warehouse) — edge #37. Scope-checked like stock.
export async function setVariantWarehouseSettings(
  tx: Tx,
  ctx: Ctx,
  input: { variantId: string; warehouseId: string; reorderPoint?: Money; reorderQty?: Money; maxStock?: Money },
) {
  await requirePermission(ctx, "products.update", { warehouseId: input.warehouseId });
  const variant = await tx.productVariant.findFirst({ where: { id: input.variantId, companyId: ctx.companyId } });
  const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: ctx.companyId } });
  if (!variant || !warehouse) throw new AppError("not_found", "Variant or warehouse not found");
  const data = {
    reorderPoint: money(input.reorderPoint, "reorderPoint") ?? null,
    reorderQty: money(input.reorderQty, "reorderQty") ?? null,
    maxStock: money(input.maxStock, "maxStock") ?? null,
  };
  if (data.reorderQty?.isZero()) throw new AppError("validation_error", "Reorder qty must be > 0 if set", { field: "reorderQty" });
  const key = { variantId_warehouseId: { variantId: variant.id, warehouseId: warehouse.id } };
  const before = await tx.variantWarehouseSettings.findUnique({ where: key });
  const after = await tx.variantWarehouseSettings.upsert({
    where: key, create: { companyId: ctx.companyId, variantId: variant.id, warehouseId: warehouse.id, ...data }, update: data,
  });
  await writeAudit(tx, ctx, { action: "reorder_settings", entityType: "product_variant", entityId: variant.id, warehouseId: warehouse.id, before, after });
  return after;
}

export async function addProductImage(tx: Tx, ctx: Ctx, input: { variantId: string; url: string }) {
  await requirePermission(ctx, "products.update");
  const variant = await tx.productVariant.findFirst({ where: { id: input.variantId, companyId: ctx.companyId } });
  if (!variant) throw new AppError("not_found", "Variant not found");
  if (!/^https:\/\/\S{1,2000}$/.test(input.url)) throw new AppError("validation_error", "Image URL must be https://", { field: "url" });
  const sort = await tx.productImage.count({ where: { variantId: variant.id } });
  const image = await tx.productImage.create({ data: { companyId: ctx.companyId, variantId: variant.id, url: input.url, sort } });
  await writeAudit(tx, ctx, { action: "image_add", entityType: "product_variant", entityId: variant.id, after: image });
  return image;
}

// ───────────── Reads ─────────────

export async function listProducts(
  ctx: Ctx,
  input: { page: number; perPage: number; q?: string; categoryId?: string; brandId?: string; status?: VariantStatus },
) {
  await requirePermission(ctx, "products.view");
  const q = input.q?.trim();
  const category = input.categoryId ? await db.category.findFirst({ where: { id: input.categoryId, companyId: ctx.companyId } }) : null;
  const where: Prisma.ProductWhereInput = {
    companyId: ctx.companyId,
    brandId: input.brandId,
    // P-CAT-07: archived products are hidden unless asked for explicitly.
    status: input.status ?? { not: "archived" },
    ...(category ? { category: { path: { startsWith: category.path } } } : {}),
    ...(q ? {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { variants: { some: { OR: [{ sku: { contains: q.toUpperCase() } }, { barcode: q }] } } },
      ],
    } : {}),
  };
  const [total, items] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where, orderBy: { name: "asc" }, skip: (input.page - 1) * input.perPage, take: input.perPage,
      include: {
        brand: { select: { name: true } }, category: { select: { path: true } },
        variants: { orderBy: { sku: "asc" }, select: { id: true, sku: true, name: true, status: true, barcode: true } },
      },
    }),
  ]);
  return { total, page: input.page, perPage: input.perPage, items };
}

export async function getProduct(ctx: Ctx, id: string) {
  await requirePermission(ctx, "products.view");
  const product = await db.product.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      brand: true, category: true,
      conversions: { orderBy: [{ uom: "asc" }, { effectiveFrom: "desc" }] },
      variants: {
        orderBy: { sku: "asc" },
        include: {
          images: { orderBy: { sort: "asc" } },
          skuAliases: true,
          barcodeAliases: { where: { expiresAt: { gt: new Date() } } },
          warehouseSettings: {
            where: { warehouse: { id: ctx.warehouseIds === "all" ? undefined : { in: ctx.warehouseIds } } },
            include: { warehouse: { select: { code: true } } },
          },
          supplierProducts: { include: { supplier: { select: { id: true, code: true, name: true, currency: true, status: true } } } },
          batches: { orderBy: [{ expiryDate: "asc" }, { batchNo: "asc" }], select: { id: true, batchNo: true, expiryDate: true } },
        },
      },
    },
  });
  if (!product) throw new AppError("not_found", "Product not found");
  return product;
}

export type LookupMatch = { variantId: string; sku: string; name: string; status: VariantStatus; matchedBy: "sku" | "barcode" | "sku_alias" | "barcode_alias" };
export type LookupResult = { code: string; result: "found" | "ambiguous" | "not_found"; matches: LookupMatch[] };

// T3.4 scan lookup (P-CAT-02): every code resolves by SKU, barcode, retired SKU or a
// still-valid old barcode. More than one distinct variant → "ambiguous"; the caller
// must ask the operator — never auto-pick. Archived items don't match (P-CAT-07).
export async function lookupCodes(ctx: Ctx, codes: string[]): Promise<LookupResult[]> {
  await requirePermission(ctx, "products.view");
  const raw = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  const upper = raw.map((c) => c.toUpperCase());
  const live = { status: { not: "archived" as const }, product: { status: { not: "archived" as const } } };
  const variantSelect = { id: true, sku: true, name: true, status: true, product: { select: { name: true } } } as const;
  const [direct, skuAliases, barcodeAliases] = await Promise.all([
    db.productVariant.findMany({
      where: { companyId: ctx.companyId, ...live, OR: [{ sku: { in: upper } }, { barcode: { in: raw } }] },
      select: { ...variantSelect, barcode: true },
    }),
    db.skuAlias.findMany({ where: { companyId: ctx.companyId, oldSku: { in: upper }, variant: live }, include: { variant: { select: variantSelect } } }),
    db.barcodeAlias.findMany({
      where: { companyId: ctx.companyId, barcode: { in: raw }, expiresAt: { gt: new Date() }, variant: live },
      include: { variant: { select: variantSelect } },
    }),
  ]);
  type V = { id: string; sku: string; name: string | null; status: VariantStatus; product: { name: string } };
  const m = (v: V, matchedBy: LookupMatch["matchedBy"]): LookupMatch =>
    ({ variantId: v.id, sku: v.sku, name: v.name ? `${v.product.name} — ${v.name}` : v.product.name, status: v.status, matchedBy });
  return raw.map((code) => {
    const u = code.toUpperCase();
    const all = [
      ...direct.filter((v) => v.sku === u).map((v) => m(v, "sku")),
      ...direct.filter((v) => v.barcode === code).map((v) => m(v, "barcode")),
      ...skuAliases.filter((a) => a.oldSku === u).map((a) => m(a.variant, "sku_alias")),
      ...barcodeAliases.filter((a) => a.barcode === code).map((a) => m(a.variant, "barcode_alias")),
    ];
    const matches = all.filter((x, i) => all.findIndex((y) => y.variantId === x.variantId) === i);
    return { code, result: matches.length === 0 ? "not_found" : matches.length === 1 ? "found" : "ambiguous", matches };
  });
}

// ───────────── Batches (Part 1) ─────────────

export async function createBatch(
  tx: Tx,
  ctx: Ctx,
  input: { variantId: string; batchNo: string; expiryDate?: Date },
) {
  await requirePermission(ctx, "products.update");
  await tx.productVariant.findFirstOrThrow({ where: { id: input.variantId, companyId: ctx.companyId } });
  const batch = await tx.batch.create({ data: { companyId: ctx.companyId, ...input } });
  await writeAudit(tx, ctx, { action: "create", entityType: "batch", entityId: batch.id, after: batch });
  return batch;
}
