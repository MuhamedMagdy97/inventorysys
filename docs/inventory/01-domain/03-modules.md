# 03 — Modules (Detailed Definitions)

For each module: Purpose / Users / Why / Entities / Workflows / Dependencies / Rules / Edge cases. Workflows point to `20-user-flows.md`; rules to `19-business-rules.md`.

## M1 — Product Catalog
Purpose: single source of product truth. Users: Inv Mgr, Purchasing, Sales (read). Entities: product, product_variant, category, brand, uom, uom_conversion, product_image, supplier_product. Workflows: create/edit/archive product, variant management. Deps: none. Key rules: SKU globally unique (per variant); barcode unique if present; archived products keep history, block new POs/reservations; UOM conversion change never rewrites history (see 04). Edge: SKU change → treat as new SKU with alias; keep old SKU in history.

## M2 — Suppliers
Purpose: who we buy from + terms + price history. Users: Purchasing. Entities: supplier, supplier_contact, supplier_address, supplier_product (last_price, lead_time), supplier_invoice_ref. Workflows: create/archive supplier, record purchase price. Deps: Catalog. Rules: archive blocked if open POs exist (must close/cancel first); prices snapshotted on PO lines. Edge: supplier currency change mid-PO.

## M3 — Warehouses & Locations
Purpose: where stock lives. Users: Wh Mgr/Staff, Inv Mgr. Entities: warehouse, zone, rack, shelf, bin (MVP: warehouse + bin required; intermediate levels optional). Workflows: create/archive warehouse/bin, assign managers. Deps: Users. Rules: archive blocked per WH-02 (any bucket > 0, open docs, or active reservations); bins archived only if empty. Edge: default/receiving bin required per warehouse.

## M4 — Inventory Engine (core)
Purpose: ATP truth + ledger. Users: all. Entities: stock_balance, stock_allocation, inventory_movement, reservation. Workflows: reserve/release/fulfil, query ATP. Deps: Catalog + Warehouses. Rules: all mutations via movements in one transaction; `available = on_hand − reserved` (canonical, doc 07 §2); never negative available (see 07/08). Edge: concurrent last-unit reservations → exactly one wins.

## M5 — Purchasing
Purpose: plan→approve→order. Users: Purchasing. Entities: purchase_order, po_line, po_approval, goods_receipt. Workflows: draft→submit→approve→order→receive→close. Deps: Suppliers, Catalog, Inventory (receiving posts). Rules: creator≠approver; price/tax/discount snapshotted; qty cannot be reduced below received. Edge: partial receiving, price change after approval.

## M6 — Goods Receiving
Purpose: record arrival truth. Users: Wh Staff. Entities: goods_receipt, receipt_line (batch/expiry/serial, accepted/damaged/expired splits). Workflows: full/partial/over/under/damaged receipt. Deps: Purchasing + Inventory. Rules: receipt posts movements immediately (sellable portion → on_hand; damaged → damaged bucket); duplicate receipt blocked by idempotency key. Edge: over-delivery tolerance, wrong product.

## M7 — Adjustments
Purpose: correct drift with control. Users: Inv Mgr. Entities: adjustment, adjustment_line, approval, evidence attachment. Workflows: draft→submit→approve→apply. Deps: Inventory. Rules: each adjustment line posts an `adjustment_in` or `adjustment_out` movement; no bucket may ever go negative (INV-003) — write-offs are capped at the quantity on hand and still require approval. Edge: small auto-approve threshold configurable, default OFF (all require approval in MVP).

## M8 — Transfers
Purpose: move stock between warehouses. Users: Wh Mgr, Inv Mgr. Entities: transfer, transfer_line, transfer_shipment, transfer_receipt. Workflows: request→approve→ship (out) → in-transit → receive (in). Deps: Inventory + Warehouses. Rules: ship decrements source (`transfer_out`), receipt increments dest (`transfer_in`); partial receives allowed; discrepancies create adjustment + audit. Edge: lost/damaged in transit, duplicate receipt.

## M9 — Sales Integration
Purpose: promise + fulfil without oversell. Users: Sales/API. Entities: sales_order_ref (external), reservation, fulfilment. Workflows: reserve→fulfil(ship)→cancel/partial. Deps: Inventory. Rules: reservation checks ATP atomically; fulfilment decrements on_hand+reserved together; cancellations release. Edge: payment fail, partial ship, expiry during reservation.

## M10 — Returns
Purpose: safe reverse logistics. Users: Wh + Purchasing/Sales. Entities: return (purchase/sales), return_line, inspection. Workflows: request→approve→ship/receive→inspect→restock/write-off. Deps: PO/SO refs + Inventory. Rules: sales returns → quarantine first; restock only after pass; purchase returns reduce on_hand on shipment. Edge: return > sold, supplier rejection.

## M11 — Batch/Expiry/Serial (V1.5 core, flags in V1)
Purpose: traceability. Entities: batch, serial_unit. Rules: FEFO picking; expired auto-blocked by job; serialized qty always 0/1. See doc 14.

## M12 — Costing
Purpose: valuation truth. Entities: cost layers (WAC), movement cost snapshots. Default WAC in V1; FIFO future. See doc 15.

## M13 — Reporting/Dashboard/Notifications/Audit/Import/Settings
Cross-cutting; see docs 16/17/18, 07-settings in 28, import/export in 24/25. All depend on ledger + audit as sources of truth.
