# 06 — Warehouses & Locations

## 1. Hierarchy
`warehouse → zone → rack → shelf → bin`. MVP requires `warehouse + bin`; zone/rack/shelf are optional location codes stored on the bin (nullable `zone`, `rack`, `shelf` columns; the bin tree groups by them — promote to tables only if levels ever need their own attributes). Each bin: `warehouse_id, zone?, rack?, shelf?, code (unique per warehouse), type (sellable|receiving|quarantine|damaged), is_default_sellable, is_default_receiving, archived`.

**warehouse:** id, code (unique, e.g., WH-DXB-01), name, address, manager_user_id, status (`active|inactive|archived`), default receiving/quarantine bins.

## 2. Rules
- WH-01: Bin codes unique within warehouse; quarantine + damaged bins auto-created per warehouse; a warehouse always keeps ≥1 active quarantine and ≥1 active damaged bin, and the default sellable/receiving bins cannot be archived (make another bin the default first).
- WH-02: Archive warehouse blocked if any `stock_balance` with (on_hand|damaged|expired|blocked) > 0, any `stock_allocation.qty_reserved` > 0, any open transfer/receipt/count/return (purchase return draft→shipped, sales return requested/approved), or any active reservation references it. Must empty + close first.
- WH-03: Archive bin blocked if balance > 0 on it. Move stock first (transfer or adjustment with audit).
- WH-04: Users restricted via `user_warehouses`. Every stock action validates `warehouse_id ∈ assigned` (or all-access role).
- WH-05: Receiving defaults to receiving bin, then putaway moves to sellable bins (V1 may auto-putaway to default sellable with movement `putaway`; explicit putaway step is V1.5).
- WH-06: Damaged/expired stock must reside in damaged/quarantine bins logically (enforced at movement level via `to_bin_type`).

## 3. Transfers Visibility
Balances visible per warehouse; global view sums across authorized warehouses only. Reports filter by warehouse; cross-warehouse sums labeled explicitly.

## 4. Edge Cases
Warehouse manager leaves → reassign required before archive of user; deleting user never deletes warehouse. Merging warehouses = transfer-all + archive loser.
