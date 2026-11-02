/**
 * Read-only application-grant lookup against db/001_core.sql.
 * Fixed tenant configuration is trusted server composition, never browser input.
 * This loader does not authenticate identities or verify Entra eligibility.
 * Use it only behind verified SAML sessions and the required eligibility check.
 */
import { ApplicationPrincipalError } from '../security/application-principal.mjs';

function uuid(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}
const unavailable = () => new ApplicationPrincipalError('AUTH_DEPENDENCY_UNAVAILABLE', 503);
function instant(value) {
  if (value === null) return null;
  if (!(value instanceof Date) && typeof value !== 'string') throw unavailable();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw unavailable();
  return parsed.toISOString();
}

export function createPostgresPrincipalRecordLoader({ pool, dbTenantId, entraTenantId } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect is required');
  const approvedDbTenant = uuid(dbTenantId, 'dbTenantId');
  const approvedEntraTenant = uuid(entraTenantId, 'entraTenantId');
  return async function loadPrincipalRecord(identity) {
    const requestedTenant = uuid(identity?.entraTenantId, 'identity.entraTenantId');
    const requestedUser = uuid(identity?.entraObjectId, 'identity.entraObjectId');
    if (requestedTenant !== approvedEntraTenant) return null;
    let client, begun = false, beginning = true, committing = false, discard = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      begun = true; beginning = false;
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [approvedDbTenant]);
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const principals = await client.query(`SELECT p.id, p.tenant_id, p.entra_object_id,
          p.display_name, p.principal_type, p.status, t.entra_tenant_id, t.status AS tenant_status
        FROM bb.principals p JOIN bb.tenants t ON t.id = p.tenant_id
        WHERE p.tenant_id = $1 AND t.entra_tenant_id = $2 AND p.entra_object_id = $3`,
      [approvedDbTenant, approvedEntraTenant, requestedUser]);
      if (!Array.isArray(principals.rows) || principals.rows.length > 1) throw unavailable();
      const row = principals.rows[0];
      let result = null;
      if (row) {
        if (row.tenant_id !== approvedDbTenant || row.entra_tenant_id !== approvedEntraTenant
            || row.entra_object_id !== requestedUser) throw unavailable();
        const grants = await client.query(`SELECT id, tenant_id, principal_id, role_name, scope_kind,
            customer_id, department_key, request_id, granted_at, expires_at, revoked_at
          FROM bb.role_grants WHERE tenant_id = $1 AND principal_id = $2
          ORDER BY id LIMIT 10001`, [approvedDbTenant, row.id]);
        if (!Array.isArray(grants.rows) || grants.rows.length > 10_000) throw unavailable();
        result = { id: row.id, tenantId: row.tenant_id, entraTenantId: row.entra_tenant_id,
          entraObjectId: row.entra_object_id, name: row.display_name, principalType: row.principal_type,
          status: row.status, tenantStatus: row.tenant_status,
          grants: grants.rows.map(grant => ({ id: grant.id, tenantId: grant.tenant_id, principalId: grant.principal_id,
            roleName: grant.role_name, scopeKind: grant.scope_kind, customerId: grant.customer_id,
            departmentKey: grant.department_key, requestId: grant.request_id,
            grantedAt: instant(grant.granted_at), expiresAt: instant(grant.expires_at), revokedAt: instant(grant.revoked_at) })) };
      }
      committing = true;
      await client.query('COMMIT'); begun = false;
      return result;
    } catch {
      discard = beginning || committing;
      if (client && begun) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
      }
      throw unavailable();
    } finally {
      if (client) {
        try { client.release(discard ? new Error('discard uncertain authorization connection') : undefined); }
        catch { throw unavailable(); }
      }
    }
  };
}
