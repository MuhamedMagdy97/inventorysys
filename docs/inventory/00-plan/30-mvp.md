# 30 — MVP Definition

## MVP must run a REAL operation: buy → receive → store → reserve → ship → return + adjust + transfer + report.

**In (MVP):** catalog (simple+variants, categories, brands, UOM base), suppliers, warehouses+bins (warehouse+bin minimum), inventory engine (buckets+ledger+reservations+TTL), PO lifecycle + receiving (partials, damaged split, tolerance=0), transfers (request→approve→ship→receive, partials, variances), adjustments (all approved), sales reserve/fulfil/cancel (no backorders), purchase+sales returns with quarantine inspection, batch/expiry/serial FLAGS + basic capture (full FEFO UI in V1.5 but data captured), WAC-reference costing (display; allocation V1.5), dashboard V1 KPIs, core reports (summary/ledger/valuation/low-out/damaged/purchasing/returns/transfers/movement), RBAC+warehouse scope, audit, notifications (in-app+email for approvals/low/discrepancy), CSV/Excel import (products/suppliers/opening) + export, global search.

**V1 (post-MVP polish):** counts module, inspection-flag workflow, approval limits/escalation, landed-cost display, expiry alerts job, barcode lookup hardening, PDF export.
**V1.5:** reorder engine, full FEFO enforcement UI, serial lifecycle UI, landed-cost allocation, turnover/dead/warehouse-performance reports, webhooks, label printing.
**Future:** POS, AP/GL, forecasting, FIFO, multi-tenant billing, native mobile, WhatsApp/SMS.

**Why:** MVP includes every link in the physical chain + its audit/permission guard; nothing in MVP can be cut without breaking trust (remove returns → quarantineless restock; remove ledger → unprovable stock). V1.5+ optimizes rather than enables.
