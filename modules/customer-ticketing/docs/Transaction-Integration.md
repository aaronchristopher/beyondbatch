# Credential-independent transaction slice — November 1 continuation

## Implemented and deliberately not wired live

`src/persistence/request-transaction.mjs` runs the existing immutable response reducer inside an injected transactional repository. The sequence is: lock tenant-scoped idempotency key, replay stored receipt (or reject conflicting reuse), lock request/version, reduce validated evidence, persist aggregate plus canonical event and obligations, enqueue a projection-refresh job, persist receipt, commit. No network, model or mail side effect occurs inside the transaction. Same event under a new receipt key cannot generate a second version/job. Caller-owned commands are snapshotted before awaiting.

This is an **application transaction adapter**, not a completed PostgreSQL driver. `tests/helpers/sqlite-harness.mjs` is a real SQLite test database implementation of that contract. Its simplified JSON tables are **not** a replacement for `db/001_core.sql`, do not validate that migration's foreign keys/triggers/RLS, and must not be used for production. The ordinary static fixture web server remains disconnected; the later separate durable fixture route is documented in `Durable-Fixture-Pipeline.md`. No production startup gate is removed.

## Repository contract and security prerequisites

`repository.transaction(callback)` commits before resolving and rolls back all writes on any exception. A connection must remain pinned throughout. It supplies:

- `lockIdempotency(tenantId, scope, key)`: serialize even absent receipt keys. PostgreSQL needs an insert/unique-key protocol or transaction advisory lock; a SELECT of a nonexistent row alone is insufficient.
- `getReceipt(tenantId, scope, key)`: stored `{fingerprint,result}` or absence. Results are scoped and authenticated by storage. Fingerprint includes request ID, expected version and sorted JSON command; changed payload/version under the same key is rejected. Exact retries return their original result, not today's newer projection.
- `lockRequest(tenantId, requestId)`: return `{tenantId,version,request}` or absence; obtain a write lock. The stored request must include the immutable canonical event ledger and all-asks scope snapshots, not reconstruct those snapshots from current obligations.
- `saveRequest(tenantId, requestId, expectedVersion, version, request)`: checked compare-and-swap; exactly one row changes.
- `appendEvent(tenantId, requestId, version, canonicalEvent)`: enforce tenant/event uniqueness and aggregate version uniqueness.
- `replaceObligations(tenantId, requestId, obligations)`: reconcile reducer projection atomically, retaining durable audit/history; no unaudited deletion of production evidence.
- `enqueue(tenantId, job)`: durable unique tenant/dedupe key. Job kind is `refresh_projection`; this is not an email-send job.
- `saveReceipt(tenantId, scope, key, receipt)`: atomically persist the completed result. Expiry/retention and any future pruning require a separately specified replay policy.

Authentication and authorization are prerequisites outside this module: tenant, request scope, human review, evidence and recipient mapping must come from trusted records, never email/model claims. The production mapper must attach authorized actor IDs and evidence IDs, map reducer string IDs to reviewed UUID identities, preserve obligation outcomes/provenance, and satisfy the proposed migration's additional requirements. These are explicit remaining integration gates, not implied implemented features.

## Actual tests

Fresh original baseline: 98/98 pass. New transaction tests use SQLite (`node:sqlite`) and exercise atomic state/event/obligation/outbox/receipt writes, tenant separation, checked versions under queued concurrent calls, conflicting receipt reuse, event collisions, validation failures, write-stage rollback, same-event dedupe, partial Sent coverage, command mutation safety, file close/reopen replay, and abrupt child-process exit before commit followed by recovery. Concurrency tests validate the contract with the harness's serialized writer; they do not establish PostgreSQL multi-connection lock behavior. Rollback tests and abrupt-exit recovery are not a production backup/restore drill.

`src/integrations/correlation.mjs` adds pure conservative review proposals and reviewed Sent response construction. A known link or reply header nominates a candidate; subject similarity cannot merge requests. Unknown customers, conflicting entities, unavailable requests or ambiguous links require review. Sent response coverage is explicitly enumerated from a trusted review; drafts, unverified recipients and unknown/bounced delivery state are rejected. A Sent record does not prove customer receipt. Helpers do not create authenticated reviews, accept merges, ingest mail or reconcile later bounces.

## Next gates

1. Review/apply the PostgreSQL schema in an approved disposable test database; implement concrete mapper/driver with actor/evidence provenance, real parallel-connection lock/isolation tests, migration rollback strategy and backup/restore drill.
2. Approved Entra identity, server sessions, scoped mailbox configuration and positive/negative access tests.
3. Wire approved incoming AND actual Sent ingestion to durable transactions and reviewed correlation. Verify a multi-ask request, partial reply and late-discovered ask end to end with distinct internal accounts.
4. Durable job leases/recovery, operator coverage status and bounce reconciliation; approved provider/data processing only if model extraction is enabled.
5. Authorized projections, browser acceptance and deployment approval. No send permission in initial pilot.
