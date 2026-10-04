# 12 — Sales Integration (Reservations, Allocation, Fulfilment)

## 1. Boundary
IMS does NOT own carts, checkout, payments, or customers. External channels (POS/web/marketplace) call: `checkAvailability → createReservation → fulfil | cancel → (return)`. IMS owns ATP, reservation ledger, and fulfilment decrements.

## 2. Entities
**sales_order_ref:** id, external_order_id (unique per channel), channel (`pos|web|marketplace|api`), status mirror. **reservation:** id, variant_id, warehouse_id, qty, qty_fulfilled, qty_released, status (`active|partially_fulfilled|fulfilled|cancelled|expired`), expires_at, order_ref, idempotency_key. **fulfilment:** reservation_id, qty, shipped_at/by, movement refs.

## 3. Behaviors
- **Reserve:** lock the position's `stock_allocation` row → atomic `available >= qty` check + `qty_reserved += qty` + `reservation` movement. Concurrent last-unit: exactly one wins; loser gets `insufficient_stock` (no partial auto-split unless caller requests with `allow_partial=true`, then reserve available portion + return remainder status).
- **Expiry:** reservations carry TTL (default from settings, e.g., 48h for web, 15min for POS hold — configurable per channel). Expiry job releases (`reservation_release` movement) + notification. Extensions allowed once with audit (max 1 extension, new expiry capped).
- **Fulfil (ship):** `on_hand −= qty AND reserved −= qty` + `sale_fulfilment` movement carrying WAC-at-fulfil snapshot (the fulfilment cost basis; restocks reference it per doc 15). Partial fulfil allowed; remainder stays reserved until fulfilled/released/expired. Fulfil validates reservation is `active|partially_fulfilled` + version match (optimistic locking) in the same transaction, so an expiry racing a fulfil has exactly one winner (loser gets `reservation_expired` / `version_conflict`, never a double move).
- **Cancel:** release unfulfilled remainder (`reserved −= remainder`). Payment failure = cancel with reason `payment_failed`.
- **Allocate vs reserve:** V1 treats them as one step (reserve = allocate to a warehouse). Multi-warehouse allocation/sourcing logic is V1.5.

## 4. Rules
- SO-01: Never reserve blocked/damaged/expired/in-transit. FEFO is MANDATORY for expirable variants: reservation must pin batch(es) oldest-expiry-first; substitution across batches requires caller `allow_substitution=true`, else fail with `batch_insufficient`. **Clarified:** without a requested `batch_id`, the reservation is split FEFO across batches (one `reservation_line` per pinned batch; batches whose `expiry_date <= today` are skipped). With a requested `batch_id`, only that batch is used; if it can't cover the qty → `batch_insufficient`, unless `allow_substitution=true`, then the rest is filled FEFO from other batches.
- SO-02: Fulfil requires active reservation (no direct decrement API in V1 except `sale_fulfilment` with reservation id; POS immediate-sale creates reservation+fulfil in one transaction).
- SO-03: Oversell blocked by default. Backorders are future (explicit flag + separate flow, not silent negative).
- SO-04: Order cancel after partial fulfil releases only unfulfilled remainder; fulfilled portion requires sales return flow.
- SO-05: Bin allocation: reservations pin warehouse (+batch where tracked); bins are assigned at pick/fulfil time FEFO (oldest batch, then default-bin order). Adjustment/removal operations can never take reserved units (I-07).
