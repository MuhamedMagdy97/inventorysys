import { z } from "zod";
import { zId, zQty } from "@/server/core/api";

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
  receiptTolerancePct: zMoney,
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

// ───────────── Part 4: purchasing + receiving ─────────────
const zQty4 = zDec.refine((s) => Number(s) > 0 && /^\d+(\.\d{1,4})?$/.test(s), "Must be > 0 with ≤ 4 decimals");
const zQty0 = zDec.refine((s) => /^\d+(\.\d{1,4})?$/.test(s), "Max 4 decimals").optional();
const zPct = zDec.refine((s) => Number(s) <= 100, "0–100").optional();
const poLine = z.object({
  id: zId.optional(), variantId: zId, qty: zQty4, uom: text(16).optional(),
  unitPrice: zDec.optional(), discountPct: zPct, taxPct: zPct,
});
const poHeader = {
  expectedDate: z.coerce.date().nullable().optional(), notes: text(5000).nullable().optional(),
  discount: zDec.optional(), tax: zDec.optional(), shipping: zDec.optional(),
};
export const PoCreate = z.object({ ...poHeader, supplierId: zId, warehouseId: zId, lines: z.array(poLine).min(1).max(500) });
export const PoPatch = z.object({ ...zVersion, ...poHeader, supplierId: zId.optional(), lines: z.array(poLine).min(1).max(500).optional() });
export const PoAction = z.object({
  ...zVersion, comment: text(2000).nullable().optional(), reason: text(2000).nullable().optional(),
  lineId: zId.optional(), qty: zQty4.optional(), // reduce-line
});
export const ReceiptCreate = z.object({
  poId: zId, supplierRef: text(100).nullable().optional(), note: text(2000).nullable().optional(),
  lines: z.array(z.object({
    poLineId: zId.optional(), variantId: zId.optional(), uom: text(16).optional(),
    accepted: zQty0, damaged: zQty0, expired: zQty0, missing: zQty0, qty: zQty0, held: z.boolean().optional(),
    binId: zId.optional(), batchNo: text(60).optional(), expiryDate: z.coerce.date().optional(), mfgDate: z.coerce.date().optional(),
    serials: z.array(text(100)).max(10000).optional(), damagedSerials: z.array(text(100)).max(10000).optional(), note: text(2000).optional(),
  }).refine((l) => !!l.poLineId !== !!l.variantId, "Give either poLineId or variantId (wrong product)")).min(1).max(500),
});
export const ReceiptReverse = z.object({ reason: text(2000) });
export const ExcessDecision = z.object({ approve: z.boolean(), comment: text(2000).nullable().optional() });

// ───────────── Part 6: transfers, adjustments ─────────────
const zSignedQty = z.union([z.string(), z.number()]).transform(String)
  .refine((s) => /^-?\d{1,14}(\.\d{1,4})?$/.test(s) && Number(s) !== 0, "Must be a non-zero number with ≤ 4 decimals");
const zSerials = z.array(text(100)).max(10000).optional();
export const TransferCreate = z.object({
  fromWarehouseId: zId, toWarehouseId: zId, notes: text(2000).nullable().optional(),
  lines: z.array(z.object({ variantId: zId, qty: zQty4, batchId: zId.nullable().optional() })).min(1).max(500),
});
export const TransferAction = z.object({
  ...zVersion, comment: text(2000).nullable().optional(), reason: text(2000).nullable().optional(), note: text(2000).nullable().optional(),
  approve: z.boolean().optional(), // variance
  lines: z.array(z.object({
    lineId: zId, qty: zQty0, serials: zSerials, // ship
    received: zQty0, damaged: zQty0, missing: zQty0, binId: zId.optional(), damagedSerials: zSerials, // receive
  })).max(500).optional(),
});
export const AdjustmentCreate = z.object({
  kind: z.enum(["adjustment", "damage", "repair", "disposal", "opening"]), warehouseId: zId, reasonCode: text(50), note: text(2000).nullable().optional(),
  asOf: z.coerce.date().nullable().optional(), // opening only (MV-04)
  lines: z.array(z.object({
    variantId: zId, qty: zSignedQty, batchId: zId.nullable().optional(), binId: zId.nullable().optional(),
    batchNo: text(60).nullable().optional(), expiryDate: z.coerce.date().nullable().optional(), // opening
    bucket: z.enum(["damaged", "expired", "blocked"]).nullable().optional(), unitCost: zDec.nullable().optional(), serials: zSerials,
  })).min(1).max(500),
  evidenceIds: z.array(zId).max(20).optional(), // uploaded via POST /api/evidence
});
export const AdjustmentAction = z.object({ ...zVersion, comment: text(2000).nullable().optional() });

// ───────────── Part 8: counts, imports ─────────────
export const CountCreate = z.object({
  warehouseId: zId, binId: zId.nullable().optional(), variantIds: z.array(zId).max(500).optional(), note: text(2000).nullable().optional(),
});
export const CountAction = z.object({
  version: z.number().int().min(0).optional(), // required except for entries (concurrent counters)
  comment: text(2000).nullable().optional(),
  lineIds: z.array(zId).max(5000).optional(), // recount
  entries: z.array(z.object({
    lineId: zId.optional(), binId: zId.optional(), variantId: zId.optional(), batchId: zId.nullable().optional(),
    countedQty: zQty0, serials: zSerials,
  })).max(5000).optional(),
});
export const ImportConfirm = z.object({ ...zVersion, mode: z.enum(["all_or_nothing", "valid_only"]).optional() });
// ───────────── Part 7: returns + inspection ─────────────
const zEvidenceIds = z.array(zId).max(20).optional();
export const PurchaseReturnCreate = z.object({
  poId: zId, reasonCode: text(50), note: text(2000).nullable().optional(),
  lines: z.array(z.object({
    variantId: zId, qty: zQty4, batchId: zId.nullable().optional(), bucket: z.enum(["onHand", "blocked", "damaged", "expired"]).optional(),
    receiptLineId: zId.nullable().optional(), serials: zSerials,
  })).min(1).max(500),
});
export const PurchaseReturnAction = z.object({
  ...zVersion, comment: text(2000).nullable().optional(), note: text(2000).nullable().optional(), creditNoteRef: text(100).nullable().optional(),
  lines: z.array(z.object({ lineId: zId, receiptLineId: zId })).max(500).optional(), // ship: re-point lots
});
export const SalesReturnCreate = z.object({
  reasonCode: text(50), note: text(2000).nullable().optional(),
  lines: z.array(z.object({ reservationId: zId, qty: zQty4, batchId: zId.nullable().optional(), serials: zSerials })).min(1).max(500),
});
export const SalesReturnAction = z.object({
  ...zVersion, comment: text(2000).nullable().optional(),
  lines: z.array(z.object({ lineId: zId, qty: zQty0, expiryDate: z.coerce.date().nullable().optional() })).max(500).optional(), // receive
});
export const InspectBody = z.object({
  disposition: z.enum(["restockable", "damaged", "defective", "missing_parts", "expired", "dispose"]),
  qty: zQty4, binId: zId.nullable().optional(), note: text(2000).nullable().optional(), serials: zSerials, evidenceIds: zEvidenceIds,
});

// ───────────── Part 5: sales channels ─────────────
export const ReserveBody = z.object({
  variantId: zId,
  warehouseId: zId,
  qty: zQty,
  batchId: zId.optional(),
  allowPartial: z.boolean().optional(),
  allowSubstitution: z.boolean().optional(),
  ttlSeconds: z.number().int().positive().optional(),
  externalOrderId: z.string().trim().min(1).max(100).optional(),
  channel: z.enum(["pos", "web", "marketplace", "api"]).optional(), // staff only; API keys act as their own channel (SO-06)
  serials: z.array(z.string().max(100)).max(10000).optional(), // POS sale of serialized items (S-02)
});
