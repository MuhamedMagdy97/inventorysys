# 08 — Stock Movements (Ledger)

## 1. Purpose
Immutable, append-only ledger. Every quantity change creates ≥1 movement in the SAME DB transaction as the balance update and audit entry. Ledger is the legal history of inventory.

## 2. Movement Schema (conceptual)
`id, company_id*, variant_id, warehouse_id, bin_id?, batch_id?, serial_id?, type, qty_delta (+/-), balance_after {on_hand,damaged,expired,blocked} (the touched bin row) + reserved_after (the position's `stock_allocation`), unit_cost_snapshot, linked_receipt_id? (for purchase returns), linked_fulfilment_ref? (for sales-return restock), uom + uom_factor_used, source_type (purchase_receipt|transfer|adjustment|reservation|fulfilment|return|count|expiry_job|damage|repair|disposal|putaway|opening|system), source_id, reverses_movement_id?, reason_code, note, actor_id (or system), idempotency_key (unique), created_at (immutable)`.

**Storage form (normative):** `qty_delta` is stored as signed per-bucket deltas `d_on_hand, d_blocked, d_damaged, d_expired, d_reserved` (a bucket move such as `damage` is `d_on_hand −n, d_damaged +n` on one row; `sale_fulfilment` is `d_on_hand −n, d_reserved −n`). Reservation legs carry no `bin_id`. Replay is then a plain `SUM` per bin (physical buckets) and per position (reserved). WAC lives per (variant, warehouse) in `variant_cost`.

Putaway is recorded as TWO legs (`putaway_out` −bin A, `putaway_in` +bin B, same `source_id`, net 0) so per-bin replay stays exact.

## 3. Movement Types (closed list, extensible only by migration)
| Type | Why | Delta | Reversible? | Editable? |
|---|---|---|---|---|
| opening_balance | Initial stock (approved flow, doc 20 flow 26) | +on_hand | via adjustment only | never |
| purchase_receipt | Goods accepted | +on_hand (accepted); +damaged/+expired for rejects | via purchase return / adjustment | never |
| sale_fulfilment | Shipped to customer | −on_hand (picked bin) −reserved (position) | via sales return | never |
| sale_return_quarantine | Received awaiting inspection | +blocked | via inspect (→restock/blocked_reject/disposal) | never |
| sale_return_restock | Inspected OK | blocked→on_hand | via adjustment | never |
| purchase_return | Shipped back to supplier (carries `linked_receipt_id`; relieved at that receipt's cost, INV-022) | −on_hand, or −blocked/−damaged/−expired for rejected/excess/damaged units (doc 13 §5 PR-04) | via new receipt; supplier refusal → `blocked_in` | never |
| transfer_out | Warehouse move, ship leg (source) | −on_hand; derived in-transit rises via `transfer_line.qty_shipped` | via reverse transfer | never |
| transfer_in | Warehouse move, receive leg (dest) | +on_hand (or +damaged for damaged-in-transit); derived in-transit falls via `transfer_line.qty_received/qty_damaged` | via reverse transfer | never |
| transfer_variance | Approved in-transit loss (missing units) | no bucket change (units already left source on ship); closes derived in-transit via `transfer_line.qty_missing`; relieves value at the ship snapshot | no (terminal loss) | never |
| adjustment_in / adjustment_out | Corrections, found/loss, count variance | ±on_hand | via counter-adjustment | never |
| cost_correction | Approved unit-cost correction (e.g., invoice ≠ PO price) | qty 0; carries corrected `unit_cost_snapshot`, WAC moves prospectively | via counter cost_correction | never |
| damage | Mark damaged (approved) | on_hand→damaged | via repair_to_stock | never |
| repair_to_stock | Inspected repair back to sellable (approved) | damaged→on_hand | via damage (re-mark) | never |
| expiry | Auto-block by expiry job | on_hand→expired | no | never |
| disposal | Final write-off of damaged/expired/blocked (approved) | −damaged / −expired / −blocked → 0 | no (terminal) | never |
| reservation / reservation_release | Promise / unpromise | ±reserved (position) | yes (release) | never |
| blocked_in | Quarantine hold: excess over tolerance, wrong product held, inspection-required receipt (RC-05), supplier-rejected return | +blocked | via blocked_release / blocked_reject / disposal | never |
| blocked_release | Hold cleared after approval/inspection pass | blocked→on_hand | via counter movement | never |
| blocked_reject | Inspection fail | blocked→damaged or blocked→expired | via repair_to_stock | never |
| putaway_out / putaway_in | Bin move within warehouse (paired legs, same source_id) | −on_hand bin A / +on_hand bin B (net 0) | n/a | never |

Reversal = NEW counter-movement referencing original (`reverses_movement_id`), never UPDATE/DELETE.

## 4. Audit Requirements per Movement
actor, timestamp, source doc, before/after per bucket, reason code + free note, idempotency key, device/channel (web/api/mobile/scan) for warehouse ops.

## 5. Rules
- MV-01: Posting without movement fails validation (transaction rolled back).
- MV-02: Idempotency is two-layer. Clients send `Idempotency-Key` header on every mutating stock call; the server maps header→result and returns the original on retry. Internally each movement leg carries a derived key `{source_type}:{source_id}:{line}:{leg}` (unique) so retries and double-posts can never duplicate a leg.
- MV-03: Movements immutable: no UPDATE/DELETE grants exist.
- MV-04: Backdated postings forbidden except `opening_balance` and dual-approved migrations (admin executes, auditor approves; auditor never posts directly). A DB trigger rejects `created_at` more than 5 minutes before the transaction time for every other type. An opening balance may only be posted for a (variant, warehouse) with no movements yet, so a backdated row never lands before history that depends on it; its `created_at` = the document's `as_of` (≤ now).
- MV-05: No void-in-place. Posted receipts/transfer receipts/adjustments are corrected ONLY by new reversal/counter documents referencing the original (`reverses_movement_id` / `reversal_of_receipt_id`). A `voided` status on receipts is forbidden.
