# 29 — Roadmap / Phases

- **P0 Discovery (this package):** spec + consistency check. Deliverable: docs/ + MASTER-SPEC.
- **P1 Foundation:** auth, RBAC+warehouse scope, users/roles, settings, audit, sequences, categories/brands. Delivers: admin can run.
- **P2 Catalog:** products/variants/UOM/images, suppliers. Delivers: buyable catalog.
- **P3 Warehouses:** warehouses/bins, assignments. Delivers: storable.
- **P4 Inventory Engine:** balances, ledger, reservations+TTL job, availability APIs. Delivers: ATP truth. Depends P1–P3.
- **P5 Purchasing + Receiving:** PO lifecycle + GRN + discrepancies. Depends P2+P4.
- **P6 Transfers + Adjustments + Counts:** with approvals. Depends P4.
- **P7 Sales Integration + Returns:** reservations/fulfil + purchase/sales returns + inspection. Depends P4–P6.
- **P8 Reporting/Dashboard/Notifications/Import-Export:** core reports + alerts + CSV/Excel. Depends P4–P7.
- **P9 Hardening:** reconciler, rate limits, backups, testing gates (doc 27), pilot.
- **P10 Advanced (V1.5):** batches/expiry enforcement UI+FEFO everywhere, serials, reorder engine, landed cost, turnover/dead-stock reports, webhooks, barcode printing.
- **P11 Mobile/API scale + SaaS:** scanner-optimized APIs, multi-tenant enablement, marketplace connectors.

Postponed explicitly: POS/checkout, AP/GL, forecasting, FIFO engine, SMS/WhatsApp (until P10+).
