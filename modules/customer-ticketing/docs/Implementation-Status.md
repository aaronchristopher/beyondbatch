# Customer Ticketing implementation status — November 2, 2026

Canonical source: `modules/customer-ticketing/` in `aaronchristopher/beyondbatch`. Customer ticketing is a BeyondBatch module. The source import includes the server, domain, adapters, schema, UI, tests and static review builder.

## Verified development behavior

The repository-root test run passed **203 tests**, including the 201 existing checks and two clean-checkout/reproducible-build checks added during the move. Coverage includes 24-hour response obligations, partial Sent coverage, conservative correlation, request/source authorization, Graph read boundaries, transactions, durable fictional jobs, identity/checkpoint contracts and local HTTP routes. These are software tests with mocked services or fictional local databases, not a real-mail evaluation sample. Source syntax checks and the static review build also passed from the repository root.

The source-linked Reply in Outlook action is available in PM request and draft views. Fictional samples show a clear disconnected explanation and never invent a message link. The browser flow was checked before import; no UI layout change is intended by this move. Opening or drafting does not reset a response clock or close a request.

## Production work still required

- Real Entra authentication/session handling and current database-backed user/evidence access resolution.
- Approved Microsoft tenant credentials, scoped live incoming/sent reads, shared-mailbox coverage and negative access tests.
- Applied PostgreSQL migration, relational evidence writer, durable integration jobs and recovery verification.
- Actual inference provider, reviewed live extraction/correlation, attachment isolation, monitored schedules and coverage warnings.
- Click-time source authorization and refreshed message links. Graph's verified web link opens Outlook on the web; the Classic Outlook Windows companion remains unimplemented and untested.
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
