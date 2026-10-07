-- CreateEnum
CREATE TYPE "count_status" AS ENUM ('open', 'counting', 'variance_review', 'approved', 'applied', 'cancelled');

-- CreateEnum
CREATE TYPE "import_type" AS ENUM ('products', 'opening_balance');

-- CreateEnum
CREATE TYPE "import_status" AS ENUM ('previewed', 'completed', 'failed', 'cancelled');

-- AlterEnum
ALTER TYPE "adjustment_kind" ADD VALUE 'opening';

-- AlterTable
ALTER TABLE "stock_adjustment" ADD COLUMN     "as_of" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "stock_count" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "bin_id" TEXT,
    "variant_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "count_status" NOT NULL DEFAULT 'open',
    "snapshot_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "counters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "applied_by" TEXT,
    "applied_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_count_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_line" (
    "id" TEXT NOT NULL,
    "count_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "bin_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "snapshot_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "counted_qty" DECIMAL(18,4),
    "counted_serials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "system_qty" DECIMAL(18,4),
    "system_serials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "counted_by" TEXT,
    "counted_at" TIMESTAMP(3),
    "recounts" INTEGER NOT NULL DEFAULT 0,
    "recount_requested" BOOLEAN NOT NULL DEFAULT false,
    "qty_at_apply" DECIMAL(18,4),
    "variance" DECIMAL(18,4),

    CONSTRAINT "stock_count_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "type" "import_type" NOT NULL,
    "status" "import_status" NOT NULL DEFAULT 'previewed',
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "warehouse_id" TEXT,
    "as_of" TIMESTAMP(3),
    "mode" TEXT,
    "rows" JSONB NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "row_count" INTEGER NOT NULL,
    "error_count" INTEGER NOT NULL,
    "result" JSONB,
    "created_by" TEXT NOT NULL,
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_count_company_id_status_idx" ON "stock_count"("company_id", "status");

-- CreateIndex
CREATE INDEX "stock_count_warehouse_id_status_idx" ON "stock_count"("warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_company_id_number_key" ON "stock_count"("company_id", "number");

-- CreateIndex
CREATE INDEX "stock_count_line_bin_id_idx" ON "stock_count_line"("bin_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_line_count_id_line_no_key" ON "stock_count_line"("count_id", "line_no");

-- CreateIndex
CREATE INDEX "import_job_company_id_created_at_idx" ON "import_job"("company_id", "created_at");

-- AddForeignKey
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_count_id_fkey" FOREIGN KEY ("count_id") REFERENCES "stock_count"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Hand-written (Part 8) ─────────
-- MV-04: no backdated postings except opening_balance (5 min slack for app/DB clock skew;
-- Prisma stamps created_at in UTC).
CREATE FUNCTION "reject_backdated_movement"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."type" <> 'opening_balance' AND NEW."created_at" < (now() AT TIME ZONE 'UTC') - interval '5 minutes' THEN
    RAISE EXCEPTION 'backdated % movement rejected (MV-04)', NEW."type" USING ERRCODE = 'check_violation', CONSTRAINT = 'movement_not_backdated';
  END IF;
  IF NEW."created_at" > (now() AT TIME ZONE 'UTC') + interval '5 minutes' THEN
    RAISE EXCEPTION 'future-dated movement rejected' USING ERRCODE = 'check_violation', CONSTRAINT = 'movement_not_future';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "inventory_movement_not_backdated" BEFORE INSERT ON "inventory_movement"
  FOR EACH ROW EXECUTE FUNCTION "reject_backdated_movement"();

ALTER TABLE "stock_adjustment" ADD CONSTRAINT "stock_adjustment_as_of" CHECK ("as_of" IS NULL OR "kind"::text = 'opening');

-- One line per bin/variant/batch in a count (batch may be null).
CREATE UNIQUE INDEX "stock_count_line_position_key" ON "stock_count_line"("count_id", "bin_id", "variant_id", "batch_id") NULLS NOT DISTINCT;
ALTER TABLE "stock_count_line"
  ADD CONSTRAINT "stock_count_line_qty" CHECK ("snapshot_qty" >= 0 AND ("counted_qty" IS NULL OR "counted_qty" >= 0) AND ("system_qty" IS NULL OR "system_qty" >= 0) AND "recounts" >= 0);
ALTER TABLE "import_job"
  ADD CONSTRAINT "import_job_mode" CHECK ("mode" IS NULL OR "mode" IN ('all_or_nothing', 'valid_only')),
  ADD CONSTRAINT "import_job_counts" CHECK ("row_count" >= 0 AND "error_count" >= 0 AND "error_count" <= "row_count" AND "file_size" >= 0);
-- Documents and import history are never deleted (INV-005, doc 22).
CREATE TRIGGER "stock_count_no_delete" BEFORE DELETE ON "stock_count" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "stock_count_line_no_delete" BEFORE DELETE ON "stock_count_line" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "import_job_no_delete" BEFORE DELETE ON "import_job" FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
