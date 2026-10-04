# Stage 6 — Implementation Roadmap (build order P1→P9)

Sources: `29-roadmap.md`, `30-mvp.md`, `27-testing-requirements.md`. Rule: never start a phase whose dependencies or gates are red.

## P1 Foundation
Auth, RBAC + warehouse scope, users/roles, settings, audit writer, sequences, categories/brands.
Gate: permission + scope-isolation + audit-completeness tests pass.

## P2 Catalog
Products/variants/UOM (+snapshots, aliases), suppliers, `variant_warehouse_settings`.
Gate: SKU/barcode/alias + inspection-flag + UOM behaviors verified.

## P3 Warehouses
Warehouses/bins (defaults, quarantine/damaged), staff assignment, archive guards (WH-02/03).
Gate: archive-blocked-with-stock and empty-system cases pass.

## P4 Inventory Engine (highest risk — do not rush)
Balances, ledger, reservations + TTL job, ATP APIs, reconciler.
Gate: last-unit race (exactly one wins), duplicate-submit idempotency, fulfil-vs-expiry race, ledger-replay == balances, point-in-time valuation replay. ALL green before P5.

## P5 Purchasing + Receiving
PO lifecycle + GRN posting, partials, tolerance, damaged/expired splits, excess-blocked decision, wrong-product quarantine, receipt reversal (never void), UOM conversion.
Gate: full/partial/over/under/wrong/damaged/duplicate-retry/PO-close cases pass.

## P6 Transfers + Adjustments + Counts
Request→approve→ship→receive with partials + variances + claim notes; approved adjustments; snapshot counts with recount loop; damage/repair/disposal approvals (I-07 enforced).
Gate: missing/damaged-in-transit, over-receipt block, recount-forcing, `reserved_conflict` cases pass.

## P7 Sales + Returns
Reserve/fulfil/cancel (+POS immediate-sale single-txn), FEFO-mandatory reservations, quarantine inspection with evidence, receipt-linked purchase returns.
Gate: partial fulfil + remainder release, return-more-than-fulfilled block, restock-only-after-pass cases pass.

## P8 Reports / Dashboard / Notifications / Import-Export
V1 KPIs + core reports (incl. in-transit line), approval inbox with SLA, low/expiry/discrepancy alerts (digest + instant), global search, CSV/Excel two-phase import (preview → all-or-nothing confirm) + scoped export with audit.
Gate: scope-aware reports, import-rollback, export-audit cases pass.

## P9 Hardening + pilot
Full E2E of all 28 flows, fuzz/concurrency suite (no oversell, no partial posts), backup-restore drill, pilot on real warehouse data via opening-balance flow (dual control).
Gate: `27-testing-requirements.md` acceptance gates 100% green.

## V1.5 backlog (only after P9)
Reorder engine, full FEFO UI, serial lifecycle UI, landed-cost allocation, turnover/dead/warehouse-performance reports, webhooks, barcode label printing. Future: POS, AP/GL, forecasting, FIFO engine, multi-tenant billing, native mobile, WhatsApp/SMS.
