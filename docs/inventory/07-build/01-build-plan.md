# 07-build / 01 — Build Plan (Parts & Tasks)

Supersedes the *ordering* in `06-execution/06-implementation-roadmap.md` (P1→P9). The *gates* there still apply: every Part below lists which P-gate it closes. Stack and architecture: `00-tech-stack.md`.

## Why this order

The full MVP scope stays the same; it's delivered in **11 Parts (0–10)**, each ending in something that runs, is tested and can be demoed.
1. **The riskiest thing goes first.** The ledger engine (old P4) shapes every other module. Building it right after setup, on a minimal catalog/warehouse, means concurrency and invariant bugs show up before 10 modules depend on them.
2. **Sellable alpha at Part 5:** buy → receive → reserve → ship works end to end through UI and API.
3. **Design happens just in time.** Stages 1–5 in `06-execution/` become a per-Part checklist (below) instead of five up-front paperwork phases.

## Per-Part workflow (do this for every Part)

1. **Spec check:** re-read the spec docs listed for the Part; fix the spec first if anything is ambiguous (06-execution rule).
2. **Schema:** add models plus hand-SQL constraints in one migration per Part.
3. **Domain:** functions in `src/server/<module>/` with `ctx`; tests next to them (`*.test.ts`) against the real test DB.
4. **API:** thin route handlers under `src/app/api/` (Zod in, `withApi` out).
5. **UI:** pages for the Part's screens (doc 25).
6. **Gate:** all listed acceptance checks green in CI, then tag `part-N`.

A task is **done** only when its check passes. Never start a Part while the previous gate is red.

---

## Part 0 — Project setup ✅ (done 2026-10-04)
- [x] T0.1 Next.js 16 + TypeScript + Tailwind scaffold at repo root
- [x] T0.2 Prisma 7.10 (pinned) + pg adapter, `src/server/db.ts` singleton
- [x] T0.3 Docker Postgres 18 (dev + `inventory_test`), `.env.example`
- [x] T0.4 Vitest against real DB with auto-migrate (`vitest.global-setup.ts`), smoke test
- [x] T0.5 `/api/health` route (DB round trip), verified in production build
- [x] T0.6 CI workflow (lint, typecheck, test, build)
- [ ] T0.7 First commit + push to GitHub (owner's call)

## Part 1 — Ledger engine core (closes P4 gate) ⚠ highest risk, don't rush — tasks ✅ 2026-10-04; tag `part-1` after CI is green
Spec: 07, 08, 14 §2, 15 §1, 18, 19 (INV-001–004, 011, 017, 021–023, 025), 21 (#1, 2, 13, 16, 17, 26, 31, 32, 38).
- [x] T1.1 **Core plumbing:** `src/server/core/`: `Ctx` type, `AppError` + the spec error codes, `withApi()` route wrapper, Zod helpers. ✅ when: unit test maps every code → HTTP status.
- [x] T1.2 **Minimal masters (schema):** `company`, `user` (id/name/company only; auth comes in Part 2), `warehouse`, `bin` (types + default bins), `product`, `product_variant` (sku, flags, status), `batch`. All with `company_id`. ✅ when: migration applies; seed creates 1 company, 1 warehouse with default bins, 2 variants.
- [x] T1.3 **Ledger schema:** `stock_balance` (per bin, physical buckets), `stock_allocation` (per position, `qty_reserved`, `version`), `inventory_movement` (doc 08 fields), `audit_log`, `sequences`, `idempotency_record` (key → stored response). Hand SQL: `CHECK >= 0` on every bucket, `UNIQUE NULLS NOT DISTINCT` position/balance keys, unique `idempotency_key` per movement leg, triggers blocking UPDATE/DELETE on `inventory_movement` + `audit_log`. ✅ when: tests prove a negative bucket, an UPDATE on a movement, and a duplicate leg key are all rejected **by the DB**.
- [x] T1.4 **`postMovements(tx, ctx, legs[])`**: the only writer. Locks allocation row then bin rows (ordered), applies deltas, enforces I-01/02/03/07, writes movement rows with `balance_after`/`reserved_after` + cost snapshot, writes audit. ✅ when: unit tests per movement type in doc 08 table.
- [x] T1.5 **Reservations:** `reserve` (`allow_partial`, FEFO batch pinning, TTL), `release`, `fulfil` (version check, picks FEFO bins), `cancel`, plus a `reservation` table with `version`. ✅ when: partial fulfil + remainder release test passes.
- [x] T1.6 **Idempotency layer:** `withIdempotency(key, fn)` stores the response; a retry returns the original; derived per-leg keys (MV-02). ✅ when: the same request sent twice → one set of movements, identical response.
- [x] T1.7 **ATP + reconciler:** `getAvailability(ctx, variant, warehouse)`; `reconcile()` replays movements and compares them to balances and allocations. ✅ when: reconciler is clean after the whole test suite.
- [x] T1.8 **Concurrency suite (the gate):** 50 parallel reserves for the last 10 units → exactly 10 succeed; fulfil-vs-expire race → exactly one winner; double-post of the same receipt → one effect; random mixed operations (property test) → no invariant broken and reconciler clean.
- [x] T1.9 **WAC + point-in-time value:** WAC updated on inbound legs; `valueAt(T)` = replay of snapshots ≤ T. ✅ when: valueAt(now) == live valuation on seeded data (INV-022).
- [x] T1.10 API: `GET /api/availability`, `GET /api/balances`, `GET /api/movements`, `POST /api/reservations` (+ `/release`, `/fulfil`, `/cancel`).

## Part 2 — Auth, RBAC, warehouse scope, app shell (closes P1 gate) — tasks ✅ 2026-10-04; tag `part-2` after CI is green
Spec: 02, 18, 26, 19 (INV-006, 013, 018, 020, 024).
- [x] T2.1 Better Auth (email+password, sessions, lockout after 5 fails, optional TOTP 2FA — required for owner/admin roles). Install here.
- [x] T2.2 `role`, `permission`, `user_roles`, `user_warehouses`; idempotent seed of 12 roles × canonical grants (doc 02 §2, `limit_amount` on approve grants).
- [x] T2.3 `requirePermission(ctx, grant, {warehouseId?, amount?})` + scope filter helper; denials → 403 + `access.denied` audit. Domain functions call it themselves (not only routes).
- [x] T2.4 `ctx` built from the session in route handlers / Server Actions; API keys (Better Auth plugin) for sales channels → service-user ctx.
- [x] T2.5 App shell: login, layout, nav gated by permissions, user/role admin pages, audit explorer (before/after diff).
- [x] T2.6 Settings table + company settings page (currency, timezone, TTLs, tolerances; approval limits live on role grants).
- [x] Gate: scope isolation (a user on warehouse A can't read or post warehouse B through any endpoint), creator≠approver helper, permission re-check at post time, audit completeness → `src/app/api/scope.test.ts`, `src/server/auth/auth.test.ts`.

## Part 3 — Catalog, suppliers, warehouses (closes P2 + P3 gates) — tasks ✅ 2026-10-04; tag `part-3` after CI is green
Spec: 04, 05, 06, 22, flows 1–5, edge #3–8, #24.
- [x] T3.1 Full product/variant model: categories (tree, max depth 5, cycle guard), brands, UOM + effective-dated conversions, `sku_alias`/`barcode_alias`, images, `variant_warehouse_settings`, lifecycle states.
- [x] T3.2 Suppliers + contacts/addresses/products/documents, lifecycle, archive guard SUP-01 (open-PO check lands with the PO table, T4.1).
- [x] T3.3 Warehouses/bins full (zone/rack/shelf optional), staff assignment, archive guards WH-02/03 (stock + reservations now; open receipts/transfers/counts join in Parts 4/6/8). Postings take `FOR SHARE` on warehouse/bin rows, archive takes `FOR UPDATE`, so archive-vs-post races have one winner.
- [x] T3.4 Scan lookup `POST /api/products/lookup` (SKU/barcode/alias, never auto-pick on ambiguity).
- [x] T3.5 UI: products list/detail tabs, categories/brands, suppliers, warehouses + bin tree.
- Gate: SKU immutability + alias flow, barcode alias window, archive-blocked-with-stock, category cycle rejected → `src/server/catalog/catalog.test.ts`, `src/server/warehouses/warehouses.test.ts`, `src/server/suppliers/suppliers.test.ts`, `src/app/api/catalog.test.ts`.
- Deferred: image/document **uploads** (URL only for now; import files got allowlist + size caps in Part 8, product uploads follow Part 7 evidence uploads); stock migration for a replaced SKU uses the Part 6 adjustment.

## Part 4 — Purchasing + receiving (closes P5 gate) — tasks ✅ 2026-10-05; tag `part-4` after CI is green
Spec: 09, 10, 14 §3 (serial capture), 23 (PO), flows 6–8, edge #1, 9, 21, 22, 27, 36. Build decisions: 09 §5 (PO-09…13), 10 §5 (RC-08…13).
- [x] T4.1 PO lifecycle on the reusable `stateMachine` helper (`src/server/core/state.ts`, compare-and-increment `version`): draft→…→closed, reject→draft, cancel guard, approval limits, SoD. Also: SUP-01 open-PO check in supplier archive, SUP-02 at approval, open PO lines in product/variant archive guard, open POs in WH-02.
- [x] T4.2 GRN posting: partials, tolerance (supplier % or company setting), damaged/expired splits, excess → `blocked_in` + approve/reject decision, wrong product (held → blocked at WAC), UOM factor snapshot, batch/expiry capture, serial capture (`serial_unit` + I-06 in the reconciler).
- [x] T4.3 Receipt reversal document (mirrors movements via `reverses_movement_id`, once only, never void).
- [x] T4.4 UI: PO list (+ pending over-delivery queue), new PO, PO detail (actions, approvals, receipts, reverse, excess decision), receiving form (idempotent).
- [x] API: `/api/purchase-orders` (+ `/:id`, `/:id/{submit|approve|reject|order|close|cancel|reduce-line}`), `POST /api/receipts`, `/api/receipts/:id/reverse`, `/api/receipt-lines/:id/excess`.
- Gate: full/partial/over/under/wrong/damaged/duplicate-retry/close + reversal, UOM, batch, serial, SoD, archive guards → `src/server/purchasing/purchasing.test.ts`, `src/app/api/purchasing.test.ts`.
- Deferred: inspection decision (`blocked_release`/`blocked_reject` for RC-05 units) with the Part 7 inspection screen; invoice-price variance + `cost_correction`; serialized reserve/fulfil/transfer (Parts 5–6 — posting refuses serialized stock outside receipts until then).

## Part 5 — Sales channel API + background worker → **sellable alpha** — tasks ✅ 2026-10-05; tag `part-5` after CI is green
Spec: 12, 14 §5, 17 (partial), edge #18, 29, 32, 34. Build decisions: 12 §5 (SO-06…11).
- [x] T5.1 pg-boss 12.36.0; `src/worker/index.ts` (stately queues, UTC crons, graceful stop); `npm run worker`.
- [x] T5.2 Jobs in `src/server/inventory/jobs.ts`: reservation TTL expiry (every minute), batch-expiry sweep (B-05 ordering, 00:15 UTC), reconciler with drift → audit `reconcile.drift` + notification (01:45 UTC). One transaction per item; re-runnable. `notification` table (stored only).
- [x] T5.3 `sales_order_ref` (per channel + external id; derived status, order cancel), channel bound to the service user behind each API key, per-channel TTL setting, POS immediate sale, one extension per reservation; fulfil skips expired-batch lines.
- [x] T5.4 UI: `/sales-orders` — ATP check, reserve / sell-now form, reservations with ship/cancel/extend and ATP inline, order view + cancel; channel picker for service users; per-channel holds in settings.
- [x] API: `POST|GET /api/reservations`, `/api/reservations/:id/{fulfil|release|cancel|extend}`, `POST /api/pos-sales`, `GET /api/sales-orders/:id`, `POST /api/sales-orders/:id/cancel`.
- Gate: buy → receive → reserve → fulfil E2E through HTTP (`src/app/api/sales.test.ts`); expiry-vs-fulfil race, killed-mid-job re-run, B-05 sweep, reconciler drift (`src/server/inventory/jobs.test.ts`).
- Deferred: serialized reserve/fulfil + expiry sweep vs open transfers (edge #34) → Part 6; notification center/email → Part 9; multi-line atomic order reserve.

## Part 6 — Transfers, adjustments, damage/repair/disposal, approvals inbox (closes P6 gate, minus counts) — tasks ✅ 2026-10-07; tag `part-6` after CI is green
Spec: 11, 07 I-07, 23, 25 (Approvals Inbox), flows 9–12, 17, 27, 28, edge #10, 11, 23, 25, 31, 33. Build decisions: doc 11 §5.
- [x] T6.1 Transfers: ship (one event, batch pinned per line, serials named) / repeatable partial receive, derived in-transit, damaged → dest damaged bin, missing reported → approved `transfer_variance` (loss at ship snapshot, exact settlement), completed / closed_with_variance. In-transit value line in `valueAt`/`liveValue` + reconciler check. Warehouse/product archive blocked by open transfers.
- [x] T6.2 Adjustments (draft → submitted → approved → applied, separate `adjust_apply`), damage/repair/disposal (apply on approval); limits on value at WAC, I-07 at apply; serialized units for damage/repair/disposal.
- [x] T6.3 Approvals inbox `/approvals` + `GET /api/approvals`: POs, over-deliveries, transfers, transfer losses, adjustments, ready-to-apply; SLA age (`approvalSlaHours` setting, default 48), over-limit flag, approve/reject with comment; stale decision → `version_conflict`.
- [x] UI: `/transfers` (list, new, detail with ship/receive/variance), `/adjustments` (list, new, detail), `/approvals`.
- [x] API: `POST|GET /api/transfers`, `GET /api/transfers/:id`, `POST /api/transfers/:id/{submit|approve|reject|cancel|ship|receive|variance}`, `POST|GET /api/adjustments`, `GET /api/adjustments/:id`, `POST /api/adjustments/:id/{submit|approve|reject|apply|cancel}`.
- Gate: missing/damaged-in-transit, over-receipt blocked, `reserved_conflict`, double-approve (`src/server/inventory/transfers.test.ts`, `adjustments.test.ts`, HTTP `src/app/api/transfers.test.ts`).
- Deferred: serialized found/loss adjustments → Part 8 counts; serialized reserve/fulfil → Part 7 (returns need fulfilled serials); draft editing of transfers/adjustments (reject → cancel + recreate for now); approval escalation job + reminders → Part 9; evidence uploads → Part 7.

## Part 7 — Returns + inspection (closes P7 gate) — tasks ✅ 2026-10-07; tag `part-7` after CI is green
Spec: 13, 19 (INV-008/009/022), flows 8, 16, edge #12, 35. Build decisions: doc 13 §3 + §5 (PR-04…08, SR-05…08, EV-01).
- [x] T7.1 Purchase returns (draft → submitted → approved → shipped → supplier_confirmed → closed) with lines linked to receipt lots (`linked_receipt_id`, oldest-first default + notice, shipper override), relieved at the linked receipt cost; any bucket (on hand / blocked / damaged / expired); supplier_rejected → `blocked_in` at the shipped value; PR-02 per lot; receipt reversal blocked by live returns.
- [x] T7.2 Sales returns (requested → approved → received → inspected → restocked | written_off) against fulfilment movements (SR-01), quarantined at the fulfil cost (`linked_fulfilment_ref`); SR-03 inspection batch for expired originals; SR-02 receiver ≠ inspector where possible.
- [x] T7.3 Quarantine lots (opened/consumed by `postMovements`, reconciler check lots = blocked); inspection decisions `sale_return_restock`/`blocked_release` (+ putaway) / `blocked_reject` / `disposal`; excess lots gated on the PO decision; evidence upload (content-sniffed allowlist, 10 MB cap, audited refusals) for inspections and adjustments.
- [x] Deferred from Part 6: serialized reserve/fulfil (units named at fulfil, `sold` + reservation link; POS sale too); evidence uploads.
- [x] UI: `/returns` (both lists), `/returns/purchase/new` (returnable lots per PO), `/returns/purchase/[id]` (actions, ship with lot override), `/returns/sales/new`, `/returns/sales/[id]` (receive with SR-03 expiry), `/inspection` (quarantine by reason, decision form with evidence, movement preview, recent decisions); serials on the sales-order ship / sell-now forms; inbox shows both return types.
- [x] API: `POST|GET /api/purchase-returns`, `GET /api/purchase-returns/:id`, `POST /api/purchase-returns/:id/{submit|approve|reject|cancel|ship|confirm|supplier-reject|close}`, `POST|GET /api/sales-returns`, `GET /api/sales-returns/:id`, `POST /api/sales-returns/:id/{approve|reject|cancel|receive}`, `GET /api/quarantine`, `POST /api/quarantine/:id/inspect`, `POST /api/evidence` (multipart), `GET /api/evidence/:id`; `serials` on reservation fulfil + POS sale; `evidenceIds` on adjustments.
- Gate: return > fulfilled / received blocked, restock only after pass (+ SR-02), linked cost relieved (not WAC), supplier refusal round trip, SR-03, serialized sale + return, evidence allowlist (`src/server/returns/returns.test.ts`, HTTP `src/app/api/returns.test.ts`); reconciler clean incl. quarantine lots.
- Deferred: cross-warehouse customer returns; per-line pinning of which fulfilment bin a serial left from (linked by batch); virus-scan hook + object storage for evidence (bytea for now); evidence on returns themselves (inspections/adjustments only); draft editing of returns (reject → cancel + recreate); financial credit-note matching (text ref only, V1).

## Part 8 — Counts, opening balance, import/export — tasks ✅ 2026-10-07; tag `part-8` after CI is green
Spec: 23 (count), 19 INV-023, flows 19–21, 26, edge #14, 28. Build decisions: doc 23 (count), doc 08 MV-04, doc 20 flows 20/21/26.
- [x] T8.1 Stock counts (`src/server/inventory/counts.ts`): open → counting → variance_review → approved → applied (+ cancel), snapshot at open (whole warehouse / one bin / SKU list), count entry with scan + found items, system qty recorded per entry under the position lock, variance posted at apply under lock against the current balance (`adjustment_in/out`, I-07), forced recount above `countRecountPct` (setting, default 10 %) + reviewer recount, approver ≠ creator/counters. Serialized found/loss (unit → `lost`, unknown/lost unit found → in_stock). WH-02/03: open counts block warehouse and bin archive.
- [x] T8.2 Opening balance = adjustment kind `opening` (create: `adjust_create` or `imports.run`; approve ≠ creator posts `opening_balance` at `as_of`): unit cost required, batch no + expiry create the batch, serials create units, only for items with no history in that warehouse. MV-04 enforced by `postMovements` and a DB trigger.
- [x] T8.3 Import (`src/server/imports/`): CSV + .xlsx (no new dependency: zip read with node:zlib), ≤ 5 MB / 10 000 rows; `products` and `opening_balance` types; preview = dry run in a rolled-back transaction (per-row savepoints, edge #14); confirm all-or-nothing (default) or valid-only; `import_job` history kept on failure; upload/preview/confirm/failed audited. Stock export CSV scoped to the caller's warehouses with one `export` audit row.
- [x] UI: `/counts` (list + open), `/counts/[id]` (count sheet with scan/found row, variance table with recount selection, approve/apply/cancel), `/imports` (upload, export, history), `/imports/[id]` (preview with row errors, confirm mode), opening kind on `/adjustments/new`, recount % on settings; counts + count apply in `/approvals`.
- [x] API: `POST|GET /api/counts`, `GET /api/counts/:id`, `POST /api/counts/:id/{entries|submit|recount|approve|apply|cancel}`, `POST|GET /api/imports` (multipart), `GET /api/imports/:id`, `POST /api/imports/:id/{confirm|cancel}`, `GET /api/exports/stock`; `/api/adjustments` takes kind `opening` + `asOf`.
- Gate: count vs concurrent postings (incl. apply racing a posting), recount loop, serialized found/loss, I-07, archive guards, opening dual control + backdated value-at-T + MV-04 trigger → `src/server/inventory/counts.test.ts`; import rollback / valid-only / opening import / scoped audited export → `src/server/imports/imports.test.ts`; HTTP `src/app/api/counts.test.ts`. Reconciler clean after the suite.
- Deferred: blind counts (counters see the snapshot qty today); counting damaged/expired/blocked buckets (on_hand only); a serial found in another bin of the same warehouse is rejected at entry (move it first) instead of an automatic putaway; Excel *export* (CSV opens in Excel); async import/export jobs for very large files (sync up to 10 000 rows); product image/document uploads (Part 3 deferral) → with Part 7 evidence uploads.

## Part 9 — Reports, dashboard, notifications, search (closes P8 gate) — tasks ✅ 2026-10-09; tag `part-9` after CI is green
Spec: 16 (V1 set), 17, 25 (global search). Build decisions: doc 16 §3 (RP-01…10), doc 17 §3 (N-05…09).
- [x] T9.1 V1 reports (`src/server/reports/reports.ts`): summary, ledger, valuation (live or as-of replay; by SKU / warehouse / category; in-transit line), low/out, damaged, purchasing + supplier performance, returns (+ dispositions, rates), transfers (in transit with aging + value, variances), product movement. Filters: warehouse, category (incl. sub-categories), brand, SKU, dates (+ ledger type/source/actor/limit). Read-only; `reports.view` + scope in every report; CSV export (`reports.export`, one `export` audit row).
- [x] T9.2 Dashboard (`src/server/reports/dashboard.ts`, `/`): KPIs (value incl. in transit, active SKUs, units, low, out, expiring ≤ 30 d, damaged value, pending POs / transfers, open adjustments), charts as plain CSS/SVG (value by warehouse, by category, movements 30 d), low/out list, pending approvals, recent activity (ledger + audit), alerts rail, permission-gated quick actions; all scope-aware.
- [x] T9.3 Notifications (`src/server/notifications/`): center with grant + scope-filtered broadcasts and per-user read state (`notification_read`), email opt-in per category (`user.email_categories`), `email_outbox` + pluggable transport (stored in dev/test), jobs: instant email (every minute), daily digest (06:00 UTC), daily stock alerts (05:30 UTC, `expiryAlertDays` setting), approval SLA reminder at ½ SLA → Owner escalation at SLA (hourly). Reconciler drift now only for `audit.view` holders.
- [x] T9.4 Global search (`src/server/search/search.ts`, `/search`, header box): SKU / barcode / aliases, PO, sales order, batch, serial, supplier, warehouse, user — each group grant-gated, warehouse-bound groups scoped.
- [x] UI: `/reports` (catalog), `/reports/[name]` (filters, preview, CSV), `/` dashboard, `/notifications` (center + email preferences, unread count in the header), `/search`; expiry-alert days on settings.
- [x] API: `GET /api/reports/:name` (`?format=csv`), `GET /api/dashboard`, `GET /api/notifications`, `POST /api/notifications/read`, `GET|PUT /api/notifications/preferences`, `GET /api/search?q=`.
- Gate: every report under a one-warehouse user (no foreign rows, foreign warehouse → forbidden), summary = balances/allocations/cost layer, valuation total = `liveValue` = `valueAt(now)`, in-transit line = transfers report total, movement net = physical qty, ledger = every movement, audited export, scoped dashboard + search → `src/server/reports/reports.test.ts`; center visibility, instant/digest email, stock alerts, SLA reminder → escalation → `src/server/notifications/notifications.test.ts`; HTTP `src/app/api/reports.test.ts`. Reconciler clean after the suite.
- Deferred: native .xlsx export + async export jobs for very large reports (CSV opens in Excel; ledger capped at 10 000 rows per run); PDF (V1.5); real email provider/SMTP transport (outbox + transport hook ready — wire at deploy, Part 10); per-event low-stock notifications at posting time (daily summary per warehouse instead); V1.5 reports (expiring buckets report, dead/slow stock, lot traceability, warehouse performance); WhatsApp/SMS.

## Part 10 — Hardening + pilot (closes P9 gate)
- T10.1 Full E2E of all 28 flows; fuzz/concurrency suite at volume (100k variants / 1M movements seed).
- T10.2 Perf targets (ATP p95 < 300 ms, reserve p95 < 500 ms at 50 concurrent same-SKU); add indexes and ledger partitioning if needed.
- T10.3 Security pass: rate limits (login/reserve/lookup), step-up auth for sensitive ops, CORS allowlist, headers, secrets.
- T10.4 Deploy: Dockerfile (web + worker), managed Postgres, encrypted daily backups + restore drill.
- T10.5 Pilot on real data via the opening-balance flow.
- Gate: `27-testing-requirements.md` acceptance gates 100% green.

**After Part 10:** V1.5 backlog from `06-execution/06-implementation-roadmap.md`.
