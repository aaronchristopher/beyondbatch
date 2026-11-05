# BeyondBatch: Project Management and Supply Chain

Date: November 5, 2026.
Status: implementation direction and ordered backlog; Supply Chain is not yet implemented or connected to live orders.

## Outcome

Build two primary workspaces in the existing BeyondBatch application:

| Workspace | Daily question | First useful experience |
|---|---|---|
| Project Management | What does each customer need, who owes the next action, and when must we respond? | My Tasks, customer requests, department dependencies, email evidence and the 24-hour response clock |
| Supply Chain | What must we buy, what is on order, and what is preventing availability? | A raw-material checklist and ETAs for each production run, plus packaging order tracking, buyer actions, partial receipts and quality blockers |

The president receives a combined operational view of customer impact, overdue answers and supply blockers. The two workspaces are navigation over connected business records. They preserve the existing Buyer, Warehouse, QA/QC and Operations workflows and the spreadsheet/shift schedule described in `docs/`.

## Existing foundation

`modules/customer-ticketing/` has tested request persistence, response-clock logic, fictional UI/email trails and SAML/MFA/network-access components. Production workspace wiring, actual authentication configuration, live email and evaluated inference remain incomplete. Its current [implementation status](../modules/customer-ticketing/docs/Implementation-Status.md) and [task list](../modules/customer-ticketing/tasks/todo.md) remain authoritative; this plan does not reset or duplicate those checklists.

Supply Chain belongs in `modules/supply-chain/` within this repository. No separate application repository, login or public purchasing API is planned. Move common infrastructure only when both implemented modules actually require it, preserving module-specific business and access rules.

## Minimum connected product

### Project Management

Keep one row per customer request: customer, specific task/original subject, accountable PM, waiting department/person, next response deadline, next action and evidence freshness. Opening a row shows its existing history and authorized email trail in a workspace window. Internal IDs stay out of ordinary PM/customer workflows.

### Supply Chain

Open **Raw Materials** from a scheduled production run. Show the FG, WO/run, planned quantity, applicable BOM revision and material need-by time. Build the checklist from all raw requirements for that operation. A raw stays visible when it is already covered, when no PO exists, and when a supplier has yet to confirm a date.

Each row shows the RM code/name, quantity required for the run, eligible quantity available to that run, shortage and unit, plus expected dock arrival date(s) and quantities for its allocated incoming supply. A buyer can open the supporting supplier PO lines, latest dated evidence and prior commitments. For split deliveries, show when enough is expected to arrive to cover the balance. If only part has a confirmed date, show the known installment and mark the remaining quantity's ETA unknown. Show received stock awaiting QA separately. Compare expected usable dates against the operation's need-by time when release timing is known.

The Raw Materials agent monitors approved supplier correspondence for PO-line delivery updates. Match the supplier, item, PO line and installment, distinguish shipping from arrival, and preserve the source and date of each update. A reviewed change updates every run relying on that delivery according to its allocated quantity. Ambiguous matches require buyer review. The run checklist exists independently of email.

Use one purchasing-line model to support the raw checklist and packaging order register. Each purchasing line shows component code/description/revision, supplier, supplier PO and line, buyer, ordered/received/remaining quantity and unit, requested and confirmed dates, next delivery, quality status, affected demand and next action. Open the line in a window with its deliveries, promise history, receipts, documents and linked PM requests.

Raw-material prerequisites include applicable material specification and supplier approval. Packaging prerequisites include the exact approved specification/artwork revision and pack configuration. Required approvals are verified evidence, not inferred from an email saying “looks good.”

Add internal purchase requests after order tracking works: proposed item, quantity, unit, available-by date, justification, required approvals and evidence. Approved demand/inventory/BOM inputs can later generate purchase suggestions. Missing inputs remain unknown; no model invents shortages, lead times or order quantities.

### The connection

A supply dependency links a customer request to a component requirement and, when matched, specific supplier PO lines, delivery quantities or lots. One line may affect several requests. One request may depend on several lines. Preserve those links instead of copying purchase orders into task records.

**Illustrative only:** a PM owes a production-date answer. Packaging cartons are delayed. Purchasing records a revised supplier commitment on the linked line; the dependency and PM next action update. The PM's response clock continues until evidence of a meaningful customer update is recorded. Partial carton receipt does not close the full requirement; pending quality does not make it usable.

## Source and authority boundaries

| Record | Initial authority / integration plan |
|---|---|
| Customer tasks, owners, handoffs, internal purchase requests | BeyondBatch, with evidence and revision history |
| Official purchase orders, inventory and ERP posting | Existing designated ERP records; begin with reviewed imports, not assumed Sage X3 API access |
| Supplier/material sourcing and price offers | Reuse RawsRus records through a future verified contract; no duplicate material/supplier master |
| Formula, specification and artwork revisions | Link verified CAPS/designated document-control records; no inferred approval |
| Quality disposition | Designated official quality authority, scoped to lot and quantity |
| Supplier email dates | Evidence-backed proposed or reviewed commitments, with source and confidence; no automatic customer promise |

In-app purchase requests are not official supplier POs. Later PO creation, changes, cancellation, supplier outreach and spend approvals require explicit authorized actions and separately approved integrations. This plan sends nothing and creates no financial commitments.

## Required data relationships and rules

The first register needs component references, supplier references, supplier PO headers/lines, delivery installments, versioned commitments, receipts, disposition references, buyer actions and immutable audit/evidence links. Link those to existing customer requests through explicit supply dependencies. Stable external IDs and source versions accompany imports; descriptions alone do not establish identity.

An applicable receipt creates or links an owned Warehouse-to-QA handoff, with requested, acknowledged and completed timestamps. Retries must not create duplicate quality work. Until full quality queues are implemented, the register must link to the designated quality case and responsible owner; “quality pending” alone is insufficient.

Keep ordered, supplier-confirmed, shipped, received, ERP-posted, quality-released and allocated quantities separate. Support partial deliveries, returns, cancellations and corrections without deleting history. Units and conversions must be explicit; packaging revisions and BOM/WO revisions must match the consuming requirement. Never allocate one quantity twice or re-explode raw demand already consumed into a WP lot. Missing or stale input is unverified, not green.

Priority starts with missed customer obligations, known shortages and latest safe arrival/release dates. Show the affected quantity, customer/run, responsible actor, evidence and explanation. Do not invent monetary business impact or rank employees by blame.

## Delivery order

1. Finish the existing saved, authenticated PM workspace (B2–B4), maintaining SAML/MFA, approved-network and per-resource authorization.
2. Build one fictional production run with a complete raw checklist and per-raw ETAs, backed by its material requirements, stock and purchasing lines. Include the packaging order register, persistence and a reviewed import path.
3. Link a delayed purchasing line to a customer request and show buyer action, PM response obligation and president impact together.
4. Add reviewed incoming/sent email updates and customer task classification; bring supplier updates in through explicit authorized mailbox coverage.
5. Add internal purchase-request drafting and, after inventory/BOM/allocation validation, evidenced suggestions for what and when to buy.
6. Enable authorized official ordering only after authority, recipient, duplicate-prevention and reconciliation controls pass acceptance.

The implementation tasks are in [todo.md](todo.md). Each slice has its own proof; a deadline does not establish readiness. The first release focuses on visible work and reliable order status before purchasing automation.

## Inputs needed at their implementation boundary

Confirm one representative production run, its work-order material requirements or applicable BOM revision and planned quantity, stock/allocation status and corresponding raw-material and packaging open-PO lines. Verify units, external IDs, date meanings and snapshot times. Confirm buyer ownership, official approval/release authorities and which system issues POs before enabling commercial writes. Use existing authorized exports when available; direct connectors are optional until verified. No private operational data or deployment settings belong in this public repository.

Actual domain/hosting, directory eligibility, durable audit and deployed VPN/SAML acceptance remain the existing security release gates. New supply-chain permissions must be defined explicitly; a PM or president role does not silently acquire purchasing or quality-release authority.
