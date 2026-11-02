# Legacy delegated-token principal prototype

**Superseded November 2, 2026. Development-only; disabled in production.** Human application access must use **SAML 2.0 with enforced Entra MFA**, according to [Security SAML Access](Security-SAML-Access.md). This file preserves the historical token/DB contract for existing fixture tests. It is not a production integration recipe. Do not wire this resolver, a bearer-token API login, or platform OIDC authentication as a fallback to SAML.

Construction and resolution now fail with `LEGACY_BEARER_DISABLED` (503) when `NODE_ENV=production`, including a final check after asynchronous dependencies. Exclude this module from the production image. Environment checks are accident-prevention guards, not authentication. The future SAML adapter may reuse the immutable identity and current database-grant policy described below, but must establish identity from a cryptographically validated SAML session instead.

`src/security/entra-principal.mjs` provides a reusable server-side mapping from a cryptographically verified API access token to an active, explicitly authorized database principal. It does not implement signature verification, acquire tokens, configure Microsoft applications, provision permissions, connect PostgreSQL, or authenticate the existing fictional review UI. No credentials, tenant changes or external deployment are supplied by this module.

## Public interface

```js
// Historical development contract only; never wire into a production HTTP route.
const resolvePrincipal = createPrincipalResolver({
  tenantId: approvedEntraTenantUuid,
  audience: configuredApiAudience,
  issuer: exactTrustedEntraIssuer,
  verifyAccessToken: testOnlyVerifier,
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

This shape feeds fictional contract tests today. The future SAML/session adapter can produce an equivalent server-side authorization context after its own validation and database checks; clients cannot manufacture it. Existing demo persona routes must remain segregated and must never be accepted by a production route.

## Historical cryptographic verifier contract (not the selected login path)

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

The original delegated-token design required all of the following **before returning**. These requirements document the legacy callback, not approval to build an alternate human-login path:

1. Verify the signature with a maintained production token-validation library and trusted Entra discovery/JWKS configuration. Pin the intended issuer, supported algorithms and tenant. Do not handwrite JWT cryptography, accept `alg:none`, trust decoded claims, or follow key/discovery URLs from untrusted token fields.
2. Verify the exact API audience, allowed tenant, issuer and valid lifetime. Wrong-resource Microsoft Graph tokens are not application API tokens. Support signing-key rotation through the verifier's reviewed key-management behavior; unknown or unverifiable keys fail closed.
3. Establish that this is a delegated **API access token**, not an ID token or an app-only workload token. Validate the configured delegated permission and any approved-client policy required by deployment. JWT header `typ` alone does not establish the intended token use.
4. Return only after those checks succeed:

```js
{ tokenUse: 'access_token', claims: verifiedClaims }
```

`tokenUse` is an **adapter contract field**, not an assumed Microsoft claim. A fake `{tokenUse, claims}` wrapper or a decode-only callback does not establish real authentication. This module cannot prove that an injected function performed cryptography; its test-only verifiers exercise the historical contract. The superseded design's proposed production verification work is not authorization to deploy a bearer fallback. There is intentionally no built-in placeholder verifier or permissive fallback.

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
| 503 | `LEGACY_BEARER_DISABLED` | Production use of this superseded prototype is prohibited |

Verifier error details, token contents and database connection errors are never attached as public causes or logged by this module. No HTTP authentication route is implemented by these files. The future production HTTP boundary accepts only sessions established through the approved SAML/MFA flow; a supplied bearer token cannot authenticate a human application request. Provider/Graph credentials remain server-side and separate.

## No platform-header or alternate-login fallback

This module does not consume `x-ms-client-principal` or related headers. Platform OIDC/Easy Auth is not the selected human-login path and must not be enabled as a SAML fallback. Strip untrusted identity headers, protect the direct origin and reject fabricated identity envelopes. A future reviewed SAML gateway would still need exact trust, MFA evidence, protected routing and independent application resource authorization; the mere presence of a proxy header proves none of those.

## Verification completed and remaining

The boundary unit tests cover verifier rejection of tampered input, missing/wrong-purpose claims, external tenants, issuer/audience variants, lifetime failure, different Entra/internal IDs, disabled/revoked identities, role/scope injection, cross-principal grants, grant expiry/revocation, immutable output and database failure. Their verifier doubles are explicitly test-only. They do not prove real cryptographic verification.

Six additional cross-module regression tests cover production rejection for the demo factory and this legacy resolver, including environment changes after construction and while provider/identity work is in flight. These do not verify SAML or deployed MFA. Before real users or customer records, implement and independently review the SAML SP, session store and current-grant loader; pass the complete [SAML/MFA and bypass matrix](Security-SAML-Access.md) in the actual approved environment. Production SSO remains incomplete.

[1]: https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation "Microsoft: validate access-token claims"
