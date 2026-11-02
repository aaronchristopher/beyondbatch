# VPN and public-IP access contract

**November 2, 2026. Target domain: `https://beyondbatch.com`.** Human access requires all of: an approved VPN/SASE network path, UniWell Entra SAML 2.0 with enforced MFA, an active application session, and current resource permissions. Domain ownership, DNS, hosting, network rules and live Entra policies remain unconfigured by this source change.

## Enforced source boundary

`createSamlAuthHandler` requires `networkAccess` configuration and constructs the actual `createNetworkAccessPolicy` implementation internally. There is no injected allow-all callback or optional network check. Missing, empty or invalid configuration refuses construction. The policy snapshots its configuration so mutating a caller's array cannot change a running allowlist.

The gate runs on every handled request after basic header, TLS and Host validation and before redirects, SAML processing, session access or rate-limit work. This includes login, ACS, session, logout, health and unknown paths. An approved IP never creates an identity or replaces MFA, current grants or CSRF. An unapproved IP cannot use an already valid session cookie. A network denial does not delete that session; returning through the approved network still requires its original expiry, authentication-age and permission checks.

This code denies HTTP access. Firewall/WAF and origin restrictions are separately required to reject unwanted network paths in production; a source test does not prove that an internet-facing listener is protected. Existing customer-data route wiring remains incomplete. No SSE or WebSocket route exists in this handler; future long-lived connections need explicit network/session revalidation and disconnect behavior before release. Bytes already delivered to a browser cannot be recalled.

## Configuration and trusted client address

| Mode | Authoritative address | Denial behavior |
|---|---|---|
| Direct TLS | The connection's socket peer | Forwarded/client-IP headers cannot change the peer or grant access |
| Dedicated trusted proxy | Exact approved socket peer, then one `x-bb-client-ip` header overwritten by that proxy | Unknown peer, missing/duplicate header, multiple addresses or malformed address denies; there is no direct-peer fallback |

Both `allowedClientIps` and proxy `peerIps` contain 1–64 exact IPv4 or IPv6 literals. Wildcards, CIDRs, hostnames, ports, zone identifiers and whitespace are rejected. IPv6 spelling and IPv4-mapped IPv6 are normalized for matching and rate-limit keys. Unknown configuration fields are rejected. The dedicated proxy header name is fixed to `x-bb-client-ip`; neither `X-Forwarded-For` nor an identity header is an alternative.

The parser permits loopback/private/documentation addresses for explicit local fixtures and private proxy hops. This is not a production approval of those addresses. Production `allowedClientIps` must contain the verified dedicated public VPN/SASE exit addresses, including approved failover addresses. Keep actual operational IPs in reviewed deployment configuration, not this public repository. Changes require a reviewed policy replacement/restart rather than mutating a live object.

```js
// Direct TLS, only when the server actually sees the VPN's public exit address.
const networkAccess = { allowedClientIps: approvedVpnPublicExitIps };

// Alternative for a dedicated proxy with verified overwrite and origin controls.
const proxiedNetworkAccess = {
  allowedClientIps: approvedVpnPublicExitIps,
  trustedProxy: {
    peerIps: approvedDedicatedProxyPeerIps,
    clientIpHeader: 'x-bb-client-ip',
  },
};
```

Do not configure the proxy's own address as an allowed client address to work around missing headers. The proxy must remove inbound copies of the dedicated header and overwrite it from its verified client connection. It must not copy untrusted client headers. All paths to the origin must be restricted to the approved proxy, using a private origin or an equivalent reviewed, deployment-specific binding. Shared cloud-provider backend addresses alone do not identify your proxy; another customer could otherwise send the same header. If the host cannot provide this exact trust contract, block deployment and implement/test a suitable adapter rather than guessing at forwarded headers.

The handler still requires a real TLS socket and the exact configured public Host. Edge-to-origin HTTP or `X-Forwarded-Proto: https` does not satisfy that check. Preserve verified HTTPS to the origin, and bind `publicOrigin`, SAML entity/ACS configuration and DNS to the reviewed canonical domain. Default hosting names, direct IPs, alternate API hosts, previews and evidence storage must not provide a bypass.

## Microsoft policy and VPN routing

Configure the human SAML enterprise application with app-scoped Conditional Access that blocks network locations outside the approved VPN/SASE exits, plus an independently required MFA/authentication-strength policy. A trusted network must never exempt a user from MFA. Conditional Access at sign-in does not replace the application's per-request gate: a custom SAML session can outlive a network change.

Route both BeyondBatch traffic and the relevant Microsoft sign-in traffic through the intended VPN path. Verify IPv4, IPv6, split tunneling, DNS behavior and failover from actual managed endpoints. The IP match proves only the observed exit address, not the employee's physical location, device compliance or use of a particular VPN client. If the office and VPN share one public exit, ordinary office traffic can match without a tunnel. Requiring the tunnel for everyone therefore needs a dedicated exit/path or an independently verified network/device control.

This is VPN-restricted access combined with SAML/MFA. It is one part of a wider SASE strategy, not a claim that device posture, centralized security policy or every other application is already integrated.

## Workers, telemetry and capacity

Background Microsoft Graph ingestion remains a separate least-privilege workload identity and does not depend on an employee's VPN session. If Graph notifications are enabled, provide a separate, bounded and verified webhook ingress with no customer-data reads or browser-session creation. Do not exempt the ordinary application routes. The SAML ACS is a browser POST and remains VPN-gated; it does not need an exception for Microsoft's server IPs.

Network failures produce generic access-denied responses and a bounded HTTP-denial audit event with `reason: 'network'`. The event contains no supplied IP, header value, cookie, assertion or arbitrary path. Audit-sink failure denies access with a generic unavailable result. Use separately reviewed edge/VPN telemetry for source-address investigation, with restricted access and retention.

The shared limiter uses the canonical address established by this policy. All employees sharing a VPN exit share the current address quota: login 10/15 minutes, ACS 20/15 minutes, logout 20/15 minutes, session/data 120/minute. These existing values are unchanged. Test concurrent login and expected user traffic before production; add reviewed edge, identity/session and abuse controls if needed rather than disabling throttling.

## Acceptance and remaining configuration

| Exercise | Required result |
|---|---|
| Approved VPN exit, signed MFA login, assigned user, allowed resource | Authorized operation succeeds |
| Approved exit but password-only/missing MFA, wrong tenant or unassigned identity | No session or private data |
| Unapproved source with a valid session and forged forwarded headers | Next protected request denies before session/resource work |
| VPN disconnect after successful login | New requests deny; returning to an approved path does not extend session lifetime |
| Off-network ACS with valid signed assertion and correlation cookie | No session; pending login remains unconsumed by the network-denied request |
| Direct origin/default host/alternate domain or forged proxy header | No bypass; an untrusted peer cannot supply the authoritative client IP |
| Missing, duplicate, chained or malformed dedicated proxy header | Deny without socket fallback |
| IPv6, split routing, DNS changes and VPN failover | Only approved observed exit addresses succeed |
| Real browser sign-in and concurrent users through one exit | Cookies, MFA, access denials and quotas behave correctly at intended capacity |

Local tests use fictional identities and real TLS connections with different loopback source addresses. They cover request-boundary behavior; they are not an actual VPN, deployed proxy or browser acceptance result. Record exact test results in [Implementation Status](Implementation-Status.md).

Before activation, prepare the exact domain/hosting configuration, dedicated public VPN exit list, dedicated proxy peers and overwrite behavior, private-origin binding, routing/failover evidence, Entra network/MFA policies and rollback procedure. Verify domain control before DNS/certificate changes. Apply live infrastructure, DNS and tenant changes only through the approved release package. The application must remain disconnected from private email until these and the [SAML security acceptance](Security-SAML-Access.md) gates pass.

Primary references: [Microsoft Entra network conditions](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-assignment-network) and [Azure Front Door origin protection](https://learn.microsoft.com/en-us/azure/frontdoor/origin-security).
