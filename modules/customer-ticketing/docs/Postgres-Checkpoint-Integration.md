# PostgreSQL checkpoint repository — November 2, 2026

## What this slice implements

`src/persistence/postgres-checkpoints.mjs` contains parameterized PostgreSQL operations against the existing `bb.sync_folder_checkpoints`, `bb.mailbox_approvals` and `bb.tenants` schema. It accepts an injected `pg`-compatible pool; it does not contain a connection string, install a driver, create a connection by itself or provision any infrastructure.

It provides approved-scope gating, transaction-local tenant context, per-folder leases, row-version/generation fencing, renewal, release, invalid-cursor reset and a transaction seam for persisting a page before its cursor advances. It does **not** implement the email/page writer, PostgreSQL request repository, outbox dispatcher, cursor encryption provider or live Graph coordinator. The existing demo remains a fixture application and is not switched to PostgreSQL by this file.

No PostgreSQL instance or credentials were available. The schema was not applied; these queries were not executed against PostgreSQL. The automated tests use scripted pool/client responses to check bindings, callback order, rollback requests and connection handling. They are contract tests, not PostgreSQL, RLS, lock-contention, crash-recovery or durability tests.

## Why this is the next small adapter, not the full repository

`src/persistence/request-transaction.mjs` already describes an application transaction, but its repository contract differs materially from `db/001_core.sql`:

- The SQLite store persists a whole reducer JSON payload; PostgreSQL requires normalized request, evidence, principal, obligation and event records.
- SQLite `replaceObligations` deletes and recreates the entire ledger. Production mapping must preserve obligation identity, original trigger times, response evidence, withdrawal reasons and history; it cannot use destructive replacement as the adapter strategy.
- `commitRequestEvent` currently saves request state before replacing obligations. The SQL closure trigger is immediate and requires inbound asks fulfilled and recurring updates retired **before** setting resolved. Conversely, reopening must update the closed request before inserting a newly discovered open obligation. The real repository must stage the command and commit normalized changes in the correct dependency order; a mechanical translation of each SQLite method is unsafe.
- Database evidence, actor and customer/mailbox approval foreign keys need actual authorized enrollment records, not fixture IDs or guessed identities.
- The SQLite database write lock does not prove PostgreSQL row locking, row-version CAS, RLS, least-privilege grants or pool context cleanup.
- Reducer statuses/outcomes, requirement versions, safe no-op idempotency receipts and audit sequence mapping still need explicit relational translation. The SQL idempotency table requires a successful result event; a no-op command must identify the existing result event rather than inventing another mutation.

The checkpoint adapter avoids pretending those gaps are solved. It uses the existing schema directly and can be integrated independently after enrollment and migration testing.

## Required constructor and identifiers

```js
const checkpoints = new PostgresCheckpointRepository(approvedPool, {
  entraClientId: approvedWorkerAppClientId,
});
```

The pool contract is `await pool.connect()` returning a client with `query(text, values)` and `release(error?)`. Configure TLS/private connectivity, bounded pool size, connection/query/statement/lock timeouts and the approved non-owning database role outside this module. Use a trusted installed driver only after dependency review. This module deliberately adds no package or secret.

| Input | Exact meaning |
|---|---|
| `tenantId` | Internal `bb.tenants.id`, established by authenticated server/worker context. Not an arbitrary tenant header and not necessarily the Entra tenant UUID. |
| `mailboxId` | Internal `bb.mailbox_approvals.id`. **Not** `graph_user_id` merely because both can look like UUIDs. |
| `graphFolderId` | Exact enrolled `bb.sync_folder_checkpoints.graph_folder_id`, treated as opaque, case-sensitive text. Do not silently substitute `Inbox` aliases for stored Graph folder IDs. |
| `entraClientId` | The configured worker app ID, matched to `mailbox_approvals.entra_client_id` on every operation. |
| `checkpointId` | Internal checkpoint UUID returned from the claim, bound again on subsequent operations. |
| `rowVersion` / `cursorGeneration` | Nonnegative PostgreSQL bigints returned as decimal strings; never convert them through an unsafe JavaScript Number. |
| `ownerToken` | Fresh random token per acquisition, prefixed by a bounded worker label. It is an internal lease token, not an end-user API parameter. |

The production coordinator must separately resolve the approved mapping from internal mailbox ID to Graph `graph_user_id` and validate its tenant/app authorization before token acquisition or network access. This repository does not fetch Graph or substitute that authorization check.

No method inserts a tenant, mailbox approval or checkpoint. A migration/enrollment operator must seed reviewed records and folder identities first. `acquire` returns `null` for a missing, blocked or busy checkpoint; it does not turn an arbitrary folder into an enrolled one.

## Operations

### Acquire

```js
const lease = await checkpoints.acquire({
  tenantId, mailboxId, graphFolderId, workerId: 'ingestion-01', leaseSeconds: 60,
});
```

Lease duration is bounded to 5–300 seconds. The database clock controls expiration; a worker cannot supply its own clock. Only an expired or unclaimed, non-blocked checkpoint can be acquired. Claiming increments `row_version` and generates a fresh owner token, even when the same worker label is reused.

The result includes scope, checkpoint ID, lease token/expiry, row version, generation, encrypted cursor bytes, cursor state and historical coverage metadata. It is an immutable descriptor; ciphertext bytes are copied. Consumers must still treat the Buffer contents as internal sensitive state. Do not log cursor bytes or expose lease objects to the browser.

### Renew

```js
lease = await checkpoints.renew(lease, 90);
```

Renewal requires the exact tenant, mailbox, folder, checkpoint, token, version and generation, with an unexpired lease. It increments `row_version`; use the newly returned lease for the next operation. Calling renew and commitPage concurrently with the same descriptor is deliberately a conflict, not a supported heartbeat shortcut. Serialize checkpoint mutations. Graph/network work happens outside these database transactions; renew before expiry when needed, or let a fenced worker stop and another worker replay safely.

### Commit a page

```js
// Integration sketch. persistAuthorizedPage is NOT implemented by this slice.
// Fetch and validate Graph outside the SQL transaction; encrypt the continuation
// outside it using approved key management before calling this method.
lease = await checkpoints.commitPage(lease, {
  cursorCiphertext: encryptedContinuationBuffer,
  cursorState: 'paging', // or 'current' for a terminal delta cursor
  // For current only: coverageFrom, coverageThrough, fullRecoveryCompleted?
}, async (client, boundScope) => {
  await persistAuthorizedPage(client, boundScope, alreadyFetchedPage);
});
```

The same-transaction callback is mandatory. It receives the already scoped, leased client and a frozen identity/version context. It must write or find durable source records **or** durable processing jobs for every fetched page item on that client. Associated audit/outbox rows use the existing schema and real authorized principal/evidence IDs. Stable per-message/page job dedupe keys make replay safe. All callback SQL must bind the supplied tenant/mailbox/folder; shared transaction context does not make arbitrary SQL safe.

This is trusted server code, never a client-provided function or SQL endpoint. The callback must not begin/commit/rollback a transaction, release the client, change tenant/role settings, call Graph/model/storage services, send notifications or retain the client for later use. Keep it short and bounded. The repository cannot infer whether an empty callback truly persisted all page items. A no-op callback is acceptable only in these isolated contract tests, **never as a production page writer**.

After the callback returns, cursor update repeats all scope/version/generation/token checks and verifies the lease has not expired. If the writer fails, or the lease expires during it, the repository requests rollback and does not acknowledge page completion. Only a successful COMMIT returns the new descriptor. Database rollback/durability remains an integration-test requirement.

`paging` stores a continuation cursor and leaves completed coverage/last-success timestamps unchanged. `current` requires a UTC coverage interval. The repository rejects future, reversed, disjoint, regressed or earlier-than-approved history ranges. PostgreSQL's observation time is the ceiling for coverage. It preserves the earliest verified contiguous start while advancing the end. The coordinator must prove that the whole indicated interval was observed; max email date is not a coverage certificate. A supplied `fullRecoveryCompleted: true` is a trusted coordinator assertion, accepted only with a terminal current cursor; the repository does not infer completion of a backfill.

Only an encrypted Buffer of 1–65,536 bytes is accepted as a cursor. A Buffer is not proof of encryption. The missing encryption provider must produce and verify an authenticated envelope with key version and tenant/mailbox/folder/generation binding. Decryption happens only for the authorized coordinator, never in API projections. Raw Graph URLs, tokens and response bodies must not be stored as error codes.

### Reset and release

```js
const resetState = await checkpoints.reset(lease, 'DELTA_TOKEN_EXPIRED');
// This clears cursor and lease, increments generation/version and sets reset_required.
// Acquire a NEW lease before recovery. Historical coverage is not silently erased.

const releasedState = await checkpoints.release(lease);
// Token and expiry are null. This descriptor is no longer a usable lease.
```

Reset requires a live matching lease. It fences older workers through both generation and version; it does not start a backfill or expand the approved history window. An expired lease can be explicitly released only if its full fence still matches, so a late worker cannot clear a replacement lease. Revoked mailbox access blocks further repository operations; an abandoned lease expires naturally rather than allowing a revoked worker to keep writing.

## SQL/authorization boundary

Every method uses one checked-out connection and this order:

1. `BEGIN`.
2. Parameterized `set_config('app.tenant_id', tenantId, true)` and transaction-local UTC timezone.
3. Require the matching mailbox/app approval and an active/pilot tenant. Lock their rows `FOR SHARE` to prevent concurrent revocation/disable during this short transaction.
4. Acquire or lock the exact checkpoint. Sent requires sent approval; Inbox requires incoming approval; custom/deleted folders conservatively require both directions because they can contain mixed content.
5. Perform the fenced mutation, optional page writer and COMMIT.
6. On failure request ROLLBACK; discard a connection when rollback fails or commit outcome is uncertain. Release the connection in every ordinary completion/error path.

Tenant settings are transaction-local; nothing is interpolated from input into SQL. UUIDs, durations, cursor size, decimal versions and symbolic error codes are validated before connecting. Parameter binding protects opaque folder strings. All updates include explicit tenant/mailbox/folder bounds as well as the schema's RLS policies. Full lease mutations additionally include checkpoint ID, token, row version and cursor generation.

This is still not the authentication boundary. Only an authorized integration service may use this repository. PostgreSQL credentials must be non-owning, non-superuser and `NOBYPASSRLS`; database privileges and row-level policies must be tested using that actual role. The module does not create grants, modify mailbox permissions or grant access because an input UUID is syntactically valid.

## Current Graph-reader integration gap

`graph-reader.readDelta` currently validates each continuation URL, then invokes:

```text
onPage(records, { tenantId, mailboxId, folderId, pageNumber })
commitCursor(finalDeltaLink)
```

The page callback does not receive the validated nextLink/deltaLink. Consequently the new repository is **not wired into that API**. Splitting page persistence and the final cursor callback can support safe replay when page persistence really is durable, but it does not supply this adapter's atomic per-page continuation contract.

The smallest next integration change is for a coordinator/reader interface to deliver each page with its already validated continuation URL and continuation kind. The coordinator encrypts it and calls `commitPage` with the actual relational page writer. It must preserve the latest returned lease after every page, renew during long fetch sequences and map internal mailbox IDs to the approved Graph IDs. Avoid buffering an entire mailbox or pretending the final cursor callback alone proves prior pages were persisted.

## Error and recovery behavior

| Result/code | Coordinator behavior |
|---|---|
| `null` from acquire | No lease obtained. Do not fetch this folder as its owner. Retry with bounded scheduling, not a tight loop. |
| `SCOPE_NOT_APPROVED` / `FOLDER_NOT_APPROVED` | Stop the operation. Surface a permission/configuration issue to the authorized operator; never auto-expand scope. |
| `LEASE_LOST` | Discard this in-flight lease/cursor result. Do not continue writing. A new owner may replay the page. |
| `SCOPE_MISMATCH` / `INVALID_DB_RESULT` | Fail closed and investigate driver/schema/mapping error. |
| `HISTORY_NOT_APPROVED` / `COVERAGE_GAP` / `FUTURE_COVERAGE` | Do not advance the cursor. Correct the coordinator's coverage/recovery plan. |
| `COMMIT_OUTCOME_UNKNOWN` | The commit may have succeeded. Discard the connection and do not blindly execute the page again as though it rolled back. Reconcile the durable checkpoint/dedupe records through an approved recovery flow; after lease expiry a new owner can safely replay with idempotent item/job keys. |
| Other SQL/transport error | This module requests rollback and propagates the error. The service maps it to bounded internal diagnostics; never expose SQL values, credentials or Graph cursors to clients. |

There is no automatic retry loop in this repository. Retry policy belongs in the worker and must distinguish uncertain commits, authorization failures, lease conflicts and retriable database faults. Connection/statement/lock deadlines are required pool/database configuration; the module cannot enforce an uncooperative driver's timeout behavior.

## Validation performed and remaining gates

The targeted test command is:

```sh
node --test tests/postgres-checkpoints.test.mjs
```

Nineteen contract tests passed when this slice was implemented. They cover bound tenant/app/mailbox predicates, fresh lease tokens, bigint-safe versions, denied approval, direction restrictions, missing/busy checkpoints, stale/expired fences, same-client callback ordering, callback failure, expiration after the writer, encrypted-buffer snapshotting, terminal-only coverage, coverage bounds, cursor reset, release, scope mismatch, uncertain commits, failed rollback/discard and invalid input before connection acquisition.

Before claiming live persistence, run a disposable PostgreSQL integration suite that applies the actual migration and seeds authorized test identities. Test real simultaneous claims, expiry while a transaction waits, revocation during a page commit, pool reuse across tenants, wrong-tenant FKs/RLS, lease generation fencing, writer rollback, unique/dedup conflicts, process/network loss before and after COMMIT and restart recovery. Verify no plaintext cursor reaches logs or database fields. Test the complete page writer and Graph coordinator against an explicitly approved pilot mailbox only after access is granted.

The production schema, request-clock relational adapter, email writer and durable job runner remain separate launch gates. No hosting, database or Microsoft permissions were changed by this implementation.
