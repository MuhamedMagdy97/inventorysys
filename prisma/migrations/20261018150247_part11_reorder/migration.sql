-- Part 11 / T11.2 reorder engine (doc 09 §6, RO-01): per-warehouse preferred supplier.
ALTER TABLE "variant_warehouse_settings" ADD COLUMN     "preferred_supplier_id" TEXT;

ALTER TABLE "variant_warehouse_settings" ADD CONSTRAINT "variant_warehouse_settings_preferred_supplier_id_fkey" FOREIGN KEY ("preferred_supplier_id") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
