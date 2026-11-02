# Entra principal resolution boundary

**November 2, 2026 · Implemented adapter boundary; production sign-in is not connected.**

`src/security/entra-principal.mjs` provides a reusable server-side mapping from a cryptographically verified API access token to an active, explicitly authorized database principal. It does not implement signature verification, acquire tokens, configure Microsoft applications, provision permissions, connect PostgreSQL, or authenticate the existing fictional review UI. No credentials, tenant changes or external deployment are supplied by this module.

## Public interface

```js
const resolvePrincipal = createPrincipalResolver({
  tenantId: approvedEntraTenantUuid,
  audience: configuredApiAudience,
  issuer: exactTrustedEntraIssuer,
  verifyAccessToken: productionCryptographicVerifier,
  loadPrincipal: databasePrincipalLoader,
  requiredScope: 'access_as_user', // default; configure to the actual exposed API scope
  clock: () => new Date(),       // default; inject only for deterministic tests
});

const principal = await resolvePrincipal(rawAccessToken);
```

The required five dependencies are `tenantId`, `audience`, `issuer`, `verifyAccessToken` and `loadPrincipal`. Construction fails if any is invalid or missing. `resolvePrincipal` accepts a raw token string, without the `Bearer ` prefix; it does not accept header objects, query parameters, a decoded principal or a caller-selected persona.

**Two tenant IDs must remain distinct:** configuration `tenantId` is the approved **Entra tenant GUID**. The returned principal's `tenantId` is **`bb.tenants.id`**, the internal database tenant ID. They do not have to equal each other. Likewise, token `oid` maps to `bb.principals.entra_object_id`, while returned `id` is `bb.principals.id`. No email address or display name is used as an identity key.

Returned shape, deeply frozen:

```js
{
  id: 'internal-principal-id',
  tenantId: 'internal-database-tenant-id',
  name: 'Database display name',
  role: 'pm', // or 'department' / 'president'
  customerIds: ['explicitly-authorized-customer-id'],
  departmentIds: [],
}
```

This shape can feed `projectWorkspace` after actual production token verification and database mapping are wired. It is a server-side authorization context, not a payload that clients are allowed to manufacture. Existing demo persona routes must remain segregated and must never be accepted by a production route.

## Cryptographic verifier contract

The resolver calls:

```js
await verifyAccessToken(rawAccessToken, {
  tenantId: approvedEntraTenantUuid,
  audience: configuredApiAudience,
  issuer: exactTrustedEntraIssuer,
  requiredScope: configuredDelegatedScope,
  tokenUse: 'access_token',
  clockToleranceSeconds: 0,
  now: 'explicit-UTC-instant',
});
```

The production adapter must perform all of the following **before returning**:

1. Verify the signature with a maintained production token-validation library and trusted Entra discovery/JWKS configuration. Pin the intended issuer, supported algorithms and tenant. Do not handwrite JWT cryptography, accept `alg:none`, trust decoded claims, or follow key/discovery URLs from untrusted token fields.
2. Verify the exact API audience, allowed tenant, issuer and valid lifetime. Wrong-resource Microsoft Graph tokens are not application API tokens. Support signing-key rotation through the verifier's reviewed key-management behavior; unknown or unverifiable keys fail closed.
3. Establish that this is a delegated **API access token**, not an ID token or an app-only workload token. Validate the configured delegated permission and any approved-client policy required by deployment. JWT header `typ` alone does not establish the intended token use.
4. Return only after those checks succeed:

```js
{ tokenUse: 'access_token', claims: verifiedClaims }
```

`tokenUse` is an **adapter contract field**, not an assumed Microsoft claim. A fake `{tokenUse, claims}` wrapper or a decode-only callback does not satisfy this contract. This module cannot prove that an injected function performed cryptography; production composition, dependency review and real-token integration tests are required. There is intentionally no built-in placeholder verifier or permissive fallback.

The resolver independently checks the returned envelope and required `tid`, `oid`, `iss`, `aud`, `exp`, `nbf`, `iat`, and `scp` fields before any database lookup. It accepts an exact audience string or a valid audience array containing that exact value. It requires the configured delegated scope, rejects `idtyp:app`, rejects expired/future lifetime claims, and rechecks expiration after asynchronous dependencies return. The default local clock tolerance is zero; operate with a synchronized server clock.

Token `roles`, `groups`, `wids`, `name`, email, customer IDs and department IDs never grant application data access. The verifier may enforce additional API policies, but it must not turn a token role directly into a workspace role. Microsoft documents audience/tenant/subject/actor checks and recommends immutable `tid` plus `oid` identity keys; this module implements the application's stricter mapping policy.[1]

## Database loader contract and exact schema mapping

The resolver calls `loadPrincipal({ entraTenantId, entraObjectId, now })` **on every request**, after token validation. The callback must use trusted database access and parameterized SQL, join the approved Entra tenant mapping to the principal, and return `null` when there is no matching authorized identity. Do not bootstrap access from email, query-string tenant values or client-supplied grants.

Normalized record:

```js
{
  id, tenantId, entraTenantId, entraObjectId,
  name, principalType: 'user', status: 'active', tenantStatus: 'active',
  workspaceRole: 'pm', // optional server-derived selection; required if multiple supported roles exist
  grants: [{
    id, tenantId, principalId, roleName: 'pm', scopeKind: 'customer',
    customerId, departmentKey: null, requestId: null,
    grantedAt: '2026-11-01T12:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
  }],
}
```

| Normalized property | Actual schema field / rule |
|---|---|
| `tenantId` | `bb.tenants.id` and `bb.principals.tenant_id` |
| `entraTenantId` | `bb.tenants.entra_tenant_id` |
| `tenantStatus` | `bb.tenants.status`; only `pilot` or `active` allowed |
| `id` | `bb.principals.id` |
| `entraObjectId` | `bb.principals.entra_object_id` |
| `name` | `bb.principals.display_name` |
| `principalType` | `bb.principals.principal_type`; only `user` allowed here |
| `status` | `bb.principals.status`; only `active` allowed |
| `grants[].id` / `tenantId` / `principalId` | `bb.role_grants.id` / `tenant_id` / `principal_id` |
| `roleName` / `scopeKind` | `bb.role_grants.role_name` / `scope_kind` |
| `customerId` / `departmentKey` / `requestId` | `customer_id` / `department_key` / `request_id` |
| `grantedAt` / `expiresAt` / `revokedAt` | `granted_at` / `expires_at` / `revoked_at`, normalized to explicit-offset ISO strings or nullable fields |
| `workspaceRole` | Server-derived application policy; **not an existing column** in the current migration |

Both Entra IDs in the result must match the verified token pair. Every grant must be bound to the returned internal tenant and principal. Duplicate IDs, malformed scope fields, wildcard IDs or missing expiry/revocation fields fail closed. Only active, unexpired, effective grants are considered; any non-null `revokedAt` makes that grant unusable. The schema has no principal `revoked_at` column: disable a principal through its existing `status`. If a future trusted adapter provides a non-null principal-level `revokedAt`, this boundary also denies it.

The trusted tenant bootstrap lookup must be designed consistently with PostgreSQL row-level security. Do not solve the initial Entra-to-internal-tenant lookup by handing ordinary web requests unrestricted database access. Use the approved server configuration/bootstrap mapping, then the transaction-local internal tenant context specified in `Data-Contracts.md`. Reauthorize again inside write transactions where a race with grant revocation matters.

## Role and scope policy

Supported workspace roles map as follows: DB `pm` → `pm`; `department_member` → `department`; `president` → `president`. Reviewer, security-admin and integration-worker grants do not implicitly authorize an ordinary customer workspace. A workload token requires a separate resolver and policy.

If exactly one supported active role exists, it is selected. If more than one exists, the database adapter must supply a deliberate server-derived `workspaceRole` backed by active grants. A client-selected persona or unverified header must never decide it. The resolver selects **only that role's grants**; PM customer permissions cannot be combined with a president role to widen executive access.

- Customer scopes become explicit `customerIds`.
- Department scopes become explicit `departmentIds`.
- Tenant-scoped grants can establish an eligible role but never expand into “all customers.”
- Request-specific grants remain unexpanded. The current workspace projector does not implement that narrower authorization path; do not convert one request grant into access to every request for its customer.
- The existing department projector requires both customer membership and department membership. Approve that conjunctive policy deliberately; a future customer/department-pair permission model needs a richer authorization predicate, not flattened lists.

A valid principal may have empty customer scopes and therefore see no operational records. Missing/disabled principals or no eligible active workspace role are denied. Even a president still requires explicit operational customer scopes. Field-level/evidence permissions, resource-specific mutation permissions and sensitive-data publication checks remain separate responsibilities; this resolver does not replace them.

No principal or grant cache is present. Local grant revocation is observed on the next resolution because the database is reread. This is not a claim that Entra session revocation, account disablement or all existing access tokens become instantly invalid. Deployment must implement its approved token/session lifetime, revocation and Conditional Access policies, and avoid long-lived copies of these authorization contexts.

## Errors and HTTP integration

`PrincipalResolutionError` exposes a bounded `code`, `statusCode`, and generic message:

| Status | Code | Meaning |
|---|---|---|
| 401 | `INVALID_ACCESS_TOKEN` | Missing, unverifiable, wrong-purpose or invalid claims |
| 403 | `PRINCIPAL_ACCESS_DENIED` | No active correctly bound identity or eligible scoped grants |
| 503 | `AUTH_DEPENDENCY_UNAVAILABLE` | Database/clock dependency could not supply an authorization decision |

Verifier error details, token contents and database connection errors are never attached as public causes or logged by this module. The future HTTP boundary should extract exactly one Bearer credential, reject ambiguous duplicate credentials, use HTTPS, apply rate limiting, return generic errors, and avoid logging Authorization headers. Choose secure server sessions or a reviewed token flow; do not persist bearer credentials in ordinary browser-accessible application storage. No HTTP authentication route is implemented by these files.

## Easy Auth alternative

This module does not consume `x-ms-client-principal` or related headers. A future platform-authentication alternative must be independently reviewed: require the platform's authenticated routing guard; prevent direct origin bypass; ensure untrusted inbound identity headers are stripped/overwritten; validate issuer/audience/tenant settings; and bind the resulting identity to the same active database authorization model. A header's presence is not evidence of authentication. Do not fabricate a “verified access token” envelope from such headers to bypass this module's verifier contract. Use a separate explicitly trusted platform-auth adapter if that architecture is selected.

## Verification completed and remaining

The boundary unit tests cover verifier rejection of tampered input, missing/wrong-purpose claims, external tenants, issuer/audience variants, lifetime failure, different Entra/internal IDs, disabled/revoked identities, role/scope injection, cross-principal grants, grant expiry/revocation, immutable output and database failure. Their verifier doubles are explicitly test-only. They do not prove real cryptographic verification.

Before real users or customer records: implement and review the actual verifier and database loader; test signed valid/invalid tokens, wrong tenant/resource, ID-token substitution, app-only tokens, signing-key rotation and identity/grant revocation against an approved test environment; wire the protected route; confirm demo persona paths cannot reach production data; test every existing projection and mutation through the actual principal; and complete the hosting/session/security gates. Until then, production SSO remains incomplete.

[1]: https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation "Microsoft: validate access-token claims"
