import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPrincipalRecordLoader } from '../src/persistence/postgres-principal-loader.mjs';
import { createApplicationPrincipalResolver } from '../src/security/application-principal.mjs';
import { createPostgresFixture, AT } from './helpers/postgres-fixture.mjs';

// Native PostgreSQL only: missing disposable loopback configuration is an error,
// not a skip. Every identity/record is generated fictional data. Directory
// eligibility is a deliberate fixture, not evidence of a Microsoft connection.
test('native PostgreSQL current SAML principal lookup', { timeout: 90000 }, async t => {
  const f = await createPostgresFixture();
  t.after(() => f.close());
  const { rows: [{ role }] } = await f.pool.query('SELECT current_user AS role');
  assert.match(role, /^bb_test_app_[0-9a-f]{16}$/);
  // The shared request-store fixture does not read grants. Add only the SELECT
  // needed for this distinct read-only adapter inside this disposable test.
  // This is not a production role-policy approval or a grant-writing capability.
  await f.admin.query(`GRANT SELECT ON bb.role_grants TO "${role}"`);
  async function seed() {
    const tenant = await f.tenant();
    const { rows: [identity] } = await f.admin.query(`SELECT t.entra_tenant_id, p.entra_object_id
      FROM bb.tenants t JOIN bb.principals p ON p.tenant_id = t.id
      WHERE t.id = $1 AND p.id = $2`, [tenant.tenantId, tenant.ownerId]);
    const pair = { entraTenantId: identity.entra_tenant_id, entraObjectId: identity.entra_object_id };
    const grantId = randomUUID();
    await f.admin.query(`INSERT INTO bb.role_grants
      (tenant_id,id,principal_id,role_name,scope_kind,customer_id,granted_by,granted_at,reason)
      VALUES ($1,$2,$3,'pm','customer',$4,$5,$6,'Fictional native principal lookup')`,
    [tenant.tenantId, grantId, tenant.ownerId, tenant.customerId, tenant.actorId, AT]);
    const load = createPostgresPrincipalRecordLoader({ pool: f.pool, dbTenantId: tenant.tenantId, entraTenantId: pair.entraTenantId });
    return { tenant, pair, grantId, load };
  }

  await t.test('native rows map to the expected immutable identity and explicit grant fields', async () => {
    const { tenant, pair, grantId, load } = await seed();
    assert.deepEqual(await load(pair), {
      id: tenant.ownerId, tenantId: tenant.tenantId, ...pair, name: 'Fictional PM',
      principalType: 'user', status: 'active', tenantStatus: 'pilot', grants: [{
        id: grantId, tenantId: tenant.tenantId, principalId: tenant.ownerId, roleName: 'pm',
        scopeKind: 'customer', customerId: tenant.customerId, departmentKey: null, requestId: null,
        grantedAt: AT, expiresAt: null, revokedAt: null,
      }],
    });
    const freshPoolLoad = createPostgresPrincipalRecordLoader({ pool: f.newPool(), dbTenantId: tenant.tenantId, entraTenantId: pair.entraTenantId });
    assert.deepEqual(await freshPoolLoad(pair), await load(pair));
  });

  await t.test('wrong tenant, missing user and another tenant user cannot resolve through the fixed mapping', async () => {
    const one = await seed(), two = await seed();
    assert.equal(await one.load(two.pair), null);
    assert.equal(await one.load({ ...one.pair, entraObjectId: randomUUID() }), null);
    assert.equal(await one.load({ ...one.pair, entraObjectId: two.pair.entraObjectId }), null);
    const incorrectMap = createPostgresPrincipalRecordLoader({ pool: f.pool,
      dbTenantId: two.tenant.tenantId, entraTenantId: one.pair.entraTenantId });
    assert.equal(await incorrectMap(one.pair), null);
  });

  await t.test('grant revocation and disabled principals are observed on the next operation', async () => {
    const { tenant, pair, grantId, load } = await seed();
    const current = '2026-01-05T09:00:00.000Z';
    const resolve = createApplicationPrincipalResolver({ loadPrincipalRecord: load,
      loadEligibility: async input => ({ entraTenantId: input.entraTenantId, entraObjectId: input.entraObjectId,
        accountEnabled: true, appAssigned: true, checkedAt: current }), clock: () => new Date(current) });
    assert.deepEqual((await resolve(pair)).customerIds, [tenant.customerId]);
    const revokedAt = '2026-01-05T08:30:00.000Z';
    await f.admin.query('UPDATE bb.role_grants SET revoked_at=$1 WHERE tenant_id=$2 AND id=$3', [revokedAt, tenant.tenantId, grantId]);
    assert.equal((await load(pair)).grants[0].revokedAt, revokedAt);
    await assert.rejects(resolve(pair), error => error.statusCode === 403);
    await f.admin.query('UPDATE bb.role_grants SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2', [tenant.tenantId, grantId]);
    await f.admin.query("UPDATE bb.principals SET status='disabled' WHERE tenant_id=$1 AND id=$2", [tenant.tenantId, tenant.ownerId]);
    assert.equal((await load(pair)).status, 'disabled');
    await assert.rejects(resolve(pair), error => error.statusCode === 403);
  });

  await t.test('restricted login stays read-only and transaction tenant context does not leak into pooled reads', async () => {
    const { tenant, pair } = await seed();
    const observations = [];
    const observedPool = { async connect() {
      const client = await f.pool.connect();
      return { async query(sql, values) {
        if (sql.includes('FROM bb.principals')) {
          observations.push((await client.query(`SELECT current_setting('transaction_read_only') AS read_only,
            current_setting('transaction_isolation') AS isolation,
            current_setting('app.tenant_id', true) AS tenant`)).rows[0]);
        }
        return client.query(sql, values);
      }, release(error) { client.release(error); } };
    } };
    const load = createPostgresPrincipalRecordLoader({ pool: observedPool, dbTenantId: tenant.tenantId, entraTenantId: pair.entraTenantId });
    assert.equal((await load(pair)).id, tenant.ownerId);
    assert.deepEqual(observations, [{ read_only: 'on', isolation: 'repeatable read', tenant: tenant.tenantId }]);
    const { rows: [rights] } = await f.pool.query(`SELECT r.rolsuper, r.rolbypassrls,
      has_table_privilege(current_user, 'bb.role_grants', 'SELECT') AS grant_read,
      has_table_privilege(current_user, 'bb.role_grants', 'INSERT') AS grant_insert,
      has_table_privilege(current_user, 'bb.role_grants', 'UPDATE') AS grant_update,
      has_column_privilege(current_user, 'bb.principals', 'status', 'UPDATE') AS status_update
      FROM pg_roles r WHERE r.rolname = current_user`);
    assert.deepEqual(rights, { rolsuper: false, rolbypassrls: false, grant_read: true,
      grant_insert: false, grant_update: false, status_update: false });
    assert.equal((await f.pool.query('SELECT * FROM bb.role_grants')).rowCount, 0);
    assert.equal((await f.pool.query('SELECT * FROM bb.principals')).rowCount, 0);
  });
});
