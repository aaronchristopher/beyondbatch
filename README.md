# BeyondBatch

BeyondBatch connects production scheduling, supply readiness, warehouse receiving, quality release and delivery risk.

## Product scope

Four departments work through connected modules in one application:

- Logistics / Buyers: incoming supply, supplier commitments and schedule shortages.
- Warehouse: expected arrivals, receiving, quality handoffs and released outbound goods.
- QA/QC: component and intermediate-lot release, finished-goods release, blockers and expected completion dates.
- Operations: line/shift scheduling, production readiness and production progress.

The production schedule and component overview are two views of the same requirements and allocations. Department queues share those records and expose the impact of delays.

## Documentation

- [Department workflows and quality module](docs/department-workflows-and-quality.md)
- [ADR 0007: Department workflows and lot-level quality](docs/decisions/0007-department-workflows-and-lot-quality.md)

## Project status

Planning documentation only. No application, deployment, executable commands or implemented integrations are included.

The department workflow requirements were requested on October 7, 2026. Detailed state mappings, official release authority and integration contracts require operational review before implementation. Earlier planning proposals are not automatically accepted by this document.

This public repository contains product requirements, not source workbooks, customer records, lot records, supplier messages or credentials.
