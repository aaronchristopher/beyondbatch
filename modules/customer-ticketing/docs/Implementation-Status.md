# Customer Ticketing implementation status — November 2, 2026

Canonical source: `modules/customer-ticketing/` in `aaronchristopher/beyondbatch`. Customer ticketing is a BeyondBatch module. The source import includes the server, domain, adapters, schema, UI, tests and static review builder.

## Verified development behavior

The repository-root test run passed **323 tests**, including genuine signed SAML, composed HTTPS login/session/logout, authorization/eligibility, six production guards, request workflow and clean-checkout/reproducible-build checks. Source checks passed for 60 JavaScript files and the static review build passed after a clean scripts-disabled install. These are software tests using fictional identities and local or mocked services, not actual tenant sign-in or real-mail evaluation.

The president table shows one row per request with its task and original email subject. Separate movable windows show fictional email threads and a reply composer; email bodies remain outside summary projections. In-app Reply is the primary planned workflow, with Open in Outlook as a secondary action. Drafts and attachment name/size previews stay in session memory, sending remains disabled, and no Microsoft message links are invented. Opening or drafting does not reset a response clock or close a request. Automated checks and a source review passed; browser interaction QA for this UI revision remains unverified because the managed preview browser route refused its connection.

## PostgreSQL request persistence — B1

The normalized request store now creates and reloads requests, preserves immutable event history, and commits evidence-linked obligations, outbox jobs and idempotency receipts atomically. Partial replies retain the exact message that answered each ask; late incoming evidence can invalidate closure while retaining original deadlines. Requirements version 1 is supported. New human decisions cannot be backdated before already accepted lifecycle evidence.

A native PostgreSQL **16.15** CI service passed **20 integration scenarios** (21 test-runner results including the parent suite) on commit `efe22dc7039e495de594fe85a3edcf27a84a92f3`: [verification run](https://github.com/aaronchristopher/beyondbatch/actions/runs/41526511433). These verify the migration, restricted non-superuser login, tenant RLS, transaction rollback, simultaneous commands, coherent reads, reconnect persistence, same-request evidence, exact partial-response attribution, waiting, closure and reopening. Source checks and the review build passed in the same clean runner.

A separate local PostgreSQL WASM exercise passed ten sequential adapter checks and file-backed close/reopen. This does not replace the native concurrency checks. A native PostgreSQL service restart also passed on commit `be01fb183f63f4799fe7521a99afaacd92b898b5`: [restart verification run](https://github.com/aaronchristopher/beyondbatch/actions/runs/41527030152). The test proves a changed server start time, compares all saved request/evidence/history/obligation/outbox/receipt rows, and confirms that replaying the original command makes no duplicate writes. Production backup/restore, abrupt-crash recovery and approved deployment roles remain unverified. The fixture uses narrow identity-column UPDATE grants for PostgreSQL row locking; that is an explicit test policy, not a production access-policy approval.

The store is an internal trusted-server component. The website still uses fictional fixtures; database-backed user projections and Microsoft sign-in are the next integration slice. No production database was provisioned. See [PostgreSQL request contract](Postgres-Requests.md).

## Exclusive SAML/MFA decision and immediate hardening

Human production access now requires UniWell Entra SAML 2.0 with enforced MFA; the earlier OIDC/delegated-bearer proposal is superseded. The exported demo-server factory, request/response paths and legacy token-resolver construction/resolution reject production use. Four new tests failed before the fixes and pass afterward; two more prove that in-flight provider/identity results cannot escape after an environment change. The focused security suites passed 35 tests. These environment guards prevent accidental reuse and do not implement authentication. Production packaging must exclude both demo and legacy login modules.

The [SAML security contract](Security-SAML-Access.md) remains the release requirement. No live MFA policy, tenant change or deployment was made by those guards.

## SAML protocol, session and authorization source — B3 components

The new backend components validate signed AuthnRequests/responses/assertions, require signed MFA evidence and immutable identity, reject XML ambiguity/replay, persist shared session/correlation state, reload current grants and eligibility, enforce CSRF/logout and session deadlines, and provide an HTTPS-only authentication handler. The existing customer UI is not yet attached to this handler. See [SAML Integration](SAML-Integration.md) for exact contracts, limits and composition.

The 100 additional fast tests include 23 genuine-signature protocol tests, 21 HTTP-boundary tests, 18 session tests, 26 principal/loader tests, eight auth-store tests and four composed signed-SAML HTTPS flows. Review identified cookie-contract drift, cross-site prior-session rotation and missing denial-audit coverage; these were fixed and regression-tested. Two independent reviews report no remaining blocker in this source slice.

`npm audit --json` reported zero known vulnerabilities in the installed lockfile; `npm audit signatures` verified 32 registry signatures and one attestation. These are supply-chain/advisory checks, not a penetration test or proof of no vulnerabilities. Exact dependencies and npm version are pinned and installation scripts are disabled. Test signing certificates/keys are generated temporarily and never committed. Production debug logging that could expose SAML-derived content is refused.

The new native PostgreSQL suites contain 15 auth-store scenarios and four principal-loader scenarios in addition to the existing 20 request-store scenarios. They require the explicitly disposable CI service; local scripted/memory tests are not database acceptance. Actual native results belong to the source commit's CI checks. Production roles, directory eligibility synchronization, durable audit sink, key custody, tenant MFA enforcement and real-browser/deployed acceptance remain open.

## Production work still required

- Compose the implemented SAML/session components into the approved production host and authorized workspace; configure actual Entra MFA, directory eligibility and audit persistence; verify real-browser/direct-route/resource-denial behavior.
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

The fast suite uses Node.js 24, OpenSSL for ephemeral fictional test certificates, local HTTPS, built-in SQLite and bounded test doubles. The separate `npm run test:ticketing:postgres` requires an explicit disposable native database; it is not silently skipped when unconfigured. Generated build output, signing material, test logs and runtime databases are excluded from Git. See `Production-Readiness.md` for the actual live-pilot go/no-go gates.
