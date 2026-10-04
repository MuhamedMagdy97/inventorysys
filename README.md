# inventorysys

Multi-warehouse, ledger-driven inventory management system. Every stock change is an immutable movement with a matching audit entry. It covers purchasing, receiving, transfers, reservations, returns, counts and reporting, with RBAC and warehouse scoping.

**Stack:** Next.js 16 (App Router + Route Handlers) · Prisma 7 · PostgreSQL 18 · Vitest · Tailwind 4

## Getting started

Requires Node 24+ and Docker.

```bash
cp .env.example .env
npm install
npm run db:up
npm run db:migrate
npm run dev
```

Open http://localhost:3000/api/health. It should return `{"status":"ok","db":"ok"}`.

## Checks

```bash
npm test
npm run typecheck
npm run lint
```

Tests run against a real Postgres database (`inventory_test`, created by docker compose).

## Docs

- Specification: [`docs/inventory/00-plan/MASTER-SPEC.md`](docs/inventory/00-plan/MASTER-SPEC.md)
- Tech stack & architecture: [`docs/inventory/07-build/00-tech-stack.md`](docs/inventory/07-build/00-tech-stack.md)
- Build plan & tasks: [`docs/inventory/07-build/01-build-plan.md`](docs/inventory/07-build/01-build-plan.md)
