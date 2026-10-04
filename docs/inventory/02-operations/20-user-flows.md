# 20 — User Flows

Each flow: Actor / Preconditions / Steps / Rules / Success / Failure / Audit. Abbreviated to normative steps; UI in doc 25, API in doc 24.

1. **Create product** (Inv Mgr): pre: category (+brand) exists. Steps: draft→validate SKU/barcode→set flags/UOM→active. Rules P-CAT-*. Success: active variant(s). Fail: duplicate SKU. Audit: product.create.
2. **Edit product:** editable fields anytime (audited); immutable flags per P-CAT-05. Success: updated + audit before/after.
3. **Archive product:** pre: no open PO lines/reservations/transfers for variants. Steps: block new → archive (stock may remain; must sell/transfer/write-off separately). Audit: product.archive.
4. **Create supplier:** pre: none. Steps: profile→contact+address→active. Audit: supplier.create.
5. **Create warehouse:** pre: admin. Steps: warehouse→default bins→assign manager/staff. Audit.
6. **Receive purchase (full):** Wh Staff, PO ordered. Steps: select PO→enter accepted/damaged per line+bins/batches/serials→post (one txn: balances+movements+PO status+audit). Success: GRN posted, PO fully_received.
7. **Partial receive:** same; PO→partially_received; remainder open.
8. **Return purchase:** Purchaser creates→Mgr approves→ship posts decrement→supplier confirm closes. Fail: qty > received−returned.
9. **Create transfer:** Wh Mgr; validates distinct warehouses + ATP advisory.
10. **Approve transfer:** approver ≠ creator; approved→shippable.
11. **Receive transfer:** dest staff posts accepted/damaged/missing; partial allowed; variance flow if missing/damaged.
12. **Adjust stock:** Inv Mgr draft (lines ±, reason+evidence)→submit→approve(≠creator)→apply (one txn). Fail: would make any bucket negative (INV-003) or take reserved units (`reserved_conflict`).
13. **Reserve stock:** Sales/API; atomic ATP check; TTL set. Fail: insufficient → 409 + available returned.
14. **Release reservation:** cancel/expire/partial remainder; reserved decrement + movement.
15. **Complete sale (fulfil):** on_hand+reserved decrement + movement; partial allowed.
16. **Return sale:** request→approve→receive to blocked→inspect→restock/write-off (each a movement).
17. **Mark damaged:** Wh Mgr+; on_hand→damaged + evidence; approval per threshold.
18. **Handle expiration:** job auto-moves expired; staff disposes with approval (expired→0 loss).
19. **Stock count:** open count (snapshot_at recorded) → count entries per bin/batch/serial → submit → variance REVIEW (variance recomputed at apply under lock per INV-023; large variance forces recount) → approve (≠counter) → apply (posts adjustment movements) → closed.
20. **Import products:** upload→validate→preview→confirm (all-or-nothing or valid-rows-only per mode, default all-or-nothing for opening balances)→history.
21. **Export inventory:** filter→export (scoped; audit export event).
22–25. **Create user / Assign role / Approve / Reject:** admin creates; role assignment audited; approve/reject with comment; rejected→editable resubmit (versioned).
26. **Opening balance:** admin/Inv Mgr creates opening batch (lines + batch/expiry/serials + unit costs) → second approver (≠creator) approves → posted as `opening_balance` movements (only backdatable flow besides dual-approved migration). Audited + visible to auditor.
27. **Repair damaged:** request (serial/batch + evidence) → approve → `repair_to_stock` movement (damaged→on_hand).
28. **Dispose expired/damaged:** request (reason + loss account note) → approve (threshold-gated) → `disposal` movement (terminal; valuation loss in reports).
