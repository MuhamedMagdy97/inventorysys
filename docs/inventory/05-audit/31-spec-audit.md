# 31 — Specification Red-Team Audit Report

## 1. Audit Summary
Adversarial review of all 31 prior docs as if written by another team. Method: inventory-integrity walk (17 operations × 11 questions), ATP race analysis, purchase/transfer/return/costing/batch/serial/RBAC/state/data/API/UI/report/warehouse/tenancy/concurrency/failure audits. Result: **10 CRITICAL, 12 HIGH, 8 MEDIUM/LOW** findings. All fixed in-place across affected docs; this report records them. No code written.

## 2. Critical Findings (all FIXED)
- **C1 ATP formula contradiction (00 vs 07):** 00 subtracted blocked, 07 did not. FIX: canonical `available = on_hand − reserved` everywhere (00 §4.2, 07 §2, MASTER §1).
- **C2 Reserved-stock removal race:** damage/expiry/ship/adjust-out/return could drive `on_hand < reserved`, violating I-02. FIX: new invariant I-07 + INV-021 `reserved_conflict` guard on all removals (07, 11, 13, 19).
- **C3 In-transit dual truth:** bucket column vs derived lines; entity model omitted the column. FIX: in-transit is DERIVED only, never stored; valuation as separate report line (07, 11, 15, 16, 22, MASTER).
- **C4 Purchase-return cost ambiguity (multi-receipt):** which receipt cost is relieved was undefined. FIX: `linked_receipt_id`, oldest-first default with lot override; fulfil cost basis + replay rule INV-022 (08, 13, 15, 19).
- **C5 Void-vs-reversal contradiction:** `voided` receipt status vs reversal-only doctrine. FIX: `voided` forbidden; corrections by reversal documents only; MV-05 + INV-025 (08, 10, 19).
- **C6 Missing count state machine + freeze question:** counts referenced but stateless; concurrent postings undefined. FIX: full count machine (open→counting→variance_review→applied→closed), snapshot semantics INV-023 (20, 22, 23, 24, 25).
- **C7 Serial dual-truth + status mismatch:** `available` vs `in_stock` counts; which table rules. FIX: unified statuses, detail+summary atomic rule I-06 (07, 14).
- **C8 Over-delivery blocked limbo:** excess in blocked with no resolution path or PO linkage. FIX: pending-decision flow (approve→new leg + PO amendment, or reject→return/dispose); excluded from `qty_received` until approved (10).
- **C9 Undefined `requires_inspection`:** referenced but never modeled. FIX: flags on variant + supplier, default false (10, 22).
- **C10 Expiry-vs-reservation ordering:** job moving reserved batch breaks I-02. FIX: B-05 ordering — release reservations first, then move stock; fulfil race decided by version (12, 14).

## 3. High Findings (all FIXED)
- **H1 Purchase-UOM gap:** order-by-case/stock-by-unit undefined. FIX: `order_uom/order_qty/base_qty/factor` snapshots; ledger in base units (10, 22).
- **H2 Opening balance flow missing:** backdate exception with no control. FIX: flow 26 with dual control (20, 08).
- **H3 Repair/disposal flows missing:** movements existed, flows did not. FIX: flows 27–28 + state machines + `repair_to_stock`/`disposal` types (08, 20, 23).
- **H4 Putaway leg representation:** "0 net" hides per-bin replay. FIX: paired `putaway_out/in` legs (08).
- **H5 Global reorder points:** false-fire across warehouses. FIX: `variant_warehouse_settings` per-warehouse thresholds (04, 21, 22).
- **H6 Auditor-mutation contradiction:** auditor read-only yet "migration with auditor role". FIX: dual control `system.migration_run` (00, 02).
- **H7 Permission synonyms:** `inventory.receive` vs `purchases.receive`, unnamed transfer/count/inspect grants. FIX: canonical grant list (02, 24).
- **H8 PO cancel wording:** "any pre-receipt" vs received==0. FIX: cancel only draft|submitted|approved with zero receipts (09, 23).
- **H9 Discontinued mid-transfer + archived-warehouse returns:** undefined. FIX: in-flight completes, new blocked; returns to archived blocked (10, 11, 13, INV-019).
- **H10 Missing reports:** no point-in-time valuation, no lot traceability, in-transit invisible. FIX: three reports added (15, 16).
- **H11 Missing UI:** no approval inbox, count, inspection, variance screens. FIX: four screen groups (25).
- **H12 Idempotency/version conflation:** derived keys vs header vs guards. FIX: two-layer idempotency + `version` on all machines + new error codes (08, 23, 24).

## 4. Medium Findings (FIXED)
- M1 sales-return batch fallback (expired/disposed original) → new inspection batch (13). M2 serial `disposed` terminal + repair approval (14). M3 barcode alias 30-day window (04). M4 sequence gaps acceptable/never reused, per-company, in-txn allocation (22). M5 audit event catalog A-06 incl. system/expiry/export/denied events (18). M6 reservation bin-vs-batch pinning rule SO-05 (12). M7 transfer valuation wording TR-06 rewritten (11). M8 historical replay test gate (27).

## 5. Low Findings (FIXED)
- L1 category-merge "reversible" clarified as re-move (no auto-undo). L2 `wrong_product` quarantine type corrected (not sales-return type). L3 report audience labels for new reports.

## 6. Changes Made (files touched)
00, 02, 04, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 27, MASTER. No file left with known contradiction.

## 7. Business Rules Added
INV-021 reserved-stock protection; INV-022 cost linkage + point-in-time reconstruction; INV-023 snapshot counts + optimistic locking; INV-024 company+warehouse scoping; INV-025 reversals-only. (19 normative.)

## 8. Edge Cases Added
31–38: reserved_conflict, fulfil-vs-expiry race, double-approve, expiry-vs-in-transit, return lot default, archived-warehouse receipt, per-warehouse reorder, sequence gaps. (21.)

## 9. State-Machine Changes
PO cancel guard tightened; count machine added; damage/repair/disposal machines added; version guards globalized. (23.)

## 10. Entity-Model Changes
`requires_inspection` flags; `variant_warehouse_settings`; UOM snapshot fields; `version` columns; count snapshot fields; `reversal_of_receipt_id`; `linked_receipt_id` concept; per-company sequences; audit catalog pointer; in-transit column explicitly absent. (22.)

## 11. Permission Changes
Canonical grant list; `inventory.receive` canonical; count/inspect/repair/dispose/return-stage grants; `system.migration_run` dual control. (02.)

## 12. Audit Changes
Event catalog A-06 (transitions, system jobs, expiry, reconciler, exports, denials, dedup hits). (18.)

## 13. Reporting Changes
Historical valuation (replay), lot traceability, in-transit aging + valuation footnote. (16.)

## 14. Final Unresolved Assumptions (explicit, none blocking)
1. Single base currency in V1 (multi-currency = future). 2. WAC computed prospectively; exact averaging formula deferred to design phase (rule-level only per charter). 3. Sequence gaps tolerated. 4. One default company seeded; `company_id` plumbing present but unenforced single-tenant until P11. 5. Approval SLA 48h/24h defaults configurable. None prevents implementation start.

## 15. Final Quality Gate
1. Internally consistent? YES (single ATP, single in-transit/serial/cost truth, verified §7). 2. Every inventory workflow representable? YES (28 flows + count/repair/disposal/opening). 3. Every critical op auditable? YES (A-06 catalog, same-txn). 4. Permissions prevent unauthorized action? YES (canonical grants + company/warehouse scope + re-checks + SoD). 5. Concurrency handled conceptually? YES (atomic checks, I-07, versions, idempotency, race outcomes defined). 6. Historical inventory reconstructible? YES (ledger replay). 7. Financial value reconstructible? YES (snapshot replay INV-022 + reports). 8. Multi-warehouse supported? YES (grain, scoping, transfers, per-wh settings). 9. Mobile-consumable domain? YES (lookup/reserve/fulfil/count/receive APIs + scan flows). 10. Coding agent can start without major clarification? YES — normative rules + effects + guards + errors are explicit. SPECIFICATION APPROVED FOR BUILD PLANNING.

## 16. Third Consistency Pass (2026-10-04)
The §6 claim "no file left with known contradiction" was not true; these residuals were found and fixed:
- **R1 (critical) Reserved grain gap:** balances keyed per bin, reservations pin only warehouse+batch → I-02/I-07 undefined. FIX: physical buckets stay on `stock_balance` (per bin); `qty_reserved` moves to new `stock_allocation(variant, warehouse, batch?)` position row, locked first; I-02/I-06/I-07/INV-021 restated per position (07, 11, 12, 13, 19, 22, 06-exec/03, MASTER).
- **R2 Serial count bug:** I-06 set `on_hand = COUNT(in_stock)`, excluding reserved serials though reserved ⊂ on_hand. FIX: `on_hand = COUNT(in_stock + reserved)` (07, 14).
- **R3 C1 leftover:** `available = on_hand − reserved − blocked` in 03 M4. FIX: canonical formula.
- **R4 C3 leftover:** in-transit written as a bucket in 07 §3, 08 transfer rows, 11 §5. FIX: derived-only wording; new `transfer_variance` type (no bucket change).
- **R5 C5 leftover:** `void` in audit actions (18), INV-005, entity model, overview. FIX: reverse/cancel only.
- **R6 Negative stock:** 03 M7 allowed negative on_hand for write-offs vs INV-003. FIX: never negative.
- **R7 Missing movement types:** `transfer_variance`, `cost_correction`, `blocked_in/blocked_release/blocked_reject` added; duplicate `opening_balance`, `damage_repair`, `expiry_disposal`, `quarantine_in/out` rows removed; `sale_return_restock` corrected to blocked→on_hand (08, 10, 13, 02).
- **R8 Batch dual truth:** quantity mirrors on `batch` removed (14, 22).
- **R9 H7 leftover:** `purchases.receive`, `transfers.*`, `receiving` grant names removed; warehouse-scoped grant list made explicit (02).
- **R10 Hygiene:** duplicate SO-02/03/04 (12), duplicate para (14), edge-case #29 twice → #30 (21), flows reordered 1–28 (20), "all 25" → 28 (27), INV-020 moved into order (19), duplicate `stock_count`/`sequences` (22), missing coverage-matrix format defined inline (06-exec/01).
