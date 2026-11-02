# Customer Ticketing implementation status — November 2, 2026

Canonical source: `modules/customer-ticketing/` in `aaronchristopher/beyondbatch`. Customer ticketing is a BeyondBatch module. The source import includes the server, domain, adapters, schema, UI, tests and static review builder.

## Verified development behavior

The repository-root test run passed **209 tests**, including six scoped fictional email-trail checks and clean-checkout/reproducible-build checks. Coverage includes 24-hour response obligations, partial Sent coverage, conservative correlation, request/source authorization, Graph read boundaries, transactions, durable fictional jobs, identity/checkpoint contracts and local HTTP routes. These are software tests with mocked services or fictional local databases, not a real-mail evaluation sample. Source syntax checks and the static review build also passed from the repository root.

The president table shows one row per request with its task and original email subject. Separate movable windows show fictional email threads and a reply composer; email bodies remain outside summary projections. In-app Reply is the primary planned workflow, with Open in Outlook as a secondary action. Drafts and attachment name/size previews stay in session memory, sending remains disabled, and no Microsoft message links are invented. Opening or drafting does not reset a response clock or close a request. Automated checks and a source review passed; browser interaction QA for this UI revision remains unverified because the managed preview browser route refused its connection.

## Production work still required

- Real Entra authentication/session handling and current database-backed user/evidence access resolution.
- Approved Microsoft tenant credentials, scoped live incoming/sent reads, shared-mailbox coverage and negative access tests.
- Applied PostgreSQL migration, relational evidence writer, durable integration jobs and recovery verification.
- Actual inference provider, reviewed live extraction/correlation, attachment isolation, monitored schedules and coverage warnings.
- Click-time source authorization and refreshed message links. Graph's verified web link opens Outlook on the web; the Classic Outlook Windows companion remains unimplemented and untested.
- Authenticated in-app reply draft/send endpoints, separately approved delegated permissions, recipient and attachment validation, explicit human approval, duplicate-send protection and Sent-evidence reconciliation. The ingestion identity remains read-only.
- Representative real-mail evaluation, workload staffing, production deployment and operational acceptance.

No email is sent by this code. The production entry point remains blocked. Demo personas are not production users. The static review is generated from the module source and is explicitly fictional.

## Reproduce checks

From the repository root:

```sh
npm test
npm run check
npm run build:ticketing-review
```

The test harness uses Node.js 24 built-in SQLite. Generated build output, test logs and runtime databases are excluded from Git. See `Production-Readiness.md` for the actual live-pilot go/no-go gates.
