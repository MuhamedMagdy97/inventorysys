# 21 — Edge Cases (Aggressive Catalog)

Each: scenario → required behavior. All must be tested (doc 27).
1. Concurrent receipt of same PO line by 2 users → idempotency + row lock; second gets duplicate-or-insufficient error, never double-post.
2. Two users reserve last unit → exactly one 200, other 409 with current available.
3. Archive product with stock → allowed but blocked from new transactions; stock must be sold/transferred/written-off.
4. Archive supplier with open POs → blocked (close/cancel first).
5. Archive warehouse with inventory/open docs → blocked.
6. SKU change after transactions → forbidden; alias flow (new variant + transfer adjustment).
7. Barcode change → allowed, audited, uniqueness enforced; old barcode kept as alias 30d (configurable) to avoid scan failures.
8. UOM factor change → new effective-dated record; history keeps old snapshot.
9. PO qty reduced below received → rejected.
10. Transfer short/damaged on arrival → variance flow (damaged bucket + missing adjustment + claim note).
11. Duplicate transfer receipt retry → idempotent return, no double increment.
12. Return > sold/received → rejected.
13. Negative stock attempt → rejected (except explicit write-off path which still never leaves negative).
14. Import duplicate SKUs / invalid qty → row-level errors, preview, all-or-nothing default; history retained.
15. Permission revoked mid-draft → submit/approve/post fails 403 + audit.
16. Double-submit / refresh during txn → idempotency key dedupes.
17. DB fail mid-txn → full rollback (balances+movements+audit atomic); safe retry.
18. Reserved batch expires before fulfil → auto-release expired portion + notify; fulfil blocked on expired.
19. Serial duplicate → reject line, no partial post.
20. Batch qty mismatch (sum legs ≠ line) → reject.
21. Supplier price change mid-PO → PO keeps snapshot; variance flagged.
22. Over-delivery above tolerance → excess to blocked + approval, never auto-sellable.
23. User approves own request → blocked (creator≠approver).
24. Category cycle (parent=self/descendant) → rejected.
25. Warehouse merge with in-transit → blocked until in-transit completes.
26. Expiry job vs concurrent sale → job's row lock wins; sale re-checks ATP after lock.
27. Backdated receipt → rejected (except opening/migration with auditor).
28. File upload malicious/oversize → validate type/size, quarantine, audit.
29. Clock skew on reservation TTL → server time authoritative.
30. Zero-qty lines → rejected at validation.
31. Damage/expiry/transfer-ship on reserved stock (on_hand−requested < reserved) → `reserved_conflict`; operator releases reservations or reduces qty (INV-021).
32. Fulfil racing reservation expiry → version check decides exactly one winner; loser gets `reservation_expired`/`version_conflict`, never a half-post.
33. Double-approve (two approvers click simultaneously) → first commits (version++), second gets `version_conflict` + audit `transition.denied`.
34. Expiry job vs open transfer carrying that batch → transfer lines pinned to the batch complete first; job processes only residual on_hand after in-transit resolves (else `batch_in_transit` defer + alert).
35. Purchase return without linked receipt (multi-receipt ambiguity) → defaults oldest-receipt-first with explicit notice; shipper may override lot selection.
36. Receiving to a warehouse archived mid-receipt → blocked `archived_conflict`; re-target via new PO.
37. Reorder alert uses per-warehouse thresholds (`variant_warehouse_settings`); global-only thresholds would false-fire — fixed by per-warehouse settings.
38. Sequence gaps after rollback → accepted, never reused (no duplicate GRN/PO/TR numbers).
