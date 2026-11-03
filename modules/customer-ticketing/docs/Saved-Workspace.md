# Saved workspace integration

November 3, 2026. Development integration; no live deployment, mailbox permission or model connection is created by these components.

## Read saved requests

`createPostgresWorkspaceRepository({pool, dbTenantId, clock, maxRequests})` exposes:

- `workspace(principal)`: the existing workspace response shape, backed by saved operational requests.
- `request(principal, requestId)`: one projected request with version, bounded operational history and active dependencies; `null` for both missing and out-of-scope records.

The caller's principal must come from the existing verified SAML session. The repository intersects it with current database grants and checks current tenant/account status inside a repeatable-read, read-only transaction. PMs see owned requests or eligible backup assignments; department users need both customer and active dependency-department access; presidents need explicit customer grants. Tenant-wide grants alone do not grant a customer view.

Quarantined/excluded requests, unapproved customers and requests with nonoperational evidence or audit sensitivity do not enter these projections. Lists never include email bodies, attachment contents, mailbox credentials, raw blobs or arbitrary audit payloads. Detail history uses fixed operational event labels. The original source email subject and email trail remain unavailable until the separate authorized-evidence integration exists; no fictional evidence is substituted.

The default workspace limit is 200 requests (trusted configuration may set 1–1,000). Exceeding the limit refuses the read; it does not return an incomplete list with misleading totals. Paginated queries and aggregate counts are a follow-up before larger deployments. Active dependencies are bounded and the earliest promised dependency is the primary row label; detail preserves the other visible dependencies.

## Use the existing SAML/network boundary

The trusted composition supplies the repository to `createSamlAuthHandler`:

```js
const workspace = createPostgresWorkspaceRepository({pool, dbTenantId});
const handler = createSamlAuthHandler({
  manager, publicOrigin, rateLimit, audit, networkAccess, workspace,
});
```

The new GET routes are `/api/workspace` and `/api/requests/<lowercase-UUID>`. They accept no query-selected identity, tenant or persona and no writes. Without the repository, they remain unavailable. All requests pass the same TLS/host, approved-network, opaque-session and shared-rate-limit checks. A second session/grant check after repository and audit awaits discards results if authorization changed during the read. Responses are no-store JSON, bounded to 1 MiB, and failures do not disclose source data or database details.

Successful prepared reads produce bounded `workspace.read_prepared` audit events with the fixed route, internal actor/tenant IDs and timestamp. This records a prepared read, not proof that a browser received it. The real durable audit sink is still a deployment requirement.

## What is still incomplete

The fictional demo remains isolated and production startup remains blocked. This change supplies database-backed API composition; it does not finish the browser workspace wiring, production hosting, actual Entra/VPN acceptance, directory eligibility synchronization, backup/restore, mail-page persistence, source access, attachment processing or model evaluation. Coverage explicitly says email is not connected. In-app sending remains unavailable.

Read-only runtime privileges for the workspace include the scoped request/audit/evidence/customer/principal/dependency tables plus `role_grants`, `customer_pm_assignments` and `raw_blob_refs`. Test fixtures grant these only to disposable non-superuser roles. Production roles, approval and deployment are separate.

## Verification

Focused fast tests cover projection shape, current grants, safe errors, transaction rollback and HTTPS rejection/reauthorization. Native PostgreSQL suites cover real scoped records, database isolation and reconnect/reload. `saved-workspace-flow.integration.mjs` composes actual signed SAML, PostgreSQL session/grant/request adapters and local HTTPS for two fictional users; it tests direct-ID denial, service recreation, network rejection and revoked access. Synthetic identity and local certificates are not proof of live Microsoft configuration.
