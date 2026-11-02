import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createPostgresAuthStore } from '../src/persistence/postgres-auth-store.mjs';
import { createPostgresAuthFixture } from './helpers/postgres-auth-fixture.mjs';

const NOW = Date.parse('2026-01-05T08:00:00Z');
const MINUTE = 60_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const key = value => `test:${hash(value)}`;
function session(label, patch = {}) {
  return {
    key: hash(label), entraTenantId: '10000000-0000-4000-8000-000000000001',
    entraObjectId: '20000000-0000-4000-8000-000000000001', csrfHash: hash(`csrf:${label}`),
    createdAtMs: NOW, lastSeenAtMs: NOW, expiresAtMs: NOW + 8 * 60 * MINUTE,
    reauthAtMs: NOW + 60 * MINUTE, ...patch,
  };
}

// Deliberately excluded from the fast *.test.mjs glob. Missing native database
// configuration fails rather than silently skipping security persistence tests.
test('native PostgreSQL shared SAML and session storage', { timeout: 90000 }, async t => {
  const fixture = await createPostgresAuthFixture();
  t.after(() => fixture.close());
  const namespace = () => `auth-test:${randomUUID()}`;
  const store = (name = namespace(), pool = fixture.pool) => createPostgresAuthStore({ pool, namespace: name });

  await t.test('runtime role is restricted and PUBLIC has no schema/table access', async () => {
    const { rows: [role] } = await fixture.pool.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    const { rows: [access] } = await fixture.admin.query(`SELECT
      EXISTS(SELECT 1 FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
        WHERE n.nspname='bb_auth' AND a.grantee=0) AS public_schema,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
        LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        WHERE n.nspname='bb_auth' AND c.relkind='r' AND a.grantee=0) AS public_tables`);
    assert.deepEqual(access, { public_schema: false, public_tables: false });
    await assert.rejects(fixture.pool.query('CREATE TABLE bb_auth.forbidden_test(id integer)'), error => error.code === '42501');
  });

  await t.test('entries preserve JSON across adapters and expire at the exact boundary', async () => {
    const name = namespace(), first = store(name), second = store(name, fixture.newPool());
    const value = { requestId: '_fictional', browserHash: hash('browser'), flags: [true, null, 3] };
    assert.equal(await first.insert(key('persist'), value, NOW + MINUTE), true);
    assert.deepEqual(await second.get(key('persist'), NOW), { value, expiresAtMs: NOW + MINUTE });
    assert.deepEqual(await second.get(key('persist'), NOW + MINUTE - 1), { value, expiresAtMs: NOW + MINUTE });
    assert.equal(await second.get(key('persist'), NOW + MINUTE), null);
    assert.equal(await second.consume(key('persist'), NOW + MINUTE), null);
    assert.equal(await first.get(key('missing'), NOW), null);
  });

  await t.test('concurrent insert-if-absent keeps exactly one replay marker', async () => {
    const shared = store();
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => shared.insert(key('assertion'), { attempt: i }, NOW + MINUTE)));
    assert.equal(attempts.filter(Boolean).length, 1);
    const winner = attempts.findIndex(Boolean);
    assert.deepEqual(await shared.get(key('assertion'), NOW), { value: { attempt: winner }, expiresAtMs: NOW + MINUTE });
    assert.equal(await shared.insert(key('assertion'), { replaced: true }, NOW + 2 * MINUTE), false);
  });

  await t.test('concurrent consumers accept a pending request only once', async () => {
    const name = namespace(), first = store(name), second = store(name, fixture.newPool());
    const value = { requestId: '_fictional-pending-request' };
    assert.equal(await first.insert(key('request'), value, NOW + MINUTE), true);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).consume(key('request'), NOW)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(results.find(Boolean), { value, expiresAtMs: NOW + MINUTE });
    assert.equal(await first.get(key('request'), NOW), null);
  });

  await t.test('entry lookup, consumption and removal are bound to namespace', async () => {
    const a = store(), b = store();
    assert.equal(await a.insert(key('same-id'), 'a', NOW + MINUTE), true);
    assert.equal(await b.get(key('same-id'), NOW), null);
    assert.equal(await b.consume(key('same-id'), NOW), null);
    assert.equal(await b.remove(key('same-id')), false);
    assert.equal(await b.insert(key('same-id'), 'b', NOW + MINUTE), true);
    assert.equal(await a.remove(key('same-id')), true);
    assert.equal(await a.remove(key('same-id')), false);
    assert.deepEqual(await b.get(key('same-id'), NOW), { value: 'b', expiresAtMs: NOW + MINUTE });
  });

  await t.test('a shared rate limit permits only its quota under concurrent requests', async () => {
    const name = namespace(), a = store(name), b = store(name, fixture.newPool());
    const rateKey = `rate:${hash('concurrent-auth-attempts')}`;
    const allowed = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? a : b).takeRateLimit(rateKey, NOW, MINUTE, 5)));
    assert.equal(allowed.filter(result => result === true).length, 5);
    assert.equal(allowed.filter(result => result === false).length, 15);
    assert.equal(await a.takeRateLimit(rateKey, NOW + MINUTE - 1, MINUTE, 5), false);
  });

  await t.test('a rate-limit window resets at exact expiry and preserves the new quota', async () => {
    const a = store(), rateKey = `rate:${hash('exact-window-boundary')}`;
    assert.equal(await a.takeRateLimit(rateKey, NOW, MINUTE, 2), true);
    assert.equal(await a.takeRateLimit(rateKey, NOW + 1, MINUTE, 2), true);
    assert.equal(await a.takeRateLimit(rateKey, NOW + MINUTE - 1, MINUTE, 2), false);
    assert.equal(await a.takeRateLimit(rateKey, NOW + MINUTE, MINUTE, 2), true);
    assert.equal(await a.takeRateLimit(rateKey, NOW + MINUTE + 1, MINUTE, 2), true);
    assert.equal(await a.takeRateLimit(rateKey, NOW + 2 * MINUTE - 1, MINUTE, 2), false);
  });

  await t.test('rate-limit quotas and expired-counter pruning are namespace bound', async () => {
    const a = store(), b = store(), rateKey = `rate:${hash('isolated-rate-limit')}`;
    assert.equal(await a.takeRateLimit(rateKey, NOW, MINUTE, 1), true);
    assert.equal(await a.takeRateLimit(rateKey, NOW, MINUTE, 1), false);
    assert.equal(await b.takeRateLimit(rateKey, NOW, MINUTE, 1), true);
    assert.equal(await b.takeRateLimit(rateKey, NOW, MINUTE, 1), false);
    assert.deepEqual(await a.prune(NOW + MINUTE), { entries: 1, sessions: 0 });
    assert.deepEqual(await b.prune(NOW + MINUTE), { entries: 1, sessions: 0 });
    assert.equal(await a.takeRateLimit(rateKey, NOW + MINUTE, MINUTE, 1), true);
  });

  await t.test('malformed stored counters fail closed before and after expiry', async () => {
    const a = store();
    const corruptValues = [{ count: 1 }, '1', 0, 1.5, 1001, null];
    for (const [i, value] of corruptValues.entries()) {
      const rateKey = `rate:${hash(`corrupt-rate-counter:${i}`)}`;
      assert.equal(await a.insert(rateKey, value, NOW + MINUTE), true);
      assert.equal(await a.takeRateLimit(rateKey, NOW, MINUTE, 5), false);
      assert.equal(await a.takeRateLimit(rateKey, NOW + MINUTE, MINUTE, 5), false);
      assert.equal(await a.takeRateLimit(rateKey, NOW + 2 * MINUTE, MINUTE, 5), false);
    }
  });

  await t.test('sessions persist across a fresh pool and cannot be overwritten', async () => {
    const name = namespace(), a = store(name), b = store(name, fixture.newPool());
    const record = session('persisted');
    assert.equal(await a.putSession(record), true);
    assert.equal(await b.putSession({ ...record, csrfHash: hash('different') }), false);
    assert.deepEqual(await b.readAndTouchSession(record.key, NOW + MINUTE, 15 * MINUTE), { ...record, lastSeenAtMs: NOW + MINUTE });
    assert.equal(await a.deleteSession(record.key), true);
    assert.equal(await b.readAndTouchSession(record.key, NOW + 2 * MINUTE, 15 * MINUTE), null);
    assert.equal(await a.deleteSession(record.key), false);
  });

  await t.test('idle expiry is strict and successful activity extends only idle life', async () => {
    const a = store(), record = session('idle');
    await a.putSession(record);
    assert.ok(await a.readAndTouchSession(record.key, NOW + 14 * MINUTE, 15 * MINUTE));
    assert.ok(await a.readAndTouchSession(record.key, NOW + 28 * MINUTE, 15 * MINUTE));
    assert.equal(await a.readAndTouchSession(record.key, NOW + 43 * MINUTE, 15 * MINUTE), null);
    const exact = session('idle-exact');
    await a.putSession(exact);
    assert.equal(await a.readAndTouchSession(exact.key, NOW + 15 * MINUTE, 15 * MINUTE), null);
  });

  await t.test('absolute expiry and reauthentication bounds cannot slide with activity', async () => {
    const a = store();
    for (const field of ['expiresAtMs', 'reauthAtMs']) {
      // The storage invariant requires reauthentication no later than absolute
      // expiry, so a shorter absolute lifetime also caps reauthentication.
      const record = session(`bound:${field}`, { [field]: NOW + 2 * MINUTE,
        ...(field === 'expiresAtMs' ? { reauthAtMs: NOW + 2 * MINUTE } : {}) });
      await a.putSession(record);
      assert.ok(await a.readAndTouchSession(record.key, NOW + 2 * MINUTE - 1, 15 * MINUTE));
      assert.equal(await a.readAndTouchSession(record.key, NOW + 2 * MINUTE, 15 * MINUTE), null);
    }
  });

  await t.test('time rollback and future-created sessions are not accepted', async () => {
    const a = store(), record = session('clock-rollback');
    await a.putSession(record);
    assert.equal(await a.readAndTouchSession(record.key, NOW - 1, 15 * MINUTE), null);
    assert.ok(await a.readAndTouchSession(record.key, NOW + MINUTE, 15 * MINUTE));
    assert.equal(await a.readAndTouchSession(record.key, NOW + MINUTE - 1, 15 * MINUTE), null);
  });

  await t.test('session reads and identity revocation remain isolated across namespaces and users', async () => {
    const a = store(), b = store();
    const one = session('user-one'), two = session('user-one-second'), other = session('other-user', { entraObjectId: randomUUID() });
    await a.putSession(one); await a.putSession(two); await a.putSession(other); await b.putSession(one);
    assert.equal(await b.readAndTouchSession(two.key, NOW, 15 * MINUTE), null);
    assert.equal(await b.deleteSession(two.key), false);
    assert.equal(await a.deleteIdentitySessions({ entraTenantId: one.entraTenantId, entraObjectId: one.entraObjectId }), 2);
    assert.equal(await a.readAndTouchSession(one.key, NOW, 15 * MINUTE), null);
    assert.equal(await a.readAndTouchSession(two.key, NOW, 15 * MINUTE), null);
    assert.ok(await a.readAndTouchSession(other.key, NOW, 15 * MINUTE));
    assert.ok(await b.readAndTouchSession(one.key, NOW, 15 * MINUTE));
  });

  await t.test('expiry pruning is bounded to its namespace and retains live records', async () => {
    const a = store(), b = store();
    await a.insert(key('expired'), 'expired', NOW + MINUTE);
    await a.insert(key('live'), 'live', NOW + 10 * MINUTE);
    await b.insert(key('expired'), 'other namespace', NOW + MINUTE);
    await a.putSession(session('expired-session', { expiresAtMs: NOW + MINUTE, reauthAtMs: NOW + MINUTE }));
    await a.putSession(session('live-session'));
    await b.putSession(session('expired-session', { expiresAtMs: NOW + MINUTE, reauthAtMs: NOW + MINUTE }));
    assert.deepEqual(await a.prune(NOW + MINUTE), { entries: 1, sessions: 1 });
    assert.deepEqual(await a.prune(NOW + MINUTE), { entries: 0, sessions: 0 });
    assert.ok(await a.get(key('live'), NOW + MINUTE));
    assert.ok(await a.readAndTouchSession(hash('live-session'), NOW + MINUTE, 15 * MINUTE));
    assert.deepEqual(await b.prune(NOW + MINUTE), { entries: 1, sessions: 1 });
  });
});
