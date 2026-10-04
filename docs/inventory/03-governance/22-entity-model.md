# 22 — Entity Model (Conceptual)

No SQL/ORM. `*` = immutable after posting. `A` = archivable (not deletable).

- **category**(id, parent_id, name, path, sort, archived[A]); **brand**(id, name, archived[A])
- **product**(id, company_id, name, brand_id, category_id, type, status, flags[batch/expiry/serialized], base_uom, requires_inspection default false, images, tags, version); **product_variant**(id, product_id, sku*, barcode, attrs, prices, requires_inspection default false, status[A], version); **variant_warehouse_settings**(variant_id, warehouse_id, reorder_point, reorder_qty, max_stock — reorder thresholds are PER WAREHOUSE, not global); **sku_alias**(old_sku*, new_variant_id); **uom, uom_conversion**(effective_from*)
- **supplier**(id, company_id, code, name, status[A], tax, terms, credit, currency, requires_inspection default false); **supplier_contact, supplier_address, supplier_product**(last_price), **supplier_document**
- **warehouse**(id, company_id, code, name, address, manager, status[A]); **zone/rack/shelf/bin**(code unique per wh, type, defaults, archived[A]); **user_warehouses**(user_id, warehouse_id*) — users themselves carry company_id; assignment across companies forbidden
- **stock_balance**(company_id*, variant_id*, warehouse_id*, bin_id*, batch_id?, on_hand, damaged, expired, blocked — physical buckets per bin; NO reserved column; NO in_transit column; in-transit derived from transfers)
- **stock_allocation**(company_id*, variant_id*, warehouse_id*, batch_id?, qty_reserved, version — one row per reservable position; reserved lives here because reservations never pin bins; lock target for ATP, see doc 07 §2)
- **inventory_movement**(*append-only; fields per doc 08); **reservation**(variant, wh, qty, fulfilled/released, status, expires_at*, order_ref, idem_key*)
- **purchase_order**(company_id*, *number, snapshots, version), **po_line**(ordered/order_uom/uom_factor/ordered_base_qty/received_base_qty/returned, price*), **po_approval**(*); **goods_receipt**(company_id*, *GRN, reversal_of_receipt_id?), **receipt_line**(*, order_uom/order_qty/base_qty, qty_excess_blocked)
- **transfer**(company_id*, *number, version), **transfer_line**(requested/shipped/received/damaged/missing), **transfer_shipment/receipt**(*)
- **adjustment**(company_id, reason, evidence, status, version), **adjustment_line**(variant, wh/bin/batch, delta)
- **stock_count**(company_id, warehouse_id, status, snapshot_at, version), **count_line**(bin/batch/serial scope, snapshot_qty, counted_qty, variance)
- **audit_log**(company_id*, full before/after, request_id, idempotency_key) now also records: reservation expiry (actor=system), expiry-job moves, reconciler drift alerts, failed transitions (`transition.denied`), exports, logins/permission changes, notification dispatches
- **sequences**(company_id, name, next — per-company numbering; numbers allocated inside the posting transaction; gaps on rollback are acceptable and never reused)
- **return**(purchase|sales, status), **return_line**(qtys per stage, disposition, inspection*)
- **batch**(variant, batch_no*, expiry* — no quantity fields; batch quantities are `stock_balance`/`stock_allocation` rows with that batch_id), **serial_unit**(serial_no* global unique, status)
- **user, role, permission, user_roles, audit_log***, **notification**, **import_history**(file*, results*), **settings**(scope,key,value)
- All primary entities carry `company_id` placeholder (future multi-tenant; single default in V1).

Archive behavior: master (product/supplier/warehouse/bin/category/brand) → archived flag; transactional (PO/transfer/adjustment/return/receipt) → terminal states (closed/cancelled; posted docs corrected by a separate reversal document, never a `voided` status — INV-025), never deleted. Movements/audit/import history → never archived/deleted within retention.
