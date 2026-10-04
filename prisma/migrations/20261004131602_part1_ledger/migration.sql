-- CreateEnum
CREATE TYPE "master_status" AS ENUM ('active', 'inactive', 'archived');

-- CreateEnum
CREATE TYPE "variant_status" AS ENUM ('active', 'discontinued', 'archived');

-- CreateEnum
CREATE TYPE "bin_type" AS ENUM ('sellable', 'receiving', 'quarantine', 'damaged');

-- CreateEnum
CREATE TYPE "movement_type" AS ENUM ('opening_balance', 'purchase_receipt', 'sale_fulfilment', 'sale_return_quarantine', 'sale_return_restock', 'purchase_return', 'transfer_out', 'transfer_in', 'transfer_variance', 'adjustment_in', 'adjustment_out', 'cost_correction', 'damage', 'repair_to_stock', 'expiry', 'disposal', 'reservation', 'reservation_release', 'blocked_in', 'blocked_release', 'blocked_reject', 'putaway_out', 'putaway_in');

-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('active', 'partially_fulfilled', 'fulfilled', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "master_status" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bin" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "bin_type" NOT NULL,
    "is_default_sellable" BOOLEAN NOT NULL DEFAULT false,
    "is_default_receiving" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "variant_status" NOT NULL DEFAULT 'active',
    "requires_batch" BOOLEAN NOT NULL DEFAULT false,
    "requires_expiry" BOOLEAN NOT NULL DEFAULT false,
    "is_serialized" BOOLEAN NOT NULL DEFAULT false,
    "base_uom" TEXT NOT NULL DEFAULT 'each',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variant" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "status" "variant_status" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "batch_no" TEXT NOT NULL,
    "mfg_date" DATE,
    "expiry_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balance" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "bin_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "on_hand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "blocked" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "damaged" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "expired" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_allocation" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "qty_reserved" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_cost" (
    "company_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_cost_pkey" PRIMARY KEY ("variant_id","warehouse_id")
);

-- CreateTable
CREATE TABLE "inventory_movement" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "bin_id" TEXT,
    "batch_id" TEXT,
    "type" "movement_type" NOT NULL,
    "d_on_hand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "d_blocked" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "d_damaged" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "d_expired" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "d_reserved" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "on_hand_after" DECIMAL(18,4),
    "blocked_after" DECIMAL(18,4),
    "damaged_after" DECIMAL(18,4),
    "expired_after" DECIMAL(18,4),
    "reserved_after" DECIMAL(18,4) NOT NULL,
    "unit_cost_snapshot" DECIMAL(18,4),
    "value_delta" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "reverses_movement_id" TEXT,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "actor_id" TEXT NOT NULL,
    "channel" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "warehouse_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "channel" TEXT,
    "request_id" TEXT,
    "idempotency_key" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequences" (
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "next" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("company_id","name")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "company_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("company_id","key")
);

-- CreateTable
CREATE TABLE "reservation" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "qty_fulfilled" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_released" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" "reservation_status" NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "order_ref" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_line" (
    "id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "qty" DECIMAL(18,4) NOT NULL,
    "qty_fulfilled" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qty_released" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "reservation_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_company_id_idx" ON "user"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_company_id_code_key" ON "warehouse"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "bin_warehouse_id_code_key" ON "bin"("warehouse_id", "code");

-- CreateIndex
CREATE INDEX "product_company_id_idx" ON "product"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_company_id_sku_key" ON "product_variant"("company_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_company_id_barcode_key" ON "product_variant"("company_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "batch_variant_id_batch_no_key" ON "batch"("variant_id", "batch_no");

-- CreateIndex
CREATE INDEX "stock_balance_company_id_variant_id_warehouse_id_idx" ON "stock_balance"("company_id", "variant_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balance_position_key" ON "stock_balance"("variant_id", "warehouse_id", "bin_id", "batch_id");

-- CreateIndex
CREATE INDEX "stock_allocation_company_id_variant_id_warehouse_id_idx" ON "stock_allocation"("company_id", "variant_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_allocation_position_key" ON "stock_allocation"("variant_id", "warehouse_id", "batch_id");

-- CreateIndex
CREATE INDEX "inventory_movement_company_id_variant_id_warehouse_id_creat_idx" ON "inventory_movement"("company_id", "variant_id", "warehouse_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_movement_company_id_source_type_source_id_idx" ON "inventory_movement"("company_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movement_company_id_idempotency_key_key" ON "inventory_movement"("company_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "audit_log_company_id_entity_type_entity_id_idx" ON "audit_log"("company_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_company_id_at_idx" ON "audit_log"("company_id", "at");

-- CreateIndex
CREATE INDEX "reservation_company_id_status_expires_at_idx" ON "reservation"("company_id", "status", "expires_at");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bin" ADD CONSTRAINT "bin_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bin" ADD CONSTRAINT "bin_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch" ADD CONSTRAINT "batch_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_allocation" ADD CONSTRAINT "stock_allocation_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_allocation" ADD CONSTRAINT "stock_allocation_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_allocation" ADD CONSTRAINT "stock_allocation_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_allocation" ADD CONSTRAINT "stock_allocation_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_cost" ADD CONSTRAINT "variant_cost_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_cost" ADD CONSTRAINT "variant_cost_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_cost" ADD CONSTRAINT "variant_cost_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_reverses_movement_id_fkey" FOREIGN KEY ("reverses_movement_id") REFERENCES "inventory_movement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_line" ADD CONSTRAINT "reservation_line_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_line" ADD CONSTRAINT "reservation_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═════════════ Hand-written constraints (Prisma can't express these) ═════════════

-- I-03: no bucket may go negative — enforced by the DB, not by app trust.
ALTER TABLE "stock_balance"
  ADD CONSTRAINT "stock_balance_on_hand_nonneg" CHECK ("on_hand" >= 0),
  ADD CONSTRAINT "stock_balance_blocked_nonneg" CHECK ("blocked" >= 0),
  ADD CONSTRAINT "stock_balance_damaged_nonneg" CHECK ("damaged" >= 0),
  ADD CONSTRAINT "stock_balance_expired_nonneg" CHECK ("expired" >= 0);
ALTER TABLE "stock_allocation"
  ADD CONSTRAINT "stock_allocation_reserved_nonneg" CHECK ("qty_reserved" >= 0);
ALTER TABLE "variant_cost" ADD CONSTRAINT "variant_cost_nonneg" CHECK ("qty" >= 0 AND "value" >= 0);
ALTER TABLE "reservation"
  ADD CONSTRAINT "reservation_qty_pos" CHECK ("qty" > 0),
  ADD CONSTRAINT "reservation_qty_bounds" CHECK ("qty_fulfilled" >= 0 AND "qty_released" >= 0 AND "qty_fulfilled" + "qty_released" <= "qty");
ALTER TABLE "reservation_line"
  ADD CONSTRAINT "reservation_line_qty_pos" CHECK ("qty" > 0),
  ADD CONSTRAINT "reservation_line_qty_bounds" CHECK ("qty_fulfilled" >= 0 AND "qty_released" >= 0 AND "qty_fulfilled" + "qty_released" <= "qty");

-- One row per bin position / reservable position; NULL batch = untracked, still unique.
-- Same index names as the Prisma @@unique, so Prisma sees no drift.
DROP INDEX "stock_balance_position_key";
CREATE UNIQUE INDEX "stock_balance_position_key"
  ON "stock_balance" ("variant_id", "warehouse_id", "bin_id", "batch_id") NULLS NOT DISTINCT;
DROP INDEX "stock_allocation_position_key";
CREATE UNIQUE INDEX "stock_allocation_position_key"
  ON "stock_allocation" ("variant_id", "warehouse_id", "batch_id") NULLS NOT DISTINCT;

-- MV-03 / A-02: ledger and audit are append-only. No UPDATE, no DELETE, no TRUNCATE.
CREATE FUNCTION "reject_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER "inventory_movement_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_movement"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "inventory_movement_no_truncate"
  BEFORE TRUNCATE ON "inventory_movement"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "audit_log_no_truncate"
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
