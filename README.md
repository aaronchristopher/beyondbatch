# BeyondBatch

BeyondBatch connects production scheduling, supply readiness, warehouse receiving, quality release, delivery risk and customer requests.

## Product scope

The immediate build has two primary workspaces: **Project Management** (customer requests, accountable owners and response deadlines) and **Supply Chain** (raw-material and packaging purchasing work). They share explicit dependency links so a supplier delay exposes its customer impact. The [connected-workspaces plan](tasks/plan.md), [execution index](tasks/todo.md) and [business glossary](GLOSSARY.md) describe this direction. Supply Chain is planned, not an implemented live ordering system.

Four departments work through connected modules in one application:

- Logistics / Buyers: incoming supply, supplier commitments and schedule shortages.
- Warehouse: expected arrivals, receiving, quality handoffs and released outbound goods.
- QA/QC: component and intermediate-lot release, finished-goods release, blockers and expected completion dates.
- Operations: line/shift scheduling, production readiness and production progress.

The production schedule and component overview are two views of the same requirements and allocations. Department queues share those records and expose the impact of delays.

## Documentation

- [Operations scheduler and run estimates](docs/operations-scheduler-and-run-estimates.md)
- [Department workflows and quality module](docs/department-workflows-and-quality.md)
- [ADR 0007: Department workflows and lot-level quality](docs/decisions/0007-department-workflows-and-lot-quality.md)

## Customer ticketing module

The [Customer Ticketing module](modules/customer-ticketing/README.md) turns customer email evidence into accountable requests, department dependencies and a president's view of what customers are waiting on. Its core goal is a meaningful customer response within 24 elapsed hours. Internal request IDs stay out of ordinary customer/PM workflows.

All implementation for this module belongs in `modules/customer-ticketing/` in this repository. It is part of BeyondBatch, not a separate product or source repository. Existing manufacturing planning documents remain in `docs/`.

Requires Node.js 24 or later. Install the pinned workspace dependencies, including the PostgreSQL driver:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run demo:ticketing
npm run build:ticketing-review
```

The demo uses fictional data and prints a loopback URL. The review build generates `modules/customer-ticketing/dist/review/` from the same UI source. Neither connects Microsoft email or sends messages. Demo persona selection is not authentication.

## Project status

Customer ticketing has tested development code and a fictional review interface. Production authentication, live Microsoft ingestion, PostgreSQL wiring and native Outlook opening remain incomplete. Production startup is deliberately blocked. See the module's [implementation status](modules/customer-ticketing/docs/Implementation-Status.md) and [readiness gates](modules/customer-ticketing/docs/Production-Readiness.md).

The department workflow requirements were requested on October 7, 2026. Detailed state mappings, official release authority and integration contracts require operational review before implementation. Earlier planning proposals are not automatically accepted by this document.

This public repository contains product requirements, application source and fictional test data. It does not contain source workbooks, customer mail, customer records, lot records, supplier messages or credentials.

