-- CreateEnum
CREATE TYPE "purchase_return_status" AS ENUM ('draft', 'submitted', 'approved', 'shipped', 'supplier_confirmed', 'supplier_rejected', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "sales_return_status" AS ENUM ('requested', 'approved', 'received', 'inspected', 'restocked', 'written_off', 'rejected', 'cancelled');

-- AlterEnum
ALTER TYPE "serial_status" ADD VALUE 'returned';

-- AlterTable
ALTER TABLE "inventory_movement" ADD COLUMN     "linked_fulfilment_ref" TEXT,
ADD COLUMN     "linked_receipt_id" TEXT;

-- AlterTable
ALTER TABLE "serial_unit" ADD COLUMN     "reservation_id" TEXT;

-- CreateTable
CREATE TABLE "purchase_return" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "status" "purchase_return_status" NOT NULL DEFAULT 'draft',
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "credit_note_ref" TEXT,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "shipped_by" TEXT,
    "shipped_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_line" (
    "id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "receipt_line_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "po_line_id" TEXT,
    "variant_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "bucket" TEXT NOT NULL DEFAULT 'onHand',
    "qty" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "serials" TEXT[],

    CONSTRAINT "purchase_return_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_return" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "sales_order_ref_id" TEXT,
    "status" "sales_return_status" NOT NULL DEFAULT 'requested',
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "received_by" TEXT,
    "received_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_return_line" (
    "id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "fulfilment_movement_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "qty" DECIMAL(18,4) NOT NULL,
    "qty_received" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_restocked" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_rejected" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_disposed" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "serials" TEXT[],
    "lot_id" TEXT,

    CONSTRAINT "sales_return_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quarantine_lot" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "bin_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "reason" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_line" TEXT NOT NULL,
    "movement_id" TEXT,
    "unit_cost" DECIMAL(18,4),
    "qty" DECIMAL(18,4) NOT NULL,
    "qty_open" DECIMAL(18,4) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quarantine_lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "note" TEXT,
    "serials" TEXT[],
    "inspector_id" TEXT NOT NULL,
    "sod_waived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_return_company_id_status_idx" ON "purchase_return"("company_id", "status");

-- CreateIndex
CREATE INDEX "purchase_return_po_id_idx" ON "purchase_return"("po_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_return_company_id_number_key" ON "purchase_return"("company_id", "number");

-- CreateIndex
CREATE INDEX "purchase_return_line_receipt_line_id_idx" ON "purchase_return_line"("receipt_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_return_line_return_id_line_no_key" ON "purchase_return_line"("return_id", "line_no");

-- CreateIndex
CREATE INDEX "sales_return_company_id_status_idx" ON "sales_return"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_company_id_number_key" ON "sales_return"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_line_lot_id_key" ON "sales_return_line"("lot_id");

-- CreateIndex
CREATE INDEX "sales_return_line_reservation_id_idx" ON "sales_return_line"("reservation_id");

-- CreateIndex
CREATE INDEX "sales_return_line_fulfilment_movement_id_idx" ON "sales_return_line"("fulfilment_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_line_return_id_line_no_key" ON "sales_return_line"("return_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "quarantine_lot_movement_id_key" ON "quarantine_lot"("movement_id");

-- CreateIndex
CREATE INDEX "quarantine_lot_company_id_variant_id_warehouse_id_bin_id_idx" ON "quarantine_lot"("company_id", "variant_id", "warehouse_id", "bin_id");

-- CreateIndex
CREATE INDEX "quarantine_lot_company_id_warehouse_id_reason_idx" ON "quarantine_lot"("company_id", "warehouse_id", "reason");

-- CreateIndex
CREATE INDEX "quarantine_lot_source_type_source_id_idx" ON "quarantine_lot"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "inspection_lot_id_idx" ON "inspection"("lot_id");

-- CreateIndex
CREATE INDEX "inspection_company_id_created_at_idx" ON "inspection"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "evidence_company_id_entity_type_entity_id_idx" ON "evidence"("company_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_linked_receipt_id_fkey" FOREIGN KEY ("linked_receipt_id") REFERENCES "goods_receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_linked_fulfilment_ref_fkey" FOREIGN KEY ("linked_fulfilment_ref") REFERENCES "inventory_movement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return" ADD CONSTRAINT "purchase_return_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_line" ADD CONSTRAINT "purchase_return_line_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "purchase_return"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_line" ADD CONSTRAINT "purchase_return_line_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "receipt_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_line" ADD CONSTRAINT "purchase_return_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_line" ADD CONSTRAINT "purchase_return_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "sales_return"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_fulfilment_movement_id_fkey" FOREIGN KEY ("fulfilment_movement_id") REFERENCES "inventory_movement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "quarantine_lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quarantine_lot" ADD CONSTRAINT "quarantine_lot_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quarantine_lot" ADD CONSTRAINT "quarantine_lot_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quarantine_lot" ADD CONSTRAINT "quarantine_lot_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quarantine_lot" ADD CONSTRAINT "quarantine_lot_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quarantine_lot" ADD CONSTRAINT "quarantine_lot_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quarantine_lot" ADD CONSTRAINT "quarantine_lot_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "inventory_movement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection" ADD CONSTRAINT "inspection_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection" ADD CONSTRAINT "inspection_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "quarantine_lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection" ADD CONSTRAINT "inspection_inspector_id_fkey" FOREIGN KEY ("inspector_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Hand-written (Part 7) ─────────
ALTER TABLE "purchase_return_line"
  ADD CONSTRAINT "purchase_return_line_qty" CHECK ("qty" > 0 AND "unit_cost" >= 0),
  ADD CONSTRAINT "purchase_return_line_bucket" CHECK ("bucket" IN ('onHand', 'blocked', 'damaged', 'expired'));
-- SR-01 bookkeeping: received ≤ requested; every decided unit was received.
ALTER TABLE "sales_return_line"
  ADD CONSTRAINT "sales_return_line_qty" CHECK (
    "qty" > 0 AND "unit_cost" >= 0 AND "qty_received" >= 0 AND "qty_received" <= "qty"
    AND "qty_restocked" >= 0 AND "qty_rejected" >= 0 AND "qty_disposed" >= 0
    AND "qty_restocked" + "qty_rejected" + "qty_disposed" <= "qty_received");
ALTER TABLE "quarantine_lot" ADD CONSTRAINT "quarantine_lot_qty" CHECK ("qty" > 0 AND "qty_open" >= 0 AND "qty_open" <= "qty");
ALTER TABLE "inspection"
  ADD CONSTRAINT "inspection_qty" CHECK ("qty" > 0),
  ADD CONSTRAINT "inspection_outcome" CHECK ("outcome" IN ('pass', 'reject', 'dispose')),
  ADD CONSTRAINT "inspection_disposition" CHECK ("disposition" IN ('restockable', 'damaged', 'defective', 'missing_parts', 'expired', 'dispose'));
-- Doc 26 / edge #28: allowlisted types, ≤ 10 MB (the domain checks content bytes too).
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_file" CHECK (
  "size_bytes" > 0 AND "size_bytes" <= 10485760 AND "mime_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'));

-- A unit back with its supplier frees its serial number, like a reversed one.
DROP INDEX "serial_unit_live_key";
CREATE UNIQUE INDEX "serial_unit_live_key" ON "serial_unit"("company_id", "serial_no") WHERE "status" NOT IN ('reversed', 'returned');

-- Documents are cancelled/closed, never deleted (INV-005); inspections and evidence are history.
CREATE TRIGGER "purchase_return_no_delete" BEFORE DELETE ON "purchase_return" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "purchase_return_line_no_delete" BEFORE DELETE ON "purchase_return_line" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "sales_return_no_delete" BEFORE DELETE ON "sales_return" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "sales_return_line_no_delete" BEFORE DELETE ON "sales_return_line" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "quarantine_lot_no_delete" BEFORE DELETE ON "quarantine_lot" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "inspection_append_only" BEFORE UPDATE OR DELETE ON "inspection" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "evidence_no_delete" BEFORE DELETE ON "evidence" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();

-- Blocked stock posted before Part 7 gets one lot per bin row, so the reconciler's
-- lots = blocked check holds from day one.
INSERT INTO "quarantine_lot" ("id", "company_id", "variant_id", "warehouse_id", "bin_id", "batch_id", "reason", "source_type", "source_id", "source_line", "qty", "qty_open", "created_by", "created_at")
SELECT uuidv7()::text, b."company_id", b."variant_id", b."warehouse_id", b."bin_id", b."batch_id", 'legacy', 'stock_balance', b."id", '1', b."blocked", b."blocked",
       (SELECT u."id" FROM "user" u WHERE u."company_id" = b."company_id" ORDER BY u."is_system" DESC, u."id" LIMIT 1), now()
FROM "stock_balance" b WHERE b."blocked" > 0;
