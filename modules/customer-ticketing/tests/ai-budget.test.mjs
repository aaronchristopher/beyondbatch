import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresAiBudget } from '../src/persistence/postgres-ai-budget.mjs';

const TENANT = '10000000-0000-4000-8000-000000000001';
const FINGERPRINT = 'a'.repeat(64);
const attempt = (patch = {}) => ({ attemptKey: 'fictional:message:v1:attempt1', fingerprint: FINGERPRINT, maxCostMicros: 1000, ...patch });

test('AI budget requires fixed trusted tenant, bounded integer policy and connection pool', () => {
  const pool = { connect() {} };
  for (const patch of [{ tenantId: '*' }, { tenantId: null }, { pool: {} }, { monthlyLimitMicros: 0 },
    { monthlyLimitMicros: 1.2 }, { monthlyLimitMicros: Number.MAX_SAFE_INTEGER }, { clock: 1 }]) {
    assert.throws(() => createPostgresAiBudget({ pool, tenantId: TENANT, ...patch }), TypeError);
  }
});

test('malformed attempt identities and money never acquire a database connection', async () => {
  let connections = 0;
  const store = createPostgresAiBudget({ pool: { connect() { connections++; throw new Error(); } }, tenantId: TENANT });
  for (const patch of [{ attemptKey: '' }, { attemptKey: 'raw email body with spaces' }, { attemptKey: 'x'.repeat(161) },
    { fingerprint: 'unknown' }, { fingerprint: 'A'.repeat(64) }, { maxCostMicros: 0 },
    { maxCostMicros: 0.5 }, { maxCostMicros: NaN }, { maxCostMicros: 1_000_000_000_001 }]) {
    await assert.rejects(store.reserve(attempt(patch)), TypeError);
  }
  for (const actualCostMicros of [-1, 1.2, NaN, Infinity, 1_000_000_000_001]) {
    await assert.rejects(store.settle({ ...attempt(), actualCostMicros }), TypeError);
  }
  assert.equal(connections, 0);
});

test('invalid trusted clock fails closed without acquiring a connection', async () => {
  let connections = 0;
  for (const clock of [() => new Date(NaN), () => 'yesterday', () => -1]) {
    const store = createPostgresAiBudget({ pool: { connect() { connections++; } }, tenantId: TENANT, clock });
    await assert.rejects(store.summary(), error => error.code === 'AI_BUDGET_UNAVAILABLE');
  }
  assert.equal(connections, 0);
});

test('connection failures reveal no database credentials and allow no fallback spending', async () => {
  const store = createPostgresAiBudget({ pool: { async connect() { throw new Error('postgres://secret-password@host/private'); } }, tenantId: TENANT });
  for (const invoke of [() => store.reserve(attempt()), () => store.markDispatched(attempt()),
    () => store.settle({ ...attempt(), actualCostMicros: 1 }), () => store.cancelBeforeDispatch(attempt()), () => store.summary()]) {
    await assert.rejects(invoke(), error => {
      assert.equal(error.code, 'AI_BUDGET_UNAVAILABLE');
      assert.equal(error.message, 'AI budget storage unavailable');
      assert.equal(error.cause, undefined);
      assert.ok(!JSON.stringify(error).includes('secret-password'));
      return true;
    });
  }
});

test('failed rollback discards the connection and never returns an accepted reservation', async () => {
  let released;
  const store = createPostgresAiBudget({ tenantId: TENANT, pool: { async connect() { return {
    async query(sql) { if (sql === 'BEGIN') return { rows: [], rowCount: 0 }; throw new Error('private driver failure'); },
    release(error) { released = error; },
  }; } } });
  await assert.rejects(store.reserve(attempt()), error => error.code === 'AI_BUDGET_UNAVAILABLE');
  assert.ok(released instanceof Error);
});
