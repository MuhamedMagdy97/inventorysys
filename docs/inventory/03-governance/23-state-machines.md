# 23 — State Machines

Notation: state →(actor, condition)→ next. Invalid transitions → 422 + audit.

**Purchase Order:** draft →(creator)→ submitted →(approver≠creator)→ approved →(purchaser)→ ordered →(receipt)→ partially_received ↔(receipt)→ fully_received →(close)→ closed. submitted →(reject)→ draft (version++). draft|submitted|approved (received==0) →(cancel)→ cancelled. ordered|partially_received →(close with reason, remainder noted)→ closed. Cancel after ANY receipt posted is forbidden (close instead).
**Stock Count (new, normative):** open →(staff)→ counting →(submit)→ variance_review →(approver≠counter)→ applied → closed. counting allows concurrent postings (no freeze); variance recomputed at apply under lock per INV-023; large variance (configurable %) forces recount → back to counting. Cancel allowed pre-apply only.
**Damage/Repair/Disposal (new, normative):** damage draft → submitted → approved → applied (`damage` movement); repair request → approved → applied (`repair_to_stock`); disposal request → approved (owner/manager threshold) → applied (`disposal`, terminal loss). All enforce I-07.
**Transfer:** draft → submitted → approved → in_transit(ship) → partially_received → completed. submitted→rejected→draft. pre-ship→cancelled. completed with acknowledged variance→closed_with_variance. Post-ship cancel forbidden.
**Adjustment:** draft → submitted → approved → applied. submitted→rejected→draft. applied terminal (correction via new adjustment). Void pre-apply→cancelled.
**Purchase Return:** draft → submitted → approved → shipped → supplier_confirmed → closed. rejected→draft; supplier_rejected→quarantine decision.
**Sales Return:** requested → approved → received → inspected → restocked|written_off (terminal). rejected/cancelled exits pre-receive.
**Reservation:** active → partially_fulfilled → fulfilled; active→cancelled|expired (release). Partial fulfil loops.
**Product/Variant:** draft → active ↔ inactive → discontinued → archived. Archived terminal (re-activate needs admin + audit, creates new version note; transactions still blocked for old history clarity — prefer clone).
**Receipt/Count lines:** posted immutable; corrections via new docs only.

Guards: every transition checks permission + company scope + warehouse scope + state precondition + `version` match + invariant (e.g., ship checks ATP and I-07) in one transaction; failed guard rolls back + audit `transition.denied`.
