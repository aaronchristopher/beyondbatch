// Explicit disposable-server durability check. CI restarts PostgreSQL between
// prepare and verify; this runner never starts, restarts or provisions a server.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import pg from 'pg';
import { PostgresRequestStore } from '../../src/persistence/postgres-request-store.mjs';
import { commitRequestEvent } from '../../src/persistence/request-transaction.mjs';

const mode = process.argv[2];
if (!['prepare', 'verify', 'cleanup'].includes(mode)) throw new Error('usage: postgres-restart.mjs prepare|verify|cleanup');
const configured = process.env.TICKETING_TEST_DATABASE_URL;
if (!configured) throw new Error('TICKETING_TEST_DATABASE_URL is required');
const url = new URL(configured);
if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^\/beyondbatch_ticketing_test(?:_[a-z0-9_]+)?$/.test(url.pathname) || url.search || url.hash) {
  throw new Error('restart check requires a loopback beyondbatch_ticketing_test database without URL options');
}
const endpoint = `${url.hostname}:${url.port || '5432'}${url.pathname}`;
const directory = new URL('../../.fixture-data/', import.meta.url);
const stateFile = new URL('postgres-restart-state.json', directory);
const admin = new pg.Pool({ connectionString: configured, max: 1 });
let app;
let state;
let schemaCreated = false;
let roleCreated = false;
let stateWritten = false;
const at = '2026-01-05T08:00:00.000Z';
const later = '2026-01-05T09:00:00.000Z';
const json = value => JSON.parse(JSON.stringify(value));
async function snapshot(tenantId, requestId) {
  const result = {};
  for (const [name, query] of Object.entries({
    request: 'SELECT * FROM bb.requests WHERE tenant_id=$1 AND id=$2',
    evidence: 'SELECT * FROM bb.request_evidence WHERE tenant_id=$1 AND request_id=$2 ORDER BY id',
    audit: 'SELECT * FROM bb.audit_events WHERE tenant_id=$1 AND request_id=$2 ORDER BY aggregate_version',
    obligations: 'SELECT * FROM bb.response_obligations WHERE tenant_id=$1 AND request_id=$2 ORDER BY trigger_key',
    outbox: 'SELECT * FROM bb.outbox WHERE tenant_id=$1 AND payload->>\'requestId\'=$2 ORDER BY dedupe_key',
    receipts: 'SELECT * FROM bb.idempotency_records WHERE tenant_id=$1 AND response_projection->\'request\'->>\'id\'=$2 ORDER BY operation_scope,idempotency_key',
  })) result[name] = (await admin.query(query, [tenantId, requestId])).rows;
  return json(result);
}
function store() {
  const appUrl = new URL(url);
  appUrl.username = state.role;
  appUrl.password = state.password;
  app = new pg.Pool({ connectionString: appUrl.href, max: 1 });
  return new PostgresRequestStore(app, { actorId: state.workerId, actorKind: 'worker' });
}
async function dropFixture() {
  await admin.query('DROP SCHEMA bb CASCADE');
  await admin.query(`DROP OWNED BY ${state.role}`);
  await admin.query(`DROP ROLE ${state.role}`);
}
try {
  await admin.query('SELECT pg_advisory_lock(764230831)');
  if (mode === 'prepare') {
    await assert.rejects(readFile(stateFile), { code: 'ENOENT' }, 'refusing to overwrite existing restart state');
    assert.equal((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='bb'")).rowCount, 0,
      'refusing to replace an existing bb schema');
    state = { version: 1, endpoint, role: `bb_test_restart_${randomBytes(8).toString('hex')}`,
      password: randomBytes(24).toString('hex'), tenantId: randomUUID(), workerId: randomUUID(),
      ownerId: randomUUID(), customerId: randomUUID(), requestId: randomUUID() };
    state.serverStartedAt = (await admin.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started.toISOString();
    await admin.query(await readFile(new URL('../../db/001_core.sql', import.meta.url), 'utf8'));
    schemaCreated = true;
    await admin.query(`CREATE ROLE ${state.role} LOGIN PASSWORD '${state.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    roleCreated = true;
    await admin.query(`GRANT CONNECT ON DATABASE ${url.pathname.slice(1)} TO ${state.role}`);
    await admin.query(`GRANT USAGE ON SCHEMA bb TO ${state.role}`);
    await admin.query(`GRANT SELECT ON bb.tenants,bb.principals,bb.customers,bb.canonical_emails,
      bb.requests,bb.request_evidence,bb.response_obligations,bb.audit_events,bb.idempotency_records,bb.dependencies TO ${state.role}`);
    await admin.query(`GRANT INSERT,UPDATE ON bb.requests,bb.response_obligations TO ${state.role}`);
    await admin.query(`GRANT INSERT ON bb.request_evidence,bb.audit_events,bb.outbox,bb.idempotency_records TO ${state.role}`);
    // Matches the integration fixture: temporary column grants enable FOR SHARE.
    // These disposable-test grants are not a reviewed production role policy.
    await admin.query(`GRANT UPDATE(id) ON bb.tenants,bb.principals,bb.customers,bb.canonical_emails TO ${state.role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION bb.current_tenant_id() TO ${state.role}`);
    await admin.query("INSERT INTO bb.tenants(id,entra_tenant_id,display_name,status) VALUES ($1,$2,'Fictional restart test','pilot')", [state.tenantId, randomUUID()]);
    for (const [id, kind] of [[state.workerId, 'service'], [state.ownerId, 'user']]) {
      await admin.query(`INSERT INTO bb.principals(tenant_id,id,entra_object_id,principal_type,display_name,email_address,status)
        VALUES ($1,$2,$3,$4,'Fictional restart principal','fictional@example.invalid','active')`, [state.tenantId, id, randomUUID(), kind]);
    }
    await admin.query(`INSERT INTO bb.customers(tenant_id,id,display_name,identity_status,approved_by,approved_at)
      VALUES ($1,$2,'Fictional restart customer','approved',$3,$4)`, [state.tenantId, state.customerId, state.ownerId, at]);
    const emailId = randomUUID();
    await admin.query(`INSERT INTO bb.canonical_emails(tenant_id,id,dedup_version,dedup_fingerprint,sender_address,recipients,subject,sent_at,first_observed_at,direction,classification,sensitivity)
      VALUES ($1,$2,'restart-v1',$3,'customer@example.invalid','[]','Fictional restart request',$4,$4,'incoming','request','operational')`,
    [state.tenantId, emailId, createHash('sha256').update(emailId).digest('hex'), at]);
    const repository = store();
    await repository.createRequest({ tenantId: state.tenantId, idempotencyKey: randomUUID(),
      input: { id: state.requestId, customerId: state.customerId, ownerId: state.ownerId,
        subject: 'Fictional request must survive database restart', receivedAt: at, evidenceId: randomUUID() },
      evidence: { canonicalEmailId: emailId, observedAt: at } });
    const evidenceId = randomUUID();
    await admin.query(`INSERT INTO bb.request_evidence(tenant_id,id,request_id,evidence_kind,observed_at,recorded_by,requirements_version,assessment_version,rationale)
      VALUES ($1,$2,$3,'human_note',$4,$5,1,'restart-v1','Fictional persisted progress evidence')`,
    [state.tenantId, evidenceId, state.requestId, later, state.ownerId]);
    state.command = { tenantId: state.tenantId, requestId: state.requestId, expectedVersion: 0,
      idempotencyKey: randomUUID(), event: { id: randomUUID(), type: 'internal_update', occurredAt: later, evidenceId } };
    state.result = await commitRequestEvent(repository, state.command);
    state.persisted = await snapshot(state.tenantId, state.requestId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(stateFile, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    stateWritten = true;
    console.log('Prepared fictional request and history; every connection will close before the server restart.');
  } else {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.version, 1);
    assert.equal(state.endpoint, endpoint, 'restart state belongs to another database endpoint');
    assert.match(state.role, /^bb_test_restart_[0-9a-f]{16}$/);
    assert.match(state.password, /^[0-9a-f]{48}$/);
    const tenants = await admin.query('SELECT id FROM bb.tenants');
    assert.deepEqual(tenants.rows.map(row => row.id), [state.tenantId], 'database no longer contains only this disposable fixture');
    if (mode === 'cleanup') {
      await dropFixture();
      await unlink(stateFile);
      console.log('Removed disposable restart fixture and its temporary credential.');
    } else {
      const started = (await admin.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started;
      assert.ok(started.getTime() > Date.parse(state.serverStartedAt), 'PostgreSQL must actually restart between prepare and verify');
      const repository = store();
      const read = await repository.read(state.tenantId, state.requestId);
      assert.deepEqual({ version: read.version, request: read.request }, state.result);
      assert.deepEqual(await snapshot(state.tenantId, state.requestId), state.persisted);
      assert.deepEqual(await commitRequestEvent(repository, state.command), state.result);
      assert.deepEqual(await snapshot(state.tenantId, state.requestId), state.persisted, 'retry after restart must not duplicate history, obligations, jobs or receipts');
      console.log('Verified real PostgreSQL server restart: request, evidence, history, deadline, outbox and idempotent retry persisted.');
    }
  }
} catch (error) {
  if (mode === 'prepare' && schemaCreated) {
    if (app) { await app.end(); app = null; }
    await admin.query('ROLLBACK');
    if (roleCreated) await dropFixture();
    else await admin.query('DROP SCHEMA bb CASCADE');
    if (stateWritten) await unlink(stateFile);
  }
  throw error;
} finally {
  if (app) await app.end();
  await admin.end();
}
