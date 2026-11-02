# Controlled launch week — November 2–6, 2026

**Target:** a controlled, authenticated, read-only Microsoft 365 pilot by **Friday, November 6, 2026**, if the gates below pass. This is a target, not a deployment commitment. The current repository is a local development scaffold with fictional data; it is not connected production software. No credentials, tenant grants, mailbox settings or outbound delivery permissions have been changed by this build.

The product is designed for organization-wide operational coverage through explicitly approved mailbox waves. Friday's target is the first useful wave, not a claim that every company mailbox is covered. No release may be described as “companywide” while relevant mailboxes, sent-message paths or folders remain outside verified coverage.

This response-first slice uses the newly specified 24-hour elapsed response policy below. Earlier business-hour response targets in the October production plan are not the current clock rule. The larger plan's security, evidence and longer-term evaluation requirements still apply; the accelerated week does not establish their completion.

## What must work on Friday

Two approved PM primary mailboxes and one approved shared customer-facing mailbox, covering three to five mapped customer accounts, are the proposed first wave. The exact people, mailboxes and customers require business and administrator approval. Include incoming and sent mail, approved business folders and supported attachments. Unsupported or sensitive content enters a restricted review queue; it is never silently interpreted as having no work.

PMs use ordinary email. They do not add ticket IDs to subjects or administer every message. The app correlates eligible requests across threads and mailbox copies, proposes evidence-backed obligations and maintains per-user work views. A named review steward checks uncertain classification, correlation and ownership. Only validated routine rules may operate automatically. Closure requires verified evidence and human confirmation throughout this pilot.

The president sees an authenticated, authorized roll-up of customer obligations: what the customer needs, the accountable PM, the next actor/department, the deadline, time waiting and the next action. Raw mailbox access, unrelated HR/legal/personal material and individual blame rankings are outside that view.

**Response clock:** 24 elapsed hours, including nights, weekends and holidays. This is 86,400 seconds in UTC, not “the same local time tomorrow” or one business day. Acknowledgments, internal notes and drafts do not stop the clock. A substantive customer-facing answer/update needs evidence and must address the applicable obligation. New follow-ups and recurring owed updates have their own records; they cannot reset or erase an older overdue obligation. Ticket resolution is a separate decision. Earlier explicit customer commitments remain separately visible and overdue when missed.

An initial response clock starts at the source message's received time, not the time an agent eventually notices it. Store both occurrence and recognition times. Run deadline recognition at least every five minutes and reconcile available mailbox/task evidence hourly. Graph arrival delays, missing sent-mail coverage and outages must be visible; “no reply observed” is not proof that no reply exists.

## Dated critical path

Owners below are required roles to name on Monday, not claims that individuals have accepted work. The business sponsor and each technical and operational owner must be explicitly assigned.

| Date | Accountable role | Concrete result | Exit gate / fallback |
|---|---|---|---|
| **Mon Nov 2** | Business sponsor + Exchange/Entra administrator | Confirm pilot mailbox/customer allowlist, primary/backup PM mappings, triage steward and weekend duty. Review the exact Entra, Exchange RBAC, hosting and model-data approval package. Assign two engineers and QA/business reviewers. | Approval owners and decisions recorded by end of day. If live-data approvals are late, continue synthetic/local work; do not borrow a user's credentials or widen access. |
| **Tue Nov 3** | Identity/backend engineer + administrator | Configure approved nonproduction resources and identities; wire Entra server-side authentication/authorization; execute PostgreSQL migrations; prove allowlisted access and denied excluded-mailbox access. Verify send-as/on-behalf evidence coverage. | Independent PM and president accounts see only their intended data. Approved mailbox read succeeds, excluded mailbox read fails, and no send/write permission exists. A successful login alone is insufficient. |
| **Wed Nov 4** | Integration engineer + QA | Connect persistent Graph sync, durable jobs/outbox, private attachment handling, five-minute recognition and hourly reconciliation. Establish approved history baseline. Begin labeled-corpus replay and shadow observation. | Restart/replay does not lose work or duplicate obligations. Missed webhook recovery and sent-reply recognition demonstrated. Coverage and evidence gaps remain visible. |
| **Thu Nov 5** | QA lead + PM/department reviewers + security owner | Complete targeted evaluation and two-account permission tests; exercise the PM → department → customer-answer → human-verified closure path; restore a database backup into an isolated environment. Review president output and review-queue workload. | All hard safety gates pass; remaining defects triaged. Any missed request/type stays in review-only processing until corrected. Readiness evidence is attached to the checklist, not assumed from local tests. |
| **Fri Nov 6** | Business sponsor + technical owner + operations owner | Conduct documented go/no-go review. If passed, release the approved first wave with a coverage banner, named support and rollback plan. Observe a full response cycle and weekend coverage. | Production deployment requires separate authorization. If any hard gate fails, keep the release in shadow or synthetic demo and state the actual blocker/date. Do not label a demonstration “live.” |

Work that depends on grants cannot be compressed by allowing broader permissions or skipping authorization checks. Monday grant approval is necessary but does not guarantee Friday readiness. If only one engineer is available, narrow the target to an authenticated shadow pilot; do not cut access controls, recovery or evidence checks to preserve the date.

## Decisions required from owners

| Decision | Proposed default | Required approver |
|---|---|---|
| First-wave scope and PM mapping | Two PM mailboxes + one shared mailbox; three to five customers; 30-day relevant-content lookback | Business sponsor / PM lead, mailbox business owners, Exchange administrator |
| 24-hour duty coverage | Named primary and backup available each day, including Nov 7–8; app checked at an agreed cadence | PM lead + participating department leads |
| Effective Graph access | Separate ingestion principal; scoped Exchange Application RBAC `Application Mail.Read`; no redundant tenant-wide mail grant; no writes/sends | Authorized Exchange/Entra administrator and security owner |
| Customer/president visibility | Sanitized customer-obligation projection; evidence permission checked separately | Business sponsor + security/privacy owner |
| Infrastructure and model data | Approved Azure resource scope and monthly budget; approved model provider/deployment, processing region, retention and credentials | Azure budget owner + security/privacy owner |

The 24-hour target is a staffed operating policy, not something AI can guarantee alone. Quiet hours can defer future nonurgent notifications, but they do not pause elapsed obligations. Initial delivery is app-only: nobody should assume an automated email or Teams message will wake a backup. The duty plan must specify who checks the queue, when, and how a human escalates urgent work. If weekend coverage is unavailable, launch may still track time, but the sponsor must explicitly acknowledge that the service target is not operationally staffed.

“JEV” production selection remains unresolved. Earlier research suggests TypeSafe Jev may be the intended model; do not depend on it until the intended product, vendor terms, account availability and evaluation are confirmed. A provider-neutral interface allows the approved model to be chosen without changing workflow rules.

## Effort and operating allowance

These are planning allowances, not supplier quotes, verified current prices, or a guarantee of completion:

| Item | Assumption / allowance |
|---|---|
| Engineering during launch week | **80–160 total engineering hours**, assuming two substantially dedicated engineers, existing reusable scaffold and no major tenant blockers. The lower end supports a narrow shadow pilot; the upper end may exceed a normal two-person workweek and must be rescheduled or staffed, not hidden as overtime. |
| Administrator/security participation | 8–16 hours for scope, identity, approval review, negative access testing and infrastructure review |
| Business/QA participation | 12–24 hours for labeling, adjudication, workflow checks and go/no-go review; separate from ongoing duty coverage |
| Pilot cloud allowance | **$300–$900/month** for a small Azure API/worker, PostgreSQL, durable queue, private objects/secrets and bounded monitoring. HA/private-network choices, attachment volume and log retention can exceed it. Obtain an actual estimate before provisioning. |
| Model processing | `sum(input_tokens × input_rate + output_tokens × output_rate + other billed usage) / applicable unit`, plus retries, verification passes, reasoning usage and OCR. Use the approved vendor's then-current quote/rates and actual usage; set hard spend alerts/caps. |
| Exclusions | Microsoft license changes, enterprise provider minimums, penetration testing, taxes, high-volume egress, on-call labor and broader company rollout |

Stop automatic model processing at the approved budget limit and retain incoming jobs for review; a cost cap must not discard customer obligations. Phase the next mailbox wave only after the first wave's coverage, error rates and review capacity are measured. See [Production-Readiness.md](Production-Readiness.md) for the hard gates and expansion backlog.
