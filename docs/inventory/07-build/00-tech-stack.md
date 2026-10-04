# 07-build / 00 — Tech Stack & Architecture Decisions

Decided 2026-10-04. Binding for the build. Spec docs (00–31) still win on *behaviour*; this file decides *how*.

## 1. Stack

| Concern | Choice | Version (pinned at setup) |
|---|---|---|
| App + API | Next.js App Router, Route Handlers (`app/api/**/route.ts`), Node runtime | 16.3 |
| Language | TypeScript strict | 5.9 |
| DB | PostgreSQL | 18 (docker, port 5433) |
| ORM | Prisma ORM 7 + `@prisma/adapter-pg` driver adapter | 7.10.0 (exact pin) |
| Validation | Zod (request bodies, query strings, env) | 4 |
| Tests | Vitest against a **real** Postgres test DB (`inventory_test`) | 5 |
| UI | Tailwind 4 (+ shadcn/ui components when UI work starts) | — |
| Auth | Better Auth (Prisma adapter, sessions, TOTP 2FA, `@better-auth/api-key` for sales channels) | 1.7.7 (exact pin) |
| Jobs (Part 5) | pg-boss — Postgres-backed queue, separate `worker` process, no Redis | add in Part 5 |
| CI | GitHub Actions: lint → typecheck → test (Postgres service) → build | — |

Add a dependency only in the Part that first needs it.

## 2. Is Prisma + Next.js Route Handlers a good fit? — Yes, with 5 rules

Prisma covers ~90% of this system (CRUD, relations, migrations, typed queries). The remaining ~10% is the ledger core, and Prisma has the escape hatches it needs. Each rule below handles one gap:

1. **Row locks → raw SQL inside interactive transactions.** Prisma has no `FOR UPDATE` in its query API. Every stock mutation runs in `db.$transaction(async tx => …)` and takes locks with `` tx.$queryRaw`SELECT … FOR UPDATE` `` (allocation row first, then bin rows ordered by `bin_id` — doc 07 §2). Always pass explicit `{ timeout, maxWait }` (Prisma's default 5 s timeout is too short under lock contention).
2. **DB constraints Prisma can't model → hand-edited migrations.** `CHECK (qty >= 0)` on every bucket, `UNIQUE NULLS NOT DISTINCT` for `(variant, warehouse, bin, batch)` keys with nullable batch, append-only triggers on `inventory_movement` and `audit_log` (block UPDATE/DELETE). Workflow: `prisma migrate dev --create-only` → append SQL → `prisma migrate dev`. The DB enforces invariants even when app code is wrong (spec Task 3.5: "without app-layer trust").
3. **Money and quantities are `Decimal`**, never `Float`: `Decimal(18,4)` for qty (fractional base units such as kg), `Decimal(18,4)` for unit cost, `Decimal(18,2)` for document totals. IDs are `String @id @default(uuid(7))` (time-sortable, safe to expose in URLs).
4. **Node runtime, long-running server.** Route Handlers use the default Node runtime (never `edge`). Deploy as a container (`next start` + `worker`) on a VPS/Railway/Fly/Render with managed Postgres. Pure serverless (Vercel functions) is possible for the web part, but the worker can't run there and every function opens its own pool, so it isn't the default.
5. **Business logic never lives in route handlers.** Route handlers and Server Actions are thin adapters: parse with Zod → call a domain function → map errors to HTTP. Domain functions live in `src/server/<module>/` and receive a `ctx` (`companyId, userId, warehouseIds, permissions, requestId`). The worker, the UI, external channels and tests all call the **same** functions, so permission checks, audit and idempotency can't be skipped.

## 3. Code layout

```
prisma/schema.prisma          models (added per Part) + migrations/ (hand SQL allowed)
src/app/                      UI pages (App Router)
src/app/api/**/route.ts       public REST API (thin)
src/server/db.ts              single PrismaClient per process
src/server/core/              ctx, errors (spec error codes), idempotency, audit writer, sequences
src/server/inventory/         THE ledger engine: postMovements(), reserve/release/fulfil, ATP, reconciler
src/server/<module>/          catalog, warehouses, purchasing, transfers, returns, counts, reports …
src/worker/                   pg-boss jobs (Part 5+)
src/generated/prisma/         generated client (git-ignored, `npm run db:generate`)
```

**The one rule that protects the whole system:** only `src/server/inventory/` writes to `stock_balance`, `stock_allocation`, `inventory_movement`. Every other module calls its exported functions. Every call writes balance + movement + audit in the caller's transaction (doc 08 §1, A-01).

## 4. Error contract

Domain functions throw `AppError(code, message, details)` using exactly the spec codes (doc 24): `insufficient_stock, reserved_conflict, batch_insufficient, invalid_transition, version_conflict, archived_conflict, discontinued_conflict, reservation_expired, forbidden, not_found, conflict, validation_error, duplicate`. One `withApi()` wrapper maps them to HTTP (409 for stock/version conflicts, 422 for invalid transitions/validation, 403, 404) with `{code, message, details, trace_id}`.

## 5. Multi-tenancy (it's a product to sell)

`company_id NOT NULL` on every primary table from the first migration, and every domain query filters by `ctx.companyId`. That's cheap now and expensive to retrofit later. Postgres Row-Level Security as a second guard is a P11 decision, not MVP.

## 6. Local dev commands

```bash
npm run db:up        # Postgres in docker (dev DB inventory + test DB inventory_test)
npm run db:migrate   # create/apply migrations on dev DB
npm run dev          # http://localhost:3000  (health: /api/health)
npm test             # migrates test DB, runs Vitest
npm run typecheck && npm run lint
```
