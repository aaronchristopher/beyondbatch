import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationPrincipalResolver, ApplicationPrincipalError } from '../src/security/application-principal.mjs';

// Fictional authorization contracts only. This module does not authenticate SAML
// or call Microsoft; live eligibility/assignment propagation needs acceptance.
const tid = '11111111-1111-1111-1111-111111111111';
const oid = '22222222-2222-2222-2222-222222222222';
const other = '33333333-3333-3333-3333-333333333333';
const now = '2026-11-02T12:00:00.000Z';
const pair = () => ({ entraTenantId: tid, entraObjectId: oid });
const grant = (patch = {}) => ({ id: 'grant1', tenantId: 'db-tenant1', principalId: 'db-user1',
  roleName: 'pm', scopeKind: 'customer', customerId: 'customer1',
  grantedAt: '2026-11-01T12:00:00.000Z', expiresAt: null, revokedAt: null, ...patch });
const row = (patch = {}) => ({ id: 'db-user1', tenantId: 'db-tenant1', ...pair(),
  name: 'Fictional PM', principalType: 'user', status: 'active', tenantStatus: 'active', grants: [grant()], ...patch });
const eligibility = (patch = {}) => ({ ...pair(), accountEnabled: true, appAssigned: true, checkedAt: now, ...patch });
function setup({ record = row(), eligible = eligibility(), clock = () => new Date(now), loadPrincipalRecord, loadEligibility } = {}) {
  const seen = { records: [], eligibility: [] };
  return { seen, resolve: createApplicationPrincipalResolver({ clock,
    loadPrincipalRecord: async input => { seen.records.push(input); return loadPrincipalRecord ? loadPrincipalRecord(input) : record; },
    loadEligibility: async input => { seen.eligibility.push(input); return loadEligibility ? loadEligibility(input) : eligible; } }) };
}
const denied = status => error => error instanceof ApplicationPrincipalError && error.statusCode === status;

test('requires current grant and eligibility dependencies; no default allowlist or directory fallback', () => {
  assert.throws(() => createApplicationPrincipalResolver(), /loadPrincipalRecord/);
  assert.throws(() => createApplicationPrincipalResolver({ loadPrincipalRecord() {} }), /loadEligibility/);
  assert.throws(() => createApplicationPrincipalResolver({ loadPrincipalRecord() {}, loadEligibility() {}, clock: null }), /clock/);
});

test('maps immutable identity to current explicit grants and freezes the projection', async () => {
  const { resolve, seen } = setup();
  const result = await resolve(pair());
  assert.deepEqual(result, { id: 'db-user1', tenantId: 'db-tenant1', name: 'Fictional PM', role: 'pm', customerIds: ['customer1'], departmentIds: [] });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.customerIds));
  assert.deepEqual(seen.records, [{ ...pair(), now }]);
  assert.deepEqual(seen.eligibility, [{ ...pair(), now }]);
  assert.ok(Object.isFrozen(seen.records[0]));
});

test('invalid identities deny before either dependency is called', async () => {
  for (const identity of [null, undefined, 'token', {}, { ...pair(), entraObjectId: 'person@example.test' }, { ...pair(), entraTenantId: '*' }]) {
    const { resolve, seen } = setup();
    await assert.rejects(resolve(identity), denied(401));
    assert.equal(seen.records.length, 0); assert.equal(seen.eligibility.length, 0);
  }
});

test('caller roles and names cannot confer access or replace the directory identity', async () => {
  const principal = await setup().resolve({ ...pair(), role: 'president', name: 'President', customerIds: ['secret'] });
  assert.equal(principal.role, 'pm'); assert.deepEqual(principal.customerIds, ['customer1']);
  assert.equal(principal.name, 'Fictional PM');
});

test('missing, disabled, service, wrong-tenant or wrong-user records deny', async () => {
  for (const record of [null, row({ status: 'disabled' }), row({ tenantStatus: 'disabled' }),
    row({ principalType: 'service' }), row({ entraTenantId: other }), row({ entraObjectId: other }), row({ revokedAt: now })]) {
    await assert.rejects(setup({ record }).resolve(pair()), denied(403));
  }
});

test('assignment and account state require exact booleans bound to the same identity', async () => {
  for (const eligible of [null, eligibility({ accountEnabled: false }), eligibility({ appAssigned: false }),
    eligibility({ accountEnabled: 'true' }), eligibility({ appAssigned: undefined }),
    eligibility({ entraTenantId: other }), eligibility({ entraObjectId: other })]) {
    await assert.rejects(setup({ eligible }).resolve(pair()), denied(403));
  }
});

test('eligibility snapshots fail closed if absent, future, malformed or older than five minutes', async () => {
  for (const checkedAt of [undefined, null, '', '2026-11-02', 'bad-date', '2026-11-02T12:00:00.001Z', '2026-11-02T11:54:59.999Z']) {
    await assert.rejects(setup({ eligible: eligibility({ checkedAt }) }).resolve(pair()), denied(503));
  }
  assert.equal((await setup({ eligible: eligibility({ checkedAt: '2026-11-02T11:55:00.000Z' }) }).resolve(pair())).role, 'pm');
});

test('time is rechecked after awaited dependencies so eligibility cannot age out in flight', async () => {
  let current = new Date(now);
  const { resolve } = setup({ clock: () => current, loadEligibility: () => {
    current = new Date(Date.parse(now) + 300_001); return eligibility();
  } });
  await assert.rejects(resolve(pair()), denied(503));
});

test('a grant that expires during dependency work cannot authorize the returned principal', async () => {
  let current = new Date(now);
  const { resolve } = setup({ clock: () => current,
    record: row({ grants: [grant({ expiresAt: '2026-11-02T12:00:00.500Z' })] }),
    loadEligibility: () => { current = new Date(Date.parse(now) + 1000); return eligibility(); } });
  await assert.rejects(resolve(pair()), denied(403));
});

test('caller identity changes during dependency work cannot retarget the authorization lookup', async () => {
  const input = pair();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { resolve, seen } = setup({ loadPrincipalRecord: async () => { await gate; return row(); } });
  const pending = resolve(input);
  input.entraObjectId = other;
  release();
  assert.equal((await pending).id, 'db-user1');
  assert.equal(seen.records[0].entraObjectId, oid);
  assert.equal(seen.eligibility[0].entraObjectId, oid);
});

test('clock failure or backwards movement denies rather than extending access', async () => {
  await assert.rejects(setup({ clock: () => new Date(NaN) }).resolve(pair()), denied(503));
  let calls = 0;
  await assert.rejects(setup({ clock: () => new Date(Date.parse(now) - calls++ * 1000) }).resolve(pair()), denied(503));
});

test('principal and directory status are reloaded on every operation', async () => {
  let current = row(), enabled = eligibility();
  const { resolve, seen } = setup({ loadPrincipalRecord: () => current, loadEligibility: () => enabled });
  await resolve(pair());
  current = row({ grants: [grant({ revokedAt: now })] });
  await assert.rejects(resolve(pair()), denied(403));
  current = row(); enabled = eligibility({ appAssigned: false });
  await assert.rejects(resolve(pair()), denied(403));
  assert.equal(seen.records.length, 3); assert.equal(seen.eligibility.length, 3);
});

test('malformed, duplicate, cross-principal and wildcard grants deny', async () => {
  for (const grants of [null, [grant(), grant()], [grant({ tenantId: 'wrong' })], [grant({ principalId: 'wrong' })],
    [grant({ customerId: '*' })], [grant({ departmentKey: 'qa' })], [grant({ expiresAt: undefined })],
    [grant({ revokedAt: undefined })], [grant({ roleName: 'admin' })]]) {
    await assert.rejects(setup({ record: row({ grants }) }).resolve(pair()), denied(403));
  }
});

test('expired, revoked and not-yet-active grants do not grant a role', async () => {
  for (const patch of [{ expiresAt: now }, { revokedAt: now }, { revokedAt: 'bad' }, { grantedAt: '2026-11-03T12:00:00Z' }]) {
    await assert.rejects(setup({ record: row({ grants: [grant(patch)] }) }).resolve(pair()), denied(403));
  }
});

test('mixed roles cannot union permissions or silently select executive access', async () => {
  const grants = [grant(), grant({ id: 'g2', roleName: 'president', customerId: 'customer2' })];
  await assert.rejects(setup({ record: row({ grants }) }).resolve(pair()), denied(403));
  const result = await setup({ record: row({ grants, workspaceRole: 'president' }) }).resolve(pair());
  assert.equal(result.role, 'president'); assert.deepEqual(result.customerIds, ['customer2']);
});

test('department role requires its own scoped grants; tenant/request grants never become all customers', async () => {
  const grants = [grant({ roleName: 'department_member' }), grant({ id: 'dept', roleName: 'department_member', scopeKind: 'department', customerId: null, departmentKey: 'qa' })];
  const result = await setup({ record: row({ grants }) }).resolve(pair());
  assert.equal(result.role, 'department'); assert.deepEqual(result.customerIds, ['customer1']); assert.deepEqual(result.departmentIds, ['qa']);
  const narrow = await setup({ record: row({ grants: [grant({ scopeKind: 'request', customerId: null, requestId: 'r1' })] }) }).resolve(pair());
  assert.deepEqual(narrow.customerIds, []);
});

test('dependency exceptions are bounded and carry no secret details or causes', async () => {
  for (const name of ['loadPrincipalRecord', 'loadEligibility']) {
    await assert.rejects(setup({ [name]: () => { throw new Error('secret-token postgres://password'); } }).resolve(pair()), error => {
      assert.ok(denied(503)(error)); assert.equal(error.cause, undefined);
      assert.equal(error.message, 'Authorization service unavailable');
      assert.ok(!JSON.stringify(error).includes('secret-token')); return true;
    });
  }
});
