# 15 — Inventory Costing & Pricing

## 1. Costing (business rules only, no formulas in code yet)
**Conceptual default: Weighted Average Cost (moving average).** FIFO lot-level is future; last-purchase-cost shown as reference only.
- Every receipt posts `unit_cost_snapshot` (PO price + V1: no landed allocation). WAC updates prospectively; history never rewritten.
- Transfers carry source WAC snapshot to dest (no revaluation).
- Returns: purchase return relieves the SPECIFIC linked receipt cost (`linked_receipt_id`; multi-receipt lines default oldest-receipt-first unless shipper selects lots). Sales fulfilment carries WAC-at-fulfil as its cost basis; sales-return restock re-admits at that fulfilment snapshot (variance to current WAC absorbed prospectively, never by rewriting history).
- Point-in-time reconstruction (normative): historical inventory value at date T = replay of all movements with `created_at <= T` using each movement's `unit_cost_snapshot`. WAC recomputation must be a pure function of that replay so finance can rebuild any past close. Reports must expose this (see doc 16).
- Damaged/expired write-offs relieve at current WAC; disposal creates valuation loss visible in reports.
- Landed costs (shipping/tax/duty): V1 records at header for display; V1.5 allocates to units prospectively (rule defined, calculation deferred).
- Negative stock forbidden, so no negative-cost edge; backorders (future) must define cost-at-fulfil rule then.

## 2. Pricing (what lives where)
IMS owns: `cost_price (last/WAC reference)`, `sell_price`, `min_sell_price` (floor; sales API rejects below without override permission), `wholesale_price?` (V1.5). Promotions/discounts/tiered pricing belong to future sales module — IMS stores only the floor + current list price. Supplier-specific prices live on `supplier_product.last_price`, never as product truth.
