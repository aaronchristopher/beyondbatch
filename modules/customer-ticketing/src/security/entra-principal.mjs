/**
 * LEGACY development-only delegated Entra API principal boundary.
 *
 * SAML 2.0 with enforced Entra MFA supersedes this proposed human-login flow.
 * Construction and resolution are disabled in production. This retained fixture
 * boundary is not a SAML implementation and must never be wired as a fallback
 * for production user sessions. Workload Graph credentials are a separate path.
 *
 * This module does NOT implement JWT signature verification or sign-in. The
 * injected verifyAccessToken MUST perform cryptographic verification using a
 * maintained production library and trusted issuer metadata before returning
 * { tokenUse: 'access_token', claims }. A decode-only function is NOT a verifier.
 * No JWT claims, client-selected roles, or proxy identity headers become grants.
 *
 * loadPrincipal({ entraTenantId, entraObjectId, now }) must read the trusted
 * database on every resolution and return the normalized contract documented in
 * docs/Entra-Principal-Integration.md. Roles/scopes originate only in that record.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_ID = /^[a-z0-9][a-z0-9_.:-]{0,199}$/i;
const WORKSPACE_ROLES = Object.freeze({ pm: 'pm', department_member: 'department', president: 'president' });
const KNOWN_ROLES = new Set([...Object.keys(WORKSPACE_ROLES), 'reviewer', 'security_admin', 'integration_worker']);
const SCOPE_KINDS = new Set(['tenant', 'customer', 'department', 'request']);

export class PrincipalResolutionError extends Error {
  constructor(code, statusCode) {
    super(statusCode === 401 ? 'Authentication required' : statusCode === 403 ? 'Access denied' : 'Authentication service unavailable');
    this.name = 'PrincipalResolutionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
const unauthenticated = () => new PrincipalResolutionError('INVALID_ACCESS_TOKEN', 401);
const denied = () => new PrincipalResolutionError('PRINCIPAL_ACCESS_DENIED', 403);
const unavailable = () => new PrincipalResolutionError('AUTH_DEPENDENCY_UNAVAILABLE', 503);
function requireLegacyDevelopmentEnvironment() {
  if (process.env.NODE_ENV === 'production') throw new PrincipalResolutionError('LEGACY_BEARER_DISABLED', 503);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function own(value, key) { return Object.hasOwn(value, key); }
function nonempty(value, max = 200) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
function uuid(value) { return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null; }
function id(value) { return typeof value === 'string' && LOCAL_ID.test(value); }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function configError(field) { throw new TypeError(`Invalid principal resolver configuration: ${field}`); }
function dateMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  return Date.parse(value);
}
function readNow(clock) {
  let value;
  try { value = clock(); } catch { throw unavailable(); }
  const ms = value instanceof Date ? value.getTime() : dateMs(value);
  if (!Number.isFinite(ms)) throw unavailable();
  return { ms, seconds: Math.floor(ms / 1000), iso: new Date(ms).toISOString() };
}
function audienceMatches(actual, expected) {
  if (typeof actual === 'string') return actual === expected;
  return Array.isArray(actual) && actual.length > 0 && actual.length <= 10
    && actual.every(item => nonempty(item, 2048)) && new Set(actual).size === actual.length
    && actual.includes(expected);
}
function validateClaims(result, policy, now) {
  if (!plain(result) || result.tokenUse !== 'access_token' || !plain(result.claims)) throw unauthenticated();
  const claims = result.claims;
  for (const field of ['tid', 'oid', 'iss', 'aud', 'exp', 'nbf', 'iat', 'scp']) {
    if (!own(claims, field)) throw unauthenticated();
  }
  const entraTenantId = uuid(claims.tid), entraObjectId = uuid(claims.oid);
  if (entraTenantId !== policy.tenantId || !entraObjectId || claims.iss !== policy.issuer
      || !audienceMatches(claims.aud, policy.audience)) throw unauthenticated();
  for (const field of ['exp', 'nbf', 'iat']) {
    if (!Number.isSafeInteger(claims[field]) || claims[field] < 0) throw unauthenticated();
  }
  // Deliberately no local grace period. The trusted verifier receives this policy.
  if (claims.exp <= now.seconds || claims.nbf > now.seconds || claims.iat > now.seconds
      || claims.exp <= claims.nbf || claims.exp <= claims.iat) throw unauthenticated();
  // This resolver is for interactive delegated API access, not ID/app-only tokens.
  if (claims.idtyp === 'app' || !nonempty(claims.scp, 4096)
      || !claims.scp.split(/\s+/).includes(policy.requiredScope)) throw unauthenticated();
  return { entraTenantId, entraObjectId, expiresAtSeconds: claims.exp };
}
function activeGrants(row, nowMs) {
  if (!Array.isArray(row.grants) || row.grants.length > 10_000) throw denied();
  const seen = new Set(), active = [];
  for (const grant of row.grants) {
    if (!plain(grant) || !id(grant.id) || seen.has(grant.id)
        || grant.tenantId !== row.tenantId || grant.principalId !== row.id
        || !KNOWN_ROLES.has(grant.roleName) || !SCOPE_KINDS.has(grant.scopeKind)
        || !own(grant, 'expiresAt') || !own(grant, 'revokedAt')) throw denied();
    seen.add(grant.id);
    const scopeFields = ['customerId', 'departmentKey', 'requestId'];
    const expected = { customer: 'customerId', department: 'departmentKey', request: 'requestId' }[grant.scopeKind];
    for (const field of scopeFields) {
      if (field === expected ? !id(grant[field]) : grant[field] !== null && grant[field] !== undefined) throw denied();
    }
    const starts = dateMs(grant.grantedAt);
    const expires = grant.expiresAt === null ? null : dateMs(grant.expiresAt);
    if (!Number.isFinite(starts) || (expires !== null && (!Number.isFinite(expires) || expires <= starts))) throw denied();
    // Any explicit revocation denies the grant, including a malformed/future value.
    if (grant.revokedAt !== null || starts > nowMs || (expires !== null && expires <= nowMs)) continue;
    active.push(grant);
  }
  return active;
}
function mapPrincipal(row, identity, nowMs) {
  if (!plain(row) || !id(row.id) || !id(row.tenantId) || !nonempty(row.name)
      || uuid(row.entraTenantId) !== identity.entraTenantId || uuid(row.entraObjectId) !== identity.entraObjectId
      || row.status !== 'active' || row.principalType !== 'user'
      || !['pilot', 'active'].includes(row.tenantStatus)
      || (row.revokedAt !== undefined && row.revokedAt !== null)) throw denied();
  const active = activeGrants(row, nowMs);
  const availableRoles = [...new Set(active.filter(grant => own(WORKSPACE_ROLES, grant.roleName)).map(grant => grant.roleName))];
  const selectedRole = row.workspaceRole ?? (availableRoles.length === 1 ? availableRoles[0] : null);
  if (!own(WORKSPACE_ROLES, selectedRole) || !availableRoles.includes(selectedRole)) throw denied();
  // Never promote one role while unioning in another role's customer scopes.
  const selectedGrants = active.filter(grant => grant.roleName === selectedRole);
  const customerIds = [...new Set(selectedGrants.filter(grant => grant.scopeKind === 'customer').map(grant => grant.customerId))].sort();
  const departmentIds = [...new Set(selectedGrants.filter(grant => grant.scopeKind === 'department').map(grant => grant.departmentKey))].sort();
  return freeze({ id: row.id, tenantId: row.tenantId, name: row.name, role: WORKSPACE_ROLES[selectedRole], customerIds, departmentIds });
}

/**
 * createPrincipalResolver({ tenantId, audience, issuer, verifyAccessToken,
 *   loadPrincipal, requiredScope='access_as_user', clock=()=>new Date() })
 * -> async resolvePrincipal(rawAccessToken) -> immutable workspace principal.
 * tenantId is the approved ENTRA tenant UUID; returned tenantId is the DB tenant.
 * No fallback verifier/loader, no token decoding, no principal or grant cache.
 */
export function createPrincipalResolver({ tenantId, audience, issuer, verifyAccessToken,
  loadPrincipal, requiredScope = 'access_as_user', clock = () => new Date() } = {}) {
  requireLegacyDevelopmentEnvironment();
  const approvedTenantId = uuid(tenantId);
  if (!approvedTenantId) configError('tenantId');
  if (!nonempty(audience, 2048)) configError('audience');
  let issuerUrl;
  try { issuerUrl = new URL(issuer); } catch { configError('issuer'); }
  if (typeof issuer !== 'string' || issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password
      || issuerUrl.search || issuerUrl.hash || !issuerUrl.hostname) configError('issuer');
  if (typeof verifyAccessToken !== 'function') configError('verifyAccessToken');
  if (typeof loadPrincipal !== 'function') configError('loadPrincipal');
  if (!nonempty(requiredScope, 200) || /\s/.test(requiredScope)) configError('requiredScope');
  if (typeof clock !== 'function') configError('clock');
  const policy = freeze({ tenantId: approvedTenantId, audience, issuer, requiredScope,
    tokenUse: 'access_token', clockToleranceSeconds: 0 });
  return async function resolvePrincipal(rawAccessToken) {
    requireLegacyDevelopmentEnvironment();
    // HTTP adapter extracts a single Authorization: Bearer value. Headers, cookies,
    // query personas and decoded principal objects are never accepted here.
    if (typeof rawAccessToken !== 'string' || !rawAccessToken.length || rawAccessToken.length > 16_384
        || /\s|[\u0000-\u001f\u007f]/.test(rawAccessToken)) throw unauthenticated();
    const verificationTime = readNow(clock);
    let verification;
    try {
      verification = await verifyAccessToken(rawAccessToken, freeze({ ...policy, now: verificationTime.iso }));
    } catch { throw unauthenticated(); }
    const identity = validateClaims(verification, policy, verificationTime);
    let row;
    try {
      row = await loadPrincipal(freeze({ entraTenantId: identity.entraTenantId,
        entraObjectId: identity.entraObjectId, now: verificationTime.iso }));
    } catch { throw unavailable(); }
    // Recheck time after asynchronous dependencies; don't return an already expired identity.
    const authorizationTime = readNow(clock);
    if (identity.expiresAtSeconds <= authorizationTime.seconds) throw unauthenticated();
    requireLegacyDevelopmentEnvironment();
    return mapPrincipal(row, identity, authorizationTime.ms);
  };
}
