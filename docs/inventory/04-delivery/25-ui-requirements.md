# 25 — UI / Screen Requirements (No Design, Requirements Only)

Each screen: purpose / info / actions / filters / perms / states (empty/loading/error).

- **Dashboard:** KPIs+charts+alerts+recent+pending approvals; scope-aware; quick actions gated.
- **Products + Product Detail:** table (sku, name, brand/cat, ATP total, reorder flag, status); detail tabs: info/variants/stock-by-wh/movements/batches/serials/suppliers/history. Actions: edit/archive/adjust/transfer/reserve (gated).
- **Categories/Brands:** tree/table mgmt, move/merge/archive with guards.
- **Suppliers + Detail:** profile, contacts/addresses, products+last price, POs, returns, performance.
- **Warehouses/Locations:** warehouse cards + bin tree; balances per bin; assign staff.
- **Inventory (central):** variant×warehouse matrix with available/on_hand/reserved/blocked/damaged/expired; filters (wh/cat/brand/flags/low/out/expiring); row → ledger drawer.
- **Stock Movements (ledger):** filterable table (date/type/source/actor/variant/wh), before/after, cost; export.
- **Adjustments / Transfers / POs / Receiving / Returns / Counts:** list (status filters) + detail (lines, approvals timeline, post actions) + wizards (create/receive/inspect) with validation + idempotency (disable double-submit).
- **Sales Orders (refs):** reservations + fulfil/cancel; ATP inline.
- **Reports:** catalog + filter builder + preview + export.
- **Approvals Inbox (required):** unified queue of POs/transfers/adjustments/returns/counts awaiting current user, with SLA age, amount, diff view, approve/reject-with-comment, escalation status. Without this, approvals stall silently.
- **Stock Counts:** open/snapshot view, count entry (scan), variance table, recount trigger, approve+apply with recomputed variance display.
- **Inspection:** quarantine list (blocked by reason: return/excess/wrong-product), inspect form (disposition + evidence photos + approver), restock/write-off preview with exact movements to be posted.
- **Transfer Ship/Receive:** serial/batch pickers, partial-receive repeat form, variance acknowledgment (missing/damaged) with claim note field.
- **Users/Roles/Audit/Notifications/Settings:** admin tables, permission matrix editor, audit explorer (before/after diff), notification center, settings forms (company/currency/timezone/tax/thresholds/sequences/reservation TTL).

Global: search (SKU/barcode/PO/SO/batch/serial/supplier/warehouse/user) with scoped results; empty states with next action; error states with trace_id; loading skeletons; mobile-responsive tables (native app future, web must work on scanners/tablets).
