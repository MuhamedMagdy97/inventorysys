# 18 — Audit System

## 1. What Is Logged
Every mutating action on: products/variants/categories/brands, suppliers, warehouses/bins, POs/receipts, transfers, adjustments, reservations/fulfils, returns/inspections, users/roles/permissions, settings, imports. Each entry: `id, at, actor_id (+system), action (create/submit/approve/reject/apply/post/reverse/cancel/inspect/archive...), entity_type+id, warehouse_id?, before JSON, after JSON, reason/note, ip/device, request_id, idempotency_key?`.

## 2. Rules
- A-01: Audit write in SAME transaction as the business write. If audit fails → whole transaction rolls back.
- A-02: Audit immutable: no update/delete grants; retention ≥ 7 years (configurable, never less than legal min).
- A-03: Ledger vs audit: ledger proves stock; audit proves who/why. Both required for every stock change; neither alone sufficient.
- A-04: `audit.view` restricted (Admin/Owner/Auditor + scoped managers see own warehouse actions). Export allowed with `reports.export`.
- A-05: Failed auth/authorization attempts logged (without passwords).
- A-06: Mandatory audit event catalog (each in the same transaction as its action): all state transitions (submit/approve/reject/ship/receive/apply/inspect/close/cancel), every movement post, reservation create/release/fulfil/expire, expiry-job moves, reconciler drift alerts, exports, imports (upload/preview/confirm), user/role/permission changes, settings changes, notification dispatches, failed transitions and double-submit dedup hits.
