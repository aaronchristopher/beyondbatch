# Database and data-access contracts

**Implementation slice: November 1, 2026.** The production target is a Microsoft Entra-authenticated Node application and workers on Azure, with PostgreSQL 16 or later and private encrypted object storage. `db/001_core.sql` is an unapplied foundation migration. The local demonstration does not connect to this schema. No database, database roles, permissions, credentials, Graph consent, mailbox access or deployment were created by this work.

The runtime clock ledger and the relational model describe the same requirements but are not yet wired together. Completing that adapter, migration execution, role provisioning, constraint tests and recovery drills are launch requirements. A successful local domain test is not evidence that database isolation or production ingestion works.

## 1. Scope and entity map

There are 20 tables. Every non-tenant row carries `tenant_id`; cross-record foreign keys include it. The database stores stable internal UUIDs. Routine customer and PM interfaces use customer, product/order and plain-language request titles; they do not require users to copy ticket IDs into email.

| Entity | Responsibility and relationship |
|---|---|
| `tenants` | Internal tenant ID mapped to the approved Entra tenant ID. New tenants default disabled. |
| `principals` | Entra user or service identity, unique by tenant and Entra object ID. Local status defaults disabled. Display email is not an authorization key. |
| `role_grants` | Time-bounded, revocable role plus exactly one scope: tenant, customer, department or request. A role alone does not grant all evidence access. |
| `customers` | Reviewed account identity, domain/contact evidence and optional external business reference. Domains alone never prove customer identity. |
| `customer_pm_assignments` | Effective-dated primary PM and optional backup; accepted by an authorized person, with reason. A backup is not a second accountable owner. |
| `mailbox_approvals` | Approved mailbox, app identity, permission mechanism and permitted history range. This records authorization; it does not grant Microsoft access. |
| `sync_folder_checkpoints` | One mailbox/folder cursor, encrypted cursor bytes, generation, lease and coverage interval. Sent and received folders are independently tracked. |
| `raw_blob_refs` | Private storage locator, byte/hash metadata, key-version reference, quarantine state, retention and hold metadata. No secret or public download URL. |
| `canonical_emails` | Logical email content record, candidate deduplication fingerprint, message headers, direction, classification and sensitivity. No mailbox-specific Graph ID. |
| `mailbox_copies` | Every observed mailbox copy and its Graph immutable ID, conversation ID, current folder and source link. Multiple copies can reference one canonical email. |
| `email_attachments` | File, embedded message or reference attachment linked to one email; raw and extracted content remain private blobs. |
| `requests` | One independently closable customer obligation, one accountable owner after acceptance, current workflow state and versioned requirements. |
| `request_evidence` | Immutable many-to-many email/request association with request-specific evidence kind, locator, assessment version and rationale. One email can support multiple requests. |
| `thread_link_proposals` | Evidence-backed proposed association, confidence, contradictions, decision and accepted evidence. A confidence number does not execute a merge. |
| `dependencies` | Concrete department deliverable linked to one request; optional assigned person; delivered and verified states differ. |
| `dependency_edges` | Multiple prerequisites between dependency work items belonging to the same request. |
| `response_obligations` | Independent 24-elapsed-hour response clocks for initial requests, follow-ups, recurring updates and reopenings. |
| `audit_events` | Append-only business and security history, actor, evidence, aggregate version and idempotency key. |
| `outbox` | Transactional jobs emitted with committed changes. Supported jobs cannot send mail or Teams messages. |
| `idempotency_records` | Tenant/operation/key plus payload digest and successful result; retries cannot silently reuse a key for different input. |

Department keys are normalized configuration identifiers, such as `qa`, `rd`, `purchasing`, `production`, `warehouse`, `finance` and `document_control`. They are not free-form display names. The server validates them against the tenant's approved department configuration; this first migration does not include a department administration table.

## 2. Tenant isolation and authentication boundary

All 20 tables enable and force PostgreSQL row-level security. The tenant policy reads `bb.current_tenant_id()`, which resolves `app.tenant_id`. Missing context returns no rows and prevents inserts; malformed context errors. This enforces **tenant isolation only**. It does not implement department, customer, individual-request, mailbox or sensitivity authorization.

The production request sequence is:

1. Validate the Entra token signature, allowed issuer, audience, tenant, expiry and relevant authentication policy. Never trust an unsigned decoded token, an email address or a client-selected tenant header.
2. Resolve the approved internal tenant and active principal from trusted server configuration/bootstrap identity mappings. The initial tenant mapping cannot be obtained by assuming unrestricted SQL access before a tenant has been established.
3. Check the requested operation against active grants, ownership, department assignments and data classification.
4. Acquire a pooled connection, `BEGIN`, and set `app.tenant_id` with transaction-local `set_config('app.tenant_id', verifiedTenantId, true)`. Set the SQL session timezone to UTC for consistent rendering/logging; timestamps remain absolute instants.
5. Execute parameterized SQL, then `COMMIT` or `ROLLBACK`. Never use session-level tenant settings that can survive in a pool. Release a connection only after the transaction is closed.

An SQL-injection-capable client could change a custom setting. Therefore application users never receive direct database credentials or arbitrary SQL capability. RLS is defense in depth, not a replacement for trusted server authentication and parameterized queries. Application/worker connections must not own tables, have `BYPASSRLS`, be superusers, change roles, disable triggers, alter schemas or truncate tables. PostgreSQL privileged operators remain a trust boundary.

Workers process one approved tenant per transaction using the same RLS context. Worker grants and queue leasing must be reviewed separately from web grants. Do not solve cross-tenant scheduling by giving the ordinary worker a bypass role. A privileged tenant enumerator, if needed, must be separately designed, reviewed and tightly restricted.

### Required server authorization

| Actor | Intended authorized projection |
|---|---|
| PM | Requests they own or explicitly cover, with customer context and permitted evidence. A backup mapping enables a reviewed coverage flow; it does not silently reassign ownership. |
| Department member | Assigned department inputs and the minimum operational request context needed to perform them. No general mailbox browsing. |
| Reviewer | Explicitly scoped identity/link/owner ambiguity queue, with only the source material their role permits. |
| President | Approved operational customer-waiting projection; department blockers, owner, timing and evidenced impact. No default right to read all source emails. |
| Security administrator | Explicit administration and audit operations. Administration does not automatically authorize reading all email content. |
| Integration worker | Approved mailbox ingestion and narrowly scoped processing jobs, no human UI impersonation and no sending. |

No grants are issued by the migration. The server must reauthorize every read, search, count, export, evidence download, model retrieval and mutation. UUID knowledge, a selected workspace window and an Outlook source link confer no access. Unauthorized resources should yield a generic not-found/forbidden response without leaking titles or counts.

## 3. Sensitive-content separation

Email and blobs enter as `unclassified`; requests enter quarantined. Allowed classifications are operational, restricted HR, restricted legal, personal and other restricted content. Ordinary reporting contains only `publication_state = approved` and `sensitivity = operational`, with an approved customer identity.

`bb.executive_open_requests` is a security-barrier, security-invoker view. It excludes restricted/unclassified/quarantined records before counting overdue obligations and emits no email body, subject, blob key, personal address, raw evidence or audit payload. It contains internal IDs for server linking; the UI hides them. Counts must be computed from this view or an equivalent authorized projection, never from all requests followed by redaction. A request needing owner review can be present with a known approved customer and a null accountable owner; show “Owner needs review,” never guess a PM.

Approval of an operational projection requires verifying that its title and next action contain no restricted content. The view cannot prove the accuracy of a classification or sanitize text already placed in a field. Mixed operational/restricted correspondence must be segregated into separately authorized evidence and an approved minimal operational summary. The server must not add restricted source context to an otherwise operational model prompt, preview, notification or export. The database's tenant-only policies do not enforce these finer restrictions.

The production database role cannot rely on a view alone while still being exposed directly to end users: a security-invoker view requires appropriate underlying privileges. Database access remains behind the authorized API. A stronger per-principal SQL policy/projection-role model is a future reviewed migration, not implemented here.

## 4. Email identity, source evidence and correlation

There are three separate identities:

- **Mailbox copy:** `(tenant_id, mailbox_id, graph_immutable_id)` uniquely identifies the observed copy. Use Microsoft's immutable-ID mode consistently. Moves update its folder; they do not create new business requests. Moving between mailbox/archive boundaries can still change identity and requires recovery handling.
- **Canonical email:** `(tenant_id, dedup_version, dedup_fingerprint)` identifies an evaluated canonical-content fingerprint. Retain every copy and source link. `internet_message_id` is a nullable, nonunique lookup field because it can be absent, duplicated or forged. Same Message-ID with materially different sender/content/attachments must not collapse automatically.
- **Customer obligation:** `requests.id` survives replies, subject changes, forwards and mailbox changes. One email may create several independently closable requests; several threads may support one request.

The fingerprint algorithm must be implemented and tested against real authorized samples before production. Its versioned input should use normalized original sender, sent instant where present, Message-ID where present, newly authored content and attachment fingerprints, while excluding transport/mailbox artifacts. Do not claim a hash of arbitrary Graph HTML is proven cross-mailbox deduplication. A digest collision or contradictory identity requires review and a preserved source copy, not silent replacement.

Graph conversation IDs are mailbox-scoped hints. A subject match, customer match, identical product reference or embedding similarity is not sufficient to accept a link. Generate proposals from actual identifiers, requested outcome, scope/revision, participants, time and explicit handoffs; record contradictions and source spans. Resolve uncertain customer and PM identities in the review queue. The current pilot acceptance contract requires an authorized human decision; evaluated automatic acceptance can be added later with explicit policy version and decision provenance.

`request_evidence` is append-only. Its locator identifies the relevant message span, attachment page or structured artifact location; the raw blob remains authoritative. Assessments carry `requirements_version` and `assessment_version`. Corrections append new evidence plus an audit event identifying the superseded association; readers must project the latest accepted association rather than blindly treating every historical link as current. The append-only table has no implicit “delete a wrong match” capability.

The API must verify that an accepted link's evidence references the proposed email and request, and that the reviewer can access both. The SQL composite FK prevents a different-tenant or different-request evidence reference, but does not fully evaluate semantic matching, review permission or whether the proposed email itself is the correct one. These remain explicit acceptance gates.

## 5. Workflow state, response clocks and closure

Workflow states are `needs_review`, `open`, `acknowledged`, `working`, `waiting_internally`, `waiting_on_customer`, `answer_sent`, `resolved` and `cancelled`.

`open` means accepted and unanswered; it does not imply an acknowledgment was sent. Unknown ownership uses `needs_review`, while response obligations continue to run. Once accepted out of review, a non-cancelled request requires a known customer and one accountable owner. Waiting on QA does not transfer customer accountability to QA. `acknowledged` is an observed courtesy response, not a satisfied response obligation. `answer_sent` remains open until verified resolution.

Response clocks are a separate ledger:

| Event | Required clock behavior |
|---|---|
| Approved initial customer request | Create initial obligation using the actual source trigger instant, not processing time. |
| Customer follow-up requiring an answer | Add an independently identified follow-up obligation; do not reset or erase the earlier obligation. |
| An unanswered request is discovered late | Preserve its earlier source time and show its elapsed breach with coverage caveats. |
| Acknowledgment, draft, internal message or promise | Does not satisfy an obligation. |
| Meaningful external response covering this request | Fulfill only the obligations it substantively addresses using outgoing sent-mail evidence and the actual sent instant. |
| Partial answer | Satisfy only covered obligations; leave others open and schedule the next owed update as required by the response policy. |
| Waiting internally/on customer | Does not pause or extend the existing 24-hour clock. Determine whether a recurring update is owed through the domain policy, not an automatic status shortcut. |
| Requirements change or issue reopens | Preserve history; create the appropriate new obligation and version requirements. Do not relabel the old promise as fulfilled. |

The SQL constraint enforces `due_at - opened_at = interval '24 hours'`: exactly 86,400 elapsed seconds, across weekends and daylight-saving changes. `timestamptz` stores instants, not a local wall-clock timezone. Use UTC ISO-8601 instants at the API boundary and display them in America/Chicago by default. Customer promises, internal estimates and response-policy deadlines are separate fields. Date-only, tentative or unclear commitments require evidence-backed interpretation; never turn them into a false exact promise.

Clock obligation keys are stable business-event keys, such as an accepted request plus its source-email identity or a recurring-update predecessor plus cycle ordinal. A recurring obligation references its predecessor. The domain service must decide the recurring trigger instant explicitly, record it in an event and prevent duplicate/branching cycles. The SQL does not run a scheduler or create recurring rows on its own.

An obligation can be `open`, `fulfilled` or `withdrawn`. Withdrawal requires an authorized human, timestamp and nonempty reason; it is not successful response and must remain distinguishable in metrics. The fulfillment trigger requires request-specific meaningful outbound-email evidence and a matching canonical sent instant. It rejects internal emails, acknowledgments marked as nonmeaningful and nonexistent evidence. It cannot independently prove recipient correctness, substantive coverage, delivery success, or the truth of a model's assessment. Those require the evaluated domain policy, recipient verification, bounce/coverage checks and pilot review. Email classification alone never closes an obligation.

Resolution requires an append-only `closure_confirmation` evidence row for the current requirements version, matching active human principal and confirmation time. The database rejects resolution while any response obligation remains open, any initial/follow-up/reopened inbound obligation is not fulfilled, or dependencies remain unverified/uncancelled. Withdrawing an unanswered inbound obligation cannot be used to pass the resolution check. An internal human verification alone cannot satisfy a customer's 24-hour response requirement; cancelled/invalid requests follow the separate cancellation workflow. The authenticated command must also verify that the person has closure authority, that referenced artifacts satisfy the criteria, and that ordinary-email human confirmation is authentic and unambiguous. A user-principal ID supplied by a worker is not proof of a real human decision.

Close ordering in one transaction: append artifact/response/confirmation evidence; fulfill every inbound ask with meaningful outbound evidence; retire any remaining recurring-progress obligation as withdrawn with an explicit verified-closure reason; verify or cancel dependencies with reasons/events; update request closure fields and state; append audit/outbox. The closure trigger is immediate, not deferred, so the repository adapter must apply this ordering; it cannot set resolved first and repair the ledger later. A late-discovered preclosure unanswered ask invalidates the current closure just as a new valid reopening does. The obligation trigger locks the request and rejects adding an open obligation while it is resolved/cancelled. The repository adapter must first reopen and clear the current closure fields, increment requirements version when scope changed, append the opening obligation and record why prior closure is invalid in the same transaction, retaining historical confirmation evidence. The SQL rejects an inconsistent closed/open-clock pair; it does not perform automatic reconciliation or infer whether a late message is an actual unanswered ask. The complete transition matrix is enforced in the domain service; this migration enforces record-shape and evidence invariants, not every allowed old-state/new-state transition.

## 6. Ownership and dependency integrity

Customer mapping selects an owner only when effective, approved and unambiguous. Query both `effective_from <= atTime` and `(effective_until IS NULL OR effective_until > atTime)`. The unique open-ended assignment index does not prevent every historical interval overlap. The assignment command must lock the customer row and reject overlapping effective ranges before changing mappings. Changing a customer's mapping does not silently reassign all existing requests; a reviewed handoff command updates each affected request and records old/new ownership, authority, reason and acceptance/override.

Every request can have multiple department inputs. Dependencies can have multiple prerequisites through `dependency_edges`. Composite FKs prevent cross-tenant and cross-request links and self-edges. The dependency command must lock the request and reject cycles with a recursive traversal before adding an edge; cycle detection is not implemented by SQL here. Delivering an internal file is not dependency verification, customer transmission or resolution. An authorized person verifies the deliverable and records evidence. Dependencies do not impose an invented personal assignee: a department queue can be assigned while the individual remains unknown.

## 7. Atomic command and outbox contract

Production mutations must use one transaction:

1. Authenticate, authorize and establish tenant context.
2. Insert or lock the idempotency record for `(tenant_id, operation_scope, idempotency_key)`. Compare the canonical request digest; reuse with a different payload returns conflict. A completed key returns the previously authorized minimal response, not another mutation.
3. Lock the request/affected aggregate with `SELECT ... FOR UPDATE`, or use a checked `row_version` compare-and-swap. Validate transition, evidence, authorization and current requirements version.
4. Append immutable evidence as needed; apply the state changes and increment row versions. Server code maintains `updated_at`; the migration does not silently do it.
5. Append one event per affected aggregate version, carrying authenticated actor, source evidence, rule/model version where relevant and a minimal structured change record.
6. Insert any outbox jobs with stable dedupe keys; complete the idempotency record with the result event and authorized minimal projection.
7. Commit. On failure roll back all changes, including the started idempotency row.

The database does not automatically append events for arbitrary SQL updates. Restrict all application writes to the reviewed command layer; direct ad hoc application SQL can otherwise violate the audit contract. The SQL triggers prohibit update/delete of event and evidence rows; application roles must also lack TRUNCATE, DDL and trigger-control capabilities. Audit payloads must not contain whole messages, credentials, signed URLs or sensitive raw attachments. Their sensitivity is enforced in reads and retention policy.

Outbox jobs are at-least-once. Workers claim due work with transaction-safe leasing, for example `FOR UPDATE SKIP LOCKED`, then commit the lease before external work. Expired leases can be reclaimed; jobs must be idempotent. Store bounded error codes, retry with jitter/backoff and honor Graph retry guidance. After an explicit retry budget, mark dead letter and alert the authorized operator. Completing a job atomically records its result event and marks the job complete. An external side effect cannot be made exactly-once solely by this table.

`reminder_candidate` creates a reviewable internal candidate only. No send/email/Teams job kind exists. Enabling sending later requires a separate reviewed permission, approval and recipient-verification design; never rename a candidate job into a sending action.

Idempotency expiry is an application cleanup eligibility time, not permission to erase durable business dedupe history. Permanent trigger keys, mailbox-copy identities, event keys and outbox keys still prevent historical replay duplicates. Sensitive response projections must be minimized, reauthorized on replay and retained only for the approved retry window.

## 8. Ingestion checkpoint and storage contract

Mailbox approval is checked before every fetch, cursor replay and backfill. Revocation blocks new reads immediately and schedules a data-retention/authorization review; it does not destroy historical evidence automatically. Store mailbox IDs and approved scopes from actual Microsoft authorization. Do not infer approval from a connected ChatGPT account or from this table existing.

Cursor and webhook handling are separate. Folder delta state is authoritative for incremental recovery; notifications only schedule work. The adapter must validate Graph host, approved mailbox/resource boundary and response paging links before use. Encrypt opaque delta links/cursors; do not log them. A cursor checkpoint advances only after every message from the page has been durably recorded or durably scheduled in the same transaction. Store intermediate paging state explicitly so a crash can replay a page safely. Cursor generation invalidates stale workers following a reset. Invalid/expired delta state triggers an approved bounded backfill plus deduplication, not a fabricated “fully synced” status.

Coverage intervals are evidence about what was successfully observed, not a promise that every corporate communication channel is covered. Record separate gaps for Sent Items, moved/custom folders, shared-mailbox sent copies, inaccessible encrypted messages, reference attachments, retention/deletion and permission failures. “No reply observed in covered mail” must never be reported as “no reply exists.” Deleted source copies retain their canonical evidence and a deletion observation, subject to approved retention/hold policy.

Blobs are written through a quarantine workflow: allocate a private tenant-scoped key, upload encrypted bytes, verify size/hash and processing outcome, then commit availability and email/attachment references. Failed database transactions can leave orphaned blobs; a bounded orphan sweeper needs its own audit/retention rules. Never publish a blob before authorization and malware/parser checks. File names, MIME declarations, HTML, forwarded text, PDFs, macros and extracted text are untrusted input, never agent instructions. Reference URLs are recorded, not automatically fetched; any dereference requires an authorized host/resource policy and SSRF controls.

Use application-enforced byte/page/nesting/time budgets and isolated attachment parsing. Never execute macros or embedded code. Parser errors and unsupported/encrypted attachments are visible gaps. The storage key reference is not a usable credential. Encryption keys, Graph credentials and database credentials belong in reviewed managed-identity/Key Vault arrangements, not these tables or logs.

## 9. Installation and privilege requirements — not performed

1. Provision an approved Azure PostgreSQL instance with TLS, private network access, approved backup/PITR configuration, monitoring and tested connection limits. Obtain approval for database and storage identities/credentials.
2. Create a dedicated schema/migration owner and distinct non-owning web and worker login/managed-identity roles. Explicitly verify `NOSUPERUSER`, `NOBYPASSRLS`, no role escalation, no object ownership and no unrestricted default/public access. Review schema/function execution privileges: PostgreSQL defaults alone are not a least-privilege setup.
3. Apply `001_core.sql` once in a fresh database/schema through the migration runner. It has no `IF NOT EXISTS` bypass and no down migration that drops user data. Record the migration checksum and version in the deployment system. Inspect transaction rollback on failure.
4. Bootstrap the single approved tenant, principals and initial grants through an explicitly authorized administrative procedure with tenant context. Do not insert guessed identities. Provision Microsoft app consent and mailbox scope separately; verify allowed and denied mailbox reads.
5. Issue only reviewed object privileges to the application roles. Typical web access excludes mailbox checkpoint updates and raw content reads not required by evidence endpoints; worker access excludes grant administration and public-report publication unless explicitly required. No role setup or GRANT statements are embedded here.
6. Run the integration gates below on disposable test tenants before production traffic. Inspect policy enforcement using the actual non-owning production-shaped roles, not the migration owner or a superuser.
7. Integrate the PostgreSQL repository adapter and the domain clock reducer; exercise atomic commands, projections, sync recovery and worker leases. The local in-memory harness is not this integration.

## 10. Required database acceptance and recovery gates

These are required production tests; they were **not executed against PostgreSQL in this slice** because no database is connected.

- Correct tenant sees its rows; absent/wrong tenant sees none; cross-tenant inserts and composite FK associations fail; pooled connections never retain tenant context across requests.
- Same-tenant unauthorized department/customer/evidence/search/count access is denied by the server; restricted and unclassified records never affect ordinary executive rows or counts.
- Duplicate immutable mailbox IDs are rejected; mailbox copies can share canonical content; same Message-ID with different content is preserved; separate requests can share one email without duplicate-clock creation.
- Deadlines remain exactly 86,400 seconds through fall-back/spring-forward and weekends. Follow-ups do not reset earlier breaches; acknowledgement/internal/draft evidence cannot fulfill a response clock.
- Wrong-request or wrong-tenant evidence FKs fail. Response fulfillment requires meaningful outgoing evidence and its sent instant. Partial answers and unknown sent coverage remain unresolved.
- Resolution without matching current human confirmation fails; stale requirement versions, any unfulfilled inbound ask, any open recurring obligation and unverified dependencies prevent closure. A late-discovered preclosure ask must reopen the request transactionally before its new open obligation can be inserted. Reopening retains all historic confirmations.
- Audit/evidence update, delete and truncate are denied to web/worker roles; outbox/email processing replay causes one business transition and one clock trigger.
- Concurrent reassignment, requirement change and response fulfillment use row-version/locking conflicts; dependency cycles and PM-assignment interval overlaps are rejected by the command layer.
- Crash between Graph page fetch and checkpoint commit safely replays; crash after state commit leaves an outbox job available; expired leases and dead-letter recovery do not send messages.
- Revoked mailbox approval prevents reads; cursor reset recovers only approved history and reports gaps; malformed attachment quarantine never reaches a model or public download.

Before go-live, restore a backup into an isolated environment and verify event/evidence counts, object-store references, row versions, cursor recovery and outbox dedupe. Never resume Microsoft reads or job execution from a restored database until the operator verifies current tenant/mailbox approval and fencing prevents both old and restored workers from processing concurrently. Reconcile storage and SQL recovery points; missing blobs are explicit evidence gaps. Set RPO/RTO from measured restore tests and business requirements, not assumed service defaults.

Retention schedules must be approved for raw email/attachments, extracted text, operational requests, immutable evidence, audit history, cursors and temporary idempotency responses. Legal holds override ordinary purging. The append-only triggers intentionally block routine deletion of evidence/audit records; implement an independently reviewed retention/hold procedure before claiming purge compliance. Redact or tombstone approved content while retaining necessary provenance, and ensure backups/object versions follow the approved policy. No purge job is supplied by this migration.
