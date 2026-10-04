# Stage 1 — Business Specification (freeze the truth)

Sources: `01-product-scope.md`, `19-business-rules.md`, `02-users-and-roles.md`, `23-state-machines.md`, `18-audit.md`, `30-mvp.md`.

## Task 1.1 — Scope lock
- Confirm MVP vs V1 vs V1.5 vs Future from `01-product-scope.md` + `30-mvp.md`.
- Produce a 1-page scope lock: each module marked MVP / V1 / V1.5 / Future.
- ✅ Done when: no MVP item depends on a V1.5/Future item.

## Task 1.2 — Rule register
- Extract INV-001…INV-025 into a table: ID | trigger | condition | result | exception.
- Link each rule to: entity + workflow + state machine + test requirement.
- Coverage matrix format: `rule ID | entities | flow #s (doc 20) | state machine (doc 23) | edge case #s (doc 21) | test layer (doc 27)`.
- ✅ Done when: zero rules are orphaned (every row has at least one flow and one test layer).

## Task 1.3 — Roles & permissions lock
- Finalize the canonical grant list (`02-users-and-roles.md` §2 — no synonyms; `inventory.receive` is the physical-post grant).
- Build the role × grant matrix + warehouse-scope matrix + approval limits + SoD (creator≠approver) + `system.migration_run` dual control.
- ✅ Done when: every mutating action in `20-user-flows.md` maps to exactly one grant.

## Task 1.4 — State machines lock
- Sign off all machines in `23-state-machines.md`: PO, transfer, adjustment, count, damage/repair/disposal, both returns, reservation, product lifecycle.
- Record for each transition: actor, required grant, pre-state, guard conditions, version handling, invalid-transition error.
- ✅ Done when: cancel-after-partial, reject→resubmit, and race outcomes are all explicit.

## Task 1.5 — Audit catalog lock
- Sign off event catalog A-06 (`18-audit.md`): transitions, postings, reservation lifecycle, system jobs, reconciler alerts, exports/imports, user/role changes, settings, denials, dedup hits.
- ✅ Done when: every stock mutation has movement + balance + audit in the SAME transaction.

## Stage gate
All five tasks green before Stage 2. Any ambiguity → fix the spec doc, not this plan.
