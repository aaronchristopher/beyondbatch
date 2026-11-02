# Durable fixture pipeline — executable local demonstration

Run `npm run fixture:e2e`. It creates an isolated SQLite file under the system temporary directory, prints its location and outputs an operational waiting list. All names and evidence are fictional. The scenario imports a two-part inbound ask, records an explicit fixture-human review, closes/reopens the database, processes the durable job, imports actual-Sent-shaped evidence answering only availability, and leaves certification overdue on its original deadline. Answered availability remains open for recurring progress; response is not resolution.

## What now works locally

- Atomic page/evidence/checkpoint persistence. Exact replay is a no-op, changed page IDs/payloads or stale expected checkpoints fail. Immutable mailbox copies retain mailbox/folder provenance; changed evidence requires an explicit new version instead of silent overwrite.
- Unreviewed mail is retained in a pending-review queue, not published as an accepted client request. A reviewed source can create multiple distinct requests.
- Accepted reviews and their durable jobs commit together. Reviews bind tenant, evidence copy, reviewer and chosen requests/coverage. Review IDs cannot be repurposed.
- A local SQLite job queue supports deduplication, leases, expiry/reclaim, fencing tokens, retry delay, bounded attempts and dead letters. No network dispatch or scheduler is implied.
- Worker execution writes accepted requests and metadata atomically; observed Sent-shaped evidence runs through the existing reviewed coverage helper and atomic request-event adapter. Lost acknowledgments safely replay rather than duplicate.
- Persistent metadata and aggregate state feed the existing server-side scope/projector functions. `workspace` distinguishes recurring response obligations; `waitingOnFirstAnswer` filters specifically for unanswered inbound obligations. It does not clear other portions when one gets answered.
- Fixtures retain SQL state across process/database reopen. Tests also exercise transaction rollback and abrupt pre-commit process termination in the underlying adapter.

## Local harness boundaries

`FixturePipeline` is **not an HTTP API or authentication system**. Caller-supplied principals and reviewer identities are fictional trusted test inputs only. Do not expose it to real clients or connect tenant mail. Run `npm run demo:durable` and open `http://127.0.0.1:4174` for the read-only existing browser interface backed by persisted fictional requests. Its persona selector is explicitly not sign-in. The ordinary `npm run demo` remains the original static fixture preview.

`SqliteFixtureStore` moved from the tests helper to a clearly named source fixture adapter so the executable demonstration can use it; tests retain a compatibility re-export. It still uses simplified JSON tables, not the production PostgreSQL migration. This is not a production storage architecture change.

`runNext` calls are serialized within a pipeline instance. While an asynchronous worker owns the shared SQLite connection, public writes and operational projection reads reject with an explicit busy/retry error; callers must wait for the worker promise. This avoids nested transactions and exposing uncommitted aggregate projections. Low-level store/queue handles are for harness tests, not a public concurrent API.

Time is explicitly supplied and simulated. Worker completion uses the passed timestamp; these tests establish token fencing in the queue, **not** wall-clock lease renewal/heartbeat for a long-running production worker. No recurring live scheduler runs. The generic event adapter's projection outbox remains durable but is not dispatched to Service Bus; projections here read persisted authoritative state directly.

No synthetic source is represented as real mail. No live Graph, model provider, token, customer message, tenant setting, production database or deployment was touched. Actual production startup still refuses.

## Remaining work versus approval gates

Can continue without live access: add operator review/dead-letter displays, test richer review/revision scenarios, refine SQL mapper contracts and local acceptance coverage.

Requires the actual approved environment/access before verification: Entra app/server-session configuration; authorized mailbox list and owner mappings; actual incoming/Sent positive/negative scope tests; approved PostgreSQL test service and migration/restore review; approved provider/data handling if model extraction is enabled; hosting/deployment permission and real-account browser acceptance. These are distinct from the local jobs/persistence now implemented.

## Persisted browser route verification

The durable browser entry stores `.fixture-data/requests.sqlite` in its working directory and idempotently reuses original evidence timestamps on restart. It binds loopback only. Both missing `--demo` and `NODE_ENV=production` refuse startup. All HTTP routes remain GET-only with host/origin/cross-site protections; fixed server demo principals alone select scope. The PM API shows only certification unanswered; the president API additionally sees the other PM’s order certificate.

Actual same-process local HTTP integration checks passed for the real persisted pipeline and browser assets. Visual browser verification was attempted but did **not** run: isolated local Chromium failed its socket permission check; a single escalation failed at sandbox startup (`bwrap` read-only session directory). No retry against that denied path, no browser pass and no screenshot claim. The screenshot/interactive-browser gate remains open for an environment with a working isolated browser. A separate-shell curl check returned no response in this execution environment; it is not counted as a pass.
