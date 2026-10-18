-- Part 11 (T11.5): serial unit history (doc 14 §6). Prisma wants to drop
-- stock_count_line_position_key (a NULLS NOT DISTINCT index it can't express); keep it.

-- CreateTable
CREATE TABLE "serial_unit_event" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "serial_unit_id" TEXT NOT NULL,
    "from_status" "serial_status",
    "to_status" "serial_status" NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "bin_id" TEXT,
    "baseline" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "serial_unit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "serial_unit_event_serial_unit_id_id_idx" ON "serial_unit_event"("serial_unit_id", "id");

-- Every writer of serial_unit is covered, in its own transaction. The event row's xmin
-- equals the xmin of the movements posted in that transaction (how the history page
-- links them). uuidv7() is monotonic within a session, so id order = event order.
CREATE FUNCTION serial_unit_event_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO serial_unit_event (id, company_id, serial_unit_id, from_status, to_status, warehouse_id, bin_id, at)
  VALUES (uuidv7()::text, NEW.company_id, NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
          NEW.status, NEW.warehouse_id, NEW.bin_id, clock_timestamp());
  RETURN NULL;
END $$;

CREATE TRIGGER serial_unit_event_insert AFTER INSERT ON serial_unit
  FOR EACH ROW EXECUTE FUNCTION serial_unit_event_log();
CREATE TRIGGER serial_unit_event_update AFTER UPDATE ON serial_unit
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.warehouse_id IS DISTINCT FROM NEW.warehouse_id OR OLD.bin_id IS DISTINCT FROM NEW.bin_id)
  EXECUTE FUNCTION serial_unit_event_log();

-- Append-only, like the ledger (MV-03).
CREATE TRIGGER "serial_unit_event_append_only" BEFORE UPDATE OR DELETE ON "serial_unit_event"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();

-- Units that already exist: their current state as a baseline.
INSERT INTO serial_unit_event (id, company_id, serial_unit_id, to_status, warehouse_id, bin_id, baseline, at)
SELECT uuidv7()::text, company_id, id, status, warehouse_id, bin_id, true, updated_at
FROM serial_unit ORDER BY created_at, id;
