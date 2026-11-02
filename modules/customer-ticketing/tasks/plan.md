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
