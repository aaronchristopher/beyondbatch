# SAML login and session integration

**November 2, 2026 — implemented backend components, not a deployed sign-in service.** This slice implements protocol validation, browser sessions, current permission resolution and the HTTPS authentication handler. It does not connect the fictional workspace to customer records, configure Entra, synchronize directory eligibility, provision a database or start a production listener. The existing demo startup remains blocked in production.

## Implemented flow

Every request first passes the mandatory [VPN/public-IP gate](Network-Access.md), including login, ACS and health. The configured network is necessary in addition to SAML/MFA and current permissions. The target public origin is `https://beyondbatch.com`; DNS and live network policy are not configured.

1. `GET /auth/saml/login` creates independent random browser correlation and RelayState values. It records only their hashes, the request ID, expiry and any prior session hash. The SP produces a signed AuthnRequest for the fixed UniWell tenant endpoint. The prior session is captured here because the main Lax cookie is normally absent on the IdP's cross-site POST.
2. `POST /auth/saml/acs` accepts only a bounded two-field form. The browser correlation cookie and pending RelayState must match, and the pending login is consumed atomically. Node-SAML verifies both signatures and consumes shared request/assertion replay markers. The wrapper rejects missing MFA, wrong immutable identity, ambiguous claims, wrong destination/recipient, stale lifetimes and malformed XML.
3. Current database grants and a fresh, independently supplied directory eligibility result must authorize that immutable identity. No principal is created automatically. A successful login creates a fresh opaque session, revokes the previous session and returns a browser-session cookie. No password, bearer token, email link or proxy header can create a session.
4. `GET /auth/session` validates the cookie, checks idle/absolute/reauthentication bounds, reloads grants and eligibility, and rechecks session existence after awaited work. It returns only the authorized principal, a distinct CSRF token and deadlines. This endpoint is an identity integration surface, not the customer workspace API.
5. `POST /auth/logout` requires the same origin and a valid CSRF token, deletes the server session and clears cookies. A directory/grant denial also deletes the current session so restoring a grant cannot silently reactivate it. Identity-wide revocation is available as a trusted store operation, not a public HTTP endpoint.

## Source boundaries

| Component | Responsibility |
|---|---|
| `src/security/saml-service-provider.mjs` | Strict configuration, signed AuthnRequests, Node-SAML validation and verified identity/MFA extraction |
| `src/security/auth-session.mjs` | Browser correlation, opaque cookies, session deadlines, rotation/logout, current authorization, audit decisions and limiter composition |
| `src/security/application-principal.mjs` | Current identity/grant/eligibility mapping; explicitly not authentication |
| `src/security/saml-http.mjs` | HTTPS/host and mandatory network enforcement, bounded forms, headers/cookies, method/origin checks and generic responses |
| `src/security/network-access.mjs` | Exact-IP allowlists, strict direct/dedicated-proxy address derivation and denial on every handled request |
| `src/persistence/postgres-auth-store.mjs` | Shared atomic replay/correlation storage, session touch/revocation and rate limiting |
| `src/persistence/postgres-principal-loader.mjs` | Fixed-tenant read-only repeatable-read principal/grant lookup against the existing schema |
| `db/002_auth.sql` | Separate auth tables; no production roles, credentials or permissions |

The `tests/helpers/` memory store and ephemeral signing fixture are test-only and must never be imported into a production image. No private signing material is committed. The legacy JWT resolver remains prohibited in production.

## Protocol policy

Exact dependencies are pinned: `@node-saml/node-saml` 5.2.0 and `@xmldom/xmldom` 0.8.15. Tests use `xml-crypto` 6.4.0 to sign fictional assertions; Node-SAML also depends on that library at runtime. npm 11.9.0 and dependency-script blocking are recorded at the repository boundary and in CI.

The wrapper requires an exact tenant-specific Microsoft entry point and issuer, fixed HTTPS entity ID/ACS, RSA keys of at least 2048 bits and matching SP key/certificate. Configured certificates must currently be valid. Rotation supports up to three explicitly configured IdP certificates; remove expired certificates before their validity ends. There is no automatic metadata/key fetch or assertion-controlled URL fetch.

AuthnRequests use RSA-SHA256 with `ForceAuthn=true` and omit the library's default password authentication-context request. ForceAuthn is **not** an MFA policy. Entra Conditional Access must enforce the approved authentication strength, and the signed authentication-method claim must contain Microsoft's `multipleauthn` indicator. Tenant and user object identifiers come from their exact signed claim URIs. Editable names, email addresses, JWTs and flat claim convenience fields cannot supply identity or grants.

Incoming responses require RSA-SHA256, SHA256 digests, the approved canonicalization/transforms, both response and assertion signatures, exactly one assertion, one successful status and exact destination/recipient/request/audience/issuer matches. Node-SAML remains the cryptographic authority; the DOM preflight can only reject. Identity is extracted from the library's verified assertion, not its raw-response accessor. Duplicate claims, ambiguous structural nodes, DTD/entities, foreign namespaces, malformed dates, unsupported encrypted assertions and disallowed algorithms deny access. XML is limited to 128 KiB, 64 levels and 2,048 DOM nodes. The HTTP form limit is 180 KiB and its read timeout is five seconds.

Some Node-SAML 5.2.0 destination/recipient checks only warn; the wrapper makes them mandatory denials. Required atomic cache operations prevent concurrent replay. Cache keys include an IdP/SP/ACS hash as well as the store's configured namespace. The wrapper refuses enabled `node-saml` debug logging because dependency diagnostics can include input-derived text. These choices are validated with genuine signed fixtures; interoperability with UniWell's actual assertions remains unverified.

## Session and authorization policy

| Control | Implemented behavior |
|---|---|
| Correlation | Five-minute, browser-bound, single-use pending login; separate `__Host-bb-login` cookie with Secure/HttpOnly/Path=/ and SameSite=None |
| Main cookie | `__Host-bb-session`, Secure/HttpOnly/Path=/, SameSite=Lax; no persistent Max-Age/Expires |
| Server storage | SHA256 session ID and CSRF hashes; immutable identity IDs and deadlines; no raw cookie, SAML assertion, Graph token or role snapshot |
| Deadlines | 15-minute sliding idle, eight-hour absolute maximum, reauthentication no later than one hour after assertion AuthnInstant; shorter IdP session expiry wins |
| Current authorization | Reload database identity/grants and directory eligibility for every authenticated operation; role/customer/department scopes are not copied from browser claims |
| Directory freshness | Required callback result bound to both identity GUIDs, account enabled and app assigned, checked within five minutes; missing/invalid/stale denies |
| CSRF | Distinct HMAC-derived token available only through the same-origin authenticated session response; logout requires it plus exact Origin |
| Rotation/revocation | Prior session captured before cross-site ACS; successful login invalidates it; logout and identity-wide store deletion invalidate server records |
| Auditing | Required sinks receive bounded login/session allow/deny, attributable logout and HTTP-denial events; no cookies/assertions/email bodies; sink failure denies the operation |

The application cannot infer that a freshly fetched directory value reflects an administrative change immediately. Implement the eligibility provider, measure actual disable/assignment propagation, and meet the approved revocation bound before launch. A dummy callback returning `true` is not acceptable production composition.

Recheck authorization inside future customer-data mutation transactions. A session does not authorize arbitrary request IDs, attachments or president raw-email access. `canReadRequest` and field/evidence policy still apply to each resource. Existing database-backed workspace projections (B2) and their wiring (B4) remain unfinished.

## Database, throttling and deployment composition

Apply `001_core.sql` and `002_auth.sql` only in an approved environment. Use separate, narrowly privileged connection pools for authentication state and current application-grant reads. Auth namespaces are trusted server configuration: adapter namespace filtering is **not database RLS** and does not contain a compromised auth database credential. Ordinary user/ingestion database roles must not access auth tables. The principal loader uses fixed internal/Entra tenant configuration, transaction-local tenant context and a read-only repeatable-read transaction.

Shared rate limits are atomic across instances, with no memory fallback. Initial source defaults per canonical permitted client address are: login 10/15 minutes, ACS 20/15 minutes, logout 20/15 minutes, session and unknown-data routes 120/minute. These are fixed windows beginning at the first accepted request. The mandatory network policy uses only the TLS socket peer in direct mode, or a singular dedicated header from an explicitly trusted proxy peer in proxy-only mode. There is no automatic forwarded-header fallback. All employees sharing one VPN exit share a quota; production capacity and edge controls must be verified without disabling throttling. Exact configuration and deployment trust requirements are in [Network Access](Network-Access.md).

The handler requires TLS on its incoming socket and exact configured Host. An edge-to-origin HTTP hop does not satisfy it; production must use a verified HTTPS origin path. Bare origin/default-hostname routes must be network-restricted and independently tested. A ten-second HTTP dependency deadline limits waiting; it does not cancel already started store operations. Failed/abandoned logins may leave unused, unguessable session records until expiry, so schedule `prune(nowMs)` and monitor storage growth. Do not extend a response deadline when a dependency is slow.

Compose a single trusted server boundary using the actual implementations:

```js
const authStore = createPostgresAuthStore({ pool: authPool, namespace: approvedAuthNamespace });
const loadPrincipalRecord = createPostgresPrincipalRecordLoader({
  pool: authorizationPool, dbTenantId: approvedDatabaseTenantId, entraTenantId: samlConfig.tenantId,
});
const resolvePrincipal = createApplicationPrincipalResolver({
  loadPrincipalRecord, loadEligibility: approvedDirectoryEligibilityProvider,
});
const serviceProvider = createSamlServiceProvider({ config: samlConfig, store: authStore });
const manager = createSamlSessionManager({
  serviceProvider, store: authStore, resolvePrincipal, audit: approvedSecurityAuditSink,
});
const authHandler = createSamlAuthHandler({
  manager, publicOrigin: approvedHttpsOrigin,
  networkAccess: approvedNetworkAccessConfig, // Required exact VPN exits and, if used, dedicated proxy trust.
  rateLimit: createAuthRateLimiter({ store: authStore }), audit: approvedSecurityAuditSink,
});
```

This is a wiring contract, not a runnable production configuration. Its unresolved inputs are mandatory. Neither this document nor a caller-supplied callback establishes live authorization. A reviewed production host must supply them and attach every private-data route behind the same session/resource checks.

## Verification and remaining gates

The fast tests cover genuine signed SAML, malformed/forged/replayed responses, wrong MFA/tenant/certificate, correlation, grants, cookie/session/CSRF rules, audit failures, HTTPS parsing and the composed login/logout flow. The composed test includes replica handoff and rotation when the old Lax cookie is absent from the ACS, with fictional eligibility and memory storage. Native PostgreSQL suites separately exercise real atomicity, quotas, isolation, read-only grants and revocation. Record actual CI outcomes in [Implementation Status](Implementation-Status.md); local mocks are not database proof.

Before live use:

1. Verify domain control and configure the approved `beyondbatch.com` origin/entity ID/ACS, VPN exits, dedicated proxy/origin restrictions and reviewed server composition. Wire authorized persisted workspace/resource routes; keep all demo and test modules out of the production image.
2. Approve/configure the separate human SAML enterprise app, request-verification certificate, signing certificates, immutable claims, MFA claims, assignments and enforced app-scoped Conditional Access requiring both approved network and MFA. Reuse the reader app separately without broadening it.
3. Implement the approved directory eligibility synchronization/provider, durable audit sink and retention, narrow runtime DB roles, key-vault retrieval/rotation, shared-store cleanup and monitored ingress controls.
4. Verify real browser cookie behavior, two accounts, actual Entra MFA and revocation, VPN disconnect and spoofed-header denials, proxy/origin restrictions, resource/attachment denial and an independent deployed security assessment. No Node HTTPS fixture substitutes for these browser/tenant tests.

Do not connect private email or enable sending until [Security SAML Access](Security-SAML-Access.md) and [Production Readiness](Production-Readiness.md) pass. Source completion does not grant deployment, permissions or credentials.

Primary implementation references: [Node-SAML 5.2.0 release](https://github.com/node-saml/node-saml/releases/tag/v5.2.0), [tagged source and configuration](https://github.com/node-saml/node-saml/tree/v5.2.0), [Microsoft SAML protocol](https://learn.microsoft.com/en-us/entra/identity-platform/single-sign-on-saml-protocol), and [Conditional Access session lifetime](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-session-lifetime).
