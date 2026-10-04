-- CreateEnum
CREATE TYPE "product_type" AS ENUM ('simple', 'variant_parent');

-- CreateEnum
CREATE TYPE "uom_type" AS ENUM ('count', 'weight', 'volume', 'length');

-- CreateEnum
CREATE TYPE "payment_terms" AS ENUM ('net15', 'net30', 'net60', 'prepaid', 'cod');

-- CreateEnum
CREATE TYPE "address_type" AS ENUM ('billing', 'shipping', 'primary');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "variant_status" ADD VALUE IF NOT EXISTS 'draft';
ALTER TYPE "variant_status" ADD VALUE IF NOT EXISTS 'inactive';

-- AlterTable
ALTER TABLE "bin" ADD COLUMN     "rack" TEXT,
ADD COLUMN     "shelf" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "zone" TEXT;

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "brand_id" TEXT,
ADD COLUMN     "category_id" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "requires_inspection" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "track_expiry_default_days" INTEGER,
ADD COLUMN     "type" "product_type" NOT NULL DEFAULT 'simple',
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "product_variant" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "cost_price" DECIMAL(18,4),
ADD COLUMN     "height_cm" DECIMAL(18,4),
ADD COLUMN     "length_cm" DECIMAL(18,4),
ADD COLUMN     "min_sell_price" DECIMAL(18,4),
ADD COLUMN     "name" TEXT,
ADD COLUMN     "requires_inspection" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sell_price" DECIMAL(18,4),
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "weight_kg" DECIMAL(18,4),
ADD COLUMN     "width_cm" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "warehouse" ADD COLUMN     "address" TEXT,
ADD COLUMN     "manager_user_id" TEXT;

-- CreateTable
CREATE TABLE "category" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_url" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uom" (
    "company_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "uom_type" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uom_pkey" PRIMARY KEY ("company_id","code")
);

-- Hand SQL: default units for existing companies (same list as DEFAULT_UOMS in
-- src/server/catalog/taxonomy.ts), so product.base_uom = 'each' satisfies its new FK.
INSERT INTO "uom" ("company_id", "code", "name", "type")
SELECT c."id", u.code, u.name, u.type::"uom_type"
FROM "company" c CROSS JOIN (VALUES
  ('each', 'Each', 'count'), ('pack', 'Pack', 'count'), ('box', 'Box', 'count'), ('case', 'Case', 'count'),
  ('kg', 'Kilogram', 'weight'), ('g', 'Gram', 'weight'), ('l', 'Litre', 'volume'), ('ml', 'Millilitre', 'volume'),
  ('m', 'Metre', 'length'), ('cm', 'Centimetre', 'length')
) AS u(code, name, type);

-- CreateTable
CREATE TABLE "uom_conversion" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "factor" DECIMAL(18,6) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uom_conversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_alias" (
    "company_id" TEXT NOT NULL,
    "old_sku" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sku_alias_pkey" PRIMARY KEY ("company_id","old_sku")
);

-- CreateTable
CREATE TABLE "barcode_alias" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barcode_alias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_image" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_warehouse_settings" (
    "company_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "reorder_point" DECIMAL(18,4),
    "reorder_qty" DECIMAL(18,4),
    "max_stock" DECIMAL(18,4),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_warehouse_settings_pkey" PRIMARY KEY ("variant_id","warehouse_id")
);

-- CreateTable
CREATE TABLE "supplier" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "master_status" NOT NULL DEFAULT 'active',
    "tax_id" TEXT,
    "payment_terms" "payment_terms" NOT NULL DEFAULT 'net30',
    "credit_limit" DECIMAL(18,2),
    "currency" TEXT NOT NULL,
    "lead_time_days" INTEGER,
    "notes" TEXT,
    "requires_inspection" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_contact" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_address" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "type" "address_type" NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "postal_code" TEXT,
    "country" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_product" (
    "supplier_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "supplier_sku" TEXT,
    "last_price" DECIMAL(18,4),
    "min_order_qty" DECIMAL(18,4),
    "lead_days" INTEGER,
    "is_preferred" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_product_pkey" PRIMARY KEY ("supplier_id","variant_id")
);

-- CreateTable
CREATE TABLE "supplier_document" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "category_sibling_name_key" ON "category"("company_id", "parent_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "uom_conversion_product_id_uom_effective_from_key" ON "uom_conversion"("product_id", "uom", "effective_from");

-- CreateIndex
CREATE INDEX "barcode_alias_company_id_barcode_idx" ON "barcode_alias"("company_id", "barcode");

-- CreateIndex
CREATE INDEX "product_image_variant_id_idx" ON "product_image"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_company_id_code_key" ON "supplier"("company_id", "code");

-- CreateIndex
CREATE INDEX "product_category_id_idx" ON "product"("category_id");

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_company_id_manager_user_id_fkey" FOREIGN KEY ("company_id", "manager_user_id") REFERENCES "user"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_company_id_base_uom_fkey" FOREIGN KEY ("company_id", "base_uom") REFERENCES "uom"("company_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand" ADD CONSTRAINT "brand_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uom" ADD CONSTRAINT "uom_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uom_conversion" ADD CONSTRAINT "uom_conversion_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_alias" ADD CONSTRAINT "sku_alias_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcode_alias" ADD CONSTRAINT "barcode_alias_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_image" ADD CONSTRAINT "product_image_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_warehouse_settings" ADD CONSTRAINT "variant_warehouse_settings_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_warehouse_settings" ADD CONSTRAINT "variant_warehouse_settings_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_contact" ADD CONSTRAINT "supplier_contact_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_address" ADD CONSTRAINT "supplier_address_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_product" ADD CONSTRAINT "supplier_product_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_product" ADD CONSTRAINT "supplier_product_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_document" ADD CONSTRAINT "supplier_document_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Hand SQL (Part 3) ──
-- P-CAT-01 / INV-012: SKUs are stored upper-case in the doc 04 format. NOT VALID: rows
-- from before Part 3 aren't rechecked; every new or changed row is.
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_sku_format"
  CHECK ("sku" ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$') NOT VALID;
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_prices"
  CHECK (("sell_price" IS NULL OR "sell_price" >= 0) AND ("cost_price" IS NULL OR "cost_price" >= 0)
     AND ("min_sell_price" IS NULL OR ("min_sell_price" >= 0 AND ("sell_price" IS NULL OR "min_sell_price" <= "sell_price"))));
-- Old SKUs never come back as live SKUs (lookup would be ambiguous forever).
ALTER TABLE "sku_alias" ADD CONSTRAINT "sku_alias_format" CHECK ("old_sku" = upper("old_sku"));

-- Doc 04 §6: depth ≤ 5, no self-parent; sibling names unique incl. roots.
ALTER TABLE "category" ADD CONSTRAINT "category_depth" CHECK ("depth" BETWEEN 1 AND 5);
ALTER TABLE "category" ADD CONSTRAINT "category_not_self_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
DROP INDEX "category_sibling_name_key";
CREATE UNIQUE INDEX "category_sibling_name_key" ON "category"("company_id", "parent_id", "name") NULLS NOT DISTINCT;

-- Doc 04 §7: brand names unique per company, case-insensitive.
CREATE UNIQUE INDEX "brand_name_key" ON "brand"("company_id", lower("name"));

-- Conversions reference a known unit, are positive, and are never rewritten (P-CAT-08).
ALTER TABLE "uom_conversion" ADD CONSTRAINT "uom_conversion_uom_fkey"
  FOREIGN KEY ("company_id", "uom") REFERENCES "uom"("company_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "uom_conversion" ADD CONSTRAINT "uom_conversion_factor_pos" CHECK ("factor" > 0);
CREATE TRIGGER "uom_conversion_append_only" BEFORE UPDATE OR DELETE ON "uom_conversion"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();

ALTER TABLE "variant_warehouse_settings" ADD CONSTRAINT "variant_warehouse_settings_qty" CHECK (
  ("reorder_point" IS NULL OR "reorder_point" >= 0) AND ("reorder_qty" IS NULL OR "reorder_qty" > 0)
  AND ("max_stock" IS NULL OR "max_stock" > 0));

ALTER TABLE "supplier" ADD CONSTRAINT "supplier_credit_limit" CHECK ("credit_limit" IS NULL OR "credit_limit" >= 0);
ALTER TABLE "supplier_product" ADD CONSTRAINT "supplier_product_qty" CHECK (
  ("last_price" IS NULL OR "last_price" >= 0) AND ("min_order_qty" IS NULL OR "min_order_qty" > 0));

-- WH-01/05: at most one default sellable and one default receiving bin per warehouse.
CREATE UNIQUE INDEX "bin_default_sellable_key" ON "bin"("warehouse_id") WHERE "is_default_sellable";
CREATE UNIQUE INDEX "bin_default_receiving_key" ON "bin"("warehouse_id") WHERE "is_default_receiving";
-- A default bin is never archived (doc 06 WH-01).
ALTER TABLE "bin" ADD CONSTRAINT "bin_default_not_archived"
  CHECK (NOT ("archived" AND ("is_default_sellable" OR "is_default_receiving")));
