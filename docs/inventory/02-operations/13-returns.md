# 13 — Returns (Purchase & Sales)

## 1. Purchase Returns (to supplier)
Lifecycle: `draft → submitted → approved → shipped → supplier_confirmed → closed`; exits: `rejected→draft`, `cancelled` (pre-ship), `supplier_rejected` (goods come back → `blocked_in`; inspect → `blocked_release` to sellable or `disposal`).
Entities: **purchase_return**, lines (variant, qty_requested/approved/shipped/confirmed, reason, batch/serial), linked PO/receipt refs.
Inventory effect: on `shipped` post `purchase_return` movement `on_hand −= shipped` carrying `linked_receipt_id` (which receipt's cost is relieved; if multiple receipts, shipper selects lots or defaults to oldest receipt first) and validating per position `(SUM(on_hand) − shipped) >= qty_reserved` (I-07). Supplier rejection after ship → `blocked_in` + inspection decision.
Financial: reduces outstanding/received value; credit note ref stored as text in V1.
Rules: PR-01 creator≠approver; PR-02 return qty ≤ (received − already returned) per PO line; PR-03 serialized units must be specified.

## 2. Sales Returns (from customer)
Lifecycle: `requested → approved → received → inspected → restocked | written_off`; exits: `rejected`, `cancelled`.
Inventory effect: on `received` → `+blocked` (quarantine, `sale_return_quarantine` movement), NEVER directly to sellable. On `inspected`: pass → `blocked→on_hand` (`sale_return_restock`); damaged/defective → `blocked→damaged` (`blocked_reject`); expired/missing parts → `blocked_reject` (→expired or →damaged per policy) or `disposal` straight from blocked; each leg is a movement with inspector + reason + (optional) photo evidence.
Rules: SR-01 return qty ≤ (fulfilled − already returned) per order line; SR-02 restock requires inspection pass by a different user than receiver where possible (or same with audit if single-person warehouse); SR-03 restocked units rejoin their traceable original batch if that batch still exists and is unexpired, else a new inspection batch (never a disposed/expired batch); serials re-activated to `in_stock` only on pass. SR-04 returns for discontinued variants allowed (receive+inspect+dispose/restock); returns for archived variants or to/from archived warehouses blocked with `archived_conflict`.
Dispositions: `restockable | damaged | defective | missing_parts | expired | dispose`. Only `restockable+pass` returns to sellable.
