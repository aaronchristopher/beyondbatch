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

## Explicit shift slots and top-level warnings

Clarified user direction, 2026-10-08: dates remain rows and production lines remain column groups. Within each line/date intersection, show two independently selectable, side-by-side slots: **1st shift on the left; 2nd shift on the right**. Keep these labels visible in the headers. A multi-day placement does not imply both shifts are occupied.

The planner drops an open order into its first date/shift slot, then extends it across the intended dates and shifts. Dragging down within the 1st-shift subcolumn selects only 1st shift on those dates; it must not automatically fill intervening 2nd shifts. Support explicit selection of both shifts, 2nd shift only, and individual additions/removals for mixed patterns. Provide equivalent keyboard controls.

Illustrative placement on one line:

| Date | 1st shift — left | 2nd shift — right |
|---|---|---|
| Monday | Run A | Available |
| Tuesday | Run A | Available |
| Wednesday | Run A | Available |

This represents three selected shifts spread across three days, not six shifts. All three placements reference one run and one planned quantity. Unselected slots remain available subject to real equipment occupancy, cleaning/changeover and interruption constraints. If the process cannot pause or leaves the line occupied overnight, show the resulting restriction rather than assuming another product can use that gap.

Store the plan as explicit line/date/shift allocations, including any partial-shift timing. Preserve the selected shift pattern when moving or extending a run; preview exceptions if a destination slot is unavailable. Never reduce the plan to only a continuous start/end range, because that would lose which shifts were selected.

Show the selected shift count, available production hours, planned quantity, historical estimate and projected finish as the planner drags or resizes. If the selected slots provide less capacity than the estimate requires, warn clearly. The planner can adopt a documented timing override; a shorter visual placement does not prove faster production. Confirmed allocation changes enter the existing revision log with before/after slots and reason.

### Potential lateness at a glance

The open-orders panel and schedule placements both expose customer-date risk. Recalculate during placement previews and after confirmed timing, quantity, shift or dependency changes. Explain the warning with the requested/agreed date, projected delivery date, estimated gap and contributing constraints. Keep delivery risk separate from material-readiness color.

For unscheduled or partly covered orders, distinguish “unscheduled / delivery at risk” from a calculated late forecast. Where enough data exists, show earliest feasible coverage based on the current schedule, compatible capacity and known dependencies. Missing capacity, duration or shipping inputs produce an explicit unknown forecast, not an invented delivery date.

For scheduled quantities, calculate finish from the actual selected shifts, then include remaining FG quality release and shipping time. A late-delivery warning can coexist with green material readiness. Identify the affected quantity when an order has partial coverage or multiple planned deliveries.

### Drill-down hierarchy

Keep the top-level spreadsheet readable, with compact order/run identification and warnings. Clicking any occupied shift opens the same production card: description, FG, customer PO, SO lines, quantity, selected shifts, component readiness and revision history. From there, open individual work orders and, in the future MasterControl phase, the linked execution record and step status. Users should not have to open every card to find potentially late orders.

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

## Predicted units from selected shifts and normal OEE

Clarified user direction, 2026-10-08: the interaction works in both directions. Entering quantity can suggest shifts; selecting shifts predicts achievable good units using the applicable SKU/line timing and normal OEE assumptions. Update this prediction as the planner adds or removes slots.

Display together in the placement preview and run card:

- Total open order quantity and required delivery dates.
- Target quantity allocated to this particular run or delivery installment.
- Selected shifts and available hours.
- Predicted good units from those slots, with the rate/OEE basis and uncertainty.
- Predicted shortfall against the run target.
- Other run/stock coverage and the order balance still needing coverage.

Normal OEE must have a defined scope, time basis, source, history window and version appropriate to the SKU/line/operation. The calculation design must reconcile ideal rate, OEE, scheduled production time, setup and planned stops on a consistent basis. Apply losses once: if an empirical good-output rate already includes the same effectiveness losses, do not multiply it by OEE again. Missing OEE or rate data produces an explicit approved fallback or unknown prediction. Validate these inputs before operational use; no live OEE feed is assumed.

Illustrative UI quantities only: order open quantity 60,000; this run target 60,000; selected shifts predict 30,000; capacity shortfall 30,000. If the planner intentionally changes this run's target to 30,000, its capacity shortfall clears, but the other 30,000 remains outstanding until linked to another run or eligible stock. The example is not a measured throughput claim.

### Advisory warnings and intentional splits

Insufficient predicted output is an advisory warning, not a requirement to extend the run. The planner may acknowledge and proceed because production is split across runs, order lines or separate deliveries, or because they expect a different actual rate. Offer actions to adjust the run target, link another run, plan a later installment, add shifts, or proceed with a reason.

Acknowledging a warning does not change the calculated prediction, declare the order fully covered or erase the outstanding balance. Show the acknowledged risk and reason, with who/when in the revision log. Re-evaluate it when quantity, shifts, rate/OEE or coverage changes; a previous acknowledgement must not silently cover a different shortfall.

Distinguish intended coverage from predicted coverage: allocating 60,000 units to a run predicted to produce 30,000 does not make the other 30,000 disappear. At order level, aggregate non-duplicated predicted contributions capped by each run's assigned quantity, plus eligible allocated stock, and show the difference from intended coverage. Multi-order runs cannot allocate their forecast output more than once.

Keep split runs and delivery installments linked to the originating SO line/customer PO with explicit quantities and dates. If actual ERP orders or lines are split, retain parent/child lineage and reconcile the original remaining balance so demand is not duplicated. A scheduling gesture alone does not create new ERP sales orders.

Assess customer-date risk for each installment and for the full remaining order. “Half now, half later” is an intentional plan, but a later installment may still be late against the requested/agreed date. Record any separately authorized customer commitment change; accepting a capacity warning does not change that commitment.

Acceptance: selecting fewer shifts reduces predicted output while leaving order quantity intact; a planner can save an acknowledged shortfall; splitting a 60,000-unit requirement into two 30,000-unit runs preserves exactly 60,000 total demand; predicted coverage remains distinct from assigned targets; and a late second delivery stays visible after the first delivery is covered.

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

## Future phase: MasterControl execution visibility and scheduling intelligence

Requested direction, captured 2026-10-08. This is a future integration and intelligence feature, not a prerequisite for the initial spreadsheet scheduler. MasterControl connectivity, accessible fields and update frequency have not been verified.

### Work-order drill-down

Opening a scheduled production card reveals its individual linked work orders. Opening a work order shows its linked MasterControl execution record and current progress: applicable operation/step, source status, completed and pending steps, blockers/holds, quantities and actual timestamps where the source provides them. Provide an authorized link to the exact record and show when the information was last refreshed.

Preserve explicit mappings between schedule run, ERP WO, product/revision, lot and MasterControl record/version. Support multiple work orders per run and multiple applicable records or steps per WO without assuming one-to-one relationships. Display unmatched records for reconciliation rather than guessing from product descriptions.

Keep physical production progress, electronic record completion, review and quality disposition distinct. A record awaiting signatures may describe physically completed production; a completed step does not establish final lot release. Parallel steps should remain visible rather than being forced into a single misleading current-step label. Do not equate the percentage of steps completed with percentage of time remaining.

### Execution data for the scheduling brain

Retain source event history, effective and received timestamps, record/template revisions, step transitions, measured runtime, good output, pauses, holds, rework and correction history where available. Preserve the original source meaning and agreed normalized meaning. Status snapshots alone cannot establish exact transition times; inferred intervals must be labeled as estimates.

Use validated execution history to support suggestions such as:

- “The last comparable run of this SKU on this line took X production hours.”
- “Across N comparable runs, the typical duration was X, with a range of Y–Z.”
- “This work order has reached this step; estimated remaining work places completion at this time.”
- “Recent comparable runs suggest allowing another shift on the next schedule.”

These are proposed output formats, not actual observations. Compare quantity, line, operation, product/template revision and applicable conditions. Separate processing time from waiting for materials, QA, documentation or equipment so an unusual hold does not automatically become the normal production rate.

Each recommendation must expose its supporting runs, sample size, assumptions, uncertainty and data freshness. Preserve its prediction timestamp, input versions and subsequent actual outcome for later accuracy review. Missing or stale source data reduces confidence and stays visible.

Planners retain control over adopting suggestions and overriding timing. Accepted suggestions become plan revisions with a reason and provenance. The integration must not automatically reschedule confirmed work, change customer commitments, complete MasterControl steps or authorize quality release.

### What to preserve now

Establish stable run/WO/order identities, versioned plan estimates, timing overrides with reasons, and separate actual measurements in the initial design. Leave explicit external-record mapping support for the future integration. Actuals can initially come from verified imports or authorized manual entry, labeled by source; do not imply MasterControl is already connected.

Before this phase is implemented, validate access methods, source permissions, record/WO mapping, available events versus snapshots, status semantics, refresh cadence and historical coverage. Start with read-only visibility and validated history, then introduce evidence-backed recommendations.

Future-phase acceptance: each WO opens the correct source record; stale/unmatched data is obvious; record review cannot masquerade as production runtime or quality release; source corrections preserve history; and a recommendation cannot alter the plan until adopted by an authorized planner.

## Shift-selection acceptance scenarios

- Extending a run down three 1st-shift slots books exactly those three slots and leaves 2nd shift unselected.
- Selecting both shifts for three days books six slots, subject to the actual calendar.
- Removing Tuesday 2nd shift preserves the other selected slots and recalculates the forecast.
- Resizing or moving a run preserves its identity, quantity coverage and explicit shift pattern, with revision history.
- Insufficient selected capacity triggers an estimate warning and requires a reason for a timing override.
- Potential customer lateness is visible in the order panel and grid before opening the card; unknown forecasts stay distinct from known late forecasts.

## Details to validate before implementation

Confirm historical actuals sources; minimum sample size and comparison window; runtime and downtime definitions; shift calendars; interruption rules; setup/changeover policy; order coverage rules; provisional-run-to-WO reconciliation; reason taxonomy; baseline freeze policy; reporting cohorts; and audit retention/access responsibilities. These are implementation decisions, not additional approved functionality.
