import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPostgresAiBudget } from '../src/persistence/postgres-ai-budget.mjs';
import { createPostgresFixture } from './helpers/postgres-fixture.mjs';

// Native PostgreSQL and fictional records only. Missing test DB is an error.
test('native durable AI cost admission', { timeout: 90000 }, async t => {
  const f = await createPostgresFixture();
  t.after(() => f.close());
  await f.admin.query(await readFile(new URL('../db/003_ai_budget.sql', import.meta.url), 'utf8'));
  const { rows: [{ role }] } = await f.pool.query('SELECT current_user AS role');
  assert.match(role, /^bb_test_app_[0-9a-f]{16}$/);
  // Disposable restricted-role policy only; not a production grant approval.
  await f.admin.query(`GRANT SELECT,INSERT,UPDATE ON bb.ai_budget_policies,bb.ai_budget_attempts TO "${role}"`);
  const at = '2026-11-03T18:00:00.000Z';
  const attempt = (maxCostMicros = 1000, attemptKey = randomUUID()) => ({ attemptKey,
    fingerprint: createHash('sha256').update(attemptKey).digest('hex'), maxCostMicros });
  async function seed(limit = 25_000_000) {
    const tenant = await f.tenant();
    let time = at;
    const config = { pool: f.pool, tenantId: tenant.tenantId, monthlyLimitMicros: limit, clock: () => new Date(time) };
    return { tenant, config, store: createPostgresAiBudget(config), setTime(value) { time = value; } };
  }

  await t.test('default budget is $25 and reserved cost survives a new pool', async () => {
    const { tenant, store, config } = await seed();
    const item = attempt(11_000);
    const result = await store.reserve(item);
    assert.equal(result.accepted, true);
    assert.equal(result.replayed, false);
    assert.equal(result.attempt.state, 'reserved');
    const reload = createPostgresAiBudget({ ...config, pool: f.newPool() });
    assert.deepEqual(await reload.summary(), { month: '2026-11-01', limitMicros: 25_000_000,
      spentMicros: 0, reservedMicros: 11_000, remainingMicros: 24_989_000, priorUnresolvedMicros: 0, blocked: false });
    assert.equal((await f.admin.query('SELECT count(*)::int AS n FROM bb.ai_budget_attempts WHERE tenant_id=$1', [tenant.tenantId])).rows[0].n, 1);
  });

  await t.test('concurrent workers cannot reserve more than the monthly budget', async () => {
    const { store } = await seed(10_000);
    const results = await Promise.all(Array.from({ length: 20 }, () => store.reserve(attempt(3000))));
    assert.equal(results.filter(result => result.accepted).length, 3);
    assert.ok(results.filter(result => !result.accepted).every(result => result.reason === 'budget_exhausted'));
    assert.equal((await store.summary()).remainingMicros, 1000);
    assert.equal((await store.summary()).reservedMicros, 9000);
  });

  await t.test('same exact attempt reserves once and dispatches once under concurrency', async () => {
    const { store } = await seed();
    const item = attempt(2000);
    const reserves = await Promise.all(Array.from({ length: 8 }, () => store.reserve(item)));
    assert.equal(reserves.filter(result => !result.replayed).length, 1);
    const dispatches = await Promise.all(Array.from({ length: 8 }, () => store.markDispatched(item)));
    assert.equal(dispatches.filter(result => result.dispatchAllowed).length, 1);
    assert.equal((await store.summary()).reservedMicros, 2000);
  });

  await t.test('changed fingerprint or reservation amount cannot reuse an attempt', async () => {
    const { store } = await seed();
    const item = attempt();
    await store.reserve(item);
    await assert.rejects(store.reserve({ ...item, maxCostMicros: 2000 }), error => error.code === 'AI_ATTEMPT_CONFLICT');
    await assert.rejects(store.markDispatched({ ...item, fingerprint: 'f'.repeat(64) }), error => error.code === 'AI_ATTEMPT_CONFLICT');
    assert.equal((await store.summary()).reservedMicros, 1000);
  });

  await t.test('successful settlement releases only unused reservation and repeated settlement is idempotent', async () => {
    const { store } = await seed(10_000);
    const item = attempt(5000);
    await store.reserve(item);
    await store.markDispatched(item);
    assert.equal((await store.settle({ ...item, actualCostMicros: 1250 })).overrun, false);
    assert.equal((await store.settle({ ...item, actualCostMicros: 1250 })).replayed, true);
    await assert.rejects(store.settle({ ...item, actualCostMicros: 1000 }), error => error.code === 'AI_ATTEMPT_CONFLICT');
    const summary = await store.summary();
    assert.equal(summary.spentMicros, 1250);
    assert.equal(summary.reservedMicros, 0);
    assert.equal(summary.remainingMicros, 8750);
  });

  await t.test('uncertain dispatched outcome has no timeout refund or automatic retry', async () => {
    const state = await seed(1000), item = attempt(1000);
    await state.store.reserve(item);
    await state.store.markDispatched(item);
    state.setTime('2026-11-29T18:00:00.000Z');
    await assert.rejects(state.store.cancelBeforeDispatch(item), error => error.code === 'AI_ATTEMPT_ALREADY_DISPATCHED');
    assert.equal((await state.store.markDispatched(item)).dispatchAllowed, false);
    assert.equal((await state.store.reserve(attempt(1))).reason, 'budget_exhausted');
    assert.equal((await state.store.summary()).reservedMicros, 1000);
  });

  await t.test('only a never-dispatched attempt can cancel and it cannot be resurrected', async () => {
    const { store } = await seed(1000), item = attempt(1000);
    await store.reserve(item);
    await assert.rejects(store.settle({ ...item, actualCostMicros: 0 }), error => error.code === 'AI_ATTEMPT_NOT_DISPATCHED');
    assert.equal((await store.cancelBeforeDispatch(item)).cancelled, true);
    assert.equal((await store.cancelBeforeDispatch(item)).replayed, true);
    assert.equal((await store.summary()).remainingMicros, 1000);
    assert.equal((await store.reserve(item)).accepted, false);
    assert.equal((await store.markDispatched(item)).dispatchAllowed, false);
  });

  await t.test('reservation overrun is recorded honestly and blocks further spending across months', async () => {
    const state = await seed(1000), item = attempt(500);
    const queued = attempt(100);
    await state.store.reserve(item);
    await state.store.reserve(queued);
    await state.store.markDispatched(item);
    const result = await state.store.settle({ ...item, actualCostMicros: 700 });
    assert.equal(result.overrun, true);
    assert.equal(result.attempt.state, 'overrun');
    assert.equal((await state.store.summary()).spentMicros, 700);
    assert.equal((await state.store.summary()).blocked, true);
    assert.equal((await state.store.markDispatched(queued)).reason, 'budget_blocked');
    state.setTime('2026-12-03T18:00:00.000Z');
    assert.equal((await state.store.reserve(attempt())).reason, 'budget_blocked');
  });

  await t.test('UTC month rollover never resets or re-dispatches an old attempt', async () => {
    const state = await seed(1000), dispatched = attempt(600), pending = attempt(400);
    state.setTime('2026-11-30T23:59:59.000Z');
    await state.store.reserve(dispatched);
    await state.store.markDispatched(dispatched);
    await state.store.reserve(pending);
    state.setTime('2026-12-01T00:00:00.000Z');
    assert.equal((await state.store.reserve(dispatched)).attempt.month, '2026-11-01');
    assert.equal((await state.store.markDispatched(dispatched)).dispatchAllowed, false);
    assert.equal((await state.store.markDispatched(pending)).reason, 'reservation_month_elapsed');
    assert.equal((await state.store.summary()).priorUnresolvedMicros, 1000);
    assert.equal((await state.store.summary()).remainingMicros, 0);
    assert.equal((await state.store.reserve(attempt(1))).reason, 'budget_exhausted');
    await state.store.settle({ ...dispatched, actualCostMicros: 550 });
    assert.equal((await state.store.summary()).priorUnresolvedMicros, 400);
    assert.equal((await state.store.summary()).spentMicros, 0);
    assert.equal((await state.store.summary()).remainingMicros, 600);
    await state.store.cancelBeforeDispatch(pending);
    assert.equal((await state.store.reserve(attempt(1000))).accepted, true);
  });

  await t.test('a connection or row-lock wait across midnight cannot authorize prior-month dispatch', async () => {
    const state = await seed(), item = attempt();
    state.setTime('2026-11-30T23:59:59.000Z');
    await state.store.reserve(item);
    const delayed = createPostgresAiBudget({ ...state.config, pool: { async connect() {
      const client = await f.pool.connect();
      return { async query(sql, parameters) {
        const result = await client.query(sql, parameters);
        if (sql.includes('FOR UPDATE')) state.setTime('2026-12-01T00:00:01.000Z');
        return result;
      }, release(error) { client.release(error); } };
    } } });
    assert.equal((await delayed.markDispatched(item)).reason, 'reservation_month_elapsed');
    assert.equal((await state.store.reserve(item)).attempt.state, 'reserved');
  });

  await t.test('dispatch permission explicitly expires at the UTC month boundary', async () => {
    const { store } = await seed(), item = attempt();
    await store.reserve(item);
    const result = await store.markDispatched(item);
    assert.equal(result.dispatchAllowed, true);
    assert.equal(result.dispatchBefore, '2026-12-01T00:00:00.000Z');
  });

  await t.test('policy mismatch and disabled tenants fail closed', async () => {
    const { store, config, tenant } = await seed();
    await store.summary();
    const changed = createPostgresAiBudget({ ...config, monthlyLimitMicros: 50_000_000 });
    await assert.rejects(changed.reserve(attempt()), error => error.code === 'AI_BUDGET_POLICY_CONFLICT');
    await f.admin.query("UPDATE bb.tenants SET status='disabled' WHERE id=$1", [tenant.tenantId]);
    await assert.rejects(store.reserve(attempt()), error => error.code === 'AI_TENANT_DISABLED');
  });

  await t.test('fixed tenant prevents another tenant attempt from being found and unbound RLS reads expose nothing', async () => {
    const one = await seed(), two = await seed(), item = attempt();
    await one.store.reserve(item);
    await assert.rejects(two.store.markDispatched(item), error => error.code === 'AI_ATTEMPT_MISSING');
    assert.equal((await two.store.summary()).reservedMicros, 0);
    assert.equal((await f.pool.query('SELECT * FROM bb.ai_budget_attempts')).rowCount, 0);
    assert.equal((await f.pool.query('SELECT * FROM bb.ai_budget_policies')).rowCount, 0);
  });

  await t.test('failed insert rolls back admission and leaves no phantom charge', async () => {
    const { config, store } = await seed(1000);
    const faulty = createPostgresAiBudget({ ...config, pool: { async connect() {
      const client = await f.pool.connect();
      return { query(sql, parameters) { if (sql.includes('INSERT INTO bb.ai_budget_attempts')) throw new Error('injected write failure');
        return client.query(sql, parameters); }, release(error) { client.release(error); } };
    } } });
    await assert.rejects(faulty.reserve(attempt(1000)), error => error.code === 'AI_BUDGET_UNAVAILABLE');
    assert.equal((await store.summary()).remainingMicros, 1000);
  });
});
