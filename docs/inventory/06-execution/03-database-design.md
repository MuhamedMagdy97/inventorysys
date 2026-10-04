# Stage 3 — Database Design (from flows + entities, no code)

Sources: `22-entity-model.md`, `07-inventory-domain.md`, `08-stock-movements.md`, `14-batch-and-serial.md`, `15-costing.md`.

## Task 3.1 — Entity sheets
For each entity: PK/FK, required vs optional, immutable-after-post (`*`), archivable, `company_id`, `version` (all state machines). New confirmations: `requires_inspection` on variant + supplier; `variant_warehouse_settings` holds reorder thresholds (per warehouse, NOT on variant); PO lines carry `order_uom/order_qty/base_qty/factor`; per-company sequences.
- ✅ Done when: field lists match `22-entity-model.md` with zero extras invented.

## Task 3.2 — Balance grain (non-negotiable)
- `stock_balance(variant_id, warehouse_id, bin_id, batch_id?)` holds physical buckets; `stock_allocation(variant_id, warehouse_id, batch_id?)` holds `qty_reserved` (reservations never pin bins). No `in_transit` column (derived from open transfer lines). No `product.quantity`. Global qty is always a sum.
- Canonical: `available = SUM(on_hand over the position's bins) − qty_reserved`; blocked/damaged/expired already moved out of `on_hand`. Serialized: balance summary = live `serial_unit` counts, same transaction (I-06).
- ✅ Done when: the grain + formula are stated identically everywhere (kills the old dual-formula bug).

## Task 3.3 — Ledger schema
`inventory_movement`: legs, per-bucket `balance_after`, cost snapshot, `linked_receipt_id` (purchase returns, oldest-first default), fulfil cost basis (sales restock), `uom + factor`, `reverses_movement_id`, idempotency keys (client header mapping + derived per-leg key), actor/reason, putaway as paired legs, reversal-only corrections (INV-025 — no `voided` flag).
- ✅ Done when: every Stage-2 flow produces its listed movements with these fields.

## Task 3.4 — Transaction scopes
One atomic scope per flow: balances + movements + source doc + audit commit together or roll back together. Jobs (reservation-expiry, expiry sweep per B-05 ordering, reconciler, imports) scoped per batch. Lock plan: lock the `stock_allocation` row first, then affected `stock_balance` rows ordered by `bin_id`, for reserve/receive/ship/apply; version checks on all state transitions; I-07 removal guard per position `(SUM(on_hand) − requested) >= qty_reserved`.
- ✅ Done when: fulfil-vs-expiry, last-unit reserve, and double-approve each have exactly one winner by construction.

## Task 3.5 — Constraints, indexes, seeds
Uniqueness: SKU, barcode (with 30-day alias), serial global, document numbers per company (gaps allowed, never reused, allocated in-txn). Checks: no negative buckets, `qty_reserved <= SUM(on_hand)` per position (enforced in the locked transaction; a plain row CHECK can't span bins). Indexes: ATP lookup, ledger listing, scope filters. Seeds: 12 roles + grants, default bins, settings, one company.
- ✅ Done when: constraints enforce I-01…I-09 without app-layer trust.

## Stage gate
Prove: every Stage-2 flow is representable; point-in-time replay (INV-022: value at T = movements ≤ T with snapshots) works. Fix `22-entity-model.md` on any gap.
