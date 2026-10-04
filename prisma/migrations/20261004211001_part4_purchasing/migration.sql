-- CreateEnum
CREATE TYPE "po_status" AS ENUM ('draft', 'submitted', 'approved', 'ordered', 'partially_received', 'fully_received', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "excess_status" AS ENUM ('pending', 'approved', 'rejected', 'reversed');

-- CreateEnum
CREATE TYPE "serial_status" AS ENUM ('in_stock', 'reserved', 'sold', 'in_transit', 'quarantine', 'damaged', 'disposed', 'returned_pending', 'reversed');

-- DropForeignKey
ALTER TABLE "uom_conversion" DROP CONSTRAINT "uom_conversion_uom_fkey";

-- AlterTable
ALTER TABLE "supplier" ADD COLUMN     "receipt_tolerance_pct" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "purchase_order" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "supplier_name" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "status" "po_status" NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "shipping" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "expected_date" DATE,
    "notes" TEXT,
    "close_reason" TEXT,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "ordered_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_line" (
    "id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "variant_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order_uom" TEXT NOT NULL,
    "uom_factor" DECIMAL(18,6) NOT NULL,
    "qty_ordered" DECIMAL(18,4) NOT NULL,
    "qty_ordered_base" DECIMAL(18,4) NOT NULL,
    "qty_received_base" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_returned_base" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "discount_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tax_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,4) NOT NULL,
    "requires_batch" BOOLEAN NOT NULL,
    "requires_expiry" BOOLEAN NOT NULL,
    "removed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "po_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_approval" (
    "id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "supplier_ref" TEXT,
    "note" TEXT,
    "received_by" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversal_of_receipt_id" TEXT,
    "idempotency_key" TEXT,

    CONSTRAINT "goods_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_line" (
    "id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "po_line_id" TEXT,
    "variant_id" TEXT NOT NULL,
    "wrong_product" BOOLEAN NOT NULL DEFAULT false,
    "held" BOOLEAN NOT NULL DEFAULT true,
    "order_uom" TEXT NOT NULL,
    "uom_factor" DECIMAL(18,6) NOT NULL,
    "order_qty" DECIMAL(18,4) NOT NULL,
    "base_qty" DECIMAL(18,4) NOT NULL,
    "qty_accepted" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_damaged" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_expired" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_excess_blocked" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_missing" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "inspection" BOOLEAN NOT NULL DEFAULT false,
    "batch_id" TEXT,
    "bin_id" TEXT NOT NULL,
    "unit_cost" DECIMAL(18,4),
    "note" TEXT,
    "excess_status" "excess_status",
    "excess_decided_by" TEXT,
    "excess_decided_at" TIMESTAMP(3),
    "excess_comment" TEXT,

    CONSTRAINT "receipt_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serial_unit" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "serial_no" TEXT NOT NULL,
    "batch_id" TEXT,
    "status" "serial_status" NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "bin_id" TEXT,
    "receipt_line_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "serial_unit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_order_company_id_status_idx" ON "purchase_order"("company_id", "status");

-- CreateIndex
CREATE INDEX "purchase_order_supplier_id_status_idx" ON "purchase_order"("supplier_id", "status");

-- CreateIndex
CREATE INDEX "purchase_order_warehouse_id_status_idx" ON "purchase_order"("warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_company_id_number_key" ON "purchase_order"("company_id", "number");

-- CreateIndex
CREATE INDEX "po_line_variant_id_idx" ON "po_line"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "po_line_po_id_line_no_key" ON "po_line"("po_id", "line_no");

-- CreateIndex
CREATE INDEX "po_approval_po_id_idx" ON "po_approval"("po_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_reversal_of_receipt_id_key" ON "goods_receipt"("reversal_of_receipt_id");

-- CreateIndex
CREATE INDEX "goods_receipt_po_id_idx" ON "goods_receipt"("po_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_company_id_number_key" ON "goods_receipt"("company_id", "number");

-- CreateIndex
CREATE INDEX "receipt_line_po_line_id_idx" ON "receipt_line"("po_line_id");

-- CreateIndex
CREATE INDEX "receipt_line_excess_status_idx" ON "receipt_line"("excess_status");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_line_receipt_id_line_no_key" ON "receipt_line"("receipt_id", "line_no");

-- CreateIndex
CREATE INDEX "serial_unit_variant_id_warehouse_id_status_idx" ON "serial_unit"("variant_id", "warehouse_id", "status");

-- AddForeignKey
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_line" ADD CONSTRAINT "po_line_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_line" ADD CONSTRAINT "po_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_approval" ADD CONSTRAINT "po_approval_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_approval" ADD CONSTRAINT "po_approval_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_reversal_of_receipt_id_fkey" FOREIGN KEY ("reversal_of_receipt_id") REFERENCES "goods_receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_line" ADD CONSTRAINT "receipt_line_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_line" ADD CONSTRAINT "receipt_line_po_line_id_fkey" FOREIGN KEY ("po_line_id") REFERENCES "po_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_line" ADD CONSTRAINT "receipt_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_line" ADD CONSTRAINT "receipt_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_line" ADD CONSTRAINT "receipt_line_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_unit" ADD CONSTRAINT "serial_unit_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_unit" ADD CONSTRAINT "serial_unit_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_unit" ADD CONSTRAINT "serial_unit_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_unit" ADD CONSTRAINT "serial_unit_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_unit" ADD CONSTRAINT "serial_unit_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "receipt_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ───────── Hand-written (Part 4) ─────────
-- Quantities never negative; ordered > 0; received never above ordered + 100% (app enforces the real tolerance).
ALTER TABLE "po_line"
  ADD CONSTRAINT "po_line_qty_pos" CHECK ("qty_ordered" > 0 AND "qty_ordered_base" > 0 AND "uom_factor" > 0),
  ADD CONSTRAINT "po_line_qty_nonneg" CHECK ("qty_received_base" >= 0 AND "qty_returned_base" >= 0 AND "unit_price" >= 0 AND "line_total" >= 0),
  ADD CONSTRAINT "po_line_pct" CHECK ("discount_pct" BETWEEN 0 AND 100 AND "tax_pct" BETWEEN 0 AND 100);
ALTER TABLE "purchase_order"
  ADD CONSTRAINT "purchase_order_money_nonneg" CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "tax" >= 0 AND "shipping" >= 0 AND "total" >= 0);
-- Reversal receipts carry negated quantities, so only the factor is sign-checked.
ALTER TABLE "receipt_line" ADD CONSTRAINT "receipt_line_factor_pos" CHECK ("uom_factor" > 0);

-- RC-11 / S-01: one live serial number per company; a reversed unit frees it.
CREATE UNIQUE INDEX "serial_unit_live_key" ON "serial_unit"("company_id", "serial_no") WHERE "status" <> 'reversed';

-- RC-08: a movement is reversed at most once.
CREATE UNIQUE INDEX "inventory_movement_reversed_once" ON "inventory_movement"("reverses_movement_id") WHERE "reverses_movement_id" IS NOT NULL;

-- MV-05: posted receipts are immutable; corrections are reversal receipts.
CREATE TRIGGER "goods_receipt_no_change" BEFORE UPDATE OR DELETE ON "goods_receipt"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "po_line_no_delete" BEFORE DELETE ON "po_line"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "receipt_line_no_delete" BEFORE DELETE ON "receipt_line"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
