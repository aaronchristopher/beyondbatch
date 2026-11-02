# All-PM mailbox rollout

**Scope decision: November 2, 2026.** The first operational rollout covers all PM mailboxes through one shared ingestion service. A one-mailbox smoke test is an implementation check, not the deployment scope. This supersedes earlier one-person and two-PM first-wave proposals. This document changes the plan; it does not establish live access, deployment or working automatic assignment.

## One service, shared requests, separate mailbox jobs

Reuse the dedicated single-tenant reader identity. Schedule independent jobs for every approved mailbox and physical folder, with checkpoints keyed by tenant, mailbox object ID and folder ID. Each job has durable progress, bounded retries, a lease and health reporting. One stalled mailbox must not stall the others or make the overall dashboard appear current.

The service reads incoming and sent mail plus approved business subfolders, records evidence, and submits only eligible operational content to the extraction provider. Hourly reconciliation repairs missing events. A separate five-minute clock monitor detects due responses without repeatedly sending unchanged threads to a model. Do not put every mailbox into a single model prompt or treat the model as the scheduler or database.

All jobs contribute to one tenant-scoped request database. Preserve mailbox-copy identity and source access controls when linking duplicate messages. Match related issues using existing links, reply headers, customer identity, product/order references and evidence; subject similarity alone is insufficient. Multiple asks stay separately tracked. Uncertain merges are reviewable and reversible. Internal request IDs stay out of customer email and ordinary PM screens.

## Exact scope inputs

The all-PM scope is authorized. The exact current roster still needs to be supplied and resolved; do not infer membership from recent correspondents, email recipients or a job-title search.

| Input | Required contents |
|---|---|
| PM roster | Each PM's primary mailbox address, resolved mailbox object ID, active status and roster owner |
| Shared-mailbox inventory | Customer/PM shared mailboxes and aliases, resolved to distinct mailbox identities; explicitly include shared mailboxes in scope |
| Customer assignments | Stable customer identity/domains, primary PM, backup PM, effective dates and approved exceptions |
| Department responsibilities | Request categories, assisting departments and their queue/review owners |
| Processing policy | Initial metadata baseline, permitted content lookback, folders, attachment handling, sensitive exclusions and retention |
| Runtime choices | Hosting resources/cost limit, credential storage and approved model provider/data processing settings |

Store real rosters, customer mappings and tenant configuration privately. This public repository contains only the schema, procedures and fictional fixtures. No production values belong in this document.

## Microsoft setup

1. Resolve every roster entry using a read-only Exchange lookup; reject missing entries, duplicate identities and unexpected mailbox types.
2. Prepare a reviewed Exchange resource scope containing exactly those mailbox object IDs. Preview and compare complete identity sets, not merely counts. Do not reuse an automatically changing employee group or a broad department filter.
3. Reuse the dedicated enterprise service principal and assign only scoped `Application Mail.Read`. Inspect existing Exchange assignments and Entra grants; they are additive. Do not add tenant-wide Entra mail grants to make a failed connection work.
4. Match the application's mailbox allowlist to the reviewed Microsoft scope. Test every included mailbox and a selected excluded mailbox using both authorization checks and actual application Graph reads.
5. Verify incoming and sent evidence for each mailbox, including shared Send As/Send on Behalf paths. A PM's delegated mailbox access does not automatically authorize that shared mailbox for the application.

Mailbox permission covers the whole permitted mailbox. Narrower customer/folder processing rules are application controls, not Microsoft-enforced message-level permission. Sensitive material must be excluded or restricted before inference, user projections and executive aggregates. Email and attachments remain untrusted evidence, never agent instructions.

See [Microsoft admin setup](Microsoft-Admin-Setup.md), [Application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac) and [shared Sent Items behavior](https://learn.microsoft.com/en-us/troubleshoot/exchange/user-and-shared-mailboxes/sent-mail-is-not-saved).

## Assignment and response rules

- Use the effective customer-to-PM mapping to establish one accountable owner. A recorded, authorized handoff can change ownership and retains the previous owner/history.
- Explicit email commitments can identify an assisting person or nominate a handoff. Being the recipient, sender, or a copied participant does not by itself replace the accountable PM.
- Missing/conflicting customer or ownership evidence goes to a named review queue. Show it as unassigned/needs review; keep its response obligation visible and running.
- Map the concrete ask to the assisting department. Track each dependency's owner, requested output, due date, evidence and next action separately from PM accountability.
- Response obligations start at the source received time and use 24 elapsed hours. A copied message, reassignment, internal update or draft cannot restart an older obligation. A partial reply covers only the asks it answers.
- A meaningful sent response and final resolution are separate events. Closure requires evidence and human confirmation during initial operation; new contradictory evidence can reopen a request.

Read-only ingestion does not create a private view into every dependent department's mailbox. Department-only conversations outside the approved PM/shared-mailbox scope remain unobserved. The dashboard must show this limitation and allow authorized department updates.

## User experience and access

PMs see their owned/backup work, responses due now, blocked items and the next action. Departments see authorized dependencies. The president sees authorized customer obligations, elapsed wait, missed commitments and the accountable owner across covered PM mailboxes. User sign-in and record authorization remain separate from the reader identity. Request-summary access never automatically grants raw-email access.

Keep source evidence and assignment explanations inside the request detail window. Show mailbox coverage and freshness. The existing fictional review remains labeled fictional until live integration and authorization pass. Graph message links open Outlook web; exact-message Classic Outlook desktop opening remains a separate unfinished integration.

## Build and release gates

1. Obtain the exact roster and customer mappings. Validate the mailbox inventory without reading bodies or changing grants.
2. Complete production sign-in, authorized projections, database event/evidence writes, durable jobs and approved credentials/provider configuration.
3. Run one controlled incoming/sent smoke test, then enable and verify every approved PM mailbox before claiming all-PM coverage.
4. Exercise cross-mailbox copies, different threads, multi-ask emails, partial replies, PM handoffs and department dependencies against a labeled sample drawn from all participating PMs.
5. Prove excluded-mailbox denial, sensitive-data separation, PM/department/president access boundaries, stale-sync warnings, restart/replay, duplicate suppression and backup restoration.
6. Establish review/support owners and 24-hour duty coverage. Use [Production readiness](Production-Readiness.md) for the measured quality gates; report review/abstention rate and evidence quality separately from accuracy.

An authenticated shadow run may cover all PM mailboxes while extraction quality is evaluated, but it supplements normal Outlook follow-up until operational acceptance. No automated sending, email/Teams reminders or automated final closure are enabled by this plan. No fixed launch date or operating cost is established by changing scope; estimate from the actual roster, volume and infrastructure configuration.
