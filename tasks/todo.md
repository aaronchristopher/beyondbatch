# Connected workspaces execution index

November 3, 2026. Root tasks coordinate the existing PM module and new Supply Chain work. PM implementation details remain in [the existing checklist](../modules/customer-ticketing/tasks/todo.md). No live deployment, permissions, purchase orders or messages are changed by this backlog.

## PM checkpoint — saved, authenticated workspace

- [ ] Complete existing B2–B4 and demonstrate a persisted request with owner, history and correct per-user visibility.
- [ ] Pass actual SAML/MFA, approved-network and resource authorization acceptance before private email.
- [ ] Preserve the 24-hour response obligation independently of internal supplier updates and resolution.

Verification: use the existing B2–B4 verification and production-readiness gates; do not substitute the fictional review for deployed authentication. Dependencies: existing B1 and remaining B3 configuration. Ownership/files: existing customer-ticketing tasks, not a parallel replacement implementation.

## S1 — Purchasing-line model and fictional examples

Create the domain contract for RM and PK purchasing lines with distinct external references, units, revisions, buyer and source freshness.

- [ ] Represent one RM and one PK line with split deliveries; distinguish customer PO from supplier PO.
- [ ] Validate quantities, units and required identities; unknown dates/revisions stay explicit.
- [ ] Define corrections/cancellations and enforce no implicit quality release or financial authorization.

Verification: focused domain tests for partial quantities, invalid identities, stale versions and unit mismatch. Dependencies: none; safe to develop alongside PM work. Likely files (M): `modules/supply-chain/src/domain/purchasing-line.mjs`, `src/fixtures.mjs`, `tests/purchasing-line.test.mjs`, module package metadata. Scope excludes runtime deployment and official PO issuance.

## S2 — Save and reload one purchasing line

Persist the line, deliveries, evidence and revision events atomically using module-owned PostgreSQL tables.

- [ ] Save/reload both types and preserve before/after changes with actor and evidence.
- [ ] Replaying an import or command creates no duplicate line, receipt quantity or event.
- [ ] Tenant isolation, concurrent edits and failed writes deny or roll back coherently.

Verification: disposable native PostgreSQL integration tests, including reconnect/restart and rollback. Dependencies: S1. Likely files (M): migration, PostgreSQL adapter, transaction service and native test. Production roles remain separate approval.

## S3 — Authorized order register

Expose saved purchasing lines in Raw Materials and Packaging views with an order-detail window.

- [ ] Rows show supplier/buyer, component/revision, open quantity/unit, confirmed date, next action and freshness.
- [ ] List/detail queries enforce approved buyer and linked-customer visibility without leaking supplier commercial terms or email bodies to unrelated users.
- [ ] Refresh preserves saved state; unauthorized direct IDs and alternate routes return no private data.

Verification: scoped API tests and browser acceptance with fictional users. Dependencies: S2 and PM authentication/resource boundary; permission mappings must be explicit. Likely files (M): scoped repository projection, API boundary, workspace view and integration tests. Extract shared hosting/auth composition only as required by both modules.

## Checkpoint — reliable purchasing visibility

- [ ] Show one RM and one PK order through refresh and restart, with correct access and clear unavailable/stale states.
- [ ] Review the line fields and daily buyer workflow before adding bulk imports or automation.

## S4 — Reviewed open-PO import

Import a defined export format into the register while preserving source identity and avoiding destructive inference.

- [ ] Stage a preview with mapping, source/as-of time, duplicates and rejected/ambiguous rows before commit.
- [ ] Repeat imports are idempotent; absent rows do not silently cancel or close existing lines.
- [ ] Keep imported official POs read-only mirrors with visible import failures and reconciliation differences.

Verification: fixtures for duplicate snapshots, changed quantities, missing lines, unknown units and conflicting revisions. Dependencies: S2 and a reviewed source contract; S3 for operator review. Likely files (M): import mapper, staging/commit service, review API and tests. Do not assume Sage X3 credentials or API support.

## S5 — Supplier promises and partial receipts

Record reviewed promise revisions and quantity-scoped receiving progress without conflating them with inventory eligibility.

- [ ] Preserve original/latest supplier commitments and separate ship, dock-arrival and available-by dates.
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
