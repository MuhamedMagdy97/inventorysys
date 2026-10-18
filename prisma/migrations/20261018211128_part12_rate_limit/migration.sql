-- Part 12 T12.1: shared rate-limit counters (doc 26). Prisma also wants to drop
-- stock_count_line_position_key (hand-SQL NULLS NOT DISTINCT index from Part 8) — removed on purpose.

-- CreateTable
CREATE TABLE "rate_limit_hit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "reset_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limit_hit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "rate_limit_hit_reset_at_idx" ON "rate_limit_hit"("reset_at");
