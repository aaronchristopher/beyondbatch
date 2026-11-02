/**
 * Current application authorization, NOT authentication.
 * The identity pair must come from the verified SAML server-session boundary.
 * Never expose this function as an HTTP identity/token-to-login endpoint.
 * Database grants and independently refreshed directory eligibility are required
 * on every call. No bearer verifier, demo principal or permissive fallback exists.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_ID = /^[a-z0-9][a-z0-9_.:-]{0,199}$/i;
const WORKSPACE_ROLES = Object.freeze({ pm: 'pm', department_member: 'department', president: 'president' });
const KNOWN_ROLES = new Set([...Object.keys(WORKSPACE_ROLES), 'reviewer', 'security_admin', 'integration_worker']);
const SCOPE_KINDS = new Set(['tenant', 'customer', 'department', 'request']);
const MAX_ELIGIBILITY_AGE_MS = 300_000;

export class ApplicationPrincipalError extends Error {
  constructor(code, statusCode) {
    super(statusCode === 401 ? 'Authentication required' : statusCode === 403 ? 'Access denied' : 'Authorization service unavailable');
    this.name = 'ApplicationPrincipalError'; this.code = code; this.statusCode = statusCode;
  }
}
const denied = () => new ApplicationPrincipalError('PRINCIPAL_ACCESS_DENIED', 403);
const unavailable = () => new ApplicationPrincipalError('AUTH_DEPENDENCY_UNAVAILABLE', 503);
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function uuid(value) { return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null; }
function id(value) { return typeof value === 'string' && LOCAL_ID.test(value); }
function nonempty(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
function dateMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  return Date.parse(value);
}
function readNow(clock) {
  const value = clock();
  const ms = value instanceof Date ? value.getTime() : dateMs(value);
  if (!Number.isFinite(ms) || ms < 0) throw unavailable();
  return { ms, iso: new Date(ms).toISOString() };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function activeGrants(row, nowMs) {
  if (!Array.isArray(row.grants) || row.grants.length > 10_000) throw denied();
  const seen = new Set(), active = [];
  for (const grant of row.grants) {
    if (!plain(grant) || !id(grant.id) || seen.has(grant.id)
        || grant.tenantId !== row.tenantId || grant.principalId !== row.id
        || !KNOWN_ROLES.has(grant.roleName) || !SCOPE_KINDS.has(grant.scopeKind)
        || !Object.hasOwn(grant, 'expiresAt') || !Object.hasOwn(grant, 'revokedAt')) throw denied();
    seen.add(grant.id);
    const expected = { customer: 'customerId', department: 'departmentKey', request: 'requestId' }[grant.scopeKind];
    for (const field of ['customerId', 'departmentKey', 'requestId']) {
      if (field === expected ? !id(grant[field]) : grant[field] !== null && grant[field] !== undefined) throw denied();
    }
    const starts = dateMs(grant.grantedAt);
    const expires = grant.expiresAt === null ? null : dateMs(grant.expiresAt);
    if (!Number.isFinite(starts) || (expires !== null && (!Number.isFinite(expires) || expires <= starts))) throw denied();
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
  const roles = [...new Set(active.filter(grant => Object.hasOwn(WORKSPACE_ROLES, grant.roleName)).map(grant => grant.roleName))];
  const selectedRole = row.workspaceRole ?? (roles.length === 1 ? roles[0] : null);
  if (!Object.hasOwn(WORKSPACE_ROLES, selectedRole) || !roles.includes(selectedRole)) throw denied();
  const selected = active.filter(grant => grant.roleName === selectedRole);
  return freeze({ id: row.id, tenantId: row.tenantId, name: row.name, role: WORKSPACE_ROLES[selectedRole],
    customerIds: [...new Set(selected.filter(grant => grant.scopeKind === 'customer').map(grant => grant.customerId))].sort(),
    departmentIds: [...new Set(selected.filter(grant => grant.scopeKind === 'department').map(grant => grant.departmentKey))].sort() });
}
function validateEligibility(eligibility, identity, nowMs) {
  if (!plain(eligibility) || uuid(eligibility.entraTenantId) !== identity.entraTenantId
      || uuid(eligibility.entraObjectId) !== identity.entraObjectId
      || eligibility.accountEnabled !== true || eligibility.appAssigned !== true) throw denied();
  const checkedAt = dateMs(eligibility.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > nowMs || nowMs - checkedAt > MAX_ELIGIBILITY_AGE_MS) throw unavailable();
}

export function createApplicationPrincipalResolver({ loadPrincipalRecord, loadEligibility, clock = () => new Date() } = {}) {
  if (typeof loadPrincipalRecord !== 'function') throw new TypeError('loadPrincipalRecord is required');
  if (typeof loadEligibility !== 'function') throw new TypeError('loadEligibility is required');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  return async function resolveApplicationPrincipal(input) {
    try {
      if (!plain(input) || !uuid(input.entraTenantId) || !uuid(input.entraObjectId)) {
        throw new ApplicationPrincipalError('INVALID_SESSION_IDENTITY', 401);
      }
      const identity = freeze({ entraTenantId: uuid(input.entraTenantId), entraObjectId: uuid(input.entraObjectId) });
      const started = readNow(clock), request = freeze({ ...identity, now: started.iso });
      let record, eligibility;
      try {
        [record, eligibility] = await Promise.all([loadPrincipalRecord(request), loadEligibility(request)]);
      } catch { throw unavailable(); }
      const finished = readNow(clock);
      if (finished.ms < started.ms) throw unavailable();
      validateEligibility(eligibility, identity, finished.ms);
      return mapPrincipal(record, identity, finished.ms);
    } catch (error) {
      if (error instanceof ApplicationPrincipalError) throw error;
      throw unavailable();
    }
  };
}
