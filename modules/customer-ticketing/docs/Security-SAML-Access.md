# Exclusive SAML 2.0, mandatory MFA and VPN access

**Decision: November 2, 2026. Required before any live customer email.** This supersedes the earlier OIDC/delegated-bearer proposal for human application access. It is an implementation contract, not a claim that SAML, Conditional Access or production hosting is already configured.

The target application domain is `https://beyondbatch.com`. UniWell employees must enter Customer Ticketing from the approved VPN/SASE public exit addresses and through UniWell Microsoft Entra SAML 2.0 single sign-on with enforced multifactor authentication. The network requirement applies to every request, including an already authenticated session; see [Network Access](Network-Access.md). Successful authentication alone does not authorize a customer, message or attachment. The application separately checks active database grants for each resource. No local-password, email-link, social-login, personal-token, demo-persona or delegated-bearer fallback may unlock private application data.

## Current evidence and remaining boundary

The demo server now refuses `NODE_ENV=production` at factory construction, request entry and response emission. The old delegated-token principal prototype refuses production construction and resolution. Regression tests cover importing the factory, injected providers, attempted override flags and an environment change after construction. These guards prevent accidental reuse; an environment variable is **not** authentication or an internet security boundary. The production image must exclude demo executables, persona datasets and the legacy resolver entirely.

The SAML service-provider wrapper, shared PostgreSQL auth store, opaque session manager, current principal resolver and HTTPS authentication handler are now implemented as backend components. Genuine signed test assertions and composed local HTTPS tests verify their behavior; see [SAML Integration](SAML-Integration.md). They are not wired into a production listener or the customer workspace. Entra MFA policy, directory eligibility synchronization, durable audit configuration, live-data endpoints and deployed/browser acceptance remain incomplete. The existing hosted review remains fictional. B3 and the deployed security tests below must pass before M2 introduces private email.

## Threat model and trust boundaries

| Boundary / attack | Required control |
|---|---|
| Off-VPN request or replay of a session outside the allowed network | Mandatory exact-IP policy on every handled request; approved proxy/origin path; no forwarded-header bypass |
| Anonymous visitor or stolen password | Exclusive SAML sign-in; Entra MFA policy enforced, not report-only; independently validated signed MFA evidence |
| Forged, replayed or misdirected SAML | Maintained validator; exact trust configuration; request correlation; one-time assertion cache; signed response and assertion |
| Valid employee accessing another customer's mail | Active immutable identity mapping plus resource authorization on every read and write |
| Direct API, origin hostname, IP or download bypass | Same application guard on all data routes; restricted origin network path; private evidence storage |
| Stolen or abandoned browser session | Opaque server sessions, secure cookies, bounded lifetime, reauthentication, revocation and incident session invalidation |
| Email HTML, attachments or model instructions | Sanitize/isolate untrusted content; no remote tracking pixels; agent cannot alter identity, grants, policy or send on its own |
| Worker or infrastructure credentials | Separate least-privilege workload identity; no ability to create interactive user sessions; audited privileged infrastructure access |

## SAML service-provider contract — B3

Use a maintained SAML service-provider library or reviewed SAML gateway with demonstrated Node/runtime support. Select and pin the library after checking its current maintenance/security history. Do not implement XML signature validation or a custom SAML parser. Do not substitute Azure platform OIDC login for the requested SAML protocol.

1. Trust only the approved UniWell tenant issuer and configured signing certificates. Use a fixed SP entity ID, HTTPS assertion consumer service (ACS) and approved logout destination. Metadata and key updates come from reviewed configuration, never assertion-supplied URLs. Document certificate overlap/rotation and test unknown-key rejection.
2. Allow **SP-initiated login only**. Sign AuthnRequests and configure Entra to require verification certificates. Validate exact `InResponseTo`, Destination, Recipient, Audience, signature coverage, SubjectConfirmation and Conditions lifetimes. Configure Entra to sign both response and assertion; reject either missing signature. Use a narrowly bounded, documented clock tolerance with synchronized hosts.
3. Bind each pending login to its initiating browser and an unpredictable one-time state value. Atomically consume request and assertion IDs in a shared store across instances. Reject duplicate, unsolicited, expired and concurrent replay responses. RelayState may select only an allowlisted local destination; it is never an arbitrary redirect.
4. Disable DTD/external-entity expansion; enforce XML/body size and processing-time limits. Test signature wrapping, duplicate identity/attribute elements, algorithm substitution and untrusted embedded certificates with real signed fixtures and the selected library.
5. Extract immutable tenant and directory object IDs only from the verified assertion. Never identify a user by editable email/name, accept client-provided claims, or grant rights from SAML roles alone. The application maps the identity pair to an existing active principal and current customer/department/evidence grants.
6. No development override, permissive verifier, alternate bearer login or proxy-header identity path is packaged into the production entry point. Unknown route or missing identity denies access. Authentication/configuration/session-store failure denies access; it never falls back to demo state.

## MFA and assignment contract

SAML conveys an authentication result; it does not itself require two factors. Configure an **app-scoped Entra Conditional Access policy** for every assigned interactive user, requiring phishing-resistant MFA authentication strength. Preferred methods are FIDO2/passkeys or Windows Hello for Business under the approved tenant policy. Device/location conditions cannot serve as an OR alternative to MFA. Enrollment and recovery procedures must not introduce password-only app access. Existing legitimate MFA may satisfy Entra policy until the configured authentication age expires; a second prompt on every page is neither required nor a proof of security. [1–3]

Configure and test the signed SAML authentication-method claim contract. Microsoft's SAML documentation identifies `http://schemas.microsoft.com/claims/multipleauthn` as MFA evidence and documents optional `amr` / `include_granular_amr` configuration for non-Salesforce apps. Do not assume these claims appear by default or accept an unsigned `mfa=true` header. Missing or unverifiable required MFA evidence denies session creation; the actual phishing-resistant method is enforced by Conditional Access and verified in tenant acceptance tests. [4]

Set **Assignment required = Yes** and assign only approved users or a reviewed group. Also require an application database allowlist and active scoped grants: tenant membership, an email domain, or an Entra administrator role does not grant customer access. Microsoft's assignment behavior has administrator exceptions; an unassigned administrator must still be denied by the application. Group membership rules and lifecycle propagation must be tested. [5–6]

Do not weaken tenant-wide emergency recovery policy to implement this app. Emergency administrator accounts have no application data grant or alternate login; infrastructure recovery remains separately privileged, MFA-protected where applicable, time-bound and audited. Administrators who can change infrastructure are a privileged trust boundary, not something a login form can make impossible.

## Required VPN/public-IP boundary

The SAML HTTP handler requires an explicit, valid network allowlist at construction and denies every handled request from an unapproved address before authentication/session processing. Direct mode trusts only the socket peer. Proxy-only mode requires an exact configured peer and one overwritten `x-bb-client-ip` value; it never falls back to direct access or arbitrary forwarded headers. Preserve TLS to the origin and exact Host validation. Restrict alternate origins and prove the proxy deployment cannot be impersonated by other tenants sharing provider infrastructure.

Require a separate Entra network restriction alongside MFA. A trusted IP cannot exempt MFA, and sign-in-time network policy does not substitute for this request gate. An IP match alone cannot prove VPN use when office traffic shares the same exit. The parser supports local/private fixture and proxy addresses; production client allowlists must be verified dedicated public exits. No live DNS, VPN, firewall or tenant policy is changed by the implementation. Deployment, routing, capacity and browser acceptance remain open; [Network Access](Network-Access.md) defines the exact contract.

## Sessions, logout and revocation

- Issue a cryptographically random opaque session ID after full SAML/MFA/authorization checks. Store only its hash and bounded identity/authentication metadata server-side. Rotate at login and privilege transitions. Never place assertions, Graph tokens or application credentials in browser local storage or URLs.
- Use an HTTPS-only `__Host-` session cookie with `Secure`, `HttpOnly`, `Path=/` and appropriate `SameSite=Lax`. SAML HTTP-POST is cross-site: use a separate short-lived `SameSite=None; Secure; HttpOnly` preauthentication correlation cookie if the selected library requires it. Keep correlation browser-bound and one-time; do not globally loosen the main session cookie or omit CSRF controls.
- Proposed defaults for implementation and acceptance: **15-minute idle timeout, 8-hour absolute session lifetime, and a fresh Entra authentication-policy evaluation at least hourly**. No persistent remember-me. Verify that the chosen SAML redirects and Entra sign-in-frequency policy actually enforce the intended authentication age; an app cookie must not indefinitely bypass Conditional Access. These are unconfigured proposed values, not current protections. [2]
- Check current application identity and grants on every authorized operation, including download/realtime continuation; recheck mutations inside their transaction. Local disable/revocation and incident logout invalidate all relevant sessions. A successful logout deletes the server session; do not depend solely on front-channel SAML logout succeeding.
- Define a directory eligibility monitor for account disablement and app-assignment removal. Proposed maximum accepted eligibility snapshot age: **five minutes**; stale/unavailable eligibility denies data access. Review the minimum directory permissions and propagation behavior before implementing it. Measure disable-to-denial from the actual administrative action; a fresh but stale upstream response is not proof of current eligibility. If measured propagation exceeds the approved bound, block release or add a verified control. An Entra logout/disable does not automatically erase local app cookies.
- CSRF protection and origin checks apply to mutations, logout and reply actions; the ACS instead uses verified SAML request/browser correlation. Rate-limit auth and data endpoints, use restrictive CSP/security headers, and return generic errors without assertions, session IDs or email bodies.

## Every private-data route uses the same guard

HTML containing private data, JSON APIs, counts, search suggestions/results, email trails, attachment bytes, exports, SSE/WebSockets and background-result retrieval all require a live authorized session. Apply object-level checks before reading/serializing private content. Guessing IDs, changing query parameters, sending `Authorization: Bearer`, or spoofing `x-ms-client-principal`/forwarded identity headers cannot establish identity.

The only unauthenticated surface is a strict allowlist: sign-in initiation, SAML ACS/metadata as needed, static non-sensitive assets and minimal health without data or infrastructure details. Unauthenticated does not mean network-exempt: all ordinary application endpoints remain VPN-gated, including the browser-posted ACS. The implemented handler also gates health; infrastructure probes need an approved separate transport or compatible source path, not a broad application bypass. Protocol webhooks have independent subscription/clientState verification and bounded durable enqueue; they expose no application data reads or session creation. Never trust webhook email content as authorization.

Restrict origin ingress to the approved edge and enforce application authorization even there. Test the main domain, default hosting hostname, API domain and any reachable origin address independently. Configure proxy trust explicitly and strip client-supplied identity/forwarding headers. Protect staging and backup/restore environments equally if they hold private content. No private data in static review JSON, source maps, public artifacts, diagnostic pages or shared/CDN caches; use `Cache-Control: no-store` for private responses.

Attachments live in private object storage. Authorize each download through the application; do not create public buckets or shareable long-lived bearer links. Short-lived storage redirects alone cannot meet immediate application revocation, so the initial design streams through the authenticated service. Quarantine/scan before delivery. Raw email HTML is sanitized or rendered as safe text; remote images and active content are off. Summaries, search indexes, exports and model retrieval inherit the source ACL. President access to operational summaries does **not** imply access to all email bodies, HR, legal or personal material.

## Machine access, database and operations

Background ingestion cannot perform an interactive MFA prompt on each sync. It uses a separate restricted managed identity or certificate and Graph application authorization scoped to approved mailboxes. This is machine-to-machine ingestion, never an alternate user login. Worker identities cannot mint browser sessions; narrow database roles/queues separate ingestion, projection and web actions. The existing request-store constructor's actor/tenant values must come from these trusted server contexts, not HTTP parameters.

Future delegated Graph draft/send consent is subordinate to an existing SAML/MFA application session, with exact user/tenant binding. Its callback/token cannot log into BeyondBatch or substitute for the SAML session. Keep provider tokens server-side. No automatic sending is authorized by this security decision.

Require TLS in transit, encrypted database/object storage and backups, private network access to database/storage, secrets in an approved vault, least-privilege deployment access, MFA/time-bound privileged operations, and tested restore/retention/deletion. Audit login decisions, resource access/downloads, grants, privileged actions and workflow changes with identifiers and reasons. Redact mail bodies, tokens, assertions and secrets. Email/attachments/model output are untrusted data, never instructions to bypass these controls. Log retention and tamper protection are release configuration, not implied by local tests.

## Deployed acceptance matrix — all required before private email

| Test | Expected result |
|---|---|
| Valid session cookie after VPN disconnect; forged forwarded client address | Next request is denied before session/resource work; no new private bytes |
| Untrusted proxy peer, duplicate/missing/chained dedicated address header | Denied; no direct-address fallback |
| IPv6, split routing, VPN failover and shared office egress | Only verified approved exits succeed; actual tunnel requirement demonstrated |
| Approved VPN exit and user, valid SAML plus enforced MFA, permitted customer | Only assigned view and authorized evidence succeeds |
| Password-only, missing MFA claim, wrong tenant or unassigned user/admin | No application session/data |
| Unsigned, altered, expired, wrong audience/destination, wrapping or replay assertion | Rejected; no session; bounded audit event |
| Unsolicited/IdP-initiated response or stolen login state from another browser | Rejected |
| Direct anonymous API, attachment/export, API host/default host/origin request | No private bytes, metadata or counts |
| Bearer token, persona/role query, spoofed principal header or other sign-in provider | Cannot establish user access |
| PM A reads PM B's customer; president requests ungranted body; cross-tenant IDs | Denied consistently in rows, search, counts, download and mutation |
| Expired/logout cookie, local grant removal, disabled/removed Entra user | Denial within measured approved bounds; no renewal from stale state |
| Session store, eligibility check, signing certificate or identity provider unavailable | No new unauthorized session or stale permission fallback; existing sessions obey explicit freshness limits |
| Shared replay cache and certificate rotation under multiple app instances | One accepted login per request; only approved certificates during overlap |
| Worker token or Graph delegated token offered to human app endpoint | Denied; no interactive principal minted |
| Static build, logs, caches, errors and backup/restore inspection | No unintended private content or credentials |

Run real two-account browser acceptance and independent security review of SAML, authorization, dependency supply chain, infrastructure and bypass routes. Unit-test pass counts are not substitutes. Record exact build/configuration, sign-in logs, sanitized evidence, owner and date; unresolved bypass findings block real-mail ingestion and team release.

## Configuration changes needing a concrete approval package

1. A **separate human SAML enterprise application**: exact host/entity ID/ACS, signing and request-verification certificates, immutable identity/MFA claims, assigned users/group and certificate custody/rotation. Reuse the existing reader identity for ingestion; do not duplicate or broaden it.
2. App-scoped Conditional Access enforcement requiring both approved network and MFA authentication strength, sign-in frequency, assigned population and enrollment/recovery verification. Test report-only first with fictional data; enforcement must be On before private data.
3. Verified domain control, DNS/certificate changes, exact VPN public exits, dedicated proxy/header contract, private origin/bypass restrictions, session store, database/storage roles, secrets, retention, audit and operational access. Identify any minimum directory-read permission needed for eligibility freshness separately.
4. Evidence that assignment, MFA, revocation, direct-route and cross-customer tests pass before authorizing live customer content.

No such changes, credentials, deployment, email connection or outbound messages are made by this document or the demo guards.

## Official references

1. [Microsoft single sign-on model](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/understand-microsoft-sso-model)
2. [Conditional Access session lifetime](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-session-lifetime)
3. [Authentication strengths](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-authentication-strengths)
4. [Microsoft SAML protocol and authentication-method claims](https://learn.microsoft.com/en-us/entra/identity-platform/single-sign-on-saml-protocol)
5. [Restrict an application to assigned users](https://learn.microsoft.com/en-us/entra/identity-platform/howto-restrict-your-app-to-a-set-of-users)
6. [Assignment errors and administrator exception](https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/app-integration/error-code-aadsts50105-user-not-assigned-role)
7. [Enforce signed SAML authentication requests](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/howto-enforce-signed-saml-authentication)
