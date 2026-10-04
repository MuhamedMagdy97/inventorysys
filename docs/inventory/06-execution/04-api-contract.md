# Stage 4 — API Contract (spec only, no implementation)

Sources: `24-api-requirements.md`, `02-users-and-roles.md`, Stage 2 flows, Stage 3 scopes.

## Task 4.1 — Endpoint inventory
Cover: products/variants/categories/brands + scan lookup; availability/balances/ledger; reserve/release/fulfil/cancel; POs (CRUD + submit/approve/reject/order/close/cancel); receipts (+reversal, excess approve/reject, quarantine intake); transfers (request/submit/approve/ship/receive/variance); adjustments; counts (open/snapshot/submit/variance/approve/apply/recount); inspections (quarantine list, decide, evidence); opening/repair/disposal; both returns lifecycles; reports run + export (sync small / async large); users/roles; imports (upload→preview→confirm); audit explorer; notifications; settings.
- ✅ Done when: every Stage-2 flow step maps to an endpoint.

## Task 4.2 — Schemas + validation
Per endpoint: inputs (SKU format, qty>0, future expiry, batch/serial required when flags on, UOM fields), outputs (resulting balances + movement IDs + audit ID), error codes: `insufficient_stock, reserved_conflict, batch_insufficient, invalid_transition, version_conflict, archived_conflict, discontinued_conflict, reservation_expired, forbidden, not_found, conflict, validation_error, duplicate`.
- ✅ Done when: request/response shapes are explicit enough to implement without guessing.

## Task 4.3 — Idempotency + concurrency
Client `Idempotency-Key` header on all mutating stock calls (header→result mapping + derived per-leg keys per MV-02); current `version` required on all state changes (stale → `version_conflict` + `transition.denied` audit).
- ✅ Done when: retry/refresh/double-click/double-approve all defined as safe replays, never double-posts.

## Task 4.4 — AuthZ per endpoint
Required grant + `company_id` + `user_warehouses` scope check + SoD, re-validated at submit/approve/post (INV-018), server-side only. Scope-isolation cases: user A cannot read or post warehouse B (403 + `access.denied` audit).
- ✅ Done when: endpoint → grant → transaction-scope trace is complete with zero orphans.
