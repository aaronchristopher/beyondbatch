# AI processing cost admission

November 3, 2026. A provider-neutral database component, not a connected model or running email job. No API key, model charge, live budget setting or production migration is created here.

## Agreed pilot constraint

The initial model-processing budget is USD 25 per UTC calendar month. This is separate from hosting, database/storage, attachment/OCR services and a separately reviewed historical import. All consuming workers must use this admission path; it cannot cap unrelated spending in a provider account.

The caller supplies a verified maximum cost for each attempt, using current approved pricing and bounded input, output/reasoning, tool charges and applicable surcharges. Each retry is separately reserved after reconciling the previous outcome. Do not estimate an average charge and call it a maximum. Pricing is not hardcoded in the ledger. Provider configuration must enforce the token/tool limits on which each reservation depends.

## Durable API

Apply `db/003_ai_budget.sql` after the core schema through the approved migration process. It creates tenant-isolated policy and attempt tables; it creates no roles or external access.

`createPostgresAiBudget({pool, tenantId, monthlyLimitMicros = 25_000_000, clock})` uses integer USD millionths and returns:

| Method | Contract |
|---|---|
| `reserve({attemptKey, fingerprint, maxCostMicros})` | Locks the tenant policy, checks committed and reserved spending, and atomically records the bounded attempt. Replays preserve its original identity and billing month. |
| `markDispatched({attemptKey, fingerprint})` | Only the first committed transition permits a paid call. The caller must enforce `dispatchAllowed === true` and dispatch strictly before the returned `dispatchBefore` UTC deadline. An attempt reserved in an earlier UTC month cannot begin dispatch. |
| `settle({attemptKey, fingerprint, actualCostMicros})` | Records measured usage once; conflicting repeat results are refused. |
| `cancelBeforeDispatch({attemptKey, fingerprint})` | Releases only an attempt that has never been claimed for dispatch. |
| `summary()` | Reports the limit, actual current-month usage, current reservations, prior unresolved holds and remaining admission capacity. |

An immutable attempt key and fingerprint identify the exact billable attempt across months and process restarts. Multiple concurrent workers cannot all spend the same remaining balance. A different configuration cannot silently overwrite an existing stored limit.

## Failure behavior

- Budget exhaustion returns `accepted:false`; the caller must preserve the message/job for visible pending review. Existing response clocks continue. A pending-review UI and scheduler integration remain follow-up work.
- Unknown external outcomes retain the full reservation. There is no timeout that automatically returns money to the budget, and a restarted process cannot dispatch an already claimed attempt again.
- Unresolved reservations from previous months reduce new-month capacity until settled or safely cancelled before dispatch. Changing months or retrying an old key does not remove them.
- An actual cost above the reserved maximum is recorded as an overrun and persistently blocks new admissions and dispatches, including in later months. This detects an incorrect maximum; it cannot undo a provider charge already incurred. Investigation and an explicit administrative recovery procedure are required.
- A database failure or uncertain COMMIT denies dispatch. The caller reconciles the same attempt against the database; it must not infer permission from a lost response.

The ledger and an external provider request cannot be one transaction. A crash after a successful claim but before the request may leave a conservative hold. That tradeoff prevents automatic duplicate spending. The future provider adapter must store request correlation and reconcile uncertain charges before retries.

## Keep analysis lightweight

The integration backlog requires canonical-message deduplication across mailbox copies, processing-version/content-hash reuse, bounded context retrieval and no repeated inference for unchanged hourly reconciliation. Timers, current owner lookups, authorization, database projections and ordinary status rules run in application code. Stronger-model review and attachment extraction each need their own admitted attempt. These optimizations are requirements for the future worker, not claims that it is connected already.

Native PostgreSQL tests cover concurrent admission/dispatch, restart/reconnect persistence, tenant isolation, idempotency conflicts, unknown-outcome holds, UTC rollover, cancellation and overrun blocking. Fast tests cover invalid inputs, dependency failures and uncertain transaction handling. Live cost per message and classification quality still require a representative authorized evaluation set.
