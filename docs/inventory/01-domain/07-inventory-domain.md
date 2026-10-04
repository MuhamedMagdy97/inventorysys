# 07 — Inventory Domain (Balances, Buckets & Truth)

## 1. The Golden Rule
There is NO `product.quantity`. Physical stock is `stock_balance(variant_id, warehouse_id, bin_id, batch_id?)`; reserved stock is `stock_allocation(variant_id, warehouse_id, batch_id?)` (see Balance grain below). Global quantity is always `SUM()` over authorized scope.

## 2. Buckets (exact meanings)
| Bucket | Meaning | Sellable? | Reservable? |
|---|---|---|---|
| `qty_on_hand` | Physical sellable units in this warehouse/bin/batch | yes | via available |
| `qty_reserved` | Portion of on_hand promised to orders (subset, not additive). Stored on `stock_allocation` (per variant+warehouse+batch), NOT per bin | no (already promised) | — |
| `qty_blocked` | Quarantine: sales returns awaiting inspection, suspect batches, blocked for count | no | no |
| `qty_damaged` | Units marked damaged, in damaged bin/bucket | no | no |
| `qty_expired` | Units past expiry, auto-moved by job | no | no |
| `qty_in_transit` | DERIVED, not a balance bucket: `SUM(open transfer lines shipped−received)` per variant+source/dest warehouse. Displayed for visibility; never stored on `stock_balance`; never reservable/sellable; valuation reported as a separate in-transit line (see docs 11/15/16). | no | no |

**Derived (normative):** `available = qty_on_hand − qty_reserved`. `qty_on_hand` holds only sellable units; `blocked/damaged/expired` are distinct buckets already moved out of `on_hand` via explicit movements. The older subtracted-blocked phrasing is withdrawn. **Negative values forbidden in every bucket.**

**Balance grain (normative):**
- Physical buckets (`on_hand, blocked, damaged, expired`) live on `stock_balance`, keyed `(variant_id, warehouse_id, bin_id, batch_id NULL-if-untracked)`.
- Reservations never know bins, so `qty_reserved` lives one level up on `stock_allocation`, keyed `(variant_id, warehouse_id, batch_id NULL-if-untracked)` — one row per **reservable position**.
- `available(position) = SUM(stock_balance.on_hand over the position's bins) − stock_allocation.qty_reserved`. Warehouse ATP = SUM over its positions.
- Bins are assigned at putaway/pick time, not at reservation time (reservation pins warehouse + batch; fulfilment picks FEFO bins and decrements the picked bin's `on_hand` and the position's `qty_reserved` in one transaction).
- Lock order (deadlock-safe): the `stock_allocation` row first, then affected `stock_balance` rows ordered by `bin_id`. Every stock mutation touching a position locks its allocation row, which makes it the single serialization point for ATP.
- Serialized variants: balances must equal live `serial_unit` counts (see §5 I-06).

## 3. How Stock Changes (only via movements, same transaction)
- **Increase sellable:** purchase receipt (accepted qty), transfer receipt, adjustment-in, sales-return restock (after pass), found/count-in.
- **Decrease sellable:** fulfilment/shipment, purchase-return shipment, transfer shipment, adjustment-out, damage marking (moves on_hand→damaged), expiry job (on_hand→expired), disposal.
- **Reserve:** `qty_reserved += n` iff `available >= n` atomically; on_hand unchanged.
- **Release:** `qty_reserved -= n` (cancel, partial fulfil remainder, expiry of hold).
- **Fulfil:** `qty_on_hand -= n AND qty_reserved -= n` together.
- **Move warehouse:** ship: source `on_hand -= n` (+ `transfer_out` movement; `transfer_line.qty_shipped += n`); receive: dest `on_hand += n` (+ `transfer_in` movement; `transfer_line.qty_received += n`). In-transit is never written — it is derived from the transfer lines.

## 4. Sources of Truth
- Current ATP per scope → `stock_balance` (physical) + `stock_allocation` (reserved), both cached and transactionally maintained.
- History → `inventory_movement` (append-only). Balances must always equal replay of movements; nightly reconciler verifies and alerts on drift.
- Cost → movement snapshot + WAC layer (see 15).

## 5. Invariants (enforced by DB + app)
I-01 `available >= 0` always; I-02 per position: `stock_allocation.qty_reserved <= SUM(stock_balance.on_hand)`; I-03 no bucket < 0; I-04 every balance delta has ≥1 movement; I-05 every movement references a source doc (PO/receipt/transfer/adjustment/order/return/count/job) + actor + reason; I-06 serialized variants: per position, `SUM(stock_balance.on_hand)` equals `COUNT(serial_unit WHERE status IN ('in_stock','reserved'))` (reserved units are still on hand) and `stock_allocation.qty_reserved` equals `COUNT(status='reserved')`, enforced in the same transaction (serial table is the detail, balances are the summary — both updated atomically, neither alone sufficient).
I-07 **Reserved-stock protection (new, normative):** any operation that would remove sellable units (damage, expiry move, transfer ship, adjustment-out, purchase-return ship, disposal) MUST validate, per position, `(SUM(on_hand) − requested) >= qty_reserved` atomically (under the allocation-row lock). If violated, the operation fails with `reserved_conflict` (operator must release/transfer reservations first or reduce the requested qty). The expiry job releases or auto-expires reservations on expiring batches BEFORE moving stock (see doc 14 §5).
I-08 **Optimistic locking:** every state-machine entity carries a `version` integer; submit/approve/ship/receive/apply compare-and-increment. Stale writes fail with `version_conflict` + audit.
I-09 **Company + warehouse scoping:** every stock/audit query and mutation is scoped by `company_id` first, then `user_warehouses`. Cross-company access is impossible by construction (see INV-024).
