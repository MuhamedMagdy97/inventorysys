@AGENTS.md

# Inventory Management System — working rules

Commercial, multi-warehouse, ledger-driven IMS. Solo developer. Built in Parts.

## Where things are
- **Spec (behaviour, normative):** `docs/inventory/` — start at `00-plan/MASTER-SPEC.md`. Conflicts resolve to `03-governance/19-business-rules.md` (INV-001…025).
- **Stack + architecture rules:** `docs/inventory/07-build/00-tech-stack.md`.
- **What to build next:** `docs/inventory/07-build/01-build-plan.md` — work the next unchecked task of the current Part; tick it when its check passes.

## Non-negotiables
- Only `src/server/inventory/` writes `stock_balance`, `stock_allocation`, `inventory_movement`. Balance + movement + audit in ONE transaction.
- No UPDATE/DELETE on movements or audit; corrections are reversal documents. Nothing is hard-deleted.
- `available = SUM(on_hand over bins) − stock_allocation.qty_reserved`. Lock the allocation row first, then bin rows ordered by `bin_id` (`tx.$queryRaw ... FOR UPDATE`).
- Every domain function takes `ctx` and checks permission + `company_id` + warehouse scope itself. Route handlers stay thin (Zod → domain → `withApi`).
- Quantities/money are `Decimal`, never float. Errors use the spec codes only (doc 24).
- If the spec is ambiguous or wrong, fix the spec doc first, then code.

## Prisma 7 notes
- Config is `prisma.config.ts` (loads `.env` via dotenv). Client is generated to `src/generated/prisma` — import from `@/generated/prisma/client`.
- Constraints Prisma can't express go into migrations: `npx prisma migrate dev --create-only`, edit the SQL, then `npm run db:migrate`.
- Prisma reference skills: `.claude/skills/prisma-*`.

## Commands
`npm run db:up` · `npm run db:migrate` · `npm run dev` · `npm test` (real Postgres, auto-migrates `inventory_test`) · `npm run typecheck` · `npm run lint`
