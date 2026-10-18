# 09 — Purchasing

## 1. Entities
**purchase_order:** id, po_number (sequence `PO-YYYY-00001`), supplier_id (+name snapshot), warehouse_id (receiving), status, currency, subtotal, discount, tax, shipping, total, expected_date, notes, creator, approver, timestamps. **po_line:** po_id, variant_id (+sku/name snapshot), qty_ordered, qty_received, qty_returned, unit_price snapshot, discount%, tax%, line_total, batch/expiry required flags copied. **po_approval:** po_id, approver, decision, comment, at. **goods_receipt** (see doc 10) links `po_id`.

## 2. State Machine (summary; full in 23)
`draft → submitted → approved → ordered → partially_received → fully_received → closed`; side exits: `rejected` (→ editable draft), `cancelled` (only from draft|submitted|approved while received==0, else close with returns). `ordered` = sent to supplier (explicit button). Auto-transition to partially/fully on receipts.

## 3. Rules
- PO-01: Creator ≠ approver. Approval limit enforced; over-limit routes to Owner queue.
- PO-02: Approval snapshots prices/totals; post-approval line price change requires re-approval (version bump).
- PO-03: `qty_ordered` cannot drop below `qty_received`. Increasing qty after partial receipt requires re-approval.
- PO-04: Receiving allowed only in `ordered|partially_received`. Each receipt validates `received_total ≤ ordered + tolerance` (tolerance default 0, configurable % per supplier).
- PO-05: Backorder = remaining `ordered − received` stays open until closed/cancelled; closing with remainder requires reason.
- PO-06: Multi-warehouse PO forbidden — one receiving warehouse per PO (split POs instead).
- PO-07: Discounts/tax/shipping at header + line; landed-cost allocation to unit cost is V1.5 (V1 stores them for display + valuation-inclusive reporting only); V1.5 allocates charges entered on a landed-cost document per receipt (doc 15 §1.1) — PO header amounts stay display-only.
- PO-08: PO number immutable; supplier change allowed only in draft.

## 4. Financial Fields (V1)
Line: qty × price − discount% + tax%. Header: subtotal − header discount + tax + shipping = total. Supplier invoice ref stored as text; full AP aging is optional module.

## 5. Build decisions (Part 4, normative)
- PO-09 Editing: header and lines are editable only in `draft` (a rejected PO returns to draft). After approval the only line edit is reducing `qty_ordered` (never below received, PO-03; no re-approval needed). Any increase or price change after approval = close/cancel and raise a new PO, except the over-delivery excess decision (doc 10 §3), which is itself the re-approval: it needs `purchases.approve` covering the excess value and an approver ≠ PO creator. Draft lines are never deleted; a removed line is flagged `removed` and drops out of totals and receiving.
- PO-10 Tolerance: `supplier.receipt_tolerance_pct` when set, else company setting `receiptTolerancePct`. Read at receipt time.
- PO-11 Cost basis: receipt `unit_cost_snapshot` per base unit = `unit_price × (1 − discount%) ÷ uom_factor` (line tax and header discount/tax/shipping excluded, PO-07).
- PO-12 Approval: `purchases.approve` must cover the PO total (limit_amount, INV-020); SUP-02 checked at every approval. Close is blocked while any receipt line has a pending excess decision.
- PO-13 Numbers: `PO-YYYY-00001` / `GRN-YYYY-00001`, per company per year, allocated inside the creating transaction (gaps after rollback accepted, edge #38).

## 6. Reorder engine (Part 11 / T11.2, V1.5, normative)
Implements INV-016: the engine **suggests**; a PO only ever comes from a user pressing "Create draft POs" on `/reorder` (or `POST /api/reorder`). No job, worker or posting ever creates a PO.
- RO-01 Settings per (variant, warehouse) on `variant_warehouse_settings`: `reorder_point`, `reorder_qty`, `max_stock` (existing, edge #37) + `preferred_supplier_id` (nullable, active supplier of the company). A row without `reorder_point` is never suggested. Edited on the product page (`products.update`, warehouse scope).
- RO-02 Trigger: `position = available + on_order ≤ reorder_point`, where `available = Σ on_hand (all bins) − reserved` (same as the low-stock report) and `on_order = Σ max(qty_ordered_base − qty_received_base, 0)` over non-removed lines of POs to that warehouse in `draft|submitted|approved|ordered|partially_received` (OPEN_PO). Drafts count, so a draft created from a suggestion clears it (no double ordering).
- RO-03 Suggested qty (base unit): `max_stock − position` when `max_stock` is set (order up to max); else `max(reorder_qty, reorder_point − position)` (`reorder_qty` null = 0). Then raised to the chosen supplier's `min_order_qty`, and rounded up to a whole unit for serialized items. A result ≤ 0 is not suggested (e.g. reorder point only, position exactly at it — set `reorder_qty`).
- RO-04 Supplier choice + price comparison: every active supplier with a `supplier_product` row for the variant is listed with `last_price` (per base unit), currency, `min_order_qty` and lead days (`lead_days`, else `supplier.lead_time_days`), sorted by price (unknown last). No FX conversion: prices compare only within a currency. Default supplier = `preferred_supplier_id` of the warehouse row → else `supplier_product.is_preferred` → else the cheapest listed → else none (user must pick).
- RO-05 Create draft POs: the user's selected rows `(variant, warehouse, supplier, qty)` are grouped by (supplier, warehouse) — one PO per group (PO-06) — and each group goes through `createPo` (same validation, numbering, audit; price = supplier last price else cost price, base UOM; notes "Created from reorder suggestions"). All groups in one transaction: any failure creates nothing. A (variant, warehouse) may appear once per request. The user can change supplier and qty; qty > 0 is the only requirement (suggestions are advisory).
- RO-06 Access: suggestions and draft creation need `purchases.create` (the role that acts on them) and are limited to the caller's warehouse scope; selecting an out-of-scope warehouse is `forbidden`. Creating POs from suggestions is otherwise identical to a manual PO (approval etc. unchanged).
