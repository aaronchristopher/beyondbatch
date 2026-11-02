# ADR 0008: Customer ticketing belongs to BeyondBatch

Status: accepted by product owner, November 2, 2026.

## Decision

Maintain customer task/ticket tracking in `modules/customer-ticketing/` inside `aaronchristopher/beyondbatch`. This repository is the canonical source for the module's server code, response-clock domain, Graph and model boundaries, persistence adapters, UI, tests, database schema and review builder.

The module's business goal is to make every customer's unanswered request visible, assign one accountable PM, record assisting departments and preserve evidence until verified resolution. A hidden internal request identity may span multiple email threads. A response is due within 24 elapsed hours; it is not automatically proof of completion.

## Boundaries

The root currently has manufacturing planning documents, not an implemented application shell. The module can run a loopback-only fictional demo for development. That entry point is not the future production shell or a separate product. Root workspace commands exercise the module without duplicated application source.

The future BeyondBatch host supplies verified identity, tenant/customer/department scope, durable storage and approved integration credentials. Domain rules remain module-owned. Cross-module links use explicit stable customer/product/order references; email text is evidence, not an authority to grant access or call tools. Existing manufacturing workflows are not prerequisites for the first email pilot.

Static reviews are generated from this module. An already published review may continue serving its existing artifact until a later authorized publication; its hosting repository is a delivery artifact, not a second development source. This import does not rebind hosting, change access or deploy production.

## Validation and limitations

The imported source retains the response-clock, correlation, authorization, read-only Graph, transaction, fixture-pipeline and Outlook-link tests. The build must reproduce all three fictional review views from a clean checkout. No real credentials, tenant data or customer evidence belong in this public repository.

Live email ingestion, complete sign-in, PostgreSQL integration, provider inference, production jobs and native Outlook launch remain tracked release gates. Relocating code does not complete those integrations.
