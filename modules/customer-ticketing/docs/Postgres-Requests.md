# Persisted request lifecycle — B1

`src/persistence/postgres-request-store.mjs` implements the existing request transaction contract against `db/001_core.sql`. The injected pool uses the pinned `pg` driver. This is a server-side persistence component, not a public API, sign-in implementation or live email connector.

## What is saved together

One committed transaction saves the request projection, immutable audit event, response obligations, projection-refresh outbox entry and idempotency result. Any failed evidence check, version conflict, constraint or closure trigger rolls the transaction back. No model or Microsoft call occurs inside the transaction.

Creation requires an enrolled active tenant, trusted active actor, approved customer, an active human owner (or explicit unassigned review) and an existing operational incoming email classified as a request. Source-message enrollment and customer/request classification are trusted upstream responsibilities; this adapter does not establish those facts by inference.

The initial audit event holds the immutable request origin at version 0. Later canonical lifecycle events occupy successive aggregate versions. Reads reconstruct the domain state from that ledger rather than trusting a saved status or deadline. Materialized obligations retain their UUID, logical trigger key, original opening time and original deadline. They are updated in place, never deleted and recreated.

Each obligation records the exact event that fulfilled or withdrew it. Two partial replies at the same timestamp therefore retain distinct evidence. Recurring obligations reference the last obligation created in source-time replay order; this link records lineage and does not determine the deadline. Every new obligation still uses exactly 24 elapsed hours.

## Trusted server API

```js
import pg from 'pg';
import { PostgresRequestStore } from '../src/persistence/postgres-request-store.mjs';
import { commitRequestEvent } from '../src/persistence/request-transaction.mjs';

// Configuration and identities come from approved server configuration/session
// resolution. Never accept connection settings, actor or tenant from the browser.
const pool = new pg.Pool(approvedDatabaseConfiguration);
const store = new PostgresRequestStore(pool, {
  actorId: verifiedWorkerPrincipalId,
  actorKind: 'worker',
});

const created = await store.createRequest({
  tenantId: authorizedTenantId,
  idempotencyKey: stableCreationKey,
  input: {
    id: requestUuid,
    customerId: reviewedCustomerUuid,
    subject: reviewedSpecificRequest,
    ownerId: reviewedOwnerUuid, // null retains assignment review and its clock
    receivedAt: verifiedIncomingTimestamp,
    evidenceId: newEvidenceUuid,
  },
  evidence: { canonicalEmailId: storedIncomingEmailUuid },
});

const updated = await commitRequestEvent(store, {
  tenantId: authorizedTenantId,
  requestId: created.request.id,
  expectedVersion: created.version,
  idempotencyKey: stableCommandKey,
  event: verifiedDomainEvent,
});
const loaded = await store.read(authorizedTenantId, created.request.id);
```

Creation/read return `{tenantId, version, request}` (read returns `null` when absent). Event commits retain the existing `{version, request}` application contract. Domain IDs and evidence IDs must be UUIDs; idempotency keys and obligation trigger keys are opaque strings.

Evidence for lifecycle events must already exist for the same tenant and request. The adapter validates every evidence reference, including recipient and closure evidence in the JSON event. Meaningful Sent fulfillment also passes the database's outgoing-message/evidence/time checks. Human pause/closure commands require a store bound to the same active human actor; worker/model assertions cannot impersonate that human. Source-body access, recipient authorization and user-level customer/department authorization still belong to the future authenticated application boundary.

## Concurrency and closure

- A transaction-scoped advisory lock serializes attempts using the same idempotency key. Exact retries return the saved result; conflicting reuse fails.
- A row lock and expected version serialize updates to one request. A stale writer fails instead of overwriting another worker's history.
- An already recorded event under a new receipt key produces no new event, version or outbox job. Its receipt refers to the existing audit event.
- Closure retires eligible recurring obligations before updating the parent to resolved. The database also requires confirmed closure evidence and no unfinished dependencies.
- Reopening, or late evidence invalidating a closure, clears the parent closure before inserting reopened obligations. Prior closure evidence and audit events remain intact.
- Tenant context and timezone are transaction-local. Failed rollback or uncertain commit causes the connection to be discarded; uncertain mutations are not automatically retried.

## Verification

The native integration suite is separate from the fast unit tests. It **fails** when its explicit test database is absent rather than reporting a skip as success.

```sh
npm ci --ignore-scripts
npm test
npm run check
# Supply a local, disposable PostgreSQL database through this environment variable:
TICKETING_TEST_DATABASE_URL='postgresql://postgres:fictional-test-only@127.0.0.1:5432/beyondbatch_ticketing_test' npm run test:ticketing:postgres
```

The suite accepts only loopback databases named `beyondbatch_ticketing_test` or that prefix plus a safe suffix. It refuses an existing `bb` schema. It applies the migration, creates a temporary restricted LOGIN role, seeds fictional records, runs operations using that role and removes its test schema/role afterward. Never point it at a live database. The CI workflow provides a disposable PostgreSQL 16 service with no deployment credentials.

Local PostgreSQL WASM checks can validate schema, sequential transactions, RLS and clean-close persistence; they are not evidence of native connection-pool behavior, concurrent row locks, server-crash recovery or production restore. Native CI results and exact limitations are recorded in `Implementation-Status.md`. The CI workflow also runs `tests/helpers/postgres-restart.mjs prepare`, restarts its disposable database service, then runs `verify` and `cleanup`. Verification checks the database server start time, the complete saved records and duplicate-safe retry. Its temporary fixture credential is stored only in the ignored `.fixture-data` directory with mode 0600 and deleted by cleanup. This is a graceful service-restart check, not a backup/restore or abrupt-crash test.

## Deliberately incomplete integration

B1 supports the existing lifecycle reducer at requirements version 1. It fails closed on unsupported requirement versions. Reassignment, department handoff commands, changed-requirement acceptance and a transactional incoming/Sent page writer are subsequent work. The database contains fields for them, but this adapter does not claim to implement those workflows.

New human pause/closure decisions cannot be backdated before the latest recorded evidence event. Use the current server-authorized decision time. Delayed incoming/Sent evidence still replays by source time; an existing obligation is never silently erased. A future retrospective correction workflow must explicitly preserve and invalidate affected history.

The existing website still uses fictional fixtures. Its API is not switched to this store and its persona switch is not sign-in. Database-backed authorized projections, Entra sessions, live Graph enrollment, job dispatch/recovery, model evaluation, backups and production hosting remain release gates. No mailbox access, API key, deployed database or sending permission is created by this slice.
