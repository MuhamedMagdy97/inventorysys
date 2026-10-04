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

There is no `purchases.receive` grant — receiving is `inventory.receive` (physical posting) scoped to the PO's warehouse; that grant also lets the receiver look up POs targeting their warehouses, and the PO state progression is a consequence of the posting (no `purchases.*` grant needed). Receipt reversal (doc 10 RC-08) needs `inventory.adjust_approve` in the warehouse, limit-checked on the reversed value. All approval grants may carry `limit_amount`; over-limit routes upward (INV-020).

## 3. Scoping Rules
- **Global vs warehouse-scoped:** `inventory.*` (incl. receive, transfer_*, count_*, adjust_*, damage/repair/dispose, inspect), `sales.reserve/fulfil/return_receive/return_inspect`, and `purchases.return_ship` are warehouse-scoped via `user_warehouses(user_id, warehouse_id)`. All other permissions global.
- If `user_warehouses` non-empty → user sees only those warehouses in selectors, dashboards, reports, and API. Requests for other `warehouse_id` → 403 + audit `access.denied`.
- Super Admin / Owner / Inventory Mgr / Auditor default to all warehouses; everyone else must be explicitly assigned.
- Approval permission may carry a `limit_amount`: e.g., `purchases.approve:5000`. Above limit requires Owner. Enforced at submit time (route to correct approver queue).

## 4. Inheritance & Assignment
- Roles bundle permissions. Users have ≥1 role. Effective permissions = union. Warehouse scope = union of assigned warehouses (most permissive wins for visibility, but actions still need the action grant).
- No per-user permission overrides in V1 (keeps audit simple). Exceptions handled by creating a new role.
- No privilege escalation: a user may only assign roles, add grants, or assign warehouses that they themselves hold (an admin sets passwords, so assigning a role is equivalent to holding it). Roles beyond the Administrator's own grants (e.g. owner, purchasing_*) are assigned by a Super Admin. Violations → `forbidden` (`reason = "escalation"`) + `access.denied` audit.
- Permission changes take effect immediately; in-flight Draft actions keep creator attribution but re-check permission at submit/approve/post time (fail with `forbidden` + audit).

## 5. Seed Roles (V1)
`super_admin, owner, admin, inventory_manager, warehouse_manager, warehouse_staff, purchasing_manager, purchasing_staff, sales_staff, accountant, auditor, viewer`. Roles are per company (`role.company_id`); the 12 seed roles are `is_system` (grants editable, code not). The canonical matrix is §5.1 and is seeded idempotently (re-running adds missing roles, never overwrites grant edits).

### 5.1 Seed grant matrix (normative)
`x.*` = every action of that resource in §2. `:N` = `limit_amount` N in company currency (no suffix = unlimited). ★ = all warehouses by default (§3).

| Role | Grants |
|---|---|
| super_admin ★ | every grant in §2 except `system.migration_run` |
| owner ★ | every `*.view`, `reports.*`, `audit.view`, `settings.manage`, `purchases.approve`, `purchases.return_approve`, `inventory.adjust_approve/transfer_approve/count_approve/damage_approve/repair_approve/dispose_approve`, `sales.return_approve` (no posting grants — SoD) |
| admin | `users.*`, `roles.manage`, `audit.view`, `settings.manage`, `imports.run`, `sequences.view`, `products.*`, `categories.manage`, `brands.manage`, `uom.manage`, `suppliers.*`, `warehouses.*`, `locations.manage` |
| inventory_manager ★ | `products.view/create/update`, `suppliers.view`, `warehouses.view`, `locations.manage`, `inventory.*` with `adjust_approve:1000`, `damage_approve:1000`, `repair_approve:1000`, `dispose_approve:1000`; `sales.view`, `sales.return_approve`, `purchases.view`, `purchases.return_approve:1000`, `reports.view/export`, `audit.view` |
| warehouse_manager | `products.view`, `suppliers.view`, `warehouses.view`, `locations.manage`, `inventory.view/receive/count_create/count_submit/adjust_create/adjust_submit/damage_mark/transfer_create/transfer_submit/transfer_approve/transfer_ship/transfer_receive/inspect`, `purchases.view`, `purchases.return_ship`, `sales.view/fulfil/return_receive/return_inspect`, `reports.view`, `audit.view` (own warehouses) |
| warehouse_staff | `products.view`, `warehouses.view`, `inventory.view/receive/count_submit/transfer_ship/transfer_receive/damage_mark`, `sales.view/fulfil/return_receive` |
| purchasing_manager | `products.view`, `suppliers.*`, `purchases.*` with `approve:5000`, `return_approve:5000`; `reports.view` |
| purchasing_staff | `products.view`, `suppliers.view/create/update`, `purchases.view/create/update/submit`, `purchases.return_create` |
| sales_staff | `products.view`, `inventory.view`, `sales.view/reserve/fulfil/cancel`, `sales.return_create` |
| accountant | `products.view`, `suppliers.view`, `warehouses.view`, `inventory.view`, `purchases.view`, `sales.view`, `reports.view/export`, `audit.view` |
| auditor ★ | every `*.view`, `reports.view/export`, `audit.view`, `sequences.view` |
| viewer | `products.view`, `warehouses.view`, `inventory.view`, `reports.view` |

Limits: a user's effective limit for a grant is the highest across their roles; any role holding the grant without a limit = unlimited. Amount above the limit → `forbidden` with `details.reason = "over_limit"` (routes upward, INV-020).

## 6. Authentication (normative for build)
- Email + password (min 10 chars). Accounts are created by an admin (`users.manage`); no self sign-up.
- Lockout: 5 consecutive failed passwords → account locked 15 min; success resets the counter. Every failure is audited `auth.login_failed` (never the password), every success `auth.login` (A-05).
- Sessions: 7-day expiry, rolling refresh after 1 day. Disabling a user revokes their sessions.
- TOTP 2FA optional for everyone, **required** for `super_admin`, `owner`, `admin`: until enabled, that user's ctx carries no permissions (`forbidden`, `details.reason = "2fa_required"`) and the UI sends them to 2FA setup.
- Sales channels authenticate with an API key (header `x-api-key`) bound to a **service user** (`user.is_service`, cannot log in) whose roles + warehouses define what the channel may do; ctx channel = `api`.
