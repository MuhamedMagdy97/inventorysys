# 00 — Overview & Discovery

## 1. Purpose
This document is the entry point for the Inventory Management System (IMS) specification. It records product discovery conclusions so that all downstream documents (scope, modules, entities, rules, flows) have a shared foundation. No code. No implementation decisions beyond conceptual architecture.

## 2. Who Uses This System
| User group | Core problem | What they need daily |
|---|---|---|
| Business Owner | "Am I losing money to stockouts, overstock, expiry, theft?" | Valuation, low/out-of-stock, dead stock, pending approvals |
| Inventory Manager | "Is stock accurate and trustworthy?" | Adjustments, transfers, counts, discrepancies, ledger |
| Warehouse Manager | "Where is everything and what moves today?" | Receiving, picking, putaway, transfers, damaged/expired |
| Warehouse Staff | "What do I receive / pick / count right now?" | Task lists, scan-driven actions, simple confirmations |
| Purchasing Manager | "What to buy, from whom, at what cost?" | Reorder suggestions, POs, approvals, supplier performance |
| Purchasing Staff | "Create POs and receive correctly." | PO creation, receiving entries, discrepancy flags |
| Sales Staff (internal) | "Can I promise this to a customer?" | Available-to-promise (ATP), reservations |
| Accountant | "What is inventory worth and what do we owe suppliers?" | Valuation, landed cost, purchase history, returns |
| Auditor (internal/external) | "Prove every unit movement." | Immutable ledger, audit log, before/after, approvals |
| Viewer / Read-only | "See stock without changing it." | Search, reports |

## 3. Daily vs Occasional Operations
**Daily (high frequency, must be fast + scan-friendly):**
Receiving, reservation creation/release, picking/packing/shipping confirmations, stock lookup, inter-warehouse transfer receipts, damage marking, sales returns inspection.

**Occasional (lower frequency, higher risk):**
Product/catalog changes, UOM conversion changes, supplier archiving, warehouse structure changes, cost method review, imports, stock counts (cycle/full), disposal of expired/damaged, closing POs.

**Approval-required (financially sensitive or corruption-prone):**
PO above threshold, adjustments (all, with auto-approve only for tiny cycle-count variances if configured), transfers out of a warehouse, purchase/sales returns, price/cost overrides, write-off of damaged/expired, cancellation after partial action.

## 4. Discovery Conclusions (binding for all docs)
1. **Ledger-first:** Every quantity change MUST create an immutable `inventory_movement`. Balances are a cached projection. No direct `quantity = X` writes.
2. **Available-to-promise (ATP) is the only sellable number (canonical):** `available = qty_on_hand − qty_reserved`, where `qty_on_hand` holds ONLY sellable units. `blocked / damaged / expired` are separate buckets that have ALREADY been moved out of `on_hand` (see `07-inventory-domain.md` §2, normative). Nothing may reserve or sell more than `available` except an explicit authorized backorder flow (post-MVP). Any other formula in older text is superseded by this definition.
3. **Nothing is deleted:** Products, suppliers, warehouses, categories, brands, POs, transfers, adjustments, movements, audit logs are archived/cancelled/reversed (never voided — INV-025) — never hard-deleted. History must survive.
4. **States are explicit:** PO / Transfer / Adjustment / Return each have a state machine (see `23-state-machines.md`). Actions are only legal in specific states.
5. **Costs are snapshotted:** Every receipt, movement, sale-reference stores `unit_cost` at posting time. Later cost changes never rewrite history (see `15-costing.md`).
6. **Warehouses scope everything:** Stock is always `product_variant + warehouse (+ bin + batch/serial where tracked)`. Global "product quantity" is always a sum, never a stored field.
7. **Damaged/expired are quarantined:** They leave `sellable on_hand` via movement into `damaged`/`expired` buckets. They are not sellable/reservable until inspected and explicitly returned to sellable.
8. **Returns require inspection:** Sales returns default to `quarantine/blocked`, not sellable. Purchase returns reduce on_hand only on shipment/confirmation per lifecycle.
9. **Concurrency is transactional:** Reserve, receive, transfer-receive, and adjustment-apply MUST run in a single atomic transaction with row-level locking / atomic compare (`available >= requested`). Retries use idempotency keys.
10. **Permissions are RBAC + warehouse scope:** `resource.action` grants plus optional `warehouse_ids` restriction. Warehouse-restricted users see only assigned warehouses (see `02-users-and-roles.md`).
11. **Audit is separate from ledger:** Ledger = what happened to stock. Audit log = who did what to which record (including non-stock actions). Both immutable.
12. **Automation never silently mutates stock:** Alerts/suggestions are automatic; stock mutations always require an explicit posted transaction (human or explicitly approved system job, e.g., expiry job creates movements with `actor_id = system`). Backdated postings are forbidden except `opening_balance` and dual-approved migrations (admin executes, auditor approves — auditor role itself is read-only and never posts).
13. **Multi-tenancy is future-proofed, not built:** Every primary entity carries a conceptual `company_id / tenant_id` placeholder. MVP is single-tenant; schema must not need restructuring to add it (see `28-non-functional-requirements.md` + roadmap).
14. **Sales is an integration boundary:** IMS owns reservation/allocation/fulfilment decrements. External channels (POS, web, marketplace) consume ATP and reservation APIs; they do not write stock directly.
15. **Batch/expiry/serial are per-product flags:** `requires_batch`, `requires_expiry`, `is_serialized` on product. If enabled, receiving/transfer/sale MUST supply them. FEFO applies when picking expirable batches.

## 5. What Is Historical & Immutable vs Editable
**Immutable (append-only, never edited):** inventory movements, audit logs, posted receipts, applied adjustments, completed transfer receipts, notifications history, import history records.
**Editable only in Draft (pre-approval/posting):** PO lines, transfer request lines, adjustment lines, return request lines.
**Editable with audit (current attributes):** product name/description/images, supplier contacts, warehouse names, bin labels, reorder points, selling prices. Cost history is never edited — new cost recorded via new receipt.
**Archived, not deleted:** products, variants, categories, brands, suppliers, warehouses/bins, users, price lists.

## 6. Document Map
Read in order: `01-product-scope.md` → `02-users-and-roles.md` → `03/modules.md` → domain docs `04–15` → cross-cutting `16–18` → rules/flows `19–23` → build requirements `24–30` → `MASTER-SPEC.md` for summary. Roadmap/MVP in `29-roadmap.md`, `30-mvp.md`.
