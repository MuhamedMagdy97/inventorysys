-- Part 11 T11.3: landed-cost allocation (doc 15 §1.1). Prisma wants to drop
-- stock_count_line_position_key (hand-SQL index from Part 8) — removed on purpose.

-- CreateEnum
CREATE TYPE "landed_cost_status" AS ENUM ('submitted', 'posted', 'rejected');

-- CreateEnum
CREATE TYPE "landed_cost_method" AS ENUM ('value', 'qty');


-- CreateTable
CREATE TABLE "landed_cost" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "method" "landed_cost_method" NOT NULL DEFAULT 'value',
    "status" "landed_cost_status" NOT NULL DEFAULT 'submitted',
    "charges" JSONB NOT NULL,
    "total" DECIMAL(18,4) NOT NULL,
    "capitalized" DECIMAL(18,4),
    "expensed" DECIMAL(18,4),
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "landed_cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landed_cost_line" (
    "id" TEXT NOT NULL,
    "landed_cost_id" TEXT NOT NULL,
    "receipt_line_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "basis_qty" DECIMAL(18,4) NOT NULL,
    "basis_value" DECIMAL(18,4) NOT NULL,
    "allocated" DECIMAL(18,4) NOT NULL,
    "capitalized" DECIMAL(18,4),
    "expensed" DECIMAL(18,4),

    CONSTRAINT "landed_cost_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "landed_cost_company_id_status_idx" ON "landed_cost"("company_id", "status");

-- CreateIndex
CREATE INDEX "landed_cost_receipt_id_idx" ON "landed_cost"("receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "landed_cost_company_id_number_key" ON "landed_cost"("company_id", "number");

-- CreateIndex
CREATE INDEX "landed_cost_line_landed_cost_id_idx" ON "landed_cost_line"("landed_cost_id");

-- AddForeignKey
ALTER TABLE "landed_cost" ADD CONSTRAINT "landed_cost_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_cost_line" ADD CONSTRAINT "landed_cost_line_landed_cost_id_fkey" FOREIGN KEY ("landed_cost_id") REFERENCES "landed_cost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_cost_line" ADD CONSTRAINT "landed_cost_line_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "receipt_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
