# 14 — Batch/Lot & Serial Tracking

## 1. Decision
Supported from V1 as per-product opt-in flags (`requires_batch`, `requires_expiry`, `is_serialized`). When OFF, tracking tables unused. When ON, every inbound/outbound/reservation line MUST supply them. Expiry alerts + FEFO active for expirable products.

## 2. Batch Model
**batch:** id, variant_id, batch_no (unique per variant), supplier_id?, mfg_date?, expiry_date (required if requires_expiry), no quantity fields (batch quantities exist only as `stock_balance` rows and `stock_allocation` rows carrying that `batch_id`, per warehouse — no mirrors, no second truth). Rules: B-01 batch_no format supplier-or-system (`B-YYYYMMDD-####`); B-02 expiry must be future at receipt (else reject to expired bucket); B-03 FEFO: all picks/reserves/fulfils order by expiry ASC; B-04 expired batches auto-move on_hand→expired via nightly job (movement actor=system, reason=expiry_job) and become unreservable instantly.

## 3. Serial Model
**serial_unit:** id, variant_id, serial_no (globally unique), batch_id?, status (`in_stock|reserved|sold|in_transit|quarantine|damaged|disposed|returned_pending`), warehouse_id, movements history. Invariant (I-06): ONE unit = ONE row; per position, `SUM(stock_balance.on_hand)` = COUNT(`in_stock` + `reserved`) and `stock_allocation.qty_reserved` = COUNT(`reserved`) (same transaction). Lifecycle: received(in_stock) → reserved → sold → (returned_pending → quarantine → in_stock|damaged|disposed). A serial is in exactly one warehouse at a time; inter-warehouse moves only via transfer (`in_transit` between ship and receive); wrong-product assignment rejected at scan time.

## 4. Interaction
A variant may be batch-tracked AND serialized (serial carries batch_id). Never allow serialized qty > 1 per line without itemized serials. S-01 duplicates rejected globally (including across products/warehouses); S-02 ship/receive/return/count must list serials; S-03 count mismatch blocks posting; S-04 repair flow (damaged→quarantine→in_stock) requires approval + note + `repair_to_stock` movement; disposal is terminal (`disposed`, never re-activated).

## 5. Expiry vs Reservations (normative ordering)
B-05: The nightly expiry job processes each expiring batch in this order within one transaction per batch: (1) auto-expire/release reservations pinned to the batch (movement `reservation_release`, reason `batch_expired`, notification to order owner); (2) move remaining `on_hand→expired` (movement `expiry`, actor=system). A fulfil racing the job wins or loses atomically via the reservation version check — expired reservations can never fulfil. FEFO is MANDATORY (not advisory) for all expirable picks/reserves/fulfils/transfers.
