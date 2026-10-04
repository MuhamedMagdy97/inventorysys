# 10 — Goods Receiving

## 1. Purpose
Record arrival truth. Posting a receipt IMMEDIATELY updates balances + ledger + PO line `qty_received` in one transaction.

## 2. Entities
**goods_receipt:** id, grn (`GRN-YYYY-00001`, sequence allocated inside the posting transaction), po_id, warehouse_id, received_by, received_at, status (`posted` only; corrections via new reversal receipt, never a void flag), idempotency_key, reversal_of_receipt_id?. **receipt_line:** receipt_id, po_line_id, variant_id, order_uom + order_qty + base_qty + uom_factor_used (purchase UOM may differ from base; factor snapshotted), qty_accepted (base units), qty_damaged, qty_expired_rejected, qty_excess_blocked, batch/expiry/serial refs, unit_cost snapshot, bin_id, note.

## 3. Behaviors
| Scenario | System action |
|---|---|
| Full delivery | accepted → +on_hand; PO → fully_received |
| Partial | accepted → +on_hand; PO → partially_received; remainder stays open |
| Over-delivery | accepted up to tolerance → +on_hand; excess above tolerance → +blocked (`blocked_in`) as qty_excess_blocked with linked pending decision. Resolution: (a) approve excess → `blocked_release` (blocked→on_hand) + PO qty_ordered amended with re-approval; or (b) reject → supplier return/dispose. Excess never counts in qty_received until (a) posts. |
| Short / missing | record missing qty on receipt (for supplier claim); no movement for missing |
| Wrong product | reject line (no movement); flag discrepancy; if physically held, post `blocked_in` with reason `wrong_product` (resolved by return to supplier or disposal) |
| Damaged | qty_damaged → +damaged bucket (damaged bin) + `purchase_receipt(damaged)` movement |
| Expired on arrival | → +expired bucket, blocked from sellable |
| Different cost on invoice | receipt keeps PO snapshot cost; variance flagged; cost correction via approved `cost_correction` movement only (qty 0, WAC moves prospectively) |
| Different batch/expiry | create/find batch record; link movement to batch |
| Serialized | require exactly qty_accepted serials, globally unique; duplicates rejected |

## 4. Rules
- RC-01: Receipt requires `inventory.receive` + warehouse assignment. Duplicate submit (same idempotency key) returns existing GRN.
- RC-02: Accepted qty posts to sellable on_hand in receiving/default bin (putaway later). Damaged/expired never touch sellable.
- RC-03: PO line `qty_received` = sum accepted only (damaged excluded).
- RC-04: Receiving an archived variant blocked always. Discontinued: receive of remaining open-PO qty allowed; new POs blocked. In-flight transfers of a newly-discontinued variant complete normally; new transfers blocked.
- RC-05: Inspection (optional): `product_variant.requires_inspection` and/or `supplier.requires_inspection` (both default false, defined in entity model). If either is true, accepted qty first posts to `blocked` (`blocked_in`), then inspection posts `blocked_release` (→on_hand) or `blocked_reject` (→damaged/expired) with approval. Default OFF in MVP.
- RC-06: UOM: PO lines carry `order_uom`; receipts capture `order_qty` and convert to `base_qty` with snapshotted factor; ledger always posts base units.
- RC-07: Receiving validates reserved-protection (I-07) trivially passes (receipts only add); PO warehouse must equal receipt warehouse (PO-06); wrong-warehouse delivery → reject + reassign via new PO/transfer, never silent cross-post.

## 5. Build decisions (Part 4, normative)
- RC-08 Reversal: a reversal receipt (`reversal_of_receipt_id`, one per receipt) mirrors every movement of the original with `reverses_movement_id` (same type, negated deltas, original unit cost; the value never goes below 0 and the last units out take the remaining value). Needs `inventory.adjust_approve` in the warehouse covering the reversed value; fails `insufficient_stock` / `reserved_conflict` if the units are gone or reserved; rolls `qty_received` and the PO status back; pending excess on the original is closed as `reversed`. Not allowed once the PO is `closed`.
- RC-09 Bins: accepted → the chosen sellable/receiving bin (default receiving bin); blocked (excess, wrong product, inspection) → the same bin's `blocked` bucket, so a release lands in place; damaged → default damaged bin; expired → quarantine bin.
- RC-10 Expiry at receipt: a batch expiry ≤ today is rejected (`validation_error`); the operator records those units as expired (B-02). An existing batch number with a different expiry is rejected.
- RC-11 Serials: `serials` lists one serial per accepted + excess unit (status `in_stock`, or `quarantine` for excess/inspection); `damaged_serials` one per damaged + expired unit (status `damaged`). Counts must match exactly or the whole receipt is rejected (edge #19). A reversed receipt sets its serials to `reversed`, which frees the serial number.
- RC-12 Inspection (RC-05) posts accepted units to `blocked`; the inspection decision (`blocked_release`/`blocked_reject`) ships with the inspection screen in Part 7.
- RC-13 Short/missing qty and wrong-product lines that are not physically held are recorded on the receipt for the supplier claim with no movement. Wrong-product units held post `blocked_in` at the current WAC (no WAC dilution).
- Deferred: invoice-price variance + `cost_correction` (later Part); landed cost (V1.5).
