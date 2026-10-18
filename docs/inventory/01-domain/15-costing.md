# 15 — Inventory Costing & Pricing

## 1. Costing (business rules only, no formulas in code yet)
**Conceptual default: Weighted Average Cost (moving average).** FIFO lot-level is future; last-purchase-cost shown as reference only.
- Every receipt posts `unit_cost_snapshot` (PO price + V1: no landed allocation). WAC updates prospectively; history never rewritten.
- Transfers carry source WAC snapshot to dest (no revaluation).
- Returns: purchase return relieves the SPECIFIC linked receipt cost (`linked_receipt_id`; multi-receipt lines default oldest-receipt-first unless shipper selects lots). Sales fulfilment carries WAC-at-fulfil as its cost basis; sales-return restock re-admits at that fulfilment snapshot (variance to current WAC absorbed prospectively, never by rewriting history).
- Point-in-time reconstruction (normative): historical inventory value at date T = replay of all movements with `created_at <= T` using each movement's `unit_cost_snapshot`. WAC recomputation must be a pure function of that replay so finance can rebuild any past close. Reports must expose this (see doc 16).
- Damaged/expired write-offs relieve at current WAC; disposal creates valuation loss visible in reports.
- Landed costs (shipping/tax/duty): V1 records at header for display; V1.5 allocates them to receipt lines and into WAC prospectively — §1.1.
- Negative stock forbidden, so no negative-cost edge; backorders (future) must define cost-at-fulfil rule then.

### 1.1 Landed-cost allocation (V1.5, normative)
A **landed cost** document (`LC-YYYY-00001`) attaches charges to ONE posted goods receipt (not a reversal, not a reversed receipt). Several documents may target the same receipt (e.g. freight now, duty invoice later). PO header `shipping`/`tax` stay display-only (PO-07); the user enters the charges actually incurred on the document.
- **Charges:** list of `{kind: shipping | duty | tax | other, amount}`; each amount ≥ 0, ≤ 4 decimals; total > 0. Currency = PO currency.
- **Basis per receipt line** (wrong-product lines excluded): `qty = accepted + damaged + expired (+ excess if the excess was approved)` in base units; `value = qty × receipt unit_cost`. Method `value` (default) or `qty`. Lines with basis 0 get 0.
- **Allocation math:** `alloc_i = round_half_up(total × basis_i / Σbasis, 4)`; the **last line with basis > 0** takes `total − Σ others` so the lines sum exactly to the total. Σbasis = 0 (e.g. zero-cost receipt under `value`) → `validation_error` (use `qty`).
- **Workflow (dual control, INV-006/020):** create (`inventory.adjust_create` in the receipt's warehouse) → `submitted` → approve (`inventory.adjust_approve`, scoped, limit-checked on the charge total, approver ≠ creator) posts in the same transaction → `posted`; or reject (comment required) → `rejected` (terminal; create a new document). No edits after create.
- **Posting:** per line one `cost_correction` movement through `postMovements` — qty 0, no bin, position = the line's (variant, warehouse, batch), `value_delta` = capitalised amount, `unit_cost_snapshot` = the WAC after the correction. WAC moves prospectively; no past movement is touched (INV-022). Lines whose capitalised amount is 0 post nothing.
- **Units already gone (decision):** WAC is a pool, so we cannot tell which units left. Per variant on the receipt, `received_v` = Σ basis qty of its lines; `remaining_v = min(received_v, current valued qty of (variant, warehouse))` read under the position + cost locks at approval. Each line capitalises `round(alloc_i × remaining_v / received_v, 4)` into stock value; the rest is **expensed** (stored on the line as `expensed`, shown on the document; finance books it to COGS/price variance). Nothing is retro-applied to fulfilments, transfers or returns already posted. Stock still on hand but returned to the supplier later is relieved at the receipt's original unit cost (INV-022), leaving the landed part in the pool.
- `cost_correction` invariants in `postMovements`: valued qty of (variant, warehouse) must be > 0 and value after ≥ 0. Valuation (`valueAt`, live) and the reconciler need no special case: the movement's `value_delta` joins Σ value like any other.

## 2. Pricing (what lives where)
IMS owns: `cost_price (last/WAC reference)`, `sell_price`, `min_sell_price` (floor; sales API rejects below without override permission), `wholesale_price?` (V1.5). Promotions/discounts/tiered pricing belong to future sales module — IMS stores only the floor + current list price. Supplier-specific prices live on `supplier_product.last_price`, never as product truth.
