# BeyondBatch — Customer Ticketing

Customer task tracking is a module of [BeyondBatch](../../README.md). All implementation belongs in this directory in `aaronchristopher/beyondbatch`.

The goal is a meaningful customer response within **24 elapsed hours**, with one accountable PM, visible assisting departments, linked email evidence and verified completion. Customers and PMs do not need to add ticket IDs to subjects or messages.

**Current state: tested development code using fictional data.** Live Microsoft mail, complete production sign-in, production PostgreSQL wiring and native Classic Outlook launch are not connected. Production startup is deliberately blocked. See [implementation status](docs/Implementation-Status.md) and [release gates](docs/Production-Readiness.md).

**Required live access: approved VPN/SASE public exit address plus exclusive UniWell Entra SAML 2.0 with enforced MFA.** Target domain: `https://beyondbatch.com`. The mandatory request-level IP gate supports direct TLS or a strictly configured dedicated proxy; see [Network Access](docs/Network-Access.md). DNS, VPN and live Microsoft policies are not configured. The SAML protocol/session/backend components are now implemented and tested with genuine signed fictional assertions and local HTTPS. They are not deployed or attached to the customer workspace. Every private-data route still needs current resource permissions. Demo factories and the legacy bearer prototype remain prohibited in production. See [SAML integration](docs/SAML-Integration.md) and [security acceptance](docs/Security-SAML-Access.md).

## Run from the repository root

Node.js 24 or later is required for the built-in SQLite fixture harness. Install the pinned workspace dependencies, including the PostgreSQL driver:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run demo:ticketing
npm run demo:ticketing:durable
npm run fixture:ticketing
npm run build:ticketing-review
```

Run either demo server, not both for the same exercise. The ordinary demo prints its loopback URL; the durable fictional demo runs at `http://127.0.0.1:4174`. Stop it with Ctrl+C. Persona selection is a fixture control, not authentication. Do not expose these development servers publicly or feed them real email. `npm start` inside this module intentionally refuses ordinary production startup.

`npm run build:ticketing-review` generates `dist/review/` within this module, including PM, department and president fictional projections. It builds the review from this module's `public/` UI; there is no independently maintained review implementation. Generated artifacts stay out of Git. The build does not publish or change access.

## Source map

| Directory | Responsibility |
|---|---|
| `src/domain/` | Immutable request events, response obligations, closure and reopening |
| `src/integrations/` | Scoped read-only Graph adapter, extraction contracts, correlation proposals |
| `src/security/` | SAML protocol/session/HTTPS boundaries, current authorization, scoped views and source links; production composition remains pending |
| `src/persistence/` | Normalized PostgreSQL request store, checkpoint adapter and fictional SQLite stores |
| `src/fixtures/` | Durable fictional pipeline and local HTTP demonstrations |
| `public/` | Personal, department and president browser workspace with internal windows |
| `db/` | Proposed PostgreSQL schema; not an applied production database |
| `scripts/` | Source checks and reproducible static review generation |
| `tests/` | Domain, integration-boundary, security, persistence and local HTTP checks |
| `docs/` | Contracts, access plan, production backlog and actual verification limits |

## Implemented behavior

- Evidence-linked 24-hour clocks, partial replies, late evidence, original deadlines and human-verified closure/reopening.
- Customer/department/owner scope applied before dashboard rows and aggregates; private raw email is excluded from summaries.
- Authorized-mailbox Graph reads, metadata delta, immutable IDs, safe cursors, retry handling and checkpoint callbacks. Token acquisition and production callbacks remain to be wired.
- Provider-neutral extraction validation and conservative cross-thread/cross-mailbox proposals. Uncertainty stays reviewable; model output cannot send or close requests.
- Durable fictional ingestion, reviewed request creation and Sent-evidence processing across local SQLite restarts. SQLite is a test/demo harness, not the production database.
- Normalized PostgreSQL request creation, append-only history, exact response evidence, version conflicts, idempotency receipts and atomic outbox writes. This internal store is not yet wired to the website or production identity. Run the separate native integration suite with `npm run test:ticketing:postgres` against an explicitly disposable local database; see [PostgreSQL request persistence](docs/Postgres-Requests.md).
- A request-level president table with the task and original email subject, plus separate request, history, email-trail and reply-composer windows. The trail and composer use explicitly fictional messages. Draft text remains in session memory; no mail is sent or attachment content uploaded. Open in Outlook supports a verified original-message web link when server-loaded source permissions are available. Current fixtures show the disconnected state. Desktop Classic Outlook requires an additional integration; no native launch is claimed. See [reply flow](docs/Outlook-Reply-Flow.md).

## Integration with BeyondBatch

The future application host supplies verified identity, authorized customer/department scope, shared infrastructure and approved integration configuration. Customer ticketing retains its domain logic and request history. Manufacturing planning remains in the root `docs/`; future links to products, orders, CAPS, Sage X3, Monday and RawsRus use explicit integration contracts rather than becoming MVP prerequisites. See [ADR 0008](../../docs/decisions/0008-customer-ticketing-module.md).

Start with [Next Integration Slice](docs/Next-Integration-Slice.md), [Microsoft Admin Setup](docs/Microsoft-Admin-Setup.md), [Data Contracts](docs/Data-Contracts.md) and [Production Readiness](docs/Production-Readiness.md). The dated November 2–6 plan is a target, not evidence of a working production service.

All names, messages, customers and times in fixtures are illustrative. Keep real evidence, access tokens, certificates, tenant details, runtime databases and hosting-account records out of this public repository.
