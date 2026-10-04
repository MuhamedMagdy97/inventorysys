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
- PO-07: Discounts/tax/shipping at header + line; landed-cost allocation to unit cost is V1.5 (V1 stores them for display + valuation-inclusive reporting only).
- PO-08: PO number immutable; supplier change allowed only in draft.

## 4. Financial Fields (V1)
Line: qty × price − discount% + tax%. Header: subtotal − header discount + tax + shipping = total. Supplier invoice ref stored as text; full AP aging is optional module.
