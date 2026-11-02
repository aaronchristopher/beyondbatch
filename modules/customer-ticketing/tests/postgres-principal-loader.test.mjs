import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresPrincipalRecordLoader } from '../src/persistence/postgres-principal-loader.mjs';

const dbTenantId = '11111111-1111-1111-1111-111111111111';
const entraTenantId = '22222222-2222-2222-2222-222222222222';
const entraObjectId = '33333333-3333-3333-3333-333333333333';
const userId = '44444444-4444-4444-4444-444444444444';
const grantId = '55555555-5555-5555-5555-555555555555';
const now = '2026-11-02T12:00:00.000Z';
const dbRow = () => ({ id: userId, tenant_id: dbTenantId, entra_object_id: entraObjectId,
  entra_tenant_id: entraTenantId, display_name: 'Fictional PM', principal_type: 'user', status: 'active', tenant_status: 'pilot' });
const dbGrant = () => ({ id: grantId, tenant_id: dbTenantId, principal_id: userId, role_name: 'pm', scope_kind: 'customer',
  customer_id: '66666666-6666-6666-6666-666666666666', department_key: null, request_id: null,
  granted_at: new Date(now), expires_at: null, revoked_at: null });
function harness({ records = [dbRow()], grants = [dbGrant()], failOn, failRollback = false, connectError = false } = {}) {
  const queries = [], releases = [];
  const client = { async query(sql, values) {
    queries.push({ sql, values });
    if (failOn && sql.includes(failOn) || failRollback && sql === 'ROLLBACK') throw new Error('secret connection material');
    return { rows: sql.includes('FROM bb.principals') ? records : sql.includes('FROM bb.role_grants') ? grants : [] };
  }, release(value) { releases.push(value); } };
  const pool = { async connect() { if (connectError) throw new Error('secret connection material'); return client; } };
  return { queries, releases, load: createPostgresPrincipalRecordLoader({ pool, dbTenantId, entraTenantId }) };
}
const identity = () => ({ entraTenantId, entraObjectId, now });

test('requires fixed approved tenant mapping and a real pool contract', () => {
  assert.throws(() => createPostgresPrincipalRecordLoader({}), /pool/);
  assert.throws(() => createPostgresPrincipalRecordLoader({ pool: { connect() {} }, dbTenantId: '*', entraTenantId }), /dbTenantId/);
  assert.throws(() => createPostgresPrincipalRecordLoader({ pool: { connect() {} }, dbTenantId, entraTenantId: 'common' }), /entraTenantId/);
});

test('loads coherent principal/grants under a fixed transaction-local tenant without exposing email', async () => {
  const { load, queries, releases } = harness();
  const result = await load(identity());
  assert.deepEqual(result, { id: userId, tenantId: dbTenantId, entraTenantId, entraObjectId,
    name: 'Fictional PM', principalType: 'user', status: 'active', tenantStatus: 'pilot', grants: [{
      id: grantId, tenantId: dbTenantId, principalId: userId, roleName: 'pm', scopeKind: 'customer',
      customerId: '66666666-6666-6666-6666-666666666666', departmentKey: null, requestId: null,
      grantedAt: now, expiresAt: null, revokedAt: null,
    }] });
  assert.match(queries[0].sql, /^BEGIN.*REPEATABLE READ.*READ ONLY/);
  const bind = queries.find(query => query.sql.includes('set_config'));
  assert.deepEqual(bind.values, [dbTenantId]);
  const principalQuery = queries.find(query => query.sql.includes('FROM bb.principals'));
  assert.deepEqual(principalQuery.values, [dbTenantId, entraTenantId, entraObjectId]);
  assert.ok(!principalQuery.sql.includes(entraObjectId));
  assert.ok(!principalQuery.sql.includes('email_address'));
  assert.equal(queries.at(-1).sql, 'COMMIT'); assert.deepEqual(releases, [undefined]);
});

test('different tenant or malformed identity never opens a database connection', async () => {
  const { load, queries } = harness();
  assert.equal(await load({ ...identity(), entraTenantId: userId }), null);
  await assert.rejects(load({ ...identity(), entraObjectId: "' OR 1=1 --" }), /identity/);
  assert.equal(queries.length, 0);
});

test('missing identity returns null and does not read any grant rows', async () => {
  const { load, queries, releases } = harness({ records: [] });
  assert.equal(await load(identity()), null);
  assert.ok(!queries.some(query => query.sql.includes('FROM bb.role_grants')));
  assert.equal(queries.at(-1).sql, 'COMMIT'); assert.deepEqual(releases, [undefined]);
});

test('duplicate or mismatched database identity fails closed', async () => {
  for (const records of [[dbRow(), dbRow()], [{ ...dbRow(), tenant_id: userId }], [{ ...dbRow(), entra_object_id: userId }]]) {
    await assert.rejects(harness({ records }).load(identity()), error => error.code === 'AUTH_DEPENDENCY_UNAVAILABLE');
  }
});

test('disabled and revoked data remain explicit for the current principal policy to deny', async () => {
  const result = await harness({ records: [{ ...dbRow(), status: 'disabled' }], grants: [{ ...dbGrant(), revoked_at: new Date(now) }] }).load(identity());
  assert.equal(result.status, 'disabled'); assert.equal(result.grants[0].revokedAt, now);
  assert.equal(result.workspaceRole, undefined);
});

test('read errors roll back and suppress connection secrets', async () => {
  const { load, queries, releases } = harness({ failOn: 'FROM bb.role_grants' });
  await assert.rejects(load(identity()), error => {
    assert.equal(error.code, 'AUTH_DEPENDENCY_UNAVAILABLE'); assert.equal(error.statusCode, 503);
    assert.equal(error.cause, undefined); assert.ok(!error.message.includes('secret')); return true;
  });
  assert.equal(queries.at(-1).sql, 'ROLLBACK'); assert.deepEqual(releases, [undefined]);
});

test('uncertain begin/commit/rollback failure discards the client', async () => {
  for (const options of [{ failOn: 'BEGIN' }, { failOn: 'COMMIT' }, { failOn: 'FROM bb.principals', failRollback: true }]) {
    const { load, releases } = harness(options);
    await assert.rejects(load(identity()), error => error.statusCode === 503);
    assert.equal(releases.length, 1); assert.ok(releases[0] instanceof Error);
    assert.ok(!releases[0].message.includes('secret'));
  }
});

test('connection acquisition failure is a bounded unavailable error', async () => {
  await assert.rejects(harness({ connectError: true }).load(identity()), error => error.statusCode === 503 && !error.message.includes('secret'));
});
