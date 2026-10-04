# Stage 5 — System Architecture

Sources: `28-non-functional-requirements.md`, `26-security.md`, `17-notifications.md`, `16-reporting.md`, `27-testing-requirements.md`.

## Task 5.1 — Components
API backend (transactions per Stage 3.4) + workers: reservation-expiry, expiry sweep (B-05 ordering), ledger↔balance reconciler + drift alert, notification dispatch (digest + instant), import processor, async export jobs. File storage for evidence photos + import files. Report path: sync CSV/Excel small, job-ID + download large.
- ✅ Done when: every Stage-4 endpoint and job has an owner component.

## Task 5.2 — Integrity + recovery
Same-txn ledger+audit writes; nightly reconciler (replay == balances); backups encrypted, RPO ≤ 24h / RTO ≤ 4h + quarterly restore drill; client retry/refresh safe via idempotency; worker retries keyed idempotently.
- ✅ Done when: "DB dies halfway / retry after success / refresh mid-post" each has a defined safe outcome.

## Task 5.3 — Security
Password hashing (argon2/bcrypt) + MFA required for admin/owner; session expiry + rotation; lockout; server-side authZ on every request; step-up + reason for approve/apply/ship/dispose/role changes; upload allowlist + size caps + scan hook; rate limits (login, reserve, lookup); bearer short-lived + CORS allowlist; secrets in vault/env; audit retention ≥ 7 years.
- ✅ Done when: privilege-escalation, horizontal/vertical access, approval-bypass, and scope-bypass cases from `31-spec-audit.md` are all closed by construction.

## Task 5.4 — Boundaries + observability
Sales/POS/web/marketplace via ATP + reservation APIs only (no direct stock writes); same domain serves future mobile/scanner flows (lookup, receive, transfer, count); webhooks deferred to V1.5. Observability: request/trace IDs, reserve-latency / receipt-volume / variance-rate metrics, job dashboards.
- ✅ Done when: NFR targets (ATP p95 < 300ms single-warehouse; 100k variants / 1M movements-yr baseline) are credible on this topology. Deferred items (WAC formula detail, multi-currency, FIFO) recorded as future — not silently assumed.
