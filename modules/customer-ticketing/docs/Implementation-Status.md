# Customer Ticketing implementation status — November 2, 2026

Canonical source: `modules/customer-ticketing/` in `aaronchristopher/beyondbatch`. Customer ticketing is a BeyondBatch module. The source import includes the server, domain, adapters, schema, UI, tests and static review builder.

## Verified development behavior

The repository-root test run passed **217 tests**, including exact response-provenance and transaction-failure checks, six scoped fictional email-trail checks and clean-checkout/reproducible-build checks. Coverage includes 24-hour response obligations, partial Sent coverage, conservative correlation, request/source authorization, Graph read boundaries, transactions, durable fictional jobs, identity/checkpoint contracts and local HTTP routes. These are software tests with mocked services or fictional local databases, not a real-mail evaluation sample. Source syntax checks and the static review build also passed from the repository root.

The president table shows one row per request with its task and original email subject. Separate movable windows show fictional email threads and a reply composer; email bodies remain outside summary projections. In-app Reply is the primary planned workflow, with Open in Outlook as a secondary action. Drafts and attachment name/size previews stay in session memory, sending remains disabled, and no Microsoft message links are invented. Opening or drafting does not reset a response clock or close a request. Automated checks and a source review passed; browser interaction QA for this UI revision remains unverified because the managed preview browser route refused its connection.

## PostgreSQL request persistence — B1

The normalized request store now creates and reloads requests, preserves immutable event history, and commits evidence-linked obligations, outbox jobs and idempotency receipts atomically. Partial replies retain the exact message that answered each ask; late incoming evidence can invalidate closure while retaining original deadlines. Requirements version 1 is supported. New human decisions cannot be backdated before already accepted lifecycle evidence.

A native PostgreSQL **16.15** CI service passed **20 integration scenarios** (21 test-runner results including the parent suite) on commit `efe22dc7039e495de594fe85a3edcf27a84a92f3`: [verification run](https://github.com/aaronchristopher/beyondbatch/actions/runs/41526511433). These verify the migration, restricted non-superuser login, tenant RLS, transaction rollback, simultaneous commands, coherent reads, reconnect persistence, same-request evidence, exact partial-response attribution, waiting, closure and reopening. Source checks and the review build passed in the same clean runner.

A separate local PostgreSQL WASM exercise passed ten sequential adapter checks and file-backed close/reopen. This does not replace the native concurrency checks. A native PostgreSQL service restart also passed on commit `be01fb183f63f4799fe7521a99afaacd92b898b5`: [restart verification run](https://github.com/aaronchristopher/beyondbatch/actions/runs/41527030152). The test proves a changed server start time, compares all saved request/evidence/history/obligation/outbox/receipt rows, and confirms that replaying the original command makes no duplicate writes. Production backup/restore, abrupt-crash recovery and approved deployment roles remain unverified. The fixture uses narrow identity-column UPDATE grants for PostgreSQL row locking; that is an explicit test policy, not a production access-policy approval.

The store is an internal trusted-server component. The website still uses fictional fixtures; database-backed user projections and Microsoft sign-in are the next integration slice. No production database was provisioned. See [PostgreSQL request contract](Postgres-Requests.md).

## Production work still required

- Real Entra authentication/session handling and current database-backed user/evidence access resolution.
- Approved Microsoft tenant credentials, scoped live incoming/sent reads, shared-mailbox coverage and negative access tests.
- Production PostgreSQL configuration/migration, relational mail-page writer, durable integration jobs and backup/recovery verification.
- Actual inference provider, reviewed live extraction/correlation, attachment isolation, monitored schedules and coverage warnings.
- Click-time source authorization and refreshed message links. Graph's verified web link opens Outlook on the web; the Classic Outlook Windows companion remains unimplemented and untested.
- Authenticated in-app reply draft/send endpoints, separately approved delegated permissions, recipient and attachment validation, explicit human approval, duplicate-send protection and Sent-evidence reconciliation. The ingestion identity remains read-only.
- Representative real-mail evaluation, workload staffing, production deployment and operational acceptance.

No email is sent by this code. The production entry point remains blocked. Demo personas are not production users. The static review is generated from the module source and is explicitly fictional.

## Reproduce checks

From the repository root:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run build:ticketing-review
```

The fast suite uses Node.js 24 built-in SQLite and mocked boundaries. The separate `npm run test:ticketing:postgres` requires an explicit disposable native database; it is not silently skipped when unconfigured. Generated build output, test logs and runtime databases are excluded from Git. See `Production-Readiness.md` for the actual live-pilot go/no-go gates.
