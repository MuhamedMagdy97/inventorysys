# Pilot runbook (T10.5) — go-live on real data via the opening-balance flow

Binding for the first real company. Spec: doc 20 flows 20 (import) + 26 (opening balance), INV rules on backdating / dual control. Dry-run evidence at the end.

## 0. Before
- Production stack up per `02-deploy.md` (managed Postgres, `migrate`, web, worker; backups on, restore drill done once).
- Reverse proxy: read timeout ≥ **5 min** on `/api/imports*` and `/imports` (a 10 000-row preview runs row by row: ~6 ms/row products, ~20 ms/row opening lines → 10 000 opening rows ≈ 3–4 min). Or split files to ≤ 2 500 rows (≈ 1 min each).
- Two admins (super_admin, 2FA on): one **creates** the imports, the other **approves** the opening documents (creator ≠ approver; approve limit must cover the opening value — super_admin is unlimited).
- Warehouses + bins created (`/warehouses`); every bin code used in the files exists.
- Pick the **as-of date** (the stock-take date, ≤ today). Every opening movement is posted at that date; nothing may be posted for those warehouses before it.

## 1. Files (CSV or .xlsx first sheet, header row, ≤ 5 MB, ≤ 10 000 rows)
**products.csv** — one simple product per row. Required `sku,name`; optional `barcode,base_uom,requires_batch,requires_expiry,is_serialized,cost_price,sell_price,min_sell_price` (booleans `true/false`).

**opening-<warehouse>.csv** — one file per warehouse. Required `sku,qty,unit_cost`; optional `bin,batch_no,expiry_date,serials`.
- `qty` > 0, ≤ 4 decimals; `unit_cost` ≥ 0 (becomes the opening WAC).
- Batch-tracked SKU: one row per batch (`batch_no`, plus `expiry_date` YYYY-MM-DD when the product requires expiry).
- Serialized SKU: `serials` = exactly `qty` serial numbers separated by space/comma/semicolon; unique across the company.
- No `bin` → the warehouse's default bin.

```csv
sku,qty,unit_cost,bin,batch_no,expiry_date,serials
SHIRT-M,120,8.50,,,,
MILK-1L,40,0.90,COLD-1,L2405,2027-01-15,
PHONE-X,2,310.00,,,,SN0001 SN0002
```

## 2. Steps (`/imports`)
1. Import **products** → preview (row errors listed: duplicate SKU, bad values) → fix the file until 0 errors → confirm (`all_or_nothing`).
2. For each warehouse: import **opening balance** with the warehouse + as-of date → preview must show **0 errors** → confirm. Result: one opening adjustment, status `submitted`.
3. Second admin: `/approvals` → open the `ADJ-…` → check lines/value → **Approve**. It posts on approval as `opening_balance` movements dated as-of.
4. Checks (all must pass before go-live):
   - `/imports` export stock CSV: per-warehouse on-hand totals = the files' qty totals; batches + serial counts match.
   - Reports → valuation: total = Σ qty × unit_cost per warehouse.
   - Worker log: next `ledger-reconcile` run → 0 drift.
   - Audit log shows `import.preview`, `import.confirm`, the adjustment approve, all by the right people.
5. Mistakes after approval are **not** deleted: correct with an adjustment (or a reversal) — never re-import the same file.

## 3. Dry run 2026-10-19 (synthetic data, scratch DB, same code path)
3 000 products (2 400 plain, 400 batch+expiry, 200 serialized) + 2 warehouses × ~2 730 opening rows (1 250 batches, 968 serials), as-of 2 days back:
- Products import 45 s (preview + confirm). **Found and fixed:** imports ran in the default 30 s transaction, so any file over ~4 500 product rows (less under load) failed with a transaction timeout; imports now use a 10 min transaction (`IMPORT_TIMEOUT`, `src/server/imports/imports.ts`).
- A file with typical mistakes (unknown SKU, negative qty, batch missing, duplicate serial) → all 4 caught in preview; confirm refused.
- Opening per warehouse: preview ~55 s, confirm ~11 s, approve ~7 s; creator approving own → `forbidden`; movements `opening_balance` at the as-of date.
- On hand 539 894 / 557 448 = file totals; export 5 469 rows, total 1 097 342 = files; serial units 968 = file; reconciler 0 drift.

Remaining for T10.5: the owner's real files + the provisioned production DB, then steps 1–4 above.
