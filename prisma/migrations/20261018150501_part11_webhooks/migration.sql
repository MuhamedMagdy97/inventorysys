-- CreateTable
CREATE TABLE "webhook_endpoint" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "disabled_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_endpoint_company_id_status_idx" ON "webhook_endpoint"("company_id", "status");

-- CreateIndex
CREATE INDEX "webhook_event_company_id_created_at_idx" ON "webhook_event"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_delivery_status_next_attempt_at_idx" ON "webhook_delivery"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_delivery_endpoint_id_created_at_idx" ON "webhook_delivery"("endpoint_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_delivery_event_id_endpoint_id_key" ON "webhook_delivery"("event_id", "endpoint_id");

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "webhook_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Part 11 T11.4: the webhooks.manage grant for existing companies (new ones get it from seedRoles).
INSERT INTO "permission" ("code", "warehouse_scoped") VALUES ('webhooks.manage', false) ON CONFLICT DO NOTHING;
INSERT INTO "role_permission" ("role_id", "permission_code")
  SELECT "id", 'webhooks.manage' FROM "role" WHERE "is_system" AND "code" IN ('super_admin', 'admin')
  ON CONFLICT DO NOTHING;
