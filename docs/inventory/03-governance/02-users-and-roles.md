# 02 — Users, Roles & Permissions

## 1. Role Catalog (only roles actually needed)
| Role | Responsibilities | Sees | Can create/edit | Can approve | Cannot |
|---|---|---|---|---|---|
| Super Admin | Bootstrap, tenants, emergency access | Everything | Users, roles, settings | Anything (break-glass, audited) | Should not do daily ops (policy, not enforced) |
| Business Owner | Financial oversight, approvals above threshold | All dashboards, valuation, all warehouses | Prices (sell), settings thresholds | POs/transfers/adjustments above threshold | Cannot post receipts directly (SoD) |
| Administrator | Users, roles, settings, imports | Users, settings, all master data | Users/roles, warehouses, categories | Nothing financial by default | Cannot approve own requests |
| Inventory Manager | Stock truth, adjustments, counts, transfers | All inventory, ledger, adjustments, transfers | Products, adjustments, transfers, counts | Adjustments, transfers, returns (within limit) | Cannot manage users/roles |
| Warehouse Manager (per warehouse) | Inbound/outbound execution in own warehouse(s) | Assigned warehouses only | Receipts, transfer receipts, damage flags, counts | Transfer requests (own warehouse), small adjustments if granted | Cannot approve own adjustment; cannot see other warehouses unless granted |
| Warehouse Staff | Execute tasks | Assigned warehouse task lists | Receipt confirmations, pick/putaway confirmations, count entries | Nothing | Cannot approve, cannot create POs/products |
| Purchasing Manager | Sourcing, PO approval, supplier terms | Suppliers, POs, receiving discrepancies | Suppliers, POs | POs up to limit, purchase returns | Cannot apply adjustments |
| Purchasing Staff | Draft POs, follow up | Suppliers, own POs | Draft POs | Nothing | Cannot approve |
| Sales Staff | Check ATP, create reservations via SO | Products (sellable), ATP, own orders | Sales order refs / reservations | Nothing | Cannot adjust/receive/transfer |
| Accountant | Valuation, landed cost, history | Valuation, POs, receipts, returns, ledger (read) | Cost corrections via `cost_correction` movement (qty 0, approved) only if granted `inventory.adjust_create` (else read) | Nothing operational | Cannot mutate quantities |
| Auditor | Read-only + export | Everything read-only, audit logs | Nothing (can flag/comment only) | Nothing | Cannot mutate anything |
| Viewer | Read-only limited | Dashboard, products, stock summary | Nothing | Nothing | Everything mutating |

SoD (segregation of duties): creator ≠ approver for PO / adjustment / transfer / return. System enforces `approver_id != creator_id`.

## 2. Permission Model: MODULE.RESOURCE.ACTION (canonical list)
Format: `<resource>.<action>`. Canonical grants (no synonyms):
- Catalog: `products.view/create/update/archive`, `categories.manage`, `brands.manage`, `uom.manage`
- Suppliers: `suppliers.view/create/update/archive`
- Warehouses: `warehouses.view/create/update/archive`, `locations.manage`, `warehouses.assign_staff`
- Inventory (warehouse-scoped): `inventory.view`, `inventory.receive`, `inventory.count_create/count_submit/count_approve/count_apply`, `inventory.adjust_create/adjust_submit/adjust_approve/adjust_apply`, `inventory.damage_mark/damage_approve/repair_approve/dispose_approve`, `inventory.transfer_create/transfer_submit/transfer_approve/transfer_ship/transfer_receive`, `inventory.inspect` (returns/inspection/quarantine decisions)
- Purchasing: `purchases.view/create/update/submit/approve/order/close/cancel`, `purchases.return_create/return_approve/return_ship`
- Sales: `sales.view/reserve/fulfil/cancel`, `sales.return_create/return_approve/return_receive/return_inspect`
- Reports: `reports.view/export`
- Admin: `users.view/manage`, `roles.manage`, `audit.view`, `settings.manage`, `imports.run`, `sequences.view`
- System (break-glass, dual-approval only): `system.migration_run` (admin executes + auditor approves; auditor alone can never post)

There is no `purchases.receive` grant — receiving is `inventory.receive` (physical posting); PO state progression from a receipt additionally requires `purchases.view`. All approval grants may carry `limit_amount`; over-limit routes upward (INV-020).

## 3. Scoping Rules
- **Global vs warehouse-scoped:** `inventory.*` (incl. receive, transfer_*, count_*, adjust_*, damage/repair/dispose, inspect), `sales.reserve/fulfil/return_receive/return_inspect`, and `purchases.return_ship` are warehouse-scoped via `user_warehouses(user_id, warehouse_id)`. All other permissions global.
- If `user_warehouses` non-empty → user sees only those warehouses in selectors, dashboards, reports, and API. Requests for other `warehouse_id` → 403 + audit `access.denied`.
- Super Admin / Owner / Inventory Mgr / Auditor default to all warehouses; everyone else must be explicitly assigned.
- Approval permission may carry a `limit_amount`: e.g., `purchases.approve:5000`. Above limit requires Owner. Enforced at submit time (route to correct approver queue).

## 4. Inheritance & Assignment
- Roles bundle permissions. Users have ≥1 role. Effective permissions = union. Warehouse scope = union of assigned warehouses (most permissive wins for visibility, but actions still need the action grant).
- No per-user permission overrides in V1 (keeps audit simple). Exceptions handled by creating a new role.
- Permission changes take effect immediately; in-flight Draft actions keep creator attribution but re-check permission at submit/approve/post time (fail with `forbidden` + audit).

## 5. Seed Roles (V1)
`super_admin, owner, admin, inventory_manager, warehouse_manager, warehouse_staff, purchasing_manager, purchasing_staff, sales_staff, accountant, auditor, viewer`. Permissions matrix (full table) lives in `24-api-requirements.md` appendix reference and must be seeded idempotently.
