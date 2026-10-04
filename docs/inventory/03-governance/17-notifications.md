# 17 — Notifications

## 1. Events (V1 in-app + email; WhatsApp/SMS future)
Low stock (available ≤ reorder_point), out-of-stock, expiring (thresholds 7/30/60/90 configurable), expired (job), PO submitted/approved/rejected/overdue, transfer submitted/approved/shipped/received/variance, adjustment submitted/approved/rejected/applied, receiving discrepancy, return decisions, reservation expiry (optional), import completion/failure.

## 2. Rules
- N-01: Notifications are advisory; they never mutate stock.
- N-02: Preferences per user (in-app always; email opt-in per category); warehouse scope applies (no cross-warehouse leaks).
- N-03: Digest mode for low/expiring (daily) + instant for approvals/discrepancies. Every notification stores `actor, entity, warehouse, link, read_at`.
- N-04: Approval SLA: escalate to Owner after 48h (configurable) with reminder at 24h.
