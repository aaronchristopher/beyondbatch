# Connected workspaces execution index

November 5, 2026. Root tasks coordinate the existing PM module and new Supply Chain work. PM implementation details remain in [the existing checklist](../modules/customer-ticketing/tasks/todo.md). No live deployment, permissions, purchase orders or messages are changed by this backlog.

## PM checkpoint — saved, authenticated workspace

- [ ] Complete existing B2–B4 and demonstrate a persisted request with owner, history and correct per-user visibility.
- [ ] Pass actual SAML/MFA, approved-network and resource authorization acceptance before private email.
- [ ] Preserve the 24-hour response obligation independently of internal supplier updates and resolution.

Verification: use the existing B2–B4 verification and production-readiness gates; do not substitute the fictional review for deployed authentication. Dependencies: existing B1 and remaining B3 configuration. Ownership/files: existing customer-ticketing tasks, not a parallel replacement implementation.

## S1 — Purchasing-line model and fictional examples

Define the run's raw and packaging requirements, the consuming operations and the RM and PK purchasing lines supplying demand. Keep the run/WO, FG, BOM revision, units, need-by time, buyer and source freshness explicit.

- [ ] Build a fictional run with raws covered by allocated released stock, incoming in installments, received awaiting QA, and short with no PO. Include packaging for two operations, with ready filling components and a final-packout component short against the shift.
- [ ] Link each requirement to quantities from stock or specific PO installments, allowing several sources per component and several runs per PO without double allocation.
- [ ] Validate quantities, units and required identities; unknown dates/revisions stay explicit.
- [ ] Define corrections/cancellations and enforce no implicit quality release or financial authorization.

Verification: focused domain tests for partial quantities, invalid identities, stale versions and unit mismatch. Dependencies: none; safe to develop alongside PM work. Likely files (M): `modules/supply-chain/src/domain/purchasing-line.mjs`, `src/fixtures.mjs`, `tests/purchasing-line.test.mjs`, module package metadata. Scope excludes runtime deployment and official PO issuance.

## S2 — Save and reload one purchasing line

Persist the line, deliveries, evidence and revision events atomically using module-owned PostgreSQL tables.

- [ ] Save/reload the run, its full raw and packaging requirements by operation and its supply allocations alongside both purchasing-line types. Preserve before/after changes with actor and evidence.
- [ ] Replaying an import or command creates no duplicate line, receipt quantity or event.
- [ ] Tenant isolation, concurrent edits and failed writes deny or roll back coherently.

Verification: disposable native PostgreSQL integration tests, including reconnect/restart and rollback. Dependencies: S1. Likely files (M): migration, PostgreSQL adapter, transaction service and native test. Production roles remain separate approval.

## S3 — Raw Materials and Packaging readiness by run

Open either checklist from the production schedule for a selected run. Show the complete RM or PK requirements with a drill-down to stock, PO lines and delivery evidence.

- [ ] Show required, usable for this run, remaining short, incoming quantities and dock ETAs by installment. Show the date enough is expected, an unknown ETA for any uncovered balance, and QA status against the run's need-by time. A missing PO never drops a required component from the list.
- [ ] Group PK components by consuming operation and need-by shift. Show which component, revision and quantity keep the shift from being ready. Distinguish usable now, scheduled arrivals and unknown timing. Missing requirements, a wrong revision or a pending release cannot produce a ready status.
- [ ] Rows show supplier/buyer, component/revision, open quantity/unit, confirmed date, next action and freshness.
- [ ] List/detail queries enforce approved buyer and linked-customer visibility without leaking supplier commercial terms or email bodies to unrelated users.
- [ ] Refresh preserves saved state; unauthorized direct IDs and alternate routes return no private data.

Verification: scoped API tests and browser acceptance with fictional users. Dependencies: S2 and PM authentication/resource boundary; permission mappings must be explicit. Likely files (M): scoped repository projection, API boundary, workspace view and integration tests. Extract shared hosting/auth composition only as required by both modules.

## Checkpoint — reliable purchasing visibility

- [ ] Open a fictional WO and see both complete checklists through refresh and restart. Demonstrate a split delivery, a raw with no ETA and a receipt awaiting QA. For packout requiring 10,000 cartons, show 6,000 usable and 4,000 due after the shift. Verify the schedule flags packout, preserves a ready upstream operation, and links the delayed balance to its PO. Moving that ETA before the shift changes the forecast; readiness follows verified usable supply.
- [ ] Review the line fields and daily buyer workflow before adding bulk imports or automation.

## S4 — Reviewed open-PO import

Import a defined export format into the register while preserving source identity and avoiding destructive inference.

- [ ] Stage a preview with mapping, source/as-of time, duplicates and rejected/ambiguous rows before commit.
- [ ] Repeat imports are idempotent; absent rows do not silently cancel or close existing lines.
- [ ] Keep imported official POs read-only mirrors with visible import failures and reconciliation differences.

Verification: fixtures for duplicate snapshots, changed quantities, missing lines, unknown units and conflicting revisions. Dependencies: S2 and a reviewed source contract; S3 for operator review. Likely files (M): import mapper, staging/commit service, review API and tests. Do not assume Sage X3 credentials or API support.

## S5 — Supplier promises and partial receipts

Record reviewed promise revisions and quantity-scoped receiving progress without conflating them with inventory eligibility.

- [ ] Preserve original/latest supplier commitments and separate ship, dock-arrival and available-by dates. A reviewed supplier email moving one installment must update the relevant raw or packaging ETAs for the affected runs and consuming shifts while preserving unaffected dates and quantities.
- [ ] Partial receipts reduce only the correct delivery/line balance; corrections and returns remain auditable.
- [ ] ERP posting and authorized lot/quantity disposition stay separate; pending/held stock never becomes usable by receipt alone.
- [ ] Applicable receipts create or link an owned Warehouse-to-QA handoff with requested/acknowledged/completed times; repeated events do not duplicate work. Before full QA queues exist, show the designated quality case and owner.

Verification: partial receipt, incorrect line, repeated evidence, duplicate QA handoff, missing QA owner, reversal, later hold and unknown-date cases. Dependencies: S2, S3 and designated receiving/quality source semantics. Likely files (M): events/reducer, receipt service, detail projection and tests. If native schema changes or QA handoff integration exceed this slice, split them into prerequisites before implementation.

## S6 — Link supply blockers to PM requests

Connect one purchasing line/requirement to its affected requests and produce shared operational impact.

- [ ] Many requests may reference one purchasing action without duplicating orders, quantities or buyer work.
- [ ] A reviewed supply update changes the dependency/next action and preserves the PM response deadline until meaningful customer-facing evidence exists.
- [ ] Cross-module links never grant source-email or commercial-record access; unverified matches remain reviewable.

Verification: one delayed PK line affecting two fictional customer requests, partial recovery, revoked access, changed revision and replayed update. Dependencies: PM checkpoint, S3 and S5. Likely files (M): supply-dependency table, linking service, event consumer and integration tests. Use stable references and an idempotent outbox; avoid distributed dual writes.

## S7 — President's combined view

Show customer impact and accountable next actions across both workspaces.

- [ ] List customers awaiting answers and supply blockers with affected quantity/run/date and evidence freshness.
- [ ] Distinguish known late, forecast at risk and unverified; supplier delay does not automatically become a new customer commitment.
- [ ] Aggregate only authorized records; prevent duplicated impact counts and unnecessary email/price exposure.

Verification: scoped projections and browser review of the S6 example. Dependencies: S6. Likely files (M): executive projection, API response, combined view and tests. Explain priorities without employee blame rankings.

## Checkpoint — connected operating example

- [ ] Demonstrate supplier delay → buyer action → PM next step → president impact, then partial receipt → quality pending → verified recovery.
- [ ] Confirm that supplier progress alone neither satisfies the customer response obligation nor closes the customer request.

## S8 — Internal purchase-request drafting

Let an authorized buyer prepare an internal buying need with the material or packaging prerequisites visible.

- [ ] Capture proposed component/revision, quantity/unit, supplier option, available-by date and supporting requirement.
- [ ] Show missing specification/artwork/supplier approvals, terms or evidence before approval routing.
- [ ] Saving/approving the internal record does not issue, email or post an official supplier PO.

Verification: missing approval, wrong revision, duplicate draft, unauthorized edit and concurrent review cases. Dependencies: S3 and approved buyer/approver mappings. Likely files (M): purchase-request schema/reducer, API, draft UI and tests.

## S9 — Verified need-to-buy calculation

Recommend buying quantities from a reconciled demand, BOM, stock and incoming-supply snapshot.

- [ ] Trace demand to exact FG/WO/BOM revisions and units; reject unverified conversions or double-exploded WP demand.
- [ ] Subtract eligible allocations once, distinguish expected from released supply, and account for partial receipts, returns and competing demand.
- [ ] Explain quantity/date suggestions and missing evidence; apply MOQ/pack multiples and lead-time allowances only from verified inputs.

Verification: allocation conservation, revision changes, MOQ rounding, stale/missing stock, held lots and multi-order demand fixtures. Dependencies: S5, S8 and reviewed source snapshots. Likely files (M): input contract, pure calculation module, allocation checker and focused tests. Split source adapters into separate tasks rather than adding them to this slice.

## Later commercial release gate

- [ ] Define official PO issuer, buyer/approver authority, ERP adapter, supplier/recipient verification and exact approval binding.
- [ ] Implement duplicate suppression and reconciliation for unknown send/post outcomes before enabling issuance, amendments or cancellation.
- [ ] Obtain approval for the specific external write/send and verify a controlled transaction before operational reliance.

No autonomous purchasing, supplier messages, quality release or customer commitments are enabled by these tasks. Existing PM mail/evaluation/reply tasks continue under their own checklist.
