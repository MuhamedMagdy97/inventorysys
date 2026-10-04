# 04 — Product Management (Catalog)

## 1. Concepts
- **Simple product:** one SKU, no variants (e.g., "AA Battery 4-pack").
- **Variant product (parent + variants):** parent holds shared attributes (brand, category); each variant has own SKU/barcode/attributes (size/color), own stock, own costs/prices. Parent itself is NEVER stocked or sold.
- **Bundle/Kit (V1.5+):** sellable set of components; stock derived from components. NOT in MVP — product has `is_bundle=false` locked.
- **Service:** out of scope for IMS.

## 2. Fields
**product (parent):** id, company_id(future), name (required, 2–200), slug, description, brand_id, category_id, product_type (`simple|variant_parent`), status (`draft|active|inactive|archived|discontinued`), requires_batch (bool), requires_expiry (bool), is_serialized (bool), base_uom, track_expiry_default_days, images, tags, created/updated. **Immutable after first stock movement:** product_type, base_uom, is_serialized, requires_batch/expiry (can only tighten with migration, never loosen silently — see rules).
**product_variant (sellable):** id, product_id, sku (required, unique, uppercase alnum `^[A-Z0-9][A-Z0-9\-_]{2,39}$`), barcode (optional, unique if present, EAN/UPC/Code128), attributes JSON (e.g., size/color), requires_inspection (bool, default false), cost_price (reference/last), sell_price, min_sell_price, status, weight/dims. Reorder thresholds live on `variant_warehouse_settings` (per warehouse), NOT on the variant. Stock NEVER stored here.
**Supporting:** brand(id,name,archived), category(id,parent_id,name,path), uom(code,name,type), uom_conversion(from,to,factor), product_image(variant_id,url,sort), supplier_product(supplier_id,variant_id,last_price,lead_days).

## 3. Relationships
brand 1→many products; category 1→many products; product 1→many variants; variant 1→many stock_balances/movements/reservations/batches/serials; variant 1→many supplier_products; variant 1→many images.

## 4. Business Rules
- P-CAT-01: SKU globally unique, immutable once stock exists. "Rename SKU" = create new variant + migrate with adjustment + alias record (`sku_alias old→new`).
- P-CAT-02: Barcode unique if present; changed barcodes keep the old value in `sku_alias`-equivalent `barcode_alias` for 30 days (configurable) so in-flight labels still scan; rescan resolves to exactly one variant or prompts disambiguation (never auto-pick).
- P-CAT-03: Parent with variants cannot have own SKU/stock/price.
- P-CAT-04: `is_serialized=true` ⇒ each unit tracked individually; receiving/sale qty must reconcile to serial count; conversions must be 1:1 to base.
- P-CAT-05: Enabling batch/expiry/serial after transactions requires backfill migration + approval; disabling blocked if balances/batches/serials exist.
- P-CAT-06: Discontinued ⇒ block new POs/reservations; existing reservations fulfil normally; on_hand may sell through or be written off.
- P-CAT-07: Archived ⇒ hidden from selectors, block ALL new transactions; history retained.
- P-CAT-08: UOM conversion factor change creates new effective-dated record; history keeps old factor snapshot on each movement (`uom_factor_used`).

## 5. Validation
Name required; SKU format + uniqueness (case-insensitive); barcode checksum warning (not hard-fail except duplicates); sell_price ≥ 0; min_sell_price ≤ sell_price; reorder_qty > 0 if set; category must be leaf or any (configurable; default any non-archived); brand optional.

## 6. Categories (hierarchical)
`category(id, parent_id, name, path, sort, archived)`. Max depth 5. `path` materialized (`/Electronics/Phones/`). Rules: no cycles (reject if parent is self/descendant); delete forbidden — archive only; archiving blocked if active products in it or descendants (must move first); moving products allowed anytime (audited); merge = move all products + archive loser (audited, reversible via re-move). See edge cases doc.

## 7. Brands
`brand(id, name unique, logo, archived)`. Archive allowed anytime (products keep `brand_id` for history; selectors hide archived). No delete. Re-activate allowed.
