# Operations scheduler and run estimates

Date: 2026-10-08
Status: Requested product direction; calculation and interaction details proposed for review. Documentation only.

## Main workspace

Preserve the familiar spreadsheet schedule as Operations' primary workspace, using the existing date rows and line/shift columns. Each production placement opens the shared run card. Do not replace this workspace with a generic dashboard.

A collapsible left-hand panel contains open order lines. Planners can search and filter by customer, SKU, customer PO, due date and scheduling status. Default to lines with quantity still needing scheduling, with all open lines available through a filter. Closing and reopening the panel preserves filters and scroll position.

Each order entry shows description, FG/SKU, customer PO, SO and line, open quantity/unit, quantity already covered by scheduled runs or allocated released stock, remaining quantity to schedule, and requested delivery date. Customer PO and supplier PO references must be clearly distinguished.

## Drag an order onto the schedule

1. Drag an open order line into a date/line/shift cell. The destination sets the proposed production start and resource.
2. Select the quantity to produce, defaulting to uncovered demand, and the applicable operation. Link an existing WO where available; otherwise identify the run as a provisional planning record. Scheduling does not silently create an ERP WO.
3. Preview required production hours, working shifts, estimated finish and occupied schedule cells. Show the rate source, setup allowance, capacity conflicts, material readiness and separate customer-date risk.
4. An authorized planner confirms the placement. Cancel leaves the order and schedule unchanged.

Provide an equivalent keyboard-accessible “Schedule on…” action.

A multi-day run occupies the appropriate cells under one stable run identity. Clicking any segment opens the same detail card. Moving it changes its start and recalculates its span; it does not create another demand. Splitting an order into runs preserves quantity coverage and exposes the remaining unscheduled balance in the panel.

Do not silently double-book a line or move other runs. An incompatible SKU/operation/line combination cannot be confirmed. Material shortages can remain visible on a deliberately planned run; scheduling never bypasses quality or execution prerequisites. Capture actor, previous and new placement, quantity and estimate version, with concurrency checks against newer edits.

## Estimate duration by SKU and line

Use historical performance for the specific SKU, line and operation. A SKU may run at different speeds on different lines. Plain average batch duration is insufficient when historical quantities differ.

Proposed baseline:

- Effective rate = total comparable good output / total comparable production hours.
- Production hours required = planned good quantity / effective rate.
- Line occupancy = production hours required + applicable setup, changeover and cleanup time.

Use consistent units, product revisions and pack configurations. Define the production-hour basis before calculating rates. If routine downtime is included in the effective rate, do not add it again as a separate allowance. Likewise, exclude separately estimated setup from the historical rate denominator. Account for planned breaks and downtime exactly once across the rate and calendar model.

Show the sample count, history window, rate basis and variability alongside the estimate. Exclude or label non-comparable trials and exceptional runs through an agreed policy. Good-output rates already reflect observed yield; do not add a second yield adjustment without a distinct reason.

Translate occupancy into available working slots from the selected start, using actual line calendars, staffed shifts, breaks, maintenance, holidays and existing reservations. Preserve partial final shifts. Do not infer calendar duration by dividing by a fixed number of shifts per day. Treat non-interruptible operations explicitly.

Illustrative example only: 60,000 units at 10,000 units per available production shift requires six production shifts. With two available shifts per working day, that is three working days before any additional setup or cleanup occupancy. Different calendars or reservations change the finish date.

When reliable history is unavailable, show an approved standard rate or planner-entered duration with its source and reason. Otherwise show duration as unknown. AI must not invent throughput. New actuals may suggest revised estimates, but cannot silently move confirmed runs.

## Planner timing overrides

Operations can keep the quantity against an order unchanged while adjusting planned start, duration, working shifts or finish. Historical runtime is a recommendation, not a locked duration. Show the system estimate and planner's chosen timing side by side, including their difference.

Identify which input the planner overrides: duration or target finish. Recalculate dependent fields using the working calendar; do not accept contradictory start, finish and duration values. A shorter duration implies a higher required rate, which must be visible alongside the historical rate. Preview conflicts and downstream impacts before saving. Existing resource compatibility and quality gates still apply.

Keep four distinct records:

1. Original system estimate, including quantity, SKU/line/operation, rate, calendar and calculation version.
2. First confirmed schedule baseline.
3. Every subsequent confirmed plan revision, including the currently active plan.
4. Actual production start, finish, good quantity, run hours and downtime, with correction history.

Later estimates are versioned separately. Changing quantity, line or calendar must not erase the assumptions behind an earlier prediction. Planner overrides are not production actuals and must not be used as measured throughput history. Returning to the suggested timing is itself a recorded revision.

## Complete revision log and reasons

Every persisted business-data change in the connected scheduling workflow must produce an append-only revision event: creation, edits, moves, duration overrides, quantity changes, splits/merges, cancellations, unscheduling, actual corrections and reversals. Include schedule-affecting changes from Buyers, Warehouse and QA/QC, such as ETA revisions, receipt corrections, quality forecasts and disposition changes. View filters and unsaved drag previews are not business revisions.

Each event records:

- Stable event ID, entity/run/order references and prior/new version.
- Changed fields with before/after values and units.
- Actor and origin: human, import, integration or automated calculation.
- Recorded timestamp and effective timestamp, retaining the timezone context.
- Required reason category and explanation; linked evidence where available.
- Related initiating event and affected runs/order lines.
- Resulting start/finish, quantity coverage, readiness and customer-date impact where applicable.

Proposed reason categories include supplier delay, receiving delay, quality hold, equipment downtime, staffing, customer request, priority change, quantity/scope change, inaccurate runtime estimate, calendar correction and data correction. “Other” requires an explanation. These categories need operational validation; a selected reason is reported evidence, not automatically a verified root cause.

Require a reason when a person saves a business change. Imports and recalculations record the source revision and triggering event automatically. If a supplier change has no explanation, retain it as “reason not provided” and assign follow-up rather than inventing a cause or discarding the update.

Persist the business change and audit event together. An audit failure must not leave an unlogged change. Repeated integration events must not duplicate revisions. Bulk edits share a change-set ID but retain each affected record's before/after values. Reversals and corrected explanations append events instead of deleting history. Preserve split/merge lineage and archived records.

A run card exposes its chronological revision log; an order aggregates all linked runs. Users can filter by date, field, actor or reason and compare any two revisions. Apply record/evidence access controls to the history as well as the current view.

## Quarterly schedule and prediction review

Support quarter, month and custom-period reviews with drill-through to the underlying revisions. Preserve period-end snapshots or equivalent reproducible as-of views; later corrections must not silently rewrite previously issued reports.

Report:

- Change frequency: distinct runs/orders changed, revision counts, reasons and time between the change and planned start. Separate manual changes from automated consequences so one ETA update is not presented as many independent planning decisions.
- Schedule movement: initial versus latest confirmed start/finish, net movement and cumulative movement, including moves earlier and repeated back-and-forth changes.
- Estimate accuracy: original system duration and planner-selected duration versus actual comparable production hours, with signed error and absolute error by SKU, line and operation.
- Schedule adherence: actual start/finish versus the first confirmed baseline and versus a defined frozen plan, such as the plan in effect before execution. Do not compare only against a last-minute revised date.
- Delivery performance: actual delivery versus customer-requested and agreed dates separately, with partial deliveries measured by quantity. Production completion alone is not evidence of on-time delivery.
- Delay explanations: linked supply, receiving, quality, equipment, staffing and planning events; distinguish recorded explanations from reviewed root causes and retain multiple contributing causes.

Define the reporting cohort explicitly, for example runs originally due in the quarter. Include overdue unfinished and canceled runs separately; unfinished runs have lateness-to-date but no completed-runtime error. Show missing actuals and missing reasons as coverage gaps. Distinguish working hours/shifts from elapsed calendar time.

Compare estimates only on a consistent quantity, operation and timing basis. Separate scope changes from prediction error; do not label a doubled order quantity as a speed-estimation failure. Preserve original predictions, and label any quantity-normalized analysis with its method. Human-reviewed patterns can inform future rate or planning-policy changes, with version history.

## Required data streams

| Stream | Required inputs | Purpose |
|---|---|---|
| Open sales orders | SO/line, customer PO, SKU, open quantity, unit, requested/agreed dates | Populate the panel and identify outstanding demand. |
| Coverage and allocation | Order-to-run quantities, allocated released FG, cancellations and shipped quantities | Avoid scheduling demand already covered elsewhere. |
| Product and operation master | SKU/revision, operation route, compatible lines, units and conversions | Match the order to a valid production resource. |
| Production actuals | Run/WO, SKU, line, operation, start/end, measured run hours, good output, rejects, setup and downtime | Establish comparable historical rates. |
| Resource calendars | Shift times, staffing/capacity, breaks, maintenance, holidays, existing reservations | Convert hours into working shifts and finish dates. |
| Revision and actual-event history | Before/after values, actor, reason, event/effective times, estimate versions and baseline snapshots | Reconstruct plans and explain changes and prediction errors. |
| Planning standards | Approved fallback rates, setup/changeover/cleanup rules, estimate policy | Support estimates where history is insufficient. |
| Material and quality readiness | BOM/WO requirements, stock/lot allocations, incoming supply, receipt and expected/actual quality release | Explain whether the proposed start is achievable. |
| Fulfillment timing | FG quality forecast, staging, pickup and transit requirements | Identify customer-date risk after production. |

Historical runtime availability and field mappings are not yet confirmed. Existing schedule placements alone are not proof of actual runtime or output.

## Connection to other departments

The estimated span belongs to the selected operation. Scheduling an FG run does not imply that upstream WP production can start at the same time; upstream requirements retain their own dependencies and need-by dates.

Confirming or moving a run recalculates affected component demand dates, buyer shortages, warehouse receiving urgency and QA/QC priorities. It preserves the shared quantity allocations described in [Department workflows and quality module](department-workflows-and-quality.md).

Production completion and customer delivery remain separate dates. Finished-goods quality release, staging, pickup and transit can produce a late-delivery alert even when materials and the production plan are green.

## Acceptance scenarios

- Closing the open-orders panel leaves the spreadsheet usable; reopening restores its context.
- Dragging an order into a cell previews the correct date, line and shift before confirmation.
- A partial quantity schedules only that quantity and leaves the remaining demand visible.
- Allocated stock and existing runs are not counted again as uncovered demand.
- Changing the line uses that SKU/line/operation's rate and rejects incompatible resources.
- Six required shifts span the actual working calendar, including blocked slots and partial shifts.
- Missing history produces a labeled fallback or unknown estimate, never a fabricated rate.
- Every cell segment opens the same run; moving the run does not duplicate requirements.
- Conflicting edits and occupied capacity cannot silently overwrite another plan.
- A start-date change updates departmental priorities and delivery risk without changing quality disposition.
- Revised throughput history proposes a new estimate without automatically rescheduling confirmed work.

- A planner changes six shifts to eight without changing order quantity; both timings and the reason remain visible.
- Every saved edit, reversal and integration update retains its before/after values and origin; failed audit persistence prevents an unlogged change.
- One supplier ETA change links all resulting impacts without inflating the number of independent decisions.
- Quarterly reports preserve the original baseline and include unfinished overdue work, missing actuals and later corrections explicitly.
- Planner overrides never enter historical throughput as measured actuals.

## Details to validate before implementation

Confirm historical actuals sources; minimum sample size and comparison window; runtime and downtime definitions; shift calendars; interruption rules; setup/changeover policy; order coverage rules; provisional-run-to-WO reconciliation; reason taxonomy; baseline freeze policy; reporting cohorts; and audit retention/access responsibilities. These are implementation decisions, not additional approved functionality.
