# MASTER-SPEC — Inventory Management System (Summary + Index)

## 1. System in One Page
Ledger-driven, multi-warehouse IMS. Every stock change = immutable `inventory_movement` + balance update + audit entry in ONE transaction. Sellable truth is `available = qty_on_hand − qty_reserved` (normative; `blocked/damaged/expired` are separate buckets already moved out of `on_hand`). `in_transit` is DERIVED from open transfer lines, never a balance bucket. Warehouses scope all stock: physical buckets per `variant + warehouse + bin [+batch]` (`stock_balance`); reserved per `variant + warehouse [+batch]` position (`stock_allocation`), because reservations pin warehouse+batch and bins are assigned at pick. Serial detail (`serial_unit`) and balance summary updated atomically. POs, transfers, adjustments, counts, returns, damage/repair/disposal run explicit versioned state machines with creator≠approver. Sales channels consume ATP + reservation APIs; returns restock only after inspection. Costs snapshotted per movement with receipt linkage; WAC default; point-in-time value = replay of snapshots. Nothing is deleted — archive/cancel/reverse only (posted docs corrected by reversal documents, never voids).

## 2. Data Ownership & Source of Truth (normative)
- Product truth → `product/variant` (catalog). Inventory NEVER stores names/prices; it references + snapshots.
- Current ATP → `stock_balance` (physical, per bin) + `stock_allocation` (reserved, per position); both cached, txn-maintained, allocation row locked first. History → `inventory_movement` (append-only; reconciler proves balance == replay).
- Serial truth → `serial_unit` detail + balance summary, same transaction (neither alone sufficient).
- In-transit → derived `SUM(open transfer lines)`; valuation shown as separate report line.
- Warehouse structure → `warehouse/bin`. Balances without valid warehouse/bin rejected.
- Purchase terms/history → `PO + receipts + returns` (receipts carry `linked` cost basis); supplier master holds only current terms + last-price reference.
- Order promise → `reservation` (versioned); fulfilment decrements require reservation id + version.
- Counts → snapshot (`snapshot_at` + `snapshot_qty`); variance recomputed at apply under lock.
- Who-did-what → `audit_log` (separate from ledger; both required; full event catalog in `18-audit.md` A-06).
- Cost now → WAC layer; cost then → movement snapshot (never rewritten); returns link receipts/fulfils.
- Settings/sequences → per-company; every query scoped `company_id` then `user_warehouses`.

## 3. Inventory Effects Cheat-Sheet (all atomic, idempotent, I-07 guarded)
Receipt accepted +on_hand | damaged +damaged | expired +expired | excess-over-tolerance / wrong-product / inspection-required +blocked (`blocked_in`, pending decision → `blocked_release` | `blocked_reject` | `disposal`) | in-transit loss `transfer_variance` (no bucket change) | cost fix `cost_correction` (qty 0) | reserve +reserved (ATP check) | release −reserved | fulfil −on_hand−reserved (version check) | transfer ship −on_hand source (derived in-transit +) | transfer receive +on_hand dest (source WAC snapshot) | adjust ±on_hand | damage on_hand→damaged | repair damaged→on_hand | expiry on_hand→expired (reservations released first) | disposal −damaged/−expired terminal | sales return +blocked→(pass)on_hand/(fail)damaged/expired/dispose | purchase return ship −on_hand (linked receipt cost). Any removal with per-position `(SUM(on_hand)−requested) < qty_reserved` fails `reserved_conflict`. Never negative.

## 4. State Machines (summary)
PO: draft→submitted→approved→ordered→partially→fully→closed (reject→draft; cancel only pre-receipt). Transfer: draft→submitted→approved→in_transit→partially→completed/closed_with_variance (no post-ship cancel). Adjustment: draft→submitted→approved→applied. Count: open→counting→variance_review→applied→closed (recount loop). Damage/repair/disposal: request→approve→applied. Purchase return: draft→submitted→approved→shipped→supplier_confirmed→closed. Sales return: requested→approved→received→inspected→restocked|written_off. Reservation: active→partial→fulfilled | cancelled/expired. Full guards + versions in `23-state-machines.md`.

## 5. Roles & Permissions (summary)
12 roles with canonical RBAC list (`02-users-and-roles.md` §2 — no synonyms; `inventory.receive` is the physical-post grant); warehouse scope via `user_warehouses`; creator≠approver; amount limits route upward; `system.migration_run` needs admin+auditor dual control (auditor alone read-only).

## 6. Index (read order — paths relative to `docs/inventory/`)
- 00-plan: `00-plan/00-overview.md` · `00-plan/01-product-scope.md` · `00-plan/29-roadmap.md` · `00-plan/30-mvp.md` · `00-plan/MASTER-SPEC.md` (this file)
- 01-domain: `01-domain/03-modules.md` · `01-domain/04-product-management.md` · `01-domain/05-suppliers.md` · `01-domain/06-warehouses.md` · `01-domain/07-inventory-domain.md` · `01-domain/08-stock-movements.md` · `01-domain/14-batch-and-serial.md` · `01-domain/15-costing.md`
- 02-operations: `02-operations/09-purchasing.md` · `02-operations/10-receiving.md` · `02-operations/11-transfers.md` · `02-operations/12-sales-integration.md` · `02-operations/13-returns.md` · `02-operations/20-user-flows.md`
- 03-governance: `03-governance/02-users-and-roles.md` · `03-governance/17-notifications.md` · `03-governance/18-audit.md` · `03-governance/19-business-rules.md` · `03-governance/21-edge-cases.md` · `03-governance/22-entity-model.md` · `03-governance/23-state-machines.md`
- 04-delivery: `04-delivery/16-reporting.md` · `04-delivery/24-api-requirements.md` · `04-delivery/25-ui-requirements.md` · `04-delivery/26-security.md` · `04-delivery/27-testing-requirements.md` · `04-delivery/28-non-functional-requirements.md`
- 05-audit: `05-audit/31-spec-audit.md`
- 06-execution (task files Claude follows, in order): `06-execution/00-plan-index.md` · `06-execution/01-business-specification.md` · `06-execution/02-user-flows.md` · `06-execution/03-database-design.md` · `06-execution/04-api-contract.md` · `06-execution/05-system-architecture.md` · `06-execution/06-implementation-roadmap.md`
- 07-build (stack + active build plan): `07-build/00-tech-stack.md` · `07-build/01-build-plan.md`

## 7. Consistency Check (red-team pass, 2026-09-30)
Second adversarial review performed; 10 critical + 12 high + 8 medium/low findings fixed across all affected docs (see `31-spec-audit.md`). Re-verified: single ATP formula everywhere; no dual source for in-transit/serials/costs; every stock action has permission + audit + idempotency + version guard; MVP deps valid; historical + financial reconstruction defined (replay rule). Normative conflicts resolve to `19-business-rules.md` (INV-001…025) + §2 above. Third pass (2026-10-04) fixed residual contradictions + the reserved-grain gap (`stock_allocation`) — see `31-spec-audit.md` §16.

## 8. Build-Readiness Note
Project scaffold is in place (Next.js 16 + Prisma 7 + Postgres 18, CI). Build proceeds Part by Part per `07-build/01-build-plan.md` (ledger engine first), with gates in `27-testing-requirements.md`.
