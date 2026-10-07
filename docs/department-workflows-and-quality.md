# Department workflows and quality module

Date: 2026-10-07
Status: Requested product scope; implementation details proposed for review.

## 1. Scope

BeyondBatch must support four connected departmental workflows: Logistics / Buyers, Warehouse, QA/QC and Operations. QA/QC is a distinct functional module inside BeyondBatch, with its own queues, assignments and permissions. It shares order, run, component, lot and schedule records with the other modules.

Quality has two primary work areas:

1. Components and intermediates: RM, PK, customer-supplied components and WP lots required by production.
2. Finished goods: produced lots awaiting testing, documentation review and final disposition before shipping.

A product detail page aggregates quality records by lot. Release must never be a single unrestricted checkbox on the material or FG master.

This extends the earlier two-view concept. Production Schedule and Supply Chain Readiness remain linked views; Warehouse and QA/QC add active handoffs and owned work queues. The first workflow pilot must cover all four departments for a bounded product family or line.

## 2. End-to-end workflow

| Stage | Responsible department | Action and handoff |
|---|---|---|
| Supply expected | Logistics / Buyers | Maintain supplier PO line, quantity, confirmed dates, shipment evidence and changes; expose expected arrivals to Warehouse. |
| Arrival and receipt | Warehouse | Record arrival and receiving details by component/lot/quantity; distinguish physical receipt from ERP posting; identify discrepancies and create a traceable quality handoff. |
| Component quality | QA/QC | Accept assigned work, sample/inspect/test as applicable, record blockers and expected release, and record or synchronize authorized disposition. |
| Production readiness and execution | Operations | See usable allocated supply and other prerequisites by run; schedule with visible risk and record progress/completion. |
| Finished-goods quality | QA/QC | Track each produced lot through applicable tests, batch-document review and final disposition; maintain expected and actual release separately. |
| Outbound fulfillment | Warehouse / Logistics | Stage and ship eligible quantities, with booking, pickup, delivery and customer-date risk visible. |

Exceptions return to the department that can resolve them. Quality may request missing supplier evidence from Buyers, receiving corrections from Warehouse or production documentation from Operations. Each exception has an owner, next action, due date and history.

## 3. Department workspaces

### Logistics / Buyers

Show components required by the schedule, allocated usable stock, uncovered demand, incoming PO delivery quantities, supplier commitments, ETA history and all affected runs. Filters include buyer, supplier, component type, production window, late supply and missing confirmation.

Separate ordered, supplier-confirmed, shipped and received states. An outstanding PO is not proof that goods have shipped. Partial receipts reduce only the corresponding open quantity; split deliveries retain their own dates.

### Warehouse

Provide inbound queues for expected, in-transit, arrived-awaiting-receipt, receiving exceptions and received-awaiting-quality-handoff items.

For each item show component/description, supplier PO line, shipment, expected arrival, received quantity and unit, supplier and internal lot identifiers, location, receiving discrepancy, relevant packing list, schedule need-by date and affected runs.

Warehouse can log RM/PK receipts and handoff details in BeyondBatch. The integration design must decide whether this creates an operational receipt awaiting ERP posting or posts an authorized transaction to the ERP. Pending or failed posting stays visible and cannot silently count as confirmed ERP inventory.

A receipt triggers quality work once, using a stable receipt/lot reference. Handoff requested, acknowledged and completed timestamps expose queue delays. Warehouse logging receipt does not release the lot.

Prioritize arrivals and handoffs by the latest safe receiving time, allowing for remaining sampling, testing and release lead time. An item due to arrive soon is not automatically more urgent than an item blocking an earlier production run.

The outbound workspace shows finished quantities awaiting release, eligible to stage, awaiting pickup and shipped. Physical staging and shipping authorization remain distinct.

### QA/QC: components and WP

Show incoming work by component and lot, receipt, quantity, location, assigned QC/QA owners, receipt age, sampling/inspection/test state, expected release, required need-by date, blockers, next action and affected runs.

Support multiple tasks per lot and separate QC work from QA disposition when the approved process requires it. Assignment, acknowledgement, sampling, laboratory submission/results, review and disposition are independently recorded where applicable; do not impose identical testing on RM and PK.

One lot can affect several runs. A component can have released, held and pending lots at the same time. WP release can block a later encapsulation, filling or packaging operation even when the original raw materials were released.

Authorized quality users record disposition or synchronize it from the designated official system. Other departments may request priority or provide evidence, but cannot release stock.

### QA/QC: finished goods

Show customer/order links, FG or applicable WP, production lot, WO/run, produced quantity/unit, completion date, sample/laboratory status, results, batch-record review, CoA status, holds, assigned owner, blocker, next action, expected release and actual disposition.

Expected release is a forecast with author, source and revision history. Actual release is a distinct authorized event with timestamp, actor, scope and evidence. A CoA date, completed test, production completion or invoicing entry alone does not establish final release.

Expose required release-by date based on pickup and delivery requirements. Delayed quality completion updates outbound and customer-date risk even if production finished on schedule.

### Operations

Use a line/shift/date schedule with linked run cards. Compact cards show description, FG/WP, customer PO reference, quantity, readiness and a separate customer-date alert. Expanded cards show SO lines, WOs, component hierarchy, lot allocations and evidence.

Multiple date/shift appearances of a run share its identity and do not create duplicate demand. A run may supply several order lines; an order line may be covered by several runs or released stock.

Operators and planners can inspect blocking receipts, quality tasks and incoming supply, then navigate to their owners. Schedule changes recalculate dependent warehouse and quality priorities. They do not automatically change customer commitments or authorize release.

## 4. Shared records and links

| Record | Essential relationships and fields |
|---|---|
| Order requirement | SO and line, customer PO, FG, quantity/unit, requested and agreed delivery dates, remaining demand. |
| Run / operation | WO, product/revision, scheduled line/shift/start/finish, quantity, actual progress and order coverage. |
| Component requirement | Issued BOM/WO requirement, revision, component, required and remaining quantity/unit, consuming operation and need-by time. |
| Supply allocation | Requirement to stock lot or expected delivery; allocated quantity/unit; prevent competing demands from using the same quantity twice. |
| Shipment / PO delivery | Supplier PO line, shipment leg, open quantity, expected ship/arrival dates and evidence. |
| Receipt | Receipt ID, PO delivery, arrival/posting timestamps, component, lot, quantity/unit, site/location and discrepancies. |
| Quality case | Component/WP/FG lot, applicable receipt/run, required tasks, assigned owners, forecast release and case status. |
| Quality task | Required inspection/test/review, responsible role, assignee, timestamps, result reference and blocker. |
| Disposition event | Subject lot and quantity scope, status, effective time, actor, reason/evidence, source authority and superseding event. |
| Handoff / exception | Origin/destination departments, owner, requested/acknowledged/resolved times, action and linked dependencies. |
| Evidence / audit | Exact message or document reference/version, access controls, observed/effective times, changes and actor identity. |

Keep transit, physical receipt, ERP posting, quality work and disposition as separate state dimensions. Suggested quality-work states are queued, assigned, in progress and review pending. Suggested disposition states are pending, released, held and rejected, subject to official source mappings.

Partial release, rework, retest and later holds require explicit quantity/lot scope and authorized transitions. A new hold invalidates affected readiness and raises impact exceptions; historical records remain intact.

## 5. Prioritization and readiness

Use explainable rules, not an arbitrary AI score.

For each pending lot or task, show:

- Earliest consuming operation and its need-by time.
- Remaining receipt/quality lead time and the resulting latest safe start.
- Time remaining or days overdue; unknown duration remains unknown.
- Quantity that could cover currently uncovered demand.
- Distinct affected runs/order requirements and their dates.
- Whether completing this task removes the last blocker or leaves other blockers.
- Named owner, actionable next step and missing evidence.

Calculate from current allocations and schedule versions. A shortage elsewhere should remain visible even if Quality expedites this lot. Priority affects work sequencing, never test requirements, acceptance criteria or release authority.

Readiness colors retain explicit explanations:

- Green: all required gates in scope are verified and required usable quantities are allocated.
- Yellow: dependencies remain pending but an evidenced forecast can cover the need-by date.
- Red: a known shortage, late availability or hard blocker prevents the planned operation.
- Unverified: required information is missing or stale; never silently green.

Production readiness and customer delivery risk are separate. Shipping calculations include production finish, finished-goods release, staging, pickup and transit. A green production card may still carry a late-delivery alert.

## 6. Evidence and authority

Link communications and files to the specific PO line, shipment, receipt, quality case or run, not just a broad material name. Retain exact message/document identifiers and revisions and enforce the original access boundaries.

BeyondBatch owns task assignments, operational handoffs, blocker explanations and planning forecasts. The ERP and designated quality system retain their authoritative records until an explicitly approved integration or system-of-record change is implemented.

Before enabling an actual release action, Quality must establish the authority, identity, required evidence and review controls for that action. A manually entered forecast date must never change inventory eligibility. Conflicting external and local disposition evidence produces an exception.

AI may extract supplier updates, suggest record matches, summarize blockers and explain affected runs. Ambiguous matches require human review. AI cannot approve disposition or silently change production plans or customer commitments.

Imports retain source IDs, version/as-of time and refresh status. Repeated imports and receipt events are idempotent; retries do not duplicate tasks or quantities. Audit captures before/after state, actor, reason, source and time. Edits use concurrency checks to avoid overwriting newer decisions.

## 7. Tracker-to-product mapping

The reviewed quality tracker contains two relevant structural patterns:

| Existing field group | Product interpretation |
|---|---|
| Product, description, customer grouping, lot and quantity | Product/lot detail and order context; resolve against authoritative IDs. |
| LAB and CoA fields | Separate laboratory and certificate milestones; define date/status semantics with Quality. |
| PO RD, Invoiced and WO fields | Preserve source labels during discovery; confirm meaning instead of treating shorthand as identifiers or release approvals. |
| Notes | Convert actionable blockers into owned exceptions while preserving original evidence. |
| Product/WO/parent lot and missing item/component lot | Explicit links between a blocked run and its component/WP quality cases. |
| Request date and days pending | Handoff timestamp and calculated queue age using the current reporting time. |
| Status and comments | Verified status mappings, evidence and history; do not infer undocumented codes. |

Normalize customer grouping rows, shortened product codes, repeated-value marks and cells containing several lots only after mapping is verified. Do not invent missing identifiers or treat a range of lot numbers as a confirmed set.

Warehouse intake, ownership, forecast/actual release and schedule-impact fields are product requirements that extend the existing tracker. The workbook is a discovery reference, not proof that those workflows are already implemented. Financial reconciliation outside the quality workflow is not included in this module.

No source workbook or operational row data is stored in this public repository.

## 8. Delivery slices and acceptance criteria

1. Shared identities and imports: map schedule, SO lines, WOs, components and lots; expose unmatched records and stale sources.
2. Warehouse receiving and quality handoff: capture receipts, posting status, discrepancies, assignments and acknowledgements.
3. Component/WP quality queue: link pending lots to production requirements and explain urgency.
4. Finished-goods quality queue: record forecast release, authorized disposition and blockers; recalculate outbound risk.
5. Connected pilot: verify the four departmental perspectives against agreed real cases before operational reliance.

Acceptance scenarios:

- Replaying one receipt event creates no duplicate quantity or quality case.
- Partial receipt of a PO line leaves the remaining quantity outstanding.
- Received stock pending quality does not become usable inventory.
- Two lots of one component retain independent disposition and quantity scope.
- One pending lot shows every affected run without double-counting order quantities.
- Moving a run updates the material need-by date and warehouse/quality priority, while preserving history.
- Releasing a WP lot covers only its allocated downstream demand; its raw inputs are not required again as new demand.
- Missing sampling/results/documents remain visible with an owner and next action.
- A forecast release date does not release a component or finished lot.
- Production completion creates or updates finished-lot quality work without implying shipping release.
- Finished-goods release delay raises customer delivery risk independently of production readiness.
- A subsequent hold invalidates affected eligibility and identifies downstream impact.
- A user without release authority cannot change disposition through either UI or API.
- A missing or conflicting source record cannot produce a green readiness result.
- Evidence links open the correct record only for authorized users.

## 9. Decisions before implementation

Confirm official disposition sources and status mappings; receiving and ERP-posting responsibilities; RM/PK/WP/FG task templates; who assigns and accepts each handoff; permitted partial releases; lead-time calendars; customer requested versus agreed dates; and the pilot scope.

The requirement to provide four connected workflows and both quality work areas is captured. These operational details remain open; no code or UI implementation is authorized by this document.
