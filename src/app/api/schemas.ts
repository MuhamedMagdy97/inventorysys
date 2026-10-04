import { z } from "zod";
import { zId } from "@/server/core/api";

// Request bodies for the Part 3 master-data routes (catalog, suppliers, warehouses).
// Domain functions re-validate business rules; these only shape the input.

const zDec = z.union([z.string(), z.number()]).transform(String)
  .refine((s) => /^\d{1,14}(\.\d{1,6})?$/.test(s), "Must be a non-negative number");
const zMoney = zDec.nullable().optional();
const text = (max: number) => z.string().max(max);
const zStatus = z.enum(["draft", "active", "inactive", "discontinued", "archived"]);
const zMaster = z.enum(["active", "inactive", "archived"]);
export const zVersion = { version: z.number().int().min(0) };

const variantFields = {
  barcode: text(48).nullable().optional(),
  name: text(100).nullable().optional(),
  attributes: z.record(z.string().max(50), z.string().max(100)).optional(),
  requiresInspection: z.boolean().optional(),
  costPrice: zMoney, sellPrice: zMoney, minSellPrice: zMoney,
  weightKg: zMoney, lengthCm: zMoney, widthCm: zMoney, heightCm: zMoney,
};
export const VariantCreate = z.object({ sku: text(40), ...variantFields, status: zStatus.optional() });
export const VariantPatch = z.object({ ...zVersion, sku: text(40).optional(), ...variantFields, status: zStatus.optional() });

const productFields = {
  name: text(200),
  description: text(5000).nullable().optional(),
  brandId: zId.nullable().optional(),
  categoryId: zId.nullable().optional(),
  type: z.enum(["simple", "variant_parent"]).optional(),
  requiresBatch: z.boolean().optional(),
  requiresExpiry: z.boolean().optional(),
  isSerialized: z.boolean().optional(),
  requiresInspection: z.boolean().optional(),
  baseUom: text(16).optional(),
  trackExpiryDefaultDays: z.number().int().min(1).max(3650).nullable().optional(),
  tags: z.array(text(50)).max(50).optional(),
};
export const ProductCreate = z.object({ ...productFields, status: z.enum(["draft", "active"]).optional(), variants: z.array(VariantCreate).min(1).max(200) });
export const ProductPatch = z.object({ ...zVersion, ...productFields, name: text(200).optional(), status: zStatus.optional() });

export const CategoryCreate = z.object({ name: text(100), parentId: zId.nullable().optional() });
export const CategoryPatch = z.object({ ...zVersion, name: text(100).optional(), parentId: zId.nullable().optional(), archived: z.boolean().optional() });
export const BrandCreate = z.object({ name: text(100), logoUrl: z.url().nullable().optional() });
export const BrandPatch = z.object({ ...zVersion, name: text(100).optional(), logoUrl: z.url().nullable().optional(), archived: z.boolean().optional() });

const supplierFields = {
  name: text(200),
  taxId: text(50).nullable().optional(),
  paymentTerms: z.enum(["net15", "net30", "net60", "prepaid", "cod"]).optional(),
  creditLimit: zMoney,
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  notes: text(5000).nullable().optional(),
  requiresInspection: z.boolean().optional(),
};
export const SupplierCreate = z.object(supplierFields);
export const SupplierPatch = z.object({ ...zVersion, ...supplierFields, name: text(200).optional(), status: zMaster.optional() });

export const WarehouseCreate = z.object({ code: text(30), name: text(100), address: text(500).nullable().optional(), managerUserId: zId.nullable().optional() });
export const WarehousePatch = z.object({
  ...zVersion, name: text(100).optional(), address: text(500).nullable().optional(), managerUserId: zId.nullable().optional(), status: zMaster.optional(),
});
const levels = { zone: text(30).nullable().optional(), rack: text(30).nullable().optional(), shelf: text(30).nullable().optional() };
export const BinCreate = z.object({ code: text(30), type: z.enum(["sellable", "receiving", "quarantine", "damaged"]), ...levels });
export const BinPatch = z.object({ ...zVersion, code: text(30).optional(), ...levels, makeDefault: z.enum(["sellable", "receiving"]).optional(), archived: z.boolean().optional() });
