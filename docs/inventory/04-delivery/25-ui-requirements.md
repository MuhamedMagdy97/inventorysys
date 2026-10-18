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
- **Barcode labels (V1.5, T11.6):** read-only print page `/labels?kind=variant|bin|batch|receipt&ids=a,b,…&copies=1..100&layout=a4|thermal&price=1` (bins also `&warehouse=<id>` = every active bin of it). Up to 200 ids, 2,000 labels per page; else `validation_error`. Barcodes are SVG, rendered in-house (no barcode dependency): **EAN-13** when the value is 13 digits with a valid check digit, otherwise **Code 128** (set B, auto-switching to set C for digit runs ≥ 4 at either end or ≥ 6 in the middle), ASCII 32–126 only. Content per kind:
  - *variant* (`products.view`): product + variant name, SKU, barcode = the variant barcode, or the SKU when it has none; sell price + company currency only with `price=1` and a price set.
  - *bin* (`warehouses.view`, warehouses the user can see per doc 02 §3): bin code (barcode), warehouse code (title), zone › rack › shelf.
  - *batch* (`inventory.view`; with a limited scope only batches with stock rows in the user's warehouses): batch no (barcode), SKU, name, expiry (and mfg) date.
  - *receipt* (same visibility as the GRN's PO): one label per received unit kept in stock (`qty_accepted + qty_excess_blocked`; a fractional qty prints 1) — a batch label for batch lines, a variant label otherwise. Damaged/expired/missing units get none. `copies` multiplies every label.
  - Layouts (print CSS `@page`): **a4** = 3 × 8 grid of 70 × 37 mm, 4.5 mm top margin (standard 24-up sheets); **thermal** = one 50 × 30 mm label per page. The toolbar (layout, copies, print) is hidden when printing. Entry points: product detail (per variant + its batches), PO detail (per receipt that is neither a reversal nor reversed), warehouse bin tree (all bins, per zone/rack/shelf group).
- **Users/Roles/Audit/Notifications/Settings:** admin tables, permission matrix editor, audit explorer (before/after diff), notification center, settings forms (company/currency/timezone/tax/thresholds/sequences/reservation TTL).

Global: search (SKU/barcode/PO/SO/batch/serial/supplier/warehouse/user) with scoped results (Part 9: each result group needs its view grant; POs, sales orders, batches, serials and warehouses only from warehouses in scope; SKU/barcode aliases resolve; 2–100 chars, up to 8 hits per group); empty states with next action; error states with trace_id; loading skeletons; mobile-responsive tables (native app future, web must work on scanners/tablets).
