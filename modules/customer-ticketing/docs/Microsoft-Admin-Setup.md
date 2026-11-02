# Microsoft administrator setup and ingestion contract

**Baseline: November 1, 2026. Local implementation; not a live Microsoft connection.**

This guide prepares a concrete approval package. Nothing in this build creates an application registration, changes access, sends mail, creates subscriptions, or obtains credentials. Administrator actions below must be performed only against the approved tenant and named pilot resources. The module has GET operations only; email contents and links are never commands.

## 1. Approvals and identifiers to record

| Item | Required decision / record |
|---|---|
| Tenant | UniWell's actual Entra tenant GUID; verified by the tenant administrator |
| Ingestion identity | Dedicated single-tenant application/client ID and enterprise service-principal object ID; separate from web sign-in |
| Credential | Approved workload federation/managed identity arrangement where supported, or certificate protected in Key Vault; owner and rotation/revocation procedure |
| Mailbox scope | Exact Entra mailbox object GUIDs, purpose, pilot owner, dates and review date; no implicit “everyone” |
| Processing scope | Approved customers, folders, metadata baseline, content lookback, sensitive exclusions and retention |
| Interactive users | Separate SAML 2.0 enterprise app; mandatory MFA/Conditional Access, assignment and application database grants; no shared-user or alternate app login |
| Infrastructure | Approved subscription/region, private evidence store, database, queue, operational ownership and cost limit |
| External inference | Provider, geography, retention/DPA and permitted content approval before any real email reaches a model |

Do not put certificates, client secrets, access tokens or actual customer bodies in source, screenshots, logs or fixtures. The token-provider implementation is a separate production dependency. It must obtain tokens from the approved tenant for `https://graph.microsoft.com/.default`; the reader does not authenticate arbitrary user-supplied tokens or infer the tenant from email domains.

## 1a. Human SAML/MFA configuration — separate from the reader

The November 2 security requirement supersedes earlier OIDC/bearer sign-in proposals. Prepare a separate human SAML enterprise application with fixed HTTPS ACS/entity ID, approved Entra signing certificates, signed AuthnRequests with verification enforced, immutable tenant/object-ID claims and verified signed MFA-method claims. Require assignment plus the application's own active scoped grants. Configure app-scoped Conditional Access with enforced phishing-resistant MFA and reviewed sign-in-frequency/session behavior; report-only testing does not enforce access. No other provider or bearer route may create a Customer Ticketing user session.

Review the exact app, user/group assignments, certificate ownership/rotation, authentication-method enrollment, policy scope and session/revocation tests before applying changes. Any directory-read permission needed for timely account/assignment revocation is a separate minimum-scope approval. Do not alter tenant-wide access or duplicate/broaden the existing reader registration. Workload Graph credentials remain separate from human SAML sessions.

See [Security SAML Access](Security-SAML-Access.md) for the configuration contract, official Microsoft references and mandatory deployed acceptance matrix. No SAML service, MFA policy or private-data deployment is enabled by this setup document.

## 2. Recommended Exchange authorization

Use Exchange Online **Application RBAC**, with `Application Mail.Read` assigned over a reviewed resource scope containing only pilot mailboxes. Register the enterprise service-principal pointer in Exchange and assign the scoped role. Use the enterprise application's service-principal object ID, not the app-registration object ID. Follow Microsoft's documented administrator-role prerequisites. [1]

**Inspect both Exchange and Entra grants.** They are independent and additive. An unscoped Entra application `Mail.Read` grant can defeat the intended Exchange restriction. Do not add broad Entra mail consent merely to make the connector work. `Test-ServicePrincipalAuthorization` checks Exchange RBAC and excludes separately granted Entra permissions. Approval therefore requires both grant inspection and actual positive/negative Graph tests. [1]

The pilot has no `Mail.Send`, `Mail.ReadWrite`, broad directory-read or SharePoint/file permissions. Body reading needs mail-read authority; basic mail metadata permissions are insufficient. App-local drafts need no Outlook write permission. A future send capability requires a separate reviewed principal and approval policy. [2]

Administrator command shapes for a reviewed change ticket, with placeholders intentionally unresolved:

```powershell
New-ServicePrincipal -AppId <APP_CLIENT_ID> -ObjectId <ENTERPRISE_SERVICE_PRINCIPAL_OBJECT_ID> -DisplayName <APPROVED_DISPLAY_NAME>
New-ManagementRoleAssignment -Name <APPROVED_ASSIGNMENT_NAME> -Role 'Application Mail.Read' -App <ENTERPRISE_SERVICE_PRINCIPAL_OBJECT_ID> -CustomResourceScope <REVIEWED_SCOPE_NAME>
Test-ServicePrincipalAuthorization -Identity <ENTERPRISE_SERVICE_PRINCIPAL_OBJECT_ID> -Resource <APPROVED_MAILBOX>
Test-ServicePrincipalAuthorization -Identity <ENTERPRISE_SERVICE_PRINCIPAL_OBJECT_ID> -Resource <EXCLUDED_TEST_MAILBOX>
```

The administrator must create and enumerate the scope first using a reviewed recipient filter or approved administrative-unit method. Do not overwrite an existing mailbox custom attribute, substitute a wildcard scope, or alter a shared production application to satisfy this guide. Maintain two independent controls: server-enforced Exchange scope and the application’s approved mailbox GUID allowlist.

Mailbox RBAC does not restrict a credential to specific customers, folders or messages inside that mailbox. The application applies narrower processing rules, but its underlying mailbox grant remains broad. If this is unacceptable, use a dedicated customer-service mailbox with explicit submissions and disclose missing personal-mailbox conversations.

## 3. Access and coverage checks before real-data use

The administrator should prepare synthetic test messages in approved and explicitly excluded test resources. Record status, request ID and timestamp, never bearer tokens or bodies.

| Check | Required result |
|---|---|
| Direct Graph folder/message read in approved mailbox | Succeeds using ingestion identity |
| Direct Graph equivalent in excluded mailbox | Access denied by Microsoft, not merely blocked by the local allowlist |
| Reader call for excluded GUID | Rejected before token acquisition or HTTP |
| Grant inspection | No overlapping unscoped Entra mail grant or other broader Exchange assignment |
| Application folder policy | Only approved discovered folders enter delta/body processing |
| Incoming / outgoing | Known test inbound and substantive sent response both appear in correct sources |
| Shared Send As / Send on Behalf | Confirm actual Sent Items location for both workflows |
| Revocation drill | New reads fail after revocation propagation; workers stop scope, flag stale coverage and preserve checkpoints |
| Future subscription tests | Allowed-mailbox subscription succeeds; excluded-mailbox creation fails; remove test subscriptions afterward |

Subscription creation is not implemented here and is a separate reviewed setup action. Do not interpret a successful RBAC test command as evidence that subscriptions or complete mail coverage work.

Shared-mailbox responses may be stored only in the delegate sender's personal Sent Items. Either authorize the required sender mailbox or separately approve the Exchange `MessageCopyForSentAsEnabled` / `MessageCopyForSendOnBehalfEnabled` settings. Test both paths; new settings do not backfill history. [3]

## 4. Exact reader API

File: `src/integrations/graph-reader.mjs`; Node 24 ESM, built-ins only.

```javascript
const reader = createGraphReader({
  tenantId: approvedTenantGuid,
  allowedMailboxIds: approvedMailboxGuids,
  getAccessToken: async ({ tenantId, scope }) => approvedTokenProvider(tenantId, scope),
  // fetchImpl and sleep are injectable for tests; production uses fetch and timers.
  maxRetries: 3,
});

const rootFolders = await reader.listFolders(mailboxId);
const children = await reader.listFolders(mailboxId, { parentFolderId });
const discoveredFolders = await reader.listFolderTree(mailboxId);

const result = await reader.readDelta(mailboxId, folderId, {
  cursor: previousDurableDeltaLink, // undefined for approved initial baseline
  onPage: async (metadata, context) => {
    // context: tenantId, mailboxId, folderId, pageNumber
    // Persist idempotent metadata upserts + outbox intents in one transaction.
    await persistPageAndProcessingIntents(metadata, context);
  },
  commitCursor: async finalOpaqueDeltaLink => {
    // Atomic compare-and-swap under the caller's folder lease.
    await commitFinalCheckpoint(finalOpaqueDeltaLink);
  },
});
// result: { deltaLink, pages, messages }

const evidence = await reader.readMessage(mailboxId, immutableMessageId);
```

`listFolderTree` discovers nonhidden folders with bounded traversal (20 levels, 5,000 distinct folders); it marks virtual search folders and does not traverse their children. Discovery does not authorize ingestion. The caller must approve the physical folder list and skip virtual search folders. Folder enumeration excludes hidden folders by default in Graph. [4,5]

`readDelta` is metadata-only: IDs, timestamps, approved participants, subject, state flags and source URL; no bodies, previews or attachment bytes. It follows empty pages, preserves opaque URLs, validates the same mailbox and folder, and calls `commitCursor` only after every awaited page callback succeeds. A failed callback/request leaves final checkpoint advancement to the caller's safe failure path. Callbacks must be durable and idempotent; this module cannot prevent a badly implemented callback from writing prematurely. Hold a per-folder lease and use atomic cursor compare-and-swap. [6]

The initial delta is unfiltered to avoid silently accepting the documented 5,000-message cap on received-date-filtered delta. Old metadata collection therefore needs approval. Fetch eligible bodies separately within the approved content lookback. Persist cursor provenance; cursors are trusted database state, never a public arbitrary URL input. [6]

`readMessage` selects plain-text `body`, `uniqueBody` and internet message headers plus metadata. It requests `outlook.body-content-type="text"`, refuses an HTML body, verifies the returned immutable ID and makes no requests to embedded links. Output remains untrusted and requires sensitive-content screening and evidence authorization before inference or display. [7]

Both methods request immutable IDs. IDs are case-sensitive; same-mailbox moves preserve them, while archive moves/export/reimport can change identity. Store mailbox-copy identity separately from canonical duplicate-message correlation. A delta `@removed` record is passed through as evidence availability, never as task closure. [8]

## 5. Failures, scheduling and the 24-hour promise

The product's response obligation is **24 elapsed hours**, including weekends and DST. This module has no scheduler or live service-level guarantee.

Production wiring must add:

1. A persistent five-minute obligation/checkpoint monitor: recompute due/overdue alerts, inspect per-folder last-success times and queue age, and flag stalled ingestion. It must not re-read every unchanged message or repeatedly call a model.
2. Near-real-time webhook-triggered jobs plus **independent hourly delta repair** for every approved folder. A webhook is a hint; final cursors and durable jobs establish recoverability.
3. A displayed observation watermark and degraded-coverage warning. A due response cannot be confidently called missing if sent-mail observation is stale. Do not pause the underlying 24-hour obligation automatically during outages; separate clock lateness from incomplete observation.
4. Durable retries/DLQ, mailbox concurrency limits, alerts, replay, scoped rebaseline and a named operator. The reader returns no successful result for partial failure.

For 429/503 the reader honors bounded `Retry-After` retries. Hints over 60 seconds, or exhausted attempts, throw `GRAPH_RETRY_DEFERRED` with `retryAfterMs`; the queue must reschedule no earlier than that delay. Missing/invalid hints use bounded exponential delay. Transport failures and other transient errors go back to the durable job policy. 401/403 are not repeatedly retried here. Redirects are never followed. Response size is limited to 2 MiB, request duration to 30 seconds and pagination to 1,000 pages. Limit failures require explicit operational handling, not silent truncation. [9]

410 or `syncStateNotFound` errors produce `GRAPH_RESYNC_REQUIRED`; do not overwrite the good cursor with a failed response or blindly follow its Location header. Record a coverage gap, obtain an approved rebaseline, replay idempotently, and clear the gap only after verified catch-up. Outlook delta-token lifetime is not fixed. [10]

Before subscriptions are introduced, implement tenant/subscription/clientState validation, rapid durable enqueue, renewal based on returned expiry and lifecycle recovery. Normal Outlook subscription lifetime is limited; renew well before expiry. Test missed, removed and reauthorization events plus a deliberately dropped webhook. [11,12]

## 6. Deliberately deferred capabilities and launch blockers

- Attachment fetching, malware quarantine, extraction/OCR, attached-message parsing and link retrieval are **not implemented**. `hasAttachments` is a warning/input to manual review, not proof contents were read. Forwarded text inside a readable body is available but remains secondary evidence.
- Online/in-place archive mailboxes, hidden/recoverable folders, historical deleted mail, PSTs and other tenants are not covered. An ordinary Archive folder within a primary mailbox is different. [13]
- Token acquisition, Entra user sign-in, database checkpoint callbacks, queue scheduler, sensitive routing, model extraction, notifications and production hosting need their own wiring and tests. Mock tests prove local behavior, not tenant authorization or Graph completeness.
- No sending or mailbox writes exist in this reader. Do not request write/send permissions during setup.
- Raw contents and headers must never enter operational logs. Application evidence visibility is narrower than ingestion permission; president reporting must exclude unrelated HR/legal/personal content, including subjects, counts and snippets.

## 7. Verification and official references

Run `node --test tests/graph-reader.test.mjs`. Tests use mock HTTP only: scope rejection, cursor boundaries, redirects, metadata projection, awaited checkpoint order, retries, failure preservation, text-body reads and bounded child discovery. After approval, add separate live smoke tests with synthetic mail and retain safe results.

1. [Exchange Online Application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
2. [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
3. [Shared-mailbox sent-copy behavior](https://learn.microsoft.com/en-us/troubleshoot/exchange/user-and-shared-mailboxes/sent-mail-is-not-saved)
4. [List mail folders](https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders?view=graph-rest-1.0)
5. [List child folders](https://learn.microsoft.com/en-us/graph/api/mailfolder-list-childfolders?view=graph-rest-1.0)
6. [Message delta synchronization](https://learn.microsoft.com/en-us/graph/delta-query-messages)
7. [Get message and plain-text response preference](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0)
8. [Immutable Outlook identifiers](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)
9. [Graph throttling guidance](https://learn.microsoft.com/en-us/graph/throttling)
10. [Delta resets and token lifetime](https://learn.microsoft.com/en-us/graph/delta-query-overview)
11. [Change notifications and subscription lifetime](https://learn.microsoft.com/en-us/graph/change-notifications-overview)
12. [Lifecycle notifications and repair](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events)
13. [Mail API coverage](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0)
