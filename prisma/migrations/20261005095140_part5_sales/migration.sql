/*
  Warnings:

  - You are about to drop the column `order_ref` on the `reservation` table. All the data in the column will be lost.
  - Added the required column `ttl_seconds` to the `reservation` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "sales_channel" AS ENUM ('pos', 'web', 'marketplace', 'api');

-- AlterTable
ALTER TABLE "reservation" DROP COLUMN "order_ref",
ADD COLUMN     "extended_at" TIMESTAMP(3),
ADD COLUMN     "sales_order_ref_id" TEXT,
ADD COLUMN     "ttl_seconds" INTEGER NOT NULL DEFAULT 172800;
ALTER TABLE "reservation" ALTER COLUMN "ttl_seconds" DROP DEFAULT;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "sales_channel" "sales_channel";

-- CreateTable
CREATE TABLE "sales_order_ref" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "channel" "sales_channel" NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_order_ref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT,
    "warehouse_id" TEXT,
    "type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "actor_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_ref_company_id_id_key" ON "sales_order_ref"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_ref_company_id_channel_external_order_id_key" ON "sales_order_ref"("company_id", "channel", "external_order_id");

-- CreateIndex
CREATE INDEX "notification_company_id_user_id_read_at_idx" ON "notification"("company_id", "user_id", "read_at");

-- CreateIndex
CREATE INDEX "reservation_sales_order_ref_id_idx" ON "reservation"("sales_order_ref_id");

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_company_id_sales_order_ref_id_fkey" FOREIGN KEY ("company_id", "sales_order_ref_id") REFERENCES "sales_order_ref"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_ref" ADD CONSTRAINT "sales_order_ref_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────── Hand-written (Part 5) ─────────
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_ttl_range" CHECK ("ttl_seconds" BETWEEN 60 AND 2592000);
-- SO-06: every service user acts as exactly one channel; login users have none.
UPDATE "user" SET "sales_channel" = 'api' WHERE "is_service";
ALTER TABLE "user" ADD CONSTRAINT "user_sales_channel_service" CHECK ("is_service" = ("sales_channel" IS NOT NULL));
