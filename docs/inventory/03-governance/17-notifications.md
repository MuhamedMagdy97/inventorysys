# 17 — Notifications

## 1. Events (V1 in-app + email; WhatsApp/SMS future)
Low stock (available ≤ reorder_point), out-of-stock, expiring (thresholds 7/30/60/90 configurable), expired (job), PO submitted/approved/rejected/overdue, transfer submitted/approved/shipped/received/variance, adjustment submitted/approved/rejected/applied, receiving discrepancy, return decisions, reservation expiry (optional), import completion/failure.

## 2. Rules
- N-01: Notifications are advisory; they never mutate stock.
- N-02: Preferences per user (in-app always; email opt-in per category); warehouse scope applies (no cross-warehouse leaks).
- N-03: Digest mode for low/expiring (daily) + instant for approvals/discrepancies. Every notification stores `actor, entity, warehouse, link, read_at`.
- N-04: Approval SLA: escalate to Owner after 48h (configurable) with reminder at 24h.

## 3. Build decisions (Part 9)
- N-05 **Recipients:** a notification names one user, or is a broadcast to everyone whose warehouse scope covers its warehouse (company-wide when none) and who holds its grant (`permission`, when set). The center and email use the same rule, so nobody sees another warehouse's events (N-02). Read state is per user.
- N-06 **Categories → mode:** `stock` (low / out of stock, expiring, expired batches) and `reservations` (reservation expiry) go in the daily digest; `approvals` (reminders, escalations), `discrepancies` (transit variance, receiving excess, reconciler drift) and `documents` (approved / rejected / shipped …) are instant. Users opt into email per category; in-app is always on.
- N-07 **Email:** every message is written to an outbox first; a pluggable transport sends it. Until a provider is chosen (deployment, Part 10), messages stay stored (dev/test). Each notification is emailed at most once (claimed before sending).
- N-08 **Stock alerts job:** daily (05:30 UTC, before the 06:00 digest), one summary notification per warehouse and kind (`stock.out`, `stock.low`, `batch.expiring` within the `expiryAlertDays` setting, default 30), at most once per day, for holders of `inventory.view` in that warehouse.
- N-09 **Approval SLA:** hourly. An item waiting ≥ half of `approvalSlaHours` (default 48 → reminder at 24 h) gets one reminder to everyone holding its decision grant in its warehouse; at ≥ `approvalSlaHours` one escalation to each Owner (Super Admins when the company has no Owner). Once per waiting period — a re-submitted document starts over.
