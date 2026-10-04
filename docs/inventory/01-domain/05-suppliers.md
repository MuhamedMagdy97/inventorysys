# 05 — Suppliers

## 1. Entities
**supplier:** id, code (unique, e.g., SUP-0001), name, status (`active|inactive|archived`), tax_id, payment_terms (`net15|net30|net60|prepaid|cod`), credit_limit, currency, lead_time_days, notes. **supplier_contact:** supplier_id, name, role, email, phone, is_primary. **supplier_address:** type (`billing|shipping|primary`), lines, city, country. **supplier_product:** supplier_id, variant_id, last_price, currency, min_order_qty, lead_days, is_preferred. **supplier_document:** supplier_id, file_url, type, uploaded_by/at.

## 2. Lifecycle
`active ↔ inactive → archived`. Inactive = temporarily blocked from new POs (existing POs continue). Archived = hidden, blocked from all new POs; history retained.

## 3. Rules
- SUP-01: Archive blocked if any PO in `draft|submitted|approved|ordered|partially_received` exists for supplier. Must close/cancel first.
- SUP-02: At least one contact + one address required before first PO approval.
- SUP-03: `supplier_product.last_price` is informational only; PO line price is snapshot at approval and never auto-updates.
- SUP-04: Credit limit + outstanding (sum of ordered-not-invoiced + invoiced-unpaid, if invoice tracking enabled) is advisory warning in V1, hard-block optional setting.
- SUP-05: Currency fixed per supplier in V1 (multi-currency per PO is future). PO currency = supplier currency.
- SUP-06: Merging suppliers: move history via `supplier_alias`, archive loser. Audited.

## 4. Purchase History & Balances (read model from POs/receipts/returns)
Per supplier: total POs, total received value, return rate, on-time rate, avg lead time, outstanding qty/value, last purchase date/price per variant. No separate balance table in V1; computed from PO/receipt/return states.

## 5. Edge Cases
Supplier archived with draft PO → PO must be cancelled; archived with confirmed receipt history → history stays, supplier name denormalized on PO snapshot (`supplier_name_snapshot`).
