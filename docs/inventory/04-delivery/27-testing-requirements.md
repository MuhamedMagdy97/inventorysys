# 27 — Testing Requirements (What Must Be Tested; No Test Code)

- **Unit (rules):** available calc, FEFO ordering, WAC snapshot propagation (rule-level), SKU/barcode validation, state guards, tolerance math, TTL/expiry transitions.
- **Integration (transactional integrity):** receipt posts balances+movements+PO+audit atomically; rollback on audit/movement failure; concurrent reserve-last-unit (exactly-once); concurrent receipts idempotent; transfer ship/receive pairs; return quarantine→restock legs; permission+scope re-checks at post time.
- **API:** auth/forbidden cases, idempotency retries, validation errors, pagination/scope isolation (user A cannot see wh B), error codes.
- **E2E (flows doc 20, all 28):** buy→receive→reserve→fulfil→return; partial receive/transfer; damage/expiry; count variance; import valid/invalid; approve/reject/resubmit.
- **Property/chaos:** randomized concurrent reserves never oversell; kill mid-txn → no partial post; replay ledger == balances (reconciler).
- **Acceptance gates:** 100% of INV-* rules (now INV-001…025) + edge cases 1–38 covered; ledger-balance reconciliation passes on seeded + fuzz data; audit completeness (every stock write has movement+audit); point-in-time valuation replay verified against live WAC on seed data; concurrent fulfil-vs-expiry and double-approve races tested for exactly-once outcome.
