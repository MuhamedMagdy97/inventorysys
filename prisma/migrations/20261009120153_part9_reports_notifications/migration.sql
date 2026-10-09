-- Part 9: notification center (per-user read state, grant-filtered broadcasts), email
-- opt-in + outbox (doc 17 §3). Prisma wants to drop stock_count_line_position_key (a
-- hand-SQL NULLS NOT DISTINCT index from Part 8) — that line is removed on purpose.

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "emailed_at" TIMESTAMP(3),
ADD COLUMN     "permission" TEXT;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "email_categories" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "notification_read" (
    "notification_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_read_pkey" PRIMARY KEY ("notification_id","user_id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "to_email" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "notification_ids" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'stored',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_read_user_id_idx" ON "notification_read"("user_id");

-- CreateIndex
CREATE INDEX "email_outbox_company_id_created_at_idx" ON "email_outbox"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "email_outbox_status_idx" ON "email_outbox"("status");

-- CreateIndex
CREATE INDEX "notification_company_id_created_at_idx" ON "notification"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_emailed_at_idx" ON "notification"("emailed_at");

-- AddForeignKey
ALTER TABLE "notification_read" ADD CONSTRAINT "notification_read_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_read" ADD CONSTRAINT "notification_read_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
