import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresRequestStore } from '../src/persistence/postgres-request-store.mjs';
import { commitRequestEvent } from '../src/persistence/request-transaction.mjs';
import { createPostgresFixture, AT } from './helpers/postgres-fixture.mjs';

// Run explicitly against a fresh local PostgreSQL server. This file is not in
// the regular *.test.mjs glob, and missing configuration is a failure, not a
// silently skipped claim of database coverage.
test('native PostgreSQL request persistence', { timeout: 90000 }, async t => {
  const f = await createPostgresFixture();
  t.after(() => f.close());
  const storeFor = (tenant, pool = f.pool, human = false) => new PostgresRequestStore(pool,
    { actorId: human ? tenant.actorId : tenant.workerId, actorKind: human ? 'human' : 'worker' });
  async function request(tenant, store = storeFor(tenant)) {
    const input = { id: randomUUID(), customerId: tenant.customerId, subject: 'Fictional approved specification needed',
      ownerId: tenant.ownerId, receivedAt: AT, evidenceId: randomUUID() };
    const command = { tenantId: tenant.tenantId, idempotencyKey: randomUUID(), input,
      evidence: { canonicalEmailId: await f.email(tenant), observedAt: AT } };
    const created = await store.createRequest(command);
    return { store, input, command, created };
  }
  const commit = (store, tenant, requestId, expectedVersion, event, idempotencyKey = randomUUID()) =>
    commitRequestEvent(store, { tenantId: tenant.tenantId, requestId, expectedVersion, event, idempotencyKey });
  async function internal(tenant, requestId, at = '2026-01-05T09:00:00.000Z') {
    return { id: randomUUID(), type: 'internal_update', occurredAt: at,
      evidenceId: await f.evidence(tenant, requestId, { at }) };
  }
  async function inbound(tenant, requestId, at, type = 'customer_followup') {
    return { id: randomUUID(), type, receivedAt: at,
      evidenceId: await f.evidence(tenant, requestId, { at, kind: 'customer_request', emailId: await f.email(tenant, { at }) }) };
  }
  async function response(tenant, requestId, at, options = {}) {
    return { id: randomUUID(), type: 'response_sent', sentAt: at,
      evidenceId: await f.evidence(tenant, requestId, { at, kind: 'outbound_answer', meaningful: true,
        emailId: await f.email(tenant, { at, direction: 'outgoing', classification: 'meaningful_response' }) }),
      recipientEvidenceId: await f.evidence(tenant, requestId, { at }),
      meaningful: true, customerFacing: true, recipientVerified: true,
      coversAllOutstandingAsks: true, ...options };
  }
  async function closure(tenant, requestId, at = '2026-01-05T11:00:00.000Z') {
    const evidenceId = await f.evidence(tenant, requestId,
      { at, kind: 'closure_confirmation', confirmedBy: tenant.actorId });
    return { id: randomUUID(), type: 'resolution_confirmed', occurredAt: at,
      evidenceId, closureEvidenceId: evidenceId, actor: { id: tenant.actorId, type: 'human' } };
  }
  async function counts(tenant, requestId) {
    const { rows: [row] } = await f.admin.query(`SELECT
      (SELECT count(*) FROM bb.audit_events WHERE tenant_id=$1 AND request_id=$2)::integer AS events,
      (SELECT count(*) FROM bb.outbox o JOIN bb.audit_events a ON a.tenant_id=o.tenant_id AND a.id=o.event_id WHERE a.tenant_id=$1 AND a.request_id=$2)::integer AS jobs,
      (SELECT row_version::integer FROM bb.requests WHERE tenant_id=$1 AND id=$2) AS version`, [tenant.tenantId, requestId]);
    return row;
  }

  await t.test('migration enables forced tenant RLS and application login cannot bypass it', async () => {
    const { rows: [role] } = await f.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
    const { rows: [grants] } = await f.pool.query(`SELECT
      has_table_privilege(current_user,'bb.audit_events','UPDATE') AS audit_update,
      has_table_privilege(current_user,'bb.request_evidence','UPDATE') AS evidence_update,
      has_table_privilege(current_user,'bb.mailbox_approvals','INSERT') AS mailbox_insert,
      has_table_privilege(current_user,'bb.role_grants','INSERT') AS role_insert,
      has_column_privilege(current_user,'bb.principals','status','UPDATE') AS principal_status_update`);
    assert.deepEqual(grants, { audit_update: false, evidence_update: false, mailbox_insert: false,
      role_insert: false, principal_status_update: false });
    const { rows } = await f.admin.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='bb' AND c.relkind='r'`);
    assert.ok(rows.length >= 20);
    assert.ok(rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
    assert.equal((await f.pool.query('SELECT * FROM bb.tenants')).rowCount, 0);
  });

  await t.test('creation persists normalized evidence, history, deadline and outbox across a new pool', async () => {
    const tenant = await f.tenant();
    const { input, created } = await request(tenant);
    assert.equal(created.version, 0);
    const read = await storeFor(tenant, f.newPool()).read(tenant.tenantId, input.id);
    assert.equal(read.version, 0);
    assert.deepEqual(read.request, created.request);
    assert.equal(read.request.dueAt, '2026-01-06T08:00:00.000Z');
    const { rows: [obligation] } = await f.admin.query(`SELECT trigger_key,state,opened_at,due_at,trigger_evidence_id
      FROM bb.response_obligations WHERE tenant_id=$1 AND request_id=$2`, [tenant.tenantId, input.id]);
    assert.equal(obligation.trigger_key, `initial:${input.id}`);
    assert.equal(obligation.state, 'open');
    assert.equal(obligation.trigger_evidence_id, input.evidenceId);
    assert.equal(obligation.due_at.getTime() - obligation.opened_at.getTime(), 86400000);
    assert.deepEqual(await counts(tenant, input.id), { events: 1, jobs: 1, version: 0 });
  });

  await t.test('creation retries are stable and changed commands cannot reuse a receipt', async () => {
    const tenant = await f.tenant();
    const { store, input, command, created } = await request(tenant);
    assert.deepEqual(await store.createRequest(command), created);
    await assert.rejects(store.createRequest({ ...command, input: { ...input, subject: 'Different request' } }), /idempotency/i);
    assert.deepEqual(await counts(tenant, input.id), { events: 1, jobs: 1, version: 0 });
  });

  await t.test('creation rejects foreign or nonrequest email and an inactive accountable owner', async () => {
    const tenant = await f.tenant();
    const foreign = await f.tenant();
    const store = storeFor(tenant);
    const input = { id: randomUUID(), customerId: tenant.customerId, subject: 'Fictional source validation',
      ownerId: tenant.ownerId, receivedAt: AT, evidenceId: randomUUID() };
    for (const canonicalEmailId of [await f.email(foreign),
      await f.email(tenant, { classification: 'marketing' }),
      await f.email(tenant, { sensitivity: 'restricted_hr' })]) {
      await assert.rejects(store.createRequest({ tenantId: tenant.tenantId, idempotencyKey: randomUUID(),
        input, evidence: { canonicalEmailId } }));
    }
    await f.admin.query("UPDATE bb.principals SET status='disabled' WHERE tenant_id=$1 AND id=$2", [tenant.tenantId, tenant.ownerId]);
    await assert.rejects(store.createRequest({ tenantId: tenant.tenantId, idempotencyKey: randomUUID(),
      input, evidence: { canonicalEmailId: await f.email(tenant) } }), /owner/i);
    assert.equal((await f.admin.query('SELECT 1 FROM bb.requests WHERE tenant_id=$1', [tenant.tenantId])).rowCount, 0);
    assert.equal((await f.admin.query('SELECT 1 FROM bb.request_evidence WHERE tenant_id=$1', [tenant.tenantId])).rowCount, 0);
    assert.equal((await f.admin.query('SELECT 1 FROM bb.idempotency_records WHERE tenant_id=$1', [tenant.tenantId])).rowCount, 0);
  });

  await t.test('event retry has one history row and an old receipt keeps its original result', async () => {
    const tenant = await f.tenant();
    const { store, input } = await request(tenant);
    const event = await internal(tenant, input.id);
    const key = randomUUID();
    const first = await commit(store, tenant, input.id, 0, event, key);
    assert.equal(first.version, 1);
    assert.deepEqual(await commit(store, tenant, input.id, 1, event), first);
    await commit(store, tenant, input.id, 1, await internal(tenant, input.id, '2026-01-05T10:00:00.000Z'));
    assert.deepEqual(await commit(store, tenant, input.id, 0, event, key), first);
    await assert.rejects(commit(store, tenant, input.id, 2, { ...event, occurredAt: '2026-01-05T12:00:00.000Z' }, key), /idempotency/i);
    assert.deepEqual(await counts(tenant, input.id), { events: 3, jobs: 3, version: 2 });
  });

  await t.test('simultaneous different writes at one version allow exactly one winner', async () => {
    const tenant = await f.tenant();
    const { store, input } = await request(tenant);
    const events = await Promise.all([internal(tenant, input.id), internal(tenant, input.id)]);
    const results = await Promise.allSettled(events.map(event => commit(store, tenant, input.id, 0, event)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /version conflict/i);
    assert.deepEqual(await counts(tenant, input.id), { events: 2, jobs: 2, version: 1 });
  });

  await t.test('simultaneous identical receipt keys serialize to one committed result', async () => {
    const tenant = await f.tenant();
    const { store, input } = await request(tenant);
    const event = await internal(tenant, input.id);
    const key = randomUUID();
    const results = await Promise.all([commit(store, tenant, input.id, 0, event, key), commit(store, tenant, input.id, 0, event, key)]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(await counts(tenant, input.id), { events: 2, jobs: 2, version: 1 });
  });

  await t.test('a concurrent writer cannot mix a newer ledger into an older read version', async () => {
    const tenant = await f.tenant();
    const { input } = await request(tenant);
    const readLocked = Promise.withResolvers();
    const releaseRead = Promise.withResolvers();
    const writeAttempted = Promise.withResolvers();
    // Transparent gates schedule the race around real SQL. Neither query nor
    // result is mocked: PostgreSQL must enforce the shared/exclusive row locks.
    const gatePool = (reader) => ({
      async connect() {
        const client = await f.pool.connect();
        return {
          async query(sql, values) {
            if (!reader && /SELECT \* FROM bb\.requests/.test(sql) && /FOR UPDATE/.test(sql)) writeAttempted.resolve();
            const result = await client.query(sql, values);
            if (reader && /SELECT \* FROM bb\.requests/.test(sql) && /FOR SHARE/.test(sql)) {
              readLocked.resolve();
              await releaseRead.promise;
            }
            return result;
          },
          release: (...args) => client.release(...args),
        };
      },
    });
    const reading = storeFor(tenant, gatePool(true)).read(tenant.tenantId, input.id);
    let writing;
    try {
      await Promise.race([readLocked.promise, reading.then(() => { throw new Error('read completed without the shared-lock gate'); })]);
      writing = commit(storeFor(tenant, gatePool(false)), tenant, input.id, 0, await internal(tenant, input.id));
      await Promise.race([writeAttempted.promise, writing.then(() => { throw new Error('write completed without the exclusive-lock gate'); })]);
    } finally {
      releaseRead.resolve();
    }
    const [snapshot, changed] = await Promise.all([reading, writing]);
    assert.equal(snapshot.version, 0);
    assert.equal(snapshot.request.events.length, 0);
    assert.equal(changed.version, 1);
    assert.equal(changed.request.events.length, 1);
    assert.equal((await storeFor(tenant).read(tenant.tenantId, input.id)).version, 1);
  });

  await t.test('an error after history/outbox writes rolls the entire command back', async () => {
    const tenant = await f.tenant();
    const { store, input, created } = await request(tenant);
    const failing = { transaction: callback => store.transaction(tx => callback(new Proxy(tx, {
      get(target, name) {
        if (name === 'enqueue') return async (...args) => { await target.enqueue(...args); throw new Error('injected after outbox'); };
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }))) };
    const event = await internal(tenant, input.id);
    const key = randomUUID();
    await assert.rejects(commit(failing, tenant, input.id, 0, event, key), /injected/);
    assert.deepEqual((await store.read(tenant.tenantId, input.id)).request, created.request);
    assert.deepEqual(await counts(tenant, input.id), { events: 1, jobs: 1, version: 0 });
    assert.equal((await f.admin.query('SELECT 1 FROM bb.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2', [tenant.tenantId, key])).rowCount, 0);
    assert.equal((await commit(store, tenant, input.id, 0, event, key)).version, 1);
  });

  await t.test('tenant RLS and same-request evidence checks reject foreign evidence', async () => {
    const tenant = await f.tenant();
    const other = await f.tenant();
    const { store, input } = await request(tenant);
    const second = await request(tenant);
    const foreign = await request(other);
    for (const evidenceId of [second.input.evidenceId, foreign.input.evidenceId]) {
      await assert.rejects(commit(store, tenant, input.id, 0,
        { id: randomUUID(), type: 'internal_update', occurredAt: '2026-01-05T09:00:00.000Z', evidenceId }));
    }
    assert.equal(await store.read(tenant.tenantId, foreign.input.id), null);
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.tenantId]);
      assert.equal((await connection.query('SELECT id FROM bb.requests WHERE id=$1', [foreign.input.id])).rowCount, 0);
      await connection.query('COMMIT');
      assert.equal((await connection.query('SELECT id FROM bb.requests')).rowCount, 0);
    } finally { connection.release(); }
    assert.deepEqual(await counts(tenant, input.id), { events: 1, jobs: 1, version: 0 });
  });

  await t.test('outgoing evidence must prove the exact sent time before fulfilling an obligation', async () => {
    const tenant = await f.tenant();
    const { store, input } = await request(tenant);
    const event = await response(tenant, input.id, '2026-01-05T09:00:00.000Z');
    await assert.rejects(commit(store, tenant, input.id, 0, { ...event, sentAt: '2026-01-05T09:01:00.000Z' }));
    const foreign = await request(tenant);
    await assert.rejects(commit(store, tenant, input.id, 0, { ...event, recipientEvidenceId: foreign.input.evidenceId }));
    assert.deepEqual(await counts(tenant, input.id), { events: 1, jobs: 1, version: 0 });
  });

  await t.test('two partial replies at the same instant retain their exact evidence attribution', async () => {
    const tenant = await f.tenant();
    const { store, input } = await request(tenant);
    const followup = await inbound(tenant, input.id, '2026-01-05T08:30:00.000Z');
    await commit(store, tenant, input.id, 0, followup);
    const first = await response(tenant, input.id, '2026-01-05T09:00:00.000Z', {
      id: '00000000-0000-4000-8000-000000000001', coversAllOutstandingAsks: false,
      addressedObligationIds: [`initial:${input.id}`],
    });
    const second = await response(tenant, input.id, '2026-01-05T09:00:00.000Z', {
      id: '00000000-0000-4000-8000-000000000002', coversAllOutstandingAsks: false,
      addressedObligationIds: [`followup:${followup.id}`],
    });
    await commit(store, tenant, input.id, 1, first);
    await commit(store, tenant, input.id, 2, second);
    const { rows } = await f.admin.query(`SELECT trigger_key,fulfilled_by_evidence_id FROM bb.response_obligations
      WHERE tenant_id=$1 AND request_id=$2 AND trigger_kind IN ('initial_request','customer_follow_up')`, [tenant.tenantId, input.id]);
    const byKey = Object.fromEntries(rows.map(row => [row.trigger_key, row.fulfilled_by_evidence_id]));
    assert.equal(byKey[`initial:${input.id}`], first.evidenceId);
    assert.equal(byKey[`followup:${followup.id}`], second.evidenceId);
  });

  await t.test('verified closure survives reconnect and late earlier evidence reopens the correct deadline', async () => {
    const tenant = await f.tenant();
    const { store, input } = await request(tenant);
    const sent = await response(tenant, input.id, '2026-01-05T09:00:00.000Z');
    await commit(store, tenant, input.id, 0, sent);
    const closed = await commit(storeFor(tenant, f.pool, true), tenant, input.id, 1, await closure(tenant, input.id));
    assert.equal(closed.request.status, 'resolved');
    assert.deepEqual((await storeFor(tenant, f.newPool()).read(tenant.tenantId, input.id)).request, closed.request);
    const before = (await f.admin.query('SELECT id,trigger_key,opened_at,due_at FROM bb.response_obligations WHERE tenant_id=$1 AND request_id=$2 ORDER BY trigger_key', [tenant.tenantId, input.id])).rows;
    const late = await inbound(tenant, input.id, '2026-01-05T08:30:00.000Z');
    const reopened = await commit(store, tenant, input.id, 2, late);
    assert.equal(reopened.request.status, 'open');
    assert.equal(reopened.request.dueAt, '2026-01-06T08:30:00.000Z');
    assert.equal(reopened.request.invalidatedEvents.length, 1);
    const { rows: [row] } = await f.admin.query('SELECT state,closure_evidence_id FROM bb.requests WHERE tenant_id=$1 AND id=$2', [tenant.tenantId, input.id]);
    assert.deepEqual(row, { state: 'open', closure_evidence_id: null });
    const after = (await f.admin.query('SELECT id,trigger_key,opened_at,due_at FROM bb.response_obligations WHERE tenant_id=$1 AND request_id=$2 ORDER BY trigger_key', [tenant.tenantId, input.id])).rows;
    for (const obligation of before) assert.deepEqual(after.find(item => item.id === obligation.id), obligation);
    assert.deepEqual(await counts(tenant, input.id), { events: 4, jobs: 4, version: 3 });
  });

  await t.test('dependency trigger prevents closure and atomically preserves the recurring obligation', async () => {
    const tenant = await f.tenant();
    const { store, input } = await request(tenant);
    await commit(store, tenant, input.id, 0, await response(tenant, input.id, '2026-01-05T09:00:00.000Z'));
    await f.admin.query(`INSERT INTO bb.dependencies(tenant_id,id,request_id,department_key,deliverable)
      VALUES ($1,$2,$3,'qa','Fictional approval still pending')`, [tenant.tenantId, randomUUID(), input.id]);
    const event = await closure(tenant, input.id);
    await assert.rejects(commit(storeFor(tenant, f.pool, true), tenant, input.id, 1, event), /dependenc|verified/i);
    const read = await store.read(tenant.tenantId, input.id);
    assert.equal(read.version, 1);
    assert.equal(read.request.status, 'open');
    assert.equal(read.request.responseObligations.filter(o => o.outcome === 'pending').length, 1);
    assert.deepEqual(await counts(tenant, input.id), { events: 2, jobs: 2, version: 1 });
  });

  await t.test('human confirmation requires the trusted matching human actor', async () => {
    const tenant = await f.tenant();
    const { store, input } = await request(tenant);
    await commit(store, tenant, input.id, 0, await response(tenant, input.id, '2026-01-05T09:00:00.000Z'));
    const event = await closure(tenant, input.id);
    await assert.rejects(commit(store, tenant, input.id, 1, event));
    await assert.rejects(commit(storeFor(tenant, f.pool, true), tenant, input.id, 1,
      { ...event, actor: { id: tenant.ownerId, type: 'human' } }));
    assert.deepEqual(await counts(tenant, input.id), { events: 2, jobs: 2, version: 1 });
  });

  await t.test('backdated human waiting and closure decisions cannot rewrite already accepted history', async () => {
    for (const type of ['waiting_customer', 'resolution_confirmed']) {
      const tenant = await f.tenant();
      const { store, input } = await request(tenant);
      const sent = await response(tenant, input.id, '2026-01-05T09:00:00.000Z', { requestsCustomerInput: true });
      await commit(store, tenant, input.id, 0, sent);
      await commit(store, tenant, input.id, 1, await internal(tenant, input.id, '2026-01-05T12:00:00.000Z'));
      const at = '2026-01-05T11:00:00.000Z';
      const event = type === 'resolution_confirmed' ? await closure(tenant, input.id, at) : {
        id: randomUUID(), type, occurredAt: at, evidenceId: await f.evidence(tenant, input.id, { at }),
        responseEventId: sent.id, actor: { id: tenant.actorId, type: 'human' },
        reason: 'Fictional backdated waiting decision',
      };
      const before = await store.read(tenant.tenantId, input.id);
      const obligations = (await f.admin.query(`SELECT * FROM bb.response_obligations
        WHERE tenant_id=$1 AND request_id=$2 ORDER BY trigger_key`, [tenant.tenantId, input.id])).rows;
      const key = randomUUID();
      await assert.rejects(commit(storeFor(tenant, f.pool, true), tenant, input.id, 2, event, key), /backdat|latest|predat|histor/i);
      assert.deepEqual(await store.read(tenant.tenantId, input.id), before);
      assert.deepEqual((await f.admin.query(`SELECT * FROM bb.response_obligations
        WHERE tenant_id=$1 AND request_id=$2 ORDER BY trigger_key`, [tenant.tenantId, input.id])).rows, obligations);
      assert.deepEqual(await counts(tenant, input.id), { events: 3, jobs: 3, version: 2 });
      assert.equal((await f.admin.query('SELECT 1 FROM bb.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2', [tenant.tenantId, key])).rowCount, 0);
    }
  });

  await t.test('waiting on customer retires only the recurring clock and a new ask resumes it', async () => {
    const tenant = await f.tenant();
    const { store, input } = await request(tenant);
    const sent = await response(tenant, input.id, '2026-01-05T09:00:00.000Z', { requestsCustomerInput: true });
    await commit(store, tenant, input.id, 0, sent);
    const at = '2026-01-05T09:05:00.000Z';
    const waiting = { id: randomUUID(), type: 'waiting_customer', occurredAt: at,
      evidenceId: await f.evidence(tenant, input.id, { at }), responseEventId: sent.id,
      actor: { id: tenant.actorId, type: 'human' }, reason: 'Fictional customer must select a packaging option' };
    const paused = await commit(storeFor(tenant, f.pool, true), tenant, input.id, 1, waiting);
    assert.equal(paused.request.status, 'waiting_on_customer');
    assert.equal(paused.request.dueAt, null);
    const { rows: [withdrawn] } = await f.admin.query(`SELECT state,withdrawn_by,withdrawal_reason FROM bb.response_obligations
      WHERE tenant_id=$1 AND request_id=$2 AND trigger_kind='recurring_update'`, [tenant.tenantId, input.id]);
    assert.equal(withdrawn.state, 'withdrawn');
    assert.equal(withdrawn.withdrawn_by, tenant.actorId);
    assert.ok(withdrawn.withdrawal_reason);
    const resumed = await commit(store, tenant, input.id, 2, await inbound(tenant, input.id, '2026-01-05T10:00:00.000Z'));
    assert.equal(resumed.request.status, 'open');
    assert.equal(resumed.request.dueAt, '2026-01-06T10:00:00.000Z');
  });

  await t.test('an explicit postclosure reopening preserves the historical closure event', async () => {
    const tenant = await f.tenant();
    const { store, input } = await request(tenant);
    await commit(store, tenant, input.id, 0, await response(tenant, input.id, '2026-01-05T09:00:00.000Z'));
    const event = await closure(tenant, input.id);
    await commit(storeFor(tenant, f.pool, true), tenant, input.id, 1, event);
    const result = await commit(store, tenant, input.id, 2, await inbound(tenant, input.id, '2026-01-06T08:00:00.000Z', 'reopened'));
    assert.equal(result.request.status, 'open');
    assert.equal(result.request.dueAt, '2026-01-07T08:00:00.000Z');
    assert.equal(result.request.events.filter(item => item.type === 'resolution_confirmed').length, 1);
    const { rows: [saved] } = await f.admin.query('SELECT payload FROM bb.audit_events WHERE tenant_id=$1 AND id=$2', [tenant.tenantId, event.id]);
    assert.equal(saved.payload.closureEvidenceId, event.closureEvidenceId);
  });

  await t.test('a lifecycle event UUID cannot be reassigned to a second request', async () => {
    const tenant = await f.tenant();
    const first = await request(tenant);
    const second = await request(tenant);
    const event = await internal(tenant, first.input.id);
    await commit(first.store, tenant, first.input.id, 0, event);
    const attempted = { ...await internal(tenant, second.input.id), id: event.id };
    await assert.rejects(commit(second.store, tenant, second.input.id, 0, attempted));
    assert.deepEqual(await counts(tenant, second.input.id), { events: 1, jobs: 1, version: 0 });
  });

  await t.test('history is append-only and tenant context never survives pooled release', async () => {
    const tenant = await f.tenant();
    const { store, input } = await request(tenant);
    await store.read(tenant.tenantId, input.id);
    const connection = await f.pool.connect();
    try {
      const { rows: [context] } = await connection.query("SELECT nullif(current_setting('app.tenant_id',true),'') AS tenant");
      assert.equal(context.tenant, null);
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.tenantId]);
      await assert.rejects(connection.query("UPDATE bb.audit_events SET event_type='tampered' WHERE tenant_id=$1 AND request_id=$2", [tenant.tenantId, input.id]), /permission denied/i);
      await connection.query('ROLLBACK');
      assert.equal((await connection.query('SELECT * FROM bb.requests')).rowCount, 0);
    } finally { connection.release(); }
    // Even the fixture administrator cannot accidentally rewrite audit history:
    // this assertion exercises the trigger without granting UPDATE to the app.
    await assert.rejects(f.admin.query("UPDATE bb.audit_events SET event_type='tampered' WHERE tenant_id=$1 AND request_id=$2", [tenant.tenantId, input.id]), /append-only/i);
    const other = await f.tenant();
    await assert.rejects(store.read(other.tenantId, input.id));
    assert.equal((await f.pool.query('SELECT * FROM bb.requests')).rowCount, 0);
  });
});
