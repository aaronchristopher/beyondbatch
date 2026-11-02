# Active execution checklist — November 2, 2026

This extends the same project; the completed foundation and previous blockers remain below as history. Milestones and scope are in `plan.md`. No live resources, permission changes or messages are created by this checklist.

## B1 — Persist one request in PostgreSQL (next)
- [ ] Implement the normalized request/event/obligation transaction adapter, preserving original due times and audit identity.
- [ ] Apply the existing migration to a disposable test database; prove restart persistence, rollback, concurrent-version rejection and tenant isolation with a least-privilege role.
- [ ] Verify: real PostgreSQL integration tests plus existing transaction/response-clock tests. No scripted-client substitute for database acceptance.
Dependencies: none beyond an available local/test PostgreSQL runtime. Scope: M; likely `src/persistence/postgres-requests.mjs`, `tests/postgres-requests.test.mjs`, test harness, reviewed schema adjustments if required.

## B2 — Read saved work through authorized API projections
- [ ] Map persisted requests to the existing workspace response shape; do not serialize source bodies into lists.
- [ ] Prove PM, department and president customer scopes and revocation using database-backed fixtures.
- [ ] Verify: API integration tests, direct-ID denial and restart/reload of saved data.
Dependencies: B1. Scope: M; likely workspace repository, API handler and integration tests.

## B3 — Wire real Microsoft sign-in
- [ ] Add a separate production entry point using supported Entra OIDC/session handling and the existing verified-principal contract.
- [ ] Load current roles/customer grants from the database; reject other tenants, tampered/expired sessions and demo persona parameters.
- [ ] Verify: two-account sign-in/sign-out, denied account and revoked-access checks in an approved test environment.
Dependencies: B2 and approved app/redirect/runtime configuration. Scope: M; likely identity adapter, session handler, production entry point and auth tests.

## B4 — Connect the existing workspace to saved records
- [ ] Display one persisted sample request with history and owner using the signed-in user's permissions.
- [ ] Confirm it survives refresh/server restart; separate users receive their correct view with no role-switch shortcut.
- [ ] Verify: browser acceptance, root tests/check/build and a reproducible deployment package.
Dependencies: B2–B3. Scope: M; likely production route wiring, frontend API boundary and acceptance fixtures.

## Checkpoint — saved, signed-in workspace
- [ ] Demonstrate a persistent request to Aaron with no live mail or model key required.
- [ ] Record actual database/auth results and remaining limitations before live content is introduced.

## M1 — Verify the existing reader identity and known mailbox roster
- [ ] Resolve every supplied mailbox and the shared project-management address; document aliases/shared mailbox/group behavior privately.
- [ ] Prepare exact scoped read permissions and secure credential configuration; implement only after the concrete access change is approved.
- [ ] Verify every included mailbox succeeds and a selected excluded mailbox is denied; inspect additive broad grants.
Dependencies: existing registration; can run alongside B1–B4. Scope: M; admin script, private inventory output and setup documentation. No private roster is committed.

## M2 — Persist incoming/sent evidence and expose authorized trails
- [ ] Implement relational message/page writer with idempotent mailbox-copy identity and checkpoint continuation handling.
- [ ] Serve an authorized source trail; isolate/scan attachments and report inaccessible content rather than substituting sample evidence.
- [ ] Verify: one controlled incoming/sent smoke test, then all enrolled mailboxes, forwards, duplicate copies, moves and shared Sent paths.
Dependencies: B4, M1 and approved processing/retention policy. Scope: M; page writer, Graph coordinator, evidence endpoint and integration tests. Break attachment worker implementation into a separate focused subtask before coding if it expands this boundary.

## J1 — Keep mail and deadlines current
- [ ] Run independently recoverable mailbox/folder jobs, hourly reconciliation and a separate five-minute deadline monitor.
- [ ] Surface sync age/errors; implement bounded throttling/retries, missed-event recovery and webhook renewal when enabled.
- [ ] Verify: lost notification, expired cursor, restart, throttling and stale-sync scenarios without duplicate requests.
Dependencies: M2. Scope: M; scheduler/coordinator, job adapter, recovery tests and health endpoint.

## A1 — Extract proposed tasks with an approved model
- [ ] Connect the provider-neutral adapter and label a representative evaluation set; extract separate requests with source references.
- [ ] Distinguish actionable requests from FYIs/marketing/acknowledgments; sensitive/excluded content never reaches ordinary inference.
- [ ] Verify: held-out false-task/missed-request results, cost, latency and evidence support. Keep uncertain results in review.
Dependencies: M2 and approved provider/credential/data handling. Scope: M; provider adapter, proposal pipeline, evaluation fixture manifest and tests.

## A2 — Assign owners, dependencies and related threads
- [ ] Import/review customer-to-PM/backup mappings and department responsibilities; maintain one accountable owner or explicit assignment review.
- [ ] Correlate copies/related threads conservatively, keep multiple asks separate and record reversible handoffs/merge decisions.
- [ ] Verify: ownership precision, duplicate rate, ambiguous customer/product/PO cases, partial replies and changed requirements.
Dependencies: A1, B1 and approved business mappings. Scope: M; routing service, correlation integration, mapping import and tests.

## R1 — Create and edit authorized reply drafts
- [ ] Implement source-linked Reply/Reply All with explicit sender/recipients and scanned attachments; honor reply-to and exclude unrelated internal content.
- [ ] Save a real Microsoft draft only after separately approved delegated rights; keep Open in Outlook as a verified alternative.
- [ ] Verify: two accounts, shared mailbox, recipient edits, denied sources, stale conversation and draft persistence. Drafts never satisfy response obligations.
Dependencies: B3, M2 and draft permission approval. Scope: M; draft adapter, draft API, composer API wiring and tests.

## R2 — Send only after the user's explicit action
- [ ] Bind Send approval to exact draft/source/sender/recipient/attachment versions and current mailbox rights.
- [ ] Track pending/unknown/failure/Sent outcomes with duplicate suppression; reconcile before retrying an uncertain send.
- [ ] Verify: controlled approved test send, double click, timeout, revoked rights and partial-response evidence; task completion remains separately confirmed.
Dependencies: R1, J1 and sending permission approval. Scope: M; send service, attempt repository, sent reconciliation and integration tests. No automatic sends.

## Q1 — Run all-PM shadow acceptance
- [ ] Compare against labeled authorized real examples across every enrolled mailbox and all important request categories.
- [ ] Exercise multi-request emails, different threads, department handoffs, partial answers, reopening, access revocation and evidence quality.
- [ ] Verify: report denominators for false/missed tasks, duplicates, ownership, stale statuses and false closure; meet documented release thresholds and reviewer capacity.
Dependencies: J1, A2, R2. Scope: M; evaluation runner, acceptance scenarios and release report. No actual customer sending without a specifically approved test or user action.

## L1 — Release the approved live module to the team
- [ ] Prepare and approve the exact infrastructure, spend, runtime configuration, audience and release artifact.
- [ ] Verify backups/restore, monitoring, rollback and named primary/backup 24-hour duty coverage.
- [ ] Verify: PM, department and president acceptance on the deployed release; remove fictional labels only for verified live paths.
Dependencies: Q1 and release decision. Scope: M per focused infrastructure/deployment subtask; use the existing BeyondBatch host where verified. Target date does not waive unmet checks.

---

## Historical foundation and blocker checklist

# Current implementation slice
- [x] Clock/state engine and meaningful tests
- [x] Scoped Graph reader and mock HTTP tests
- [x] PostgreSQL schema and access-rule proposal (not applied)
- [x] Runnable fixture harness and API boundary tests
- [x] November 2–6 launch plan and Microsoft setup package
- [x] Security/code review and fixes
- [x] Package and persist original source (November 1; subsequent updates are versioned)
- [x] Consolidate all implementation and the review builder as `modules/customer-ticketing/` in BeyondBatch; 203 tests and root build/check commands pass

# Production blockers
- [ ] Azure subscription/resource scope and deployment path confirmed
- [ ] Entra app registrations and approved mailbox scope
- [ ] Customer-to-PM and backup mapping
- [ ] Entra authentication and server authorization integrated
- [ ] PostgreSQL migrations executed and recovery validated
- [ ] Durable jobs, polling and delta recovery in tenant; subscriptions when enabled
- [ ] Provider/model processing authorization and evaluation
- [ ] Department and president pilot acceptance
