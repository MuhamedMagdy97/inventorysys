# Build Plan Index — how Claude must work through this project

> **Updated 2026-10-04:** building now follows `07-build/01-build-plan.md` (Parts 0–10, sliced delivery). Stages 1–5 below are no longer up-front phases; they're the per-Part checklist (spec check → schema → domain → API → UI → gate) applied just in time to each Part. The P1–P9 gates in `06-implementation-roadmap.md` still apply, mapped to Parts in the build plan.

> Source of truth: `D:\inventory sys\docs\inventory\` (00–31 + MASTER-SPEC). Normative rules: INV-001…INV-025 in `19-business-rules.md`. Nothing here overrides those docs — if this plan ever conflicts with them, the spec docs win.

## File order (follow strictly, one stage at a time)

1. `01-business-specification.md` — freeze scope, rules, roles, states, audit. NOTHING downstream starts until its gate passes.
2. `02-user-flows.md` — happy paths + failure paths + approvals for all 28 flows. Gate: 3 paper walkthroughs pass.
3. `03-database-design.md` — entities, ledger, reservations, transactions, constraints, seeds. Gate: every flow representable + replay works.
4. `04-api-contract.md` — endpoints, schemas, errors, idempotency, authZ. Gate: flow→endpoint→permission→transaction trace complete.
5. `05-system-architecture.md` — components, jobs, integrity, security, observability. Gate: NFRs credible.
6. `06-implementation-roadmap.md` — P1→P9 build order with per-phase gates. V1.5 only after P9.

## Working rules for Claude

- One file at a time; never start a later file while its predecessor's gate is red.
- When a gate fails, fix the referenced `docs/inventory/` spec doc first, then continue. Code/design must never contradict INV rules.
- Every task below has an explicit acceptance check. A task is done only when its check passes.
- ~~No implementation code in Stages 1–5.~~ Superseded: see the note at the top.
