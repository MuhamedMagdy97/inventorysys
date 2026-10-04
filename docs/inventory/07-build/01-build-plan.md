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

## Part 2 — Auth, RBAC, warehouse scope, app shell (closes P1 gate)
Spec: 02, 18, 26, 19 (INV-006, 013, 018, 020, 024).
- T2.1 Better Auth (email+password, sessions, lockout after 5 fails, optional TOTP 2FA — required for owner/admin roles). Install here.
- T2.2 `role`, `permission`, `user_roles`, `user_warehouses`; idempotent seed of 12 roles × canonical grants (doc 02 §2, `limit_amount` on approve grants).
- T2.3 `requirePermission(ctx, grant, {warehouseId?, amount?})` + scope filter helper; denials → 403 + `access.denied` audit. Domain functions call it themselves (not only routes).
- T2.4 `ctx` built from the session in route handlers / Server Actions; API keys (Better Auth plugin) for sales channels → service-user ctx.
- T2.5 App shell: login, layout, nav gated by permissions, user/role admin pages, audit explorer (before/after diff).
- T2.6 Settings table + company settings page (currency, timezone, TTLs, tolerances, approval limits).
- Gate: scope isolation (a user on warehouse A can't read or post warehouse B through any endpoint), creator≠approver helper, permission re-check at post time, audit completeness.

## Part 3 — Catalog, suppliers, warehouses (closes P2 + P3 gates)
Spec: 04, 05, 06, 22, flows 1–5, edge #3–8, #24.
- T3.1 Full product/variant model: categories (tree, max depth 5, cycle guard), brands, UOM + effective-dated conversions, `sku_alias`/`barcode_alias`, images, `variant_warehouse_settings`, lifecycle states.
- T3.2 Suppliers + contacts/addresses/products/documents, lifecycle, archive guard SUP-01.
- T3.3 Warehouses/bins full (zone/rack/shelf optional), staff assignment, archive guards WH-02/03.
- T3.4 Scan lookup `POST /api/products:lookup` (SKU/barcode/alias, never auto-pick on ambiguity).
- T3.5 UI: products list/detail tabs, categories/brands, suppliers, warehouses + bin tree.
- Gate: SKU immutability + alias flow, barcode alias window, archive-blocked-with-stock, category cycle rejected.

## Part 4 — Purchasing + receiving (closes P5 gate)
Spec: 09, 10, 14 §3 (serial capture), 23 (PO), flows 6–8, edge #1, 9, 21, 22, 27, 36.
- T4.1 PO lifecycle (state machine helper with `version`, reused by every later document): draft→…→closed, reject→draft, cancel guard, approval limits.
- T4.2 GRN posting: partials, tolerance, damaged/expired splits, excess → `blocked_in` + decision, wrong product, UOM conversion snapshot, batch/expiry capture, serial capture (`serial_unit` + I-06).
- T4.3 Receipt reversal document (never void).
- T4.4 UI: PO list/detail/wizard, receiving wizard (scan-friendly).
- Gate: the doc 06-execution P5 case list (full/partial/over/under/wrong/damaged/duplicate-retry/close).

## Part 5 — Sales channel API + background worker → **sellable alpha**
Spec: 12, 14 §5, 17 (partial), edge #18, 29, 32, 34.
- T5.1 Install pg-boss; `src/worker/index.ts` process; `npm run worker`.
- T5.2 Jobs: reservation TTL expiry, nightly batch-expiry sweep (B-05 ordering), nightly reconciler with drift alert.
- T5.3 Sales order refs, channel API keys, POS immediate-sale (reserve+fulfil in one transaction), reservation extension (max 1).
- T5.4 UI: sales orders/reservations page with ATP inline.
- Gate: buy → receive → reserve → fulfil E2E through the HTTP API; expiry-vs-fulfil race; the worker can be killed mid-job and safely re-run.

## Part 6 — Transfers, adjustments, damage/repair/disposal, approvals inbox (closes P6 gate, minus counts)
Spec: 11, 07 I-07, 23, 25 (Approvals Inbox), flows 9–12, 17, 27, 28, edge #10, 11, 23, 25, 31, 33.
- T6.1 Transfers: ship/receive partials, derived in-transit, `transfer_variance`, closed_with_variance.
- T6.2 Adjustments (all approved in MVP), damage/repair/disposal flows.
- T6.3 Approvals inbox (all document types, SLA age, approve/reject with comment, double-approve → `version_conflict`).
- Gate: missing/damaged-in-transit, over-receipt blocked, `reserved_conflict`, double-approve.

## Part 7 — Returns + inspection (closes P7 gate)
Spec: 13, 19 (INV-008/009/022), flows 8, 16, edge #12, 35.
- T7.1 Purchase returns with `linked_receipt_id` (oldest-first default), supplier_rejected path.
- T7.2 Sales returns → quarantine → inspection → `sale_return_restock` / `blocked_reject` / `disposal`; batch fallback rule SR-03.
- T7.3 Inspection screen (quarantine list by reason, evidence upload with allowlist + size caps).
- Gate: return > fulfilled blocked, restock only after pass, linked cost relieved correctly.

## Part 8 — Counts, opening balance, import/export
Spec: 23 (count), 19 INV-023, flows 19–21, 26, edge #14, 28.
- T8.1 Stock counts: snapshot, count entry (scan), variance recomputed at apply under lock, recount loop.
- T8.2 Opening balance flow (dual control, the only backdated posting).
- T8.3 CSV/Excel import: upload → preview → confirm (all-or-nothing default), import history; scoped export with audit.
- Gate: count with concurrent postings applies the correct variance; import rollback; export is audited.

## Part 9 — Reports, dashboard, notifications, search (closes P8 gate)
Spec: 16 (V1 set), 17, 25 (global search).
- T9.1 V1 reports (summary, ledger, valuation, low/out, damaged, purchasing, returns, transfers incl. in-transit line, movement) with CSV/Excel export.
- T9.2 Dashboard KPIs + charts, scope-aware.
- T9.3 Notifications: in-app + email (digest + instant), approval SLA escalation job.
- T9.4 Global scoped search.
- Gate: every report respects warehouse scope; numbers reconcile with the ledger.

## Part 10 — Hardening + pilot (closes P9 gate)
- T10.1 Full E2E of all 28 flows; fuzz/concurrency suite at volume (100k variants / 1M movements seed).
- T10.2 Perf targets (ATP p95 < 300 ms, reserve p95 < 500 ms at 50 concurrent same-SKU); add indexes and ledger partitioning if needed.
- T10.3 Security pass: rate limits (login/reserve/lookup), step-up auth for sensitive ops, CORS allowlist, headers, secrets.
- T10.4 Deploy: Dockerfile (web + worker), managed Postgres, encrypted daily backups + restore drill.
- T10.5 Pilot on real data via the opening-balance flow.
- Gate: `27-testing-requirements.md` acceptance gates 100% green.

**After Part 10:** V1.5 backlog from `06-execution/06-implementation-roadmap.md`.
