# Beyond Batch Customer Ticketing — path from demo to live use

Updated November 2, 2026. This extends the same project plan. All code remains in `modules/customer-ticketing/` in `aaronchristopher/beyondbatch`.

## Verified starting point

The private fictional interface has task/email-subject columns, linked email-trail windows, session-only reply drafts and a secondary Open in Outlook action. Source is merged through PR 3. The domain/access/adapter foundations have 217 passing tests. The normalized PostgreSQL request store also passed 20 native PostgreSQL integration scenarios; a production database is not connected. Production sign-in, real mail, model inference and sending are not connected. Automated tests do not establish real-mail accuracy. Visual interaction acceptance remains open because the managed browser preview route was unavailable.

The dedicated Microsoft reader app has already been registered, and the user supplied the initial mailbox roster including a corrected entry. Do not ask for these again or create a duplicate reader registration. Exchange mailbox resolution, scoped grants, the shared project-management address's actual type and customer-to-PM/backup mappings still need verification. The first operational scope is all named approved mailboxes; two unnamed possible additions remain excluded. A one-mailbox smoke test does not narrow that scope.

## Outcome milestones

1. **Saved, signed-in workspace:** one request can be stored, assigned, reloaded after a restart and seen only by authorized users. Start with fictional records. This is the next development milestone.
2. **Verified Microsoft access:** reuse the reader registration; resolve the known roster and shared address, configure exact read-only mailbox scope and prove included success plus excluded denial.
3. **Real email trail:** persist approved incoming/sent evidence, safely handle attachments and show authorized source threads in the existing windows.
4. **Automatic tasks and ownership:** identify customer, split asks, propose related-thread links and resolve one PM plus department dependencies. Use reviewed mappings; uncertainty remains reviewable.
5. **Reliable response tracking:** recurring sync and hourly reconciliation update evidence/status while a separate deadline monitor keeps 24 elapsed hours visible. Acknowledgments, internal messages and drafts never clear the clock.
6. **Reply inside Beyond Batch:** a signed-in user can review a source-linked draft and explicitly send through an authorized mailbox. Open in Outlook stays optional. Sending is separate from the background reader and from verified task closure.
7. **All-PM shadow acceptance:** compare the system with approved real examples from every enrolled mailbox, exercise access boundaries and recovery, and measure missed/false requests, duplicates, ownership, stale statuses, false closure and evidence support.
8. **Controlled team release:** authenticated PM, department and president views, backups/monitoring, duty coverage and an explicit release record. Remove fictional labels only for data paths actually connected and verified.

The milestone sequence is a dependency order, not a promise that every stage can safely finish this week. Microsoft configuration/mapping work can run alongside backend implementation. UI feedback can continue throughout. No 3D expansion or unrelated ERP integration is on the launch critical path.

## Architecture and behavior decisions

- Retain Azure, Entra, Microsoft Graph and PostgreSQL as the production target. Reuse existing BeyondBatch infrastructure where verified; prepare an exact resource/budget proposal before new billable resources are created.
- Build one complete saved-request path first. Test the normalized PostgreSQL mapping against real disposable PostgreSQL, not only scripted clients or SQLite. The closure/reopening write order must satisfy the schema's constraints.
- Resolve identity from verified server sessions and current database grants. Never ship the demo persona switch as access control. Executive summary rights are separate from source-email and sending rights.
- One ingestion service owns independent durable jobs per approved mailbox/folder. Store evidence and continuation checkpoints safely; report coverage gaps and stale sync. Initial live backfill/lookback and retention require a concrete policy before ingesting bodies.
- The provider-neutral extraction contract remains. Benchmark an approved provider on labeled requests; no claim that JEV or OpenAI is more accurate without results. Secure provider credentials are introduced only when this stage is ready.
- Distinct requests remain distinct even within one email. Correlation uses message links and customer/product/order evidence; subject similarity alone cannot merge. All proposed merges and ownership changes retain provenance and review history.
- In-app human replies are now part of the live product scope. Use separately approved delegated draft/send rights; do not broaden the ingestion identity to send mail. Reply targets the selected customer message and honors reply-to and verified recipients. Uncertain sends are reconciled before retrying. No automatic sends or autonomous final closure.
- Open in Outlook can use a verified Outlook web link. Exact-message opening in Classic Outlook for Windows remains a separately testable desktop integration and must not be presented as already supported.

## Implementation task index

Detailed acceptance criteria, dependencies and file boundaries are in `todo.md`. **B1: persist one request in PostgreSQL** is implemented with native database checks; recovery verification is being completed. **B2: read saved work through authorized API projections** follows. B2–B4 complete the signed-in saved-workspace milestone without live mailbox ingestion or model keys.

## Inputs and approvals at the point they are needed

- **Hosting:** actual subscription/resource group, region, private runtime URL and approved spend before creating resources. The previously entered budget alert is not a spending cap or approved operating estimate.
- **Microsoft read access:** exact verified mailbox scope and credential method before granting application read access. The registered app alone does not establish permission.
- **Business mapping:** customer → primary PM → backup, department queue owners and 24-hour duty coverage. Import an existing authorized mapping where available, then review exceptions.
- **Data processing:** eligible lookback/folders, sensitive exclusions, retention and provider privacy settings before live content processing.
- **Human sending:** sender rights and delegated Microsoft consent before enabling Send; shared send-as/on-behalf routes require their own verification. No message is sent by this planning update.
- **Release:** exact build, audience, resources, scope, acceptance results and rollback procedure before live reliance.

## Risks and response

| Risk | Control |
|---|---|
| Demo mistaken for live integration | Keep fictional and disconnected labels until the actual path passes acceptance |
| An inbox or Sent path is missing | Per-mailbox/folder coverage, negative access checks and stale-sync warnings |
| Wrong task merge, owner or customer | Evidence-backed proposals, abstention and reversible review history |
| A draft/internal answer falsely clears a request | Observe meaningful customer-facing Sent evidence for each addressed obligation |
| Duplicate send after timeout | Bound approval version, send-attempt ledger and reconcile unknown outcomes before retrying |
| Unauthorized email exposed to executive/department views | Independent source authorization and restricted summaries |

---

## Historical foundation slice

The following records the completed November 1 foundation. Its no-send scope describes that slice; the current human-operated reply scope above supersedes it for future live work. No earlier completion is relabeled as production readiness.

# Response-first implementation slice — November 1, 2026

User authorized starting implementation and targets live use during November 2–6. Existing production plan v1.1 remains the architecture reference. This slice implements testable foundational code; launch requires authenticated hosting and Microsoft authorization. No tenant changes or outbound sending are authorized by this local build.

## Decisions
- Keep Azure/Microsoft Entra + Microsoft Graph + PostgreSQL as the production target.
- 24 elapsed hours, including weekends and DST. Every approved request/follow-up and recurring owed update has an independently tracked obligation. No acknowledgement, draft or internal email satisfies it.
- One application renders authorized per-user views and a sanitized president roll-up.
- Same request can span threads; every mutation needs source evidence and audit history. Review ambiguous links/owners.
- Development harness uses fictional fixtures only and refuses production mode. Its clock engine, authorization projection, Graph reader and SQL schema are reusable modules. Never claim mock ingestion is live AI or Microsoft access.
- No Graph write/send methods. The next production slice wires Entra, PostgreSQL, job persistence and evaluated model proposals.

## Tasks and dependencies
1. Domain clock + state reducer: tested 24-hour semantics, idempotency, partial replies, coverage, verified closure.
2. Scoped Graph read adapter: tested pagination, host/mailbox boundaries, retry and cursor handling.
3. Database and access contracts: migration design, role scopes and evidence separation.
4. Local runnable integration harness: real module/API integration over fictional state; explicit not-connected status; per-role projections.
5. Launch runbook: dated critical path, concrete Microsoft approval checklist, blocked items and measurable go/no-go gates.

Complete this slice with focused tests and code review. It is not production readiness. Expand on the same foundation after admin setup and acceptance testing.
