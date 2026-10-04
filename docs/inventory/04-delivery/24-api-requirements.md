# 24 — API Requirements (Conceptual, No Code)

Conventions (binding for later build): REST/JSON; auth bearer+refresh; every stock-mutating POST requires client `Idempotency-Key` header (server maps header→result AND stores derived per-leg keys per MV-02); every state-changing PATCH/POST requires current `version` (optimistic locking, INV-023); errors `{code, message, details, trace_id}` with codes: `insufficient_stock, reserved_conflict, batch_insufficient, invalid_transition, version_conflict, archived_conflict, discontinued_conflict, reservation_expired, forbidden, not_found, conflict, validation_error, duplicate`. Pagination `?page&per_page&sort&filter`; scope filtering server-side by company + warehouses. All mutating responses include resulting balances + movement ids + audit id.

Groups:
- **Products:** CRUD + archive, variant mgmt, category/brand mgmt, bulk lookup by SKU/barcode (`POST /products/lookup` for scans — `:` can't appear in a route folder name; returns every match per code, never auto-picks). Perms per doc 02. Errors: `duplicate` (`details.field` = sku|barcode), `conflict` with `details.reason = "immutable_flag"`.
- **Inventory:** `GET /availability?v&wh` (ATP), `GET /balances`, `GET /movements` (ledger, filterable), reserve/release/fulfil endpoints (atomic, TTL, allow_partial). Business rules INV-001/002/004.
- **Warehouses:** CRUD + bins + assign users. Archive guards WH-02/03.
- **Purchasing/Receiving:** PO CRUD + submit/approve/reject/order/close/cancel; receipts post (multipart lines with batches/serials); returns lifecycle. Idempotent GRN numbering server-side.
- **Transfers:** request/submit/approve/ship/receive(+variance resolve). Ship/receive validate ATP + serials/batches.
- **Returns:** both flows + inspection decisions.
- **Counts:** open/snapshot/submit/variance/approve/apply/recount endpoints (snapshot semantics per INV-023).
- **Inspection:** quarantine list, inspect decisions (restock/damage/expire/dispose with evidence refs), excess-delivery approve/reject.
- **Opening/repair/disposal:** dedicated endpoints under `inventory.*` grants with dual-control (creator≠approver).
- **Reports:** run with filters → sync CSV/Excel (async for large, job id + download).
- **Users/Roles/Audit/Notifications/Settings/Imports:** standard CRUD + run + history. Imports: upload→preview→confirm two-phase.
- **Webhooks (V1.5):** stock.low, stock.out, reservation.expired, po.approved, transfer.received.

Rate limits on reservation/lookup (scan bursts); input validation (SKU format, qty>0, future expiry); file upload allowlist + size caps.
