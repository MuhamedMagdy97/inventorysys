# Stage 2 — User Flows (behavior before data)

Sources: `20-user-flows.md` (flows 1–28), `19-business-rules.md`, `21-edge-cases.md`, `12-sales-integration.md`, `10-receiving.md`, `11-transfers.md`, `13-returns.md`.

## Task 2.1 — Happy paths (one sheet per flow)
For each of the 28 flows document: actor | preconditions (state + grant + scope) | numbered steps | success state | movements posted | audit events.
Priority order: receive PO (full, partial) → transfer ship/receive → reserve/fulfil/cancel → sales-return inspect/restock → purchase return → adjust → count → damage/repair/dispose → opening balance → remaining admin flows.
- ✅ Done when: each flow names its exact movements (e.g. fulfil = `−on_hand −reserved` + `sale_fulfilment`) and audit entries.

## Task 2.2 — Failure paths
For every happy path add: rejection, cancellation, duplicate submit (idempotent return), `version_conflict`, `reserved_conflict` (I-07), `insufficient_stock`, `batch_insufficient`, expiry-race outcome, `archived_conflict` / `discontinued_conflict`.
- ✅ Done when: every error code in `24-api-requirements.md` is reachable from at least one flow, and each race has exactly one defined winner.

## Task 2.3 — Approval flows
PO / transfer / adjustment / return / count / disposal: approver eligibility (≠creator, limit check), SLA + escalation, reject-with-comment → versioned resubmit.
- ✅ Done when: double-approve yields first-wins + `version_conflict` for the second, with `transition.denied` audited.

## Task 2.4 — Walkthrough gate (paper run, no code)
- W1: buy → receive → reserve → ship → sales return → restock.
- W2: partial transfer with damaged + missing units → variance close.
- W3: reservation open on a batch that expires before fulfil.
- ✅ Done when: all three run end-to-end with no ambiguous step. If stuck, fix `20-user-flows.md` first.
