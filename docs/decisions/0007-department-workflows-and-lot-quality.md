# ADR 0007: Connected departmental workflows and lot-level quality

## Status

Proposed architecture supporting the product scope requested on 2026-10-07.

## Context

A production schedule and a buyer component list explain demand and incoming supply but cannot assign the receiving and quality work needed to make that supply usable. Finished goods also require a separate release workflow before shipping.

Earlier planning package ADRs 0001–0006 remain unpublished proposals. Number 0007 preserves that sequence without implying those proposals were accepted or committed here.

## Decision

Model Logistics / Buyers, Warehouse, QA/QC and Operations as functional modules in one application with shared identities, allocations, evidence and audit history.

QA/QC has component/intermediate and finished-goods work areas. Quality cases and dispositions attach to lot and quantity scope. The product master aggregates cases but does not own a blanket released flag.

Separate task progress, forecast release and actual disposition. Warehouse receipt starts a quality handoff; production completion starts finished-goods quality work. Neither event itself grants release.

Derive departmental urgency from the same scheduled requirements and delivery commitments used by the schedule. Preserve approved quality authority independently of priority.

## Alternatives

- Separate department databases: would duplicate identities and allow conflicting readiness.
- Quality status only on the schedule card: would omit assignments, handoffs and finished-goods release work.
- One released flag per material/product: would incorrectly combine independently held and released lots.
- Automated AI disposition: would remove the required human approval boundary.

## Consequences

Shared records make changes visible across departments and require consistent permissions, event handling and source reconciliation. Different task templates can support RM, PK, WP and FG without duplicating the entire data model.

BeyondBatch initially owns operational workflow records and forecasts. The authoritative source and controls for actual disposition must be agreed before implementation. This ADR defines module and record boundaries, not a QMS replacement or regulatory validation claim.
