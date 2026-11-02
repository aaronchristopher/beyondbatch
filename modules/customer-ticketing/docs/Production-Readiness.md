# Production readiness — Beyond Batch Requests

**November 1, 2026 · Unmet gates remain unchecked.** This file is the release checklist for a controlled pilot and later organization-wide expansion. Local fixtures, mock Graph responses, a migration file and a passing test command are development evidence; they do not establish Microsoft access, deployed identity, persistence, model quality or production readiness.

## What this repository establishes

The current build is a **development scaffold** for response clocks/workflow, a Graph read adapter, data/access contracts and a runnable fixture interface. Check the repository's current test report and README for completed modules. It has no approved live-mail connection or verified production deployment. Demo identity selection must never be usable as production authentication. No production gates below are pre-checked from scaffold completion.

The production target remains one Entra-authenticated application with an Azure API and worker, PostgreSQL as the source of workflow truth, Service Bus for durable jobs, private Blob evidence storage and Key Vault-managed credentials. Per-user and president views are server-authorized projections of the same records. No sending adapter, `Mail.Send`, `Mail.ReadWrite` or Teams-posting permission is required for the initial pilot.

## Hard release gates

Every gate needs a named owner, dated result and evidence link in the release record. A failure blocks live reliance; it cannot be waived by relabeling the demo.

### 1. Approved identities and scope — Exchange/Entra + security owners

- [ ] Single-tenant Entra sign-in is integrated server-side with token issuer/audience/tenant validation, secure sessions and current user/role enforcement. An unapproved tenant/user is denied.
- [ ] Dedicated ingestion identity and explicitly approved mailbox/folder inventory exist. Exchange Application RBAC grants the needed `Application Mail.Read` scope. Effective permissions have been inspected for additive broad Entra mail grants; no unscoped grant bypasses the allowlist.
- [ ] Positive read test for approved mailbox and negative read test for excluded mailbox pass using the actual application identity. UI filtering is not accepted as mailbox scoping.
- [ ] Incoming, personal Sent Items and shared send-as/on-behalf paths are tested. Any shared-mailbox copy-setting change has separate approval. Remaining gaps are listed to users; inaccessible archive/protected content is not claimed as covered.
- [ ] API/provider credentials have approved owners, rotation/revocation procedures and Key Vault storage. No secrets are present in client code, fixtures, source control or model prompts.

### 2. Correct user and executive access — API/security owners

- [ ] PM A cannot read PM B's unassigned customer content without an explicit scope grant. Department contributors see only the necessary assigned work context. Direct object URLs and guessed IDs do not bypass checks.
- [ ] President scope is approved and tested: authorized high-level customer obligations, accountable owner, blocker, elapsed age, commitment and next action. Raw message bodies/attachments are separate permissions, not automatic executive entitlement.
- [ ] HR, legal, personal and unrelated sensitive material is absent from ordinary lists, search snippets, aggregate counts, exports, caches and AI prompts. A mixed sensitive/business message receives restricted review or an approved redacted projection.
- [ ] Scope revocation is effective on API reads, downloads, background jobs and queued AI work. No unauthorized fallback provider or broader mailbox scope is used after an error.
- [ ] Demo impersonation/header/query shortcuts are absent from production paths; the development harness refuses production configuration.

### 3. Durable evidence and recovery — backend/operations owners

- [ ] PostgreSQL migrations have run in the approved environment. Workflow events, current state, evidence links and an outbox commit atomically; restart/replay is idempotent.
- [ ] Real per-folder Graph delta checkpoints persist only after processed pages are durable. Folder moves, duplicate notifications, message copies and out-of-order changes do not lose evidence or duplicate obligations.
- [ ] Service Bus retries/DLQ and bounded mailbox concurrency are deployed. 429 `Retry-After`, transient faults, auth revocation, expired subscriptions and invalid delta tokens have tested outcomes.
- [ ] The first single-mailbox wave may use monitored incremental polling every five minutes, with hourly folder inventory/reconciliation and missed-poll recovery. If webhooks are enabled, validation, renewal and missed-event recovery must also pass. Observed coverage and sync age are visible to operators and users.
- [ ] Five-minute deadline recognition is scheduled and monitored separately from hourly evidence reconciliation. Source occurrence and ingestion/recognition timestamps remain distinct.
- [ ] Attachments are scanned, size/type constrained and parsed in an isolated worker. Active content/macros are not executed; inaccessible, corrupt and unsupported files produce a visible review item.
- [ ] Private evidence storage, encryption and an approved retention/deletion/hold policy are configured. Ordinary logs contain identifiers/metrics, not full email bodies.
- [ ] Backup restore into an isolated environment is demonstrated; deletion/hold ledgers are reapplied before access. Record measured recovery time and possible data loss. No RPO/RTO is claimed solely from a cloud product default.

### 4. Response and closure behavior — workflow + business owners

- [ ] Each accepted obligation has one real accountable owner or an explicit unresolved assignment under a named review steward. Department execution does not silently transfer PM accountability.
- [ ] 24-hour due times use elapsed UTC duration, including weekends and DST. Reprocessing, duplicate copies, reassignment and later follow-ups cannot reset an earlier clock. Separate promises remain visible.
- [ ] Acknowledgments, promises, drafts, internal mail, OOO replies and irrelevant customer-facing replies do not satisfy a substantive-response obligation. A partial reply advances only its covered work.
- [ ] Meaningful customer-facing updates are linked to observed sent evidence and the obligations actually addressed. A recurring update obligation does not overwrite a previous overdue record.
- [ ] Ticket completion remains distinct from response completion. Human confirmation plus current, sufficient closure evidence is required; autonomous closure is disabled. “Thanks,” silence or a missing message cannot close a ticket.
- [ ] Changed requirements and contradictory replies invalidate stale proposals and reopen/review the same obligation when appropriate, preserving history. Cross-thread ambiguity is reviewable.
- [ ] New evidence, owner changes and ticket version changes invalidate pending drafts/proposals as appropriate. AI outputs cannot execute tools, alter policy or issue arbitrary workflow commands.

### 5. Minimum first-wave evaluation — QA + business reviewers

Use **at least 200 labeled message events** as a minimum launch-screening set, with actionable and negative mail, quotes, samples, specifications, production/shipping questions, acknowledgments, partial answers, forwards, duplicate mailbox copies, sent replies, requirement changes, attachments, ambiguous owners and sensitive exclusions. Include linked sequences, not only isolated messages. Keep thread groups and their copies together when splitting development and holdout sets. At least two reviewers independently label a subset and adjudicate disagreements. Report actual request, thread and closure-candidate denominators; 200 messages are not 200 independent customer cases.

- [ ] Held-out results show proposed first-wave targets: task precision at least 95%, request recall at least 90%, duplicate-obligation rate at most 2%, and ownership precision at least 95% **among automatically assigned eligible cases**. Report abstention/review rate separately; hiding hard cases cannot inflate apparent success.
- [ ] Every material automatic status/ownership claim has an accessible supporting evidence reference; sampled semantic support is at least 98%. All closure assertions require complete criterion evidence and human confirmation.
- [ ] Zero observed false closures, unsafe closure acceptance or unauthorized disclosure in the targeted test set. Autonomous closure stays disabled regardless of this result. A small set with zero failures is not proof of a zero-risk system.
- [ ] Stale status is measured as eligible new evidence not reflected within the configured freshness limit. Test lost webhooks and recoverable outages. Show sync degradation rather than manufacturing certainty.
- [ ] Measure p50/p95 event-to-visible latency, due-to-breach-recognition latency, model/attachment cost and reviewer time. Target healthy deadline recognition within five minutes and completed hourly reconciliation within 75 minutes of the prior successful cycle; classify upstream outages separately without erasing their impact.
- [ ] Review-queue arrivals can be handled by the named steward and backup. If a category or mapping fails quality targets, keep that path in reviewed/shadow operation; do not silently discard it or force automatic assignments.
- [ ] Approved live shadow observation and PM/department/president acceptance have occurred. If time or sample size is insufficient by Friday, release only the explicitly labeled shadow mode; extend evaluation before relying on automatic updates.

These minimal screening targets narrow the first-wave release; they do not replace the larger evaluation and sustained observation described in the production plan. Report synthetic and authorized-real-mail results separately. Broader rollout requires category/customer-specific evidence and representative actual closures, not a fixed date.

### 6. Operational readiness and go/no-go — operations + sponsor

- [ ] Named primary and backup cover the 24-hour response obligation, including weekends. Their queue-check cadence and human escalation path are documented. App-only visibility is not treated as an outbound notification service.
- [ ] Infrastructure budget, provider data handling/region, retention and operational support are approved. Spending alerts and hard safeguards queue work for review rather than losing it.
- [ ] Health monitoring covers API availability, recognition scheduler, reconciliation age, mailbox access errors, expiring subscriptions, queue/DLQ depth, attachment failures, evidence gaps and review backlog. A named operator receives technical alerts through an explicitly approved operations mechanism.
- [ ] Feature flags can pause model processing or automatic acceptance while retaining authorized ingestion and evidence; a broader ingestion kill switch exists for a security incident. Failed releases can roll back without losing audit history.
- [ ] Release owner records the exact build, migrations, configuration, scope, known limitations, gate evidence and rollback steps. Sponsor authorizes the specific deployment; no approval is inferred from the request to build locally.

## Prioritized production backlog

| Priority | Work package | Depends on | Acceptance evidence |
|---|---|---|---|
| P0 | Name policy, technical and duty owners; approve pilot scope and 24-hour coverage | Sponsor decisions | Signed scope/visibility/mapping and duty matrix |
| P0 | Entra identity + server authorization; remove demo identities from deployable path | Approved app registration | Two-account and excluded-tenant access tests |
| P0 | Provision approved PostgreSQL/Service Bus/Blob/Key Vault; wire persistence/outbox | Hosting approval | Restart/replay, migration and isolated restore results |
| P0 | Complete scoped Graph ingestion and actual tenant sent-path coverage | Exchange grant | Positive/negative mailbox tests; baseline/coverage inventory |
| P0 | Durable scheduling, webhook renewal, five-minute recognition and hourly recovery | Persistence + Graph | Lost notification, expired token, throttling and crash scenarios |
| P0 | Approved provider adapter, restricted context and bounded extraction proposals | Provider/data approval | Labeled holdout report with cost, latency, review rate and source support |
| P0 | Production PM/department/president routes and evidence authorization | Identity + persistence | End-to-end workflow, privacy and browser acceptance results |
| P0 | Retention, monitoring, incident/rollback and duty handover | Above packages | All hard gates evidenced; controlled release decision |
| P1 | Expand request categories and cross-thread automation | First-wave measured results | Per-category precision/recall/ownership gates and review capacity |
| P1 | Enroll the next mailbox/customer wave | Approved mapping + scope | Sent-path coverage, fresh baseline, negative access test and shadow review per wave |
| P1 | Improve forecasts and relevant-record retrieval | Reliable historical events + separate record permissions | Forecast calibration and traceable, ACL-filtered retrieval |
| P2 | Monday, Sage X3, CAPS Control and RawsRus adapters | Separate business/API approvals | Read-only reconciliation first; source-of-truth and conflict policy per field |
| P2 | Draft approval and eventual delivery | Separate sending authorization and security review | Recipient verification, quiet hours, approval expiry, duplicate suppression, unknown-send reconciliation, audit and kill switch |

Organization-wide expansion retains exclusions. Add only approved operational mailbox cohorts; verify coverage, identity mappings, provider capacity, privacy and review workload before each wave. No companywide access grant or automated outbound sending is a prerequisite for the MVP.

## If launch gates miss November 6

Choose the truthful fallback: a synthetic demonstration if live-data approvals are missing; authenticated live shadow mode if ingestion and access controls pass but automation quality does not; or a narrower approved first wave if only particular categories/mailboxes pass. Continue normal Outlook work, with designated humans reviewing customer obligations. Record the unmet gates and next evidence checkpoint. A local fixture, manual import or shadow proposal must never be presented as complete live organization-wide tracking.
