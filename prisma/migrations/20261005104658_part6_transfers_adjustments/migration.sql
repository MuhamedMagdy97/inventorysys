-- CreateEnum
CREATE TYPE "transfer_status" AS ENUM ('draft', 'submitted', 'approved', 'in_transit', 'partially_received', 'completed', 'closed_with_variance', 'cancelled');

-- CreateEnum
CREATE TYPE "adjustment_kind" AS ENUM ('adjustment', 'damage', 'repair', 'disposal');

-- CreateEnum
CREATE TYPE "adjustment_status" AS ENUM ('draft', 'submitted', 'approved', 'applied', 'cancelled');

-- AlterEnum
ALTER TYPE "serial_status" ADD VALUE 'lost';

-- AlterTable
ALTER TABLE "serial_unit" ADD COLUMN     "transfer_line_id" TEXT;

-- CreateTable
CREATE TABLE "transfer" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "from_warehouse_id" TEXT NOT NULL,
    "to_warehouse_id" TEXT NOT NULL,
    "status" "transfer_status" NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "reason" TEXT,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "shipped_by" TEXT,
    "shipped_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_line" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "variant_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "qty_requested" DECIMAL(18,4) NOT NULL,
    "qty_shipped" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_received" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_damaged" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_missing" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_missing_reported" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "shipped_value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "settled_value" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "transfer_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustment" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "adjustment_kind" NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "status" "adjustment_status" NOT NULL DEFAULT 'draft',
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "applied_by" TEXT,
    "applied_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustment_line" (
    "id" TEXT NOT NULL,
    "adjustment_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "variant_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "bin_id" TEXT,
    "qty" DECIMAL(18,4) NOT NULL,
    "bucket" TEXT,
    "unit_cost" DECIMAL(18,4),
    "serials" TEXT[],

    CONSTRAINT "stock_adjustment_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "amount" DECIMAL(18,4),
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transfer_company_id_status_idx" ON "transfer"("company_id", "status");

-- CreateIndex
CREATE INDEX "transfer_from_warehouse_id_status_idx" ON "transfer"("from_warehouse_id", "status");

-- CreateIndex
CREATE INDEX "transfer_to_warehouse_id_status_idx" ON "transfer"("to_warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_company_id_number_key" ON "transfer"("company_id", "number");

-- CreateIndex
CREATE INDEX "transfer_line_variant_id_idx" ON "transfer_line"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_line_transfer_id_line_no_key" ON "transfer_line"("transfer_id", "line_no");

-- CreateIndex
CREATE INDEX "stock_adjustment_company_id_status_idx" ON "stock_adjustment"("company_id", "status");

-- CreateIndex
CREATE INDEX "stock_adjustment_warehouse_id_status_idx" ON "stock_adjustment"("warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustment_company_id_number_key" ON "stock_adjustment"("company_id", "number");

-- CreateIndex
CREATE INDEX "stock_adjustment_line_variant_id_idx" ON "stock_adjustment_line"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustment_line_adjustment_id_line_no_key" ON "stock_adjustment_line"("adjustment_id", "line_no");

-- CreateIndex
CREATE INDEX "approval_entity_type_entity_id_idx" ON "approval"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "serial_unit" ADD CONSTRAINT "serial_unit_transfer_line_id_fkey" FOREIGN KEY ("transfer_line_id") REFERENCES "transfer_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer" ADD CONSTRAINT "transfer_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer" ADD CONSTRAINT "transfer_from_warehouse_id_fkey" FOREIGN KEY ("from_warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer" ADD CONSTRAINT "transfer_to_warehouse_id_fkey" FOREIGN KEY ("to_warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer" ADD CONSTRAINT "transfer_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_line" ADD CONSTRAINT "transfer_line_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_line" ADD CONSTRAINT "transfer_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_line" ADD CONSTRAINT "transfer_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_line" ADD CONSTRAINT "stock_adjustment_line_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "stock_adjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_line" ADD CONSTRAINT "stock_adjustment_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_line" ADD CONSTRAINT "stock_adjustment_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_line" ADD CONSTRAINT "stock_adjustment_line_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Hand-written (Part 6) ─────────
ALTER TABLE "transfer" ADD CONSTRAINT "transfer_distinct_warehouses" CHECK ("from_warehouse_id" <> "to_warehouse_id"); -- TR-01
-- Every shipped unit is received, damaged, missing or still in transit (never over-received, TR-03).
ALTER TABLE "transfer_line"
  ADD CONSTRAINT "transfer_line_qty" CHECK (
    "qty_requested" > 0 AND "qty_shipped" >= 0 AND "qty_shipped" <= "qty_requested"
    AND "qty_received" >= 0 AND "qty_damaged" >= 0 AND "qty_missing" >= 0 AND "qty_missing_reported" >= 0
    AND "qty_received" + "qty_damaged" + "qty_missing" + "qty_missing_reported" <= "qty_shipped"),
  ADD CONSTRAINT "transfer_line_value" CHECK ("shipped_value" >= 0 AND "settled_value" >= 0 AND "settled_value" <= "shipped_value");
ALTER TABLE "stock_adjustment_line"
  ADD CONSTRAINT "stock_adjustment_line_qty" CHECK ("qty" <> 0 AND ("unit_cost" IS NULL OR "unit_cost" >= 0)),
  ADD CONSTRAINT "stock_adjustment_line_bucket" CHECK ("bucket" IS NULL OR "bucket" IN ('damaged', 'expired', 'blocked'));
ALTER TABLE "approval" ADD CONSTRAINT "approval_decision" CHECK ("decision" IN ('approved', 'rejected'));
-- Documents are cancelled, never deleted (INV-005); approvals are history.
CREATE TRIGGER "transfer_no_delete" BEFORE DELETE ON "transfer" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "transfer_line_no_delete" BEFORE DELETE ON "transfer_line" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "stock_adjustment_no_delete" BEFORE DELETE ON "stock_adjustment" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "stock_adjustment_line_no_delete" BEFORE DELETE ON "stock_adjustment_line" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "approval_append_only" BEFORE UPDATE OR DELETE ON "approval" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
