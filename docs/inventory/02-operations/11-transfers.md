# 11 — Warehouse Transfers

## 1. Lifecycle (required stages; picking/packing optional in V1)
`draft → submitted → approved → in_transit (shipped) → partially_received → completed`; exits: `rejected → draft`, `cancelled` (only before ship), `closed_with_variance` (short/damaged acknowledged).

V1 keeps pick/pack as a single "ship" confirmation with line qtys; full WMS picking waves are future.

## 2. Entities
**transfer:** id, number (`TR-YYYY-00001`), from_wh, to_wh, status, creator/approver, shipper/receiver, notes. **transfer_line:** transfer_id, variant_id, batch/serial refs, qty_requested, qty_shipped, qty_received, qty_damaged, qty_missing. **transfer_shipment** (ship event) + **transfer_receipt** (receive event, idempotent).

## 3. Inventory Effects (transactional)
- Ship: source `on_hand −= shipped` + `transfer_out` movement. Validates per source position `available >= shipped` AND `(SUM(on_hand) − shipped) >= qty_reserved` (I-07) atomically. `in_transit` is derived from open transfer lines, not a balance bucket.
- Receive: dest `on_hand += accepted` (+ `transfer_in` movement carrying source WAC snapshot); damaged → dest damaged bucket (`transfer_in` to damaged); missing = shipped − received − damaged → flagged, resolved via an approved `transfer_variance` movement (in-transit loss; no bucket change, closes the derived in-transit) + audit. In-transit value is reported separately until receipt (see docs 15/16).
- Partial receives allowed repeatedly until received+damaged+missing == shipped, then `completed` or `closed_with_variance`.

## 4. Rules
- TR-01: Same-warehouse transfer forbidden. Creator ≠ approver. Receiver must have `inventory.transfer_receive` on destination.
- TR-02: Ship blocked if source ATP insufficient at ship time (re-check; request-time check is advisory).
- TR-03: Duplicate receipt (same idempotency key) returns existing; over-receipt above shipped blocked.
- TR-04: Serialized/batch-tracked lines must specify units/batches on ship AND receive; mismatch blocks posting.
- TR-05: Cancel after ship forbidden — must receive + reverse-transfer.
- TR-06: Valuation in transit: source relief at source WAC on ship; dest admission at the same snapshot on receive (no revaluation). Reports show in-transit value as its own line until receipt (no double-count, no disappearance).
- TR-07: Discontinued/archived mid-transfer: in-flight transfers complete normally; new transfer requests for discontinued/archived variants blocked. Transfers to/from an archived warehouse blocked (must re-target before ship; in-transit to a warehouse archived mid-flight completes receipt, then stock must be moved out before warehouse archive can proceed per WH-02).

## 5. Discrepancies
Damaged in transit → dest damaged bucket + claim note. Missing → the receiver reports it (`transfer_line.qty_missing_reported`, no movement) → an approver (`inventory.transfer_approve` on the destination, ≠ transfer creator) approves it as a `transfer_variance` movement (loss at ship snapshot value; sets `transfer_line.qty_missing`, which removes it from derived in-transit) or rejects it (report cleared, units stay in transit). Extra (received > shipped) → rejected on the transfer (TR-03 / INV-010 win); units that physically arrived on top are booked at dest with an approved adjustment-in (reason `found`).

**Build decisions (Part 6):** ship is one event per transfer (line qty_shipped ≤ qty_requested; an unshipped remainder is simply not sent). A line pins one batch at request time (TR-04 for batches); serialized lines list unit serials on ship and on receive. Each line keeps `shipped_value` (exact value relieved at source) and `settled_value`; a receive/variance takes `qty × shipped_value / qty_shipped`, and the one that settles the line takes the exact remainder, so in-transit value always reaches 0. `transfer_variance` carries no bucket delta, `unit_cost_snapshot` = ship snapshot, and `value_delta` = −loss; it is booked against the source warehouse but is not part of that warehouse's stock value (in-transit value at T = −Σ value_delta of `transfer_out` and `transfer_in` + Σ value_delta of `transfer_variance`, all up to T). Status after a receive/variance: all units accounted with no damaged/missing → `completed`; otherwise `closed_with_variance`.
