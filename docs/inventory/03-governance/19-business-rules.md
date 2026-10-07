# 19 — Business Rules (Normative Catalog)

Format: ID / Name / Trigger / Condition / Result / Exception. This file is NORMATIVE — conflicts resolved in its favor after consistency check.

**INV-001 Cannot sell unavailable stock.** Trigger: reserve/fulfil. Condition: available < requested. Result: fail `insufficient_stock` (or partial if allow_partial). Exception: future authorized backorder only.
**INV-002 Atomic reservation.** Reserve + balance update + movement + audit in one transaction with row lock; concurrent last-unit → exactly one wins.
**INV-003 No negative buckets.** Any posting making a bucket < 0 rejected.
**INV-004 Ledger completeness.** Every balance delta requires ≥1 movement with source + actor + reason; else rollback.
**INV-005 Archive-not-delete.** Deletes forbidden on master + transactional entities; archive/cancel/reverse with audit (no voids — INV-025).
**INV-006 Creator≠approver.** Enforced on PO/transfer/adjustment/return approvals.
**INV-007 PO receiving bound.** Accept only in ordered|partially_received; accepted_total ≤ ordered+tolerance; qty_ordered ≥ qty_received.
**INV-008 Damaged/expired quarantine.** Damaged/expired post to their buckets, never sellable; return to sellable only via inspected repair/restock movement with approval.
**INV-009 Sales returns to quarantine.** Received returns → blocked; restock only after inspection pass.
**INV-010 Transfer integrity.** Ship validates source ATP; receive ≤ shipped; cancel-after-ship forbidden; duplicates idempotent.
**INV-011 Cost snapshots immutable.** Receipt/movement/fulfil costs never rewritten; WAC moves prospectively.
**INV-012 SKU/barcode uniqueness.** Duplicates rejected; SKU immutable once transacted (alias flow instead).
**INV-013 Warehouse scope.** Stock actions outside assigned warehouses → 403 + audit.
**INV-014 FEFO.** Expirable picks order by expiry ASC.
**INV-015 Expiry auto-block.** Nightly job moves expired on_hand→expired; expired unreservable.
**INV-016 Reorder signal.** available ≤ reorder_point raises alert + suggestion (never auto-PO in V1).
**INV-017 Idempotency.** Mutating stock APIs require idempotency key; retry returns original.
**INV-018 Permission re-check.** Permissions + warehouse scope re-validated at submit/approve/post, not just draft.
**INV-019 Discontinued/archived blocks.** Trigger: new PO / reservation / transfer / return. Condition: variant discontinued → block new POs/reservations/transfers; in-flight receipts/transfers/fulfils of existing commitments complete normally. Archived variant/warehouse → block ALL new transactions including returns (except completing an already-shipped transfer receipt). Result: `discontinued_conflict` / `archived_conflict`.
**INV-020 Threshold approvals.** Amounts above role limit route upward; applied only after sufficient approval.
**INV-021 Reserved-stock protection.** Trigger: any removal of sellable units (damage, expiry move, transfer ship, adjustment-out, purchase-return ship, disposal). Condition (per position, doc 07 §2): `(SUM(on_hand) − requested) < qty_reserved`. Result: fail `reserved_conflict`. Exceptions: none (release reservations first).
**INV-022 Cost linkage + reconstruction.** Every purchase return carries `linked_receipt_id` (oldest-receipt-first default); every fulfil carries WAC-at-fulfil as cost basis; sales restock re-admits at that basis. Historical value at T = replay of movements ≤ T with snapshots. Rewriting snapshots forbidden.
**INV-023 Snapshot counts + optimistic locking.** Stock counts operate on a snapshot (`snapshot_at` + frozen `snapshot_qty`); variance = counted vs the system qty of that bin at the moment of counting, posted at apply under lock against the current balance (postings between counting and apply are kept; doc 23 build decisions). All state transitions require `version` match; stale writes fail `version_conflict`.
**INV-024 Company + warehouse scoping.** Every stock/audit/report query and mutation scoped by `company_id`, then `user_warehouses`. Cross-company reads/writes impossible; sequences numbered per company.
**INV-025 Reversals only, never voids.** Posted stock documents corrected only by new reversal/counter documents. A `voided` status or in-place quantity edit on posted docs is forbidden.

Full trigger/condition/result text for each is enforced by flows (doc 20) and tested per doc 27.
