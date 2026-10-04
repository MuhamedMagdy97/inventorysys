# 28 — Non-Functional Requirements & Settings

Performance: availability lookup p95 < 300ms (single wh), ledger list paginated < 500ms; reserve endpoint p95 < 500ms under 50 concurrent same-SKU (locked path). Scalability: 100k variants, 1M movements/year baseline; ledger partitioned by date/warehouse later. Availability: 99.5% V1; RPO ≤ 24h, RTO ≤ 4h; daily encrypted backups + quarterly restore drill. Auditability/Integrity: txn-atomic ledger+audit; nightly ledger↔balance reconciler + alert. Maintainability/Observability: structured logs with request/trace ids; metrics (reserve latency, receipt volume, variance rate); import/job dashboards.

**Settings (scoped):** Global: base currency, timezone, date format. Company: name/logo/address/tax, PO/GRN/TR numbering prefixes, approval limits, over-delivery tolerance %, reservation TTLs per channel, low-stock/expiry thresholds + digest schedule, UOM defaults, inspection-required flags. Warehouse: default receiving/sellable/quarantine bins, manager, count frequency. User: locale, notification prefs. Every settings change audited with before/after.

**Multi-tenancy (future-proof):** `company_id` on all primary entities; queries scoped by it when enabled; sequences per company; roles/permissions per company. V1 ships single default company; no schema rewrite to enable multi-tenant later.
