import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresAuthStore } from '../src/persistence/postgres-auth-store.mjs';

const HASH = 'a'.repeat(64), OTHER_HASH = 'b'.repeat(64);
const KEY = `login:${HASH}`;
const AT = Date.parse('2026-11-02T12:00:00Z');
const TID = '10000000-0000-4000-8000-000000000001';
const OID = '10000000-0000-4000-8000-000000000002';
const session = (patch = {}) => ({ key: HASH, csrfHash: OTHER_HASH, entraTenantId: TID,
  entraObjectId: OID, createdAtMs: AT, lastSeenAtMs: AT, expiresAtMs: AT + 28_800_000,
  reauthAtMs: AT + 3_600_000, ...patch });
function fixture(answer = { rows: [], rowCount: 0 }) {
  const queries = [];
  const pool = { async query(sql, parameters) { queries.push({ sql, parameters });
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(sql, parameters) : answer;
  } };
  return { store: createPostgresAuthStore({ pool, namespace: 'fictional:sp1' }), queries };
}

test('auth store requires a trusted namespace and query-capable pool', () => {
  for (const namespace of ['', '*', 'tenant;DROP', ' space', 'x'.repeat(201), null]) {
    assert.throws(() => createPostgresAuthStore({ pool: { query() {} }, namespace }), TypeError);
  }
  assert.throws(() => createPostgresAuthStore({ namespace: 'valid' }), TypeError);
});

test('invalid cache keys and unbounded JSON never reach the database', async () => {
  const { store, queries } = fixture();
  for (const key of ['', HASH, `login:${'z'.repeat(64)}`, `login:${HASH}' OR TRUE`, 'login:raw-cookie']) {
    await assert.rejects(store.insert(key, { safe: true }, AT + 300_000), TypeError);
    await assert.rejects(store.get(key, AT), TypeError);
    await assert.rejects(store.consume(key, AT), TypeError);
    await assert.rejects(store.remove(key), TypeError);
  }
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [undefined, { bad: undefined }, { bad: NaN }, new Date(), cyclic,
    { nested: { value: 'x'.repeat(8192) } }, { secret: () => 'unsafe' }]) {
    await assert.rejects(store.insert(KEY, value, AT + 300_000), TypeError);
  }
  assert.equal(queries.length, 0);
});

test('invalid times and malformed sessions reject before database access', async () => {
  const { store, queries } = fixture();
  for (const instant of [-1, NaN, Infinity, 1.2, '2026-11-02', Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(store.get(KEY, instant), TypeError);
    await assert.rejects(store.prune(instant), TypeError);
    await assert.rejects(store.insert(KEY, {}, instant), TypeError);
  }
  for (const patch of [{ key: 'cookie' }, { csrfHash: 'csrf' }, { entraTenantId: 'tenant' },
    { entraObjectId: 'object' }, { lastSeenAtMs: AT - 1 }, { expiresAtMs: AT },
    { reauthAtMs: AT }, { reauthAtMs: AT + 30_000_000 }, { rawToken: 'never store this' }]) {
    await assert.rejects(store.putSession(session(patch)), TypeError);
  }
  for (const idleMs of [0, -1, NaN, 1.2, 86_400_001]) {
    await assert.rejects(store.readAndTouchSession(HASH, AT, idleMs), TypeError);
  }
  await assert.rejects(store.deleteIdentitySessions({ entraTenantId: TID, entraObjectId: '*' }), TypeError);
  assert.equal(queries.length, 0);
});

test('database errors are bounded and reveal no credentials or driver internals', async () => {
  const { store } = fixture(new Error('postgres://private:credential@host/private-mail'));
  const calls = [() => store.insert(KEY, {}, AT + 300_000), () => store.get(KEY, AT),
    () => store.consume(KEY, AT), () => store.remove(KEY), () => store.putSession(session()),
    () => store.readAndTouchSession(HASH, AT, 900_000), () => store.deleteSession(HASH),
    () => store.deleteIdentitySessions({ entraTenantId: TID, entraObjectId: OID }), () => store.prune(AT)];
  for (const call of calls) await assert.rejects(call(), error => {
    assert.equal(error.code, 'AUTH_STORE_UNAVAILABLE'); assert.equal(error.statusCode, 503);
    assert.equal(error.cause, undefined); assert.equal(error.message, 'Authentication storage unavailable');
    assert.ok(!JSON.stringify(error).includes('credential')); return true;
  });
});

test('cache values and namespace are parameters, never SQL fragments', async () => {
  const { store, queries } = fixture({ rows: [{ key: KEY }], rowCount: 1 });
  const value = { marker: "'); DROP TABLE users; --" };
  assert.equal(await store.insert(KEY, value, AT + 300_000), true);
  assert.equal(queries.length, 1);
  assert.ok(!queries[0].sql.includes(value.marker));
  assert.ok(!queries[0].sql.includes('fictional:sp1'));
  assert.ok(queries[0].parameters.includes('fictional:sp1'));
  assert.ok(queries[0].parameters.includes(KEY));
});

test('unexpected malformed stored rows fail closed rather than authenticate', async () => {
  const { store } = fixture({ rows: [{ payload: { okay: true }, expires_at: 'not-a-date' }], rowCount: 1 });
  await assert.rejects(store.get(KEY, AT), error => error.code === 'AUTH_STORE_UNAVAILABLE');
  await assert.rejects(store.readAndTouchSession(HASH, AT, 900_000), error => error.code === 'AUTH_STORE_UNAVAILABLE');
});

test('shared rate limits reject invalid keys and policy bounds before database access', async () => {
  const { store, queries } = fixture();
  for (const key of [KEY, `rate:${'z'.repeat(64)}`, 'rate:raw-address']) {
    await assert.rejects(store.takeRateLimit(key, AT, 900_000, 10), TypeError);
  }
  for (const windowMs of [0, -1, 1.1, NaN, 900_001]) {
    await assert.rejects(store.takeRateLimit(`rate:${HASH}`, AT, windowMs, 10), TypeError);
  }
  for (const limit of [0, -1, 1.1, NaN, 1001]) {
    await assert.rejects(store.takeRateLimit(`rate:${HASH}`, AT, 900_000, limit), TypeError);
  }
  await assert.rejects(store.takeRateLimit(`rate:${HASH}`, 253402300799999, 1, 1), TypeError);
  assert.equal(queries.length, 0);
});

test('shared rate-limit storage failures deny without a fallback or sensitive error', async () => {
  const { store } = fixture(new Error('private-database-password'));
  await assert.rejects(store.takeRateLimit(`rate:${HASH}`, AT, 900_000, 10), error => {
    assert.equal(error.code, 'AUTH_STORE_UNAVAILABLE'); assert.equal(error.statusCode, 503);
    assert.equal(error.cause, undefined); assert.ok(!String(error).includes('password')); return true;
  });
});
