# 01 — Product Scope

## 1. Scope Statement
A multi-warehouse, ledger-driven inventory platform that tracks every unit from supplier purchase through receiving, storage, reservation, fulfilment, transfer, adjustment, damage/expiry, and return — with full auditability, approvals, and reporting. Sales channels integrate via ATP + reservation APIs; IMS does not own checkout/payments.

## 2. Module Tiers
### CORE (MVP/V1 must-have)
1. Product Catalog (products, variants, categories, brands, UOM)
2. Suppliers
3. Warehouses & Locations (warehouse → zone → rack → shelf → bin; MVP may use warehouse + bin only, hierarchy reserved)
4. Inventory Engine (balances + ledger + reservations)
5. Purchasing (PO lifecycle)
6. Goods Receiving (incl. partials, discrepancies)
7. Stock Adjustments (with approvals)
8. Warehouse Transfers
9. Sales Integration (reservations + fulfilment decrements + cancellations)
10. Returns (purchase + sales with inspection)
11. Users, Roles, Permissions (RBAC + warehouse scope)
12. Audit Log
13. Dashboard (V1 KPIs) + Core Reports
14. Import/Export (products, suppliers, opening balances)

### SECONDARY (V1.5 — needed for real operation, not MVP Day 1)
- Batch/Lot + Expiry management + FEFO picking + expiry alerts
- Serial tracking (for serialized SKUs)
- Reorder engine (reorder point suggestions, supplier price comparison)
- Landed cost (shipping/tax allocation to unit cost)
- Stock counts (cycle + full physical with variance workflow)
- Notifications (in-app + email; low/expiring/approval/discrepancy)
- Advanced reports (turnover, dead stock, warehouse performance, profitability assist)

### OPTIONAL (depends on business)
- Barcode label printing, composite/bundle products, multi-UOM purchasing, supplier credit limits/invoices aging, purchase request (pre-PO) workflow, quarantine locations, repair/refurbish flow for damaged.

### FUTURE (explicitly postponed)
- POS / checkout / payments, CRM/customers master, full accounting/GL, multi-tenant SaaS billing, mobile native app (API-ready only), WhatsApp/SMS, demand forecasting, FIFO lot-level costing engine, multi-currency purchasing.

## 3. Per-Module Summary
| Module | Purpose | Primary users | Key entities | Depends on |
|---|---|---|---|---|
| Catalog | Single source of product truth | Inv Mgr, Purchasing | product, variant, category, brand, UOM | — |
| Suppliers | Who we buy from + terms/history | Purchasing | supplier, contact, supplier_product | Catalog |
| Warehouses | Where stock lives | Wh Mgr/Staff | warehouse, zone/rack/shelf/bin | Users/permissions |
| Inventory Engine | ATP + balances + ledger + reservations | All stock actors | stock_balance, movement, reservation | Catalog, Warehouses |
| Purchasing | Plan + approve + order | Purchasing | PO, PO line, approval | Suppliers, Catalog |
| Receiving | Truth of what arrived | Wh Staff | receipt, receipt line | Purchasing, Inventory |
| Adjustments | Correct drift with control | Inv Mgr | adjustment, lines, approval | Inventory |
| Transfers | Move stock between warehouses | Wh Mgr | transfer, lines, receipt | Inventory, Warehouses |
| Sales Integration | Promise + fulfil without oversell | Sales/API | sales order ref, reservation, fulfilment | Inventory |
| Returns | Handle reverse flows safely | Wh + Purchasing/Sales | return, lines, inspection | Inventory, PO/SO refs |
| Reporting | Answer "what/where/worth?" | Owner, Acct, Auditor | report definitions | All |
| Admin/Audit | Who can do what + who did what | Admin, Auditor | user, role, permission, audit_log | — |

## 4. Out of Scope (V1)
Checkout, payment processing, customer master/CRM, general ledger postings, payroll, manufacturing/BOM production, marketplace listing sync. These may integrate later via API but have no tables in V1 except external reference IDs (`external_order_id`, `external_channel`).

## 5. Scope Guardrails
- No stock mutation without a movement + audit entry in the same transaction.
- No feature may require breaking ledger immutability or archive-not-delete.
- MVP must run a real operation: buy → receive → store → reserve → ship → return + adjust + transfer + report. Anything that breaks that chain is MVP, not future.
