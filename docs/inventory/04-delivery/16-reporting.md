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

## 3. Build decisions (Part 9)
- RP-01 **Scope:** every report and dashboard widget needs `reports.view` (dashboard: `inventory.view` or `reports.view`) and covers only the caller's warehouses; a requested warehouse outside scope → `forbidden`. Transfers (and the in-transit line) count when either end is in scope (TR-06). Export additionally needs `reports.export` and writes one `export` audit row (filters, scope, row count).
- RP-02 **Sources:** reports only read. Quantities from `stock_balance` / `stock_allocation`, value from the cost layer (`variant_cost`, WAC × all physical buckets), history from `inventory_movement`. Valuation with an *as of* date is the INV-022 replay (`valueAt`); without one it is the live value, and both equal at *now*.
- RP-03 **Valuation total** = Σ warehouse lines + the in-transit line (shipped value − value settled at the destination). With a product / category / brand filter the in-transit line is omitted (noted on the report). Category filters include sub-categories.
- RP-04 **Low / out:** available = on hand − reserved per (SKU, warehouse); *out* = available ≤ 0, *low* = available ≤ `reorder_point` (variant_warehouse_settings). Archived / discontinued SKUs are left out.
- RP-05 **Product movement:** physical units per movement row (on hand + blocked + damaged + expired), so bucket-to-bucket moves net to 0; putaways (within a warehouse) and reservation rows are skipped. Net over all time = current physical quantity.
- RP-06 **Damaged:** damaged quantity now × current WAC, plus damage legs (Δ damaged > 0) in the period grouped by reason code.
- RP-07 **Purchasing:** POs by status / currency; per supplier (non-draft, non-cancelled POs): fill % = received ÷ ordered, return % = returned ÷ received, lead time = order date → first non-reversed receipt, on time = first receipt ≤ expected date.
- RP-08 **Returns:** purchase / customer returns by status + reason, inspection outcomes + dispositions, and rates from the ledger (purchase returns ÷ receipts, customer returns ÷ fulfilments, in units, for the period).
- RP-09 **Export format:** CSV (UTF-8, formula-guarded, multi-section reports separated by a blank line and the section title). Native .xlsx export and async exports for very large reports are deferred (CSV opens in Excel; the ledger caps at 10 000 rows per run).
- RP-10 **Dashboard:** "inventory value" is the valuation total incl. in transit (shown as a sub-line); "units" = on hand; "expiring" = batch positions with on hand > 0 expiring within 30 days; recent activity mixes the last 20 movements with audit rows (audit only with `audit.view`); alerts = expired / expiring ≤ 7 d, stockouts, transit variances awaiting approval, reconciler drift in the last 7 days.

## 4. Build decisions (Part 11, T11.1 — V1.5 reports)
RP-01 (scope, export audit), RP-02 (read-only) and RP-09 (CSV) apply unchanged. Dates are UTC days, like the V1 reports.
- RP-11 **Turnover:** period = *from*–*to* (default: the 365 days ending *to*, *to* default now). Per (SKU, warehouse): COGS = −Σ `value_delta` of `sale_fulfilment` movements in the period (customer returns are not netted), units sold = −Σ physical delta of those rows, opening / closing value = the INV-022 replay (`valueAt`) at *from* / *to*, average value = (opening + closing) ÷ 2, **turns** = COGS ÷ average value, **days of inventory** = period days ÷ turns (blank when there are no sales or no stock). Rows with no COGS, opening or closing value are left out. The total row uses the same formulas over the totals. Transfers are not sales: stock moved out by a transfer lowers the source's closing value only.
- RP-12 **Dead / slow stock:** company settings `slowStockDays` (default **90**) and `deadStockDays` (default **180**) — slow is the earlier threshold, dead the later one (saving dead < slow is refused, `validation_error`) (dead stock is slow stock that kept sitting; the "90/180 d" of §2 read in that order). Per (SKU, warehouse) with physical stock now (on hand + blocked + damaged + expired > 0): *last out* = the latest `sale_fulfilment` or `transfer_out` movement there; *idle days* = whole days since last out, or since the first movement into that position when it never went out. Idle ≥ deadStockDays → **dead**, ≥ slowStockDays → **slow**, else not listed. Value = the live cost-layer value of the position. Sorted dead first, then by idle days descending.
- RP-13 **Warehouse performance:** one row per warehouse with activity, period filter on the event that *ends* each cycle, averages in days (1 dp; display only). Three sections:
  - *Receiving:* receipts (non-reversal, not reversed) received in the period — avg PO ordered → receipt (each receipt counts), receipt lines, **discrepant lines** (damaged, expired, missing, excess or wrong product > 0) and their %; inbound transfers (destination = the warehouse) first received in the period — avg shipped → first receive, **transit discrepancy %** = (damaged + approved missing + reported missing) ÷ shipped units.
  - *Shipping:* outbound transfers shipped in the period — avg approved → shipped; reservations first fulfilled in the period — avg reserved → first fulfilment.
  - *Count accuracy:* lines of counts applied in the period with a count entered — lines with a posted variance ≠ 0 and their %.
- RP-14 **Lot traceability:** filter `batchNo` and/or `serialNo` (exact; optional product filters narrow it, a batch number may exist on several SKUs). Without either the report is empty with a note. Sections: *Lot* (SKU, batch, mfg / expiry; for a serial its current status and warehouse), *Supply* (receipt lines of the batch / the serial's receipt line → GRN, PO, supplier, warehouse, received, accepted qty), *Transfers* (transfer lines of the batch; for a serial the last transfer that moved it — the full unit history is T11.5's serial page), *Reservations & fulfilments* (reservation lines of the batch / the reservation that sold the serial, with the order reference), *Returns* (purchase and customer return lines of the batch or naming the serial), and for a batch the *Ledger* rows of that batch (newest 1 000). Every row is filtered to warehouse scope (transfers: either end, TR-06), so a user sees only the part of the trail that touched their warehouses.
- RP-15 **Expiring:** batch positions (summed over bins) with on hand or expired > 0 and an expiry date ≤ today + 90 d. Bucket by days left (expiry − today): **expired** (< 0), **0–7**, **8–30**, **31–60**, **61–90**. Qty = on hand + expired bucket (blocked / damaged batch stock shows in its own reports); value = qty × the position's current WAC. Section 1: buckets (positions, on hand, expired, value); section 2: the positions by expiry date.
