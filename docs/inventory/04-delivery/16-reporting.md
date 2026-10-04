# 16 — Reporting & Dashboard

## 1. Dashboard (V1)
KPIs: inventory value (WAC × on_hand), SKUs active, total units (sellable), low-stock count, out-of-stock count, expiring ≤30d, damaged value, pending POs, pending transfers, open adjustments. Charts: value by warehouse, value by category, movement volume 30d. Tables: low/out list, recent activity (last 20 ledger+audit), pending approvals. Alerts rail: expiries, stockouts, discrepancies. Quick actions (permission-gated): New PO, Receive, New Transfer, New Adjustment, New Product. All widgets respect warehouse scope.

## 2. Report Catalog
For each: purpose/audience/filters/columns/grouping/export (CSV+Excel in V1, PDF V1.5). All reports filter by warehouse(s), category/brand, date range; respect scope.
- **Inventory Summary (V1):** on_hand/reserved/available/damaged/expired/blocked + WAC value per variant/warehouse. Audience: Owner/Inv Mgr.
- **Stock Ledger (V1):** every movement with actor/source/reason/cost. Audience: Auditor. Filters: variant, type, source, actor.
- **Valuation (V1):** qty × WAC by variant/warehouse/category. Audience: Owner/Accountant.
- **Low/Out-of-Stock (V1):** vs reorder_point; out = available ≤ 0. Audience: Purchasing.
- **Expiring/Expired (V1 if expiry flags on; else V1.5):** buckets today/7/30/60/90d.
- **Damaged (V1):** qty + value + reasons.
- **Purchasing + Supplier performance (V1):** POs by status, lead time, return rate.
- **Purchase/Sales Returns (V1):** rates, dispositions.
- **Transfers (V1):** in-transit aging, variances.
- **Overstock/Dead/Slow/Fast/Turnover/Profitability (V1.5):** define thresholds in settings (dead = no movement 90/180d configurable).
- **Historical Valuation / Point-in-Time (V1.5, normative requirement):** rebuild value at any past date T by replaying movements ≤ T with snapshots (INV-022). Audience: Accountant/Auditor. Without this, historical closes are unverifiable.
- **Lot Traceability (V1.5):** for any batch/serial: supplying PO + receipt → warehouses/transfers → reservations/fulfils → returns. Answers "which supplier supplied THIS unit" and "who received from batch X". Audience: Auditor/Owner (recall support).
- **In-Transit (V1):** open transfers with aging (ship date → days in transit), per-line shipped vs received vs missing; valuation line included in total-value footnotes so in-transit value neither vanishes nor double-counts.
- **Warehouse Performance (V1.5):** receive/ship cycle times, discrepancy rates.
- **Product Movement (V1):** in/out net per variant.

V1 = Summary, Ledger, Valuation, Low/Out, Damaged, Purchasing, Returns, Transfers, Product Movement. V1.5+ = rest.
