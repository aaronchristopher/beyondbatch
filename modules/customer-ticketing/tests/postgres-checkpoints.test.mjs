import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointError, PostgresCheckpointRepository } from '../src/persistence/postgres-checkpoints.mjs';

// These tests exercise a pg client CONTRACT using scripted responses. They do
// not execute PostgreSQL, prove RLS, reproduce locks, or prove durable rollback.
const TENANT = '11111111-1111-4111-8111-111111111111';
const MAILBOX = '22222222-2222-4222-8222-222222222222';
const CHECKPOINT = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-11-02T12:00:00.000Z';
const FROM = '2026-11-01T00:00:00.000Z';
const scope = {tenantId:TENANT, mailboxId:MAILBOX, graphFolderId:'opaque-inbox-folder'};
const lease = {...scope, checkpointId:CHECKPOINT, ownerToken:'worker:unique-claim', rowVersion:'9007199254740993', cursorGeneration:'2'};
const errorCode = expected => error => error instanceof CheckpointError && error.code === expected;

function row(overrides = {}) {
  return {id:CHECKPOINT, tenant_id:TENANT, mailbox_id:MAILBOX, graph_folder_id:scope.graphFolderId,
    folder_kind:'inbox', delta_cursor_ciphertext:Buffer.from([1, 2, 3]), cursor_generation:'2',
    cursor_state:'current', last_success_at:NOW, last_full_recovery_at:null,
    coverage_from:FROM, coverage_through:'2026-11-02T11:00:00.000Z',
    lease_owner:lease.ownerToken, lease_until:'2026-11-02T12:05:00.000Z',
    last_error_code:null, row_version:lease.rowVersion, observed_db_now:NOW, ...overrides};
}
function queryTag(sql) {
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return sql;
  if (sql.includes('set_config')) return 'tenant_context';
  if (sql.startsWith('SET LOCAL')) return 'timezone';
  return sql.match(/\/\* (?:bb\.checkpoint\.|test\.)([a-z_]+) \*\//)?.[1] ?? 'unknown';
}
function fixture(overrides = {}) {
  const calls = [];
  const releases = [];
  let connections = 0;
  const client = {
    async query(sql, values = []) {
      const tag = queryTag(sql);
      calls.push({tag, sql, values:values.map(v=>Buffer.isBuffer(v)?Buffer.from(v):v)});
      if (Object.hasOwn(overrides, tag)) {
        const result = overrides[tag];
        if (result instanceof Error) throw result;
        return typeof result === 'function' ? result(values, sql) : result;
      }
      if (tag === 'approval') return {rows:[{include_incoming:true, include_sent:true, history_start_at:FROM}]};
      if (tag === 'lock') return {rows:[row()]};
      if (tag === 'acquire') return {rows:[row({tenant_id:values[0], mailbox_id:values[1], graph_folder_id:values[2], lease_owner:values[3], row_version:'9007199254740994'})]};
      if (tag === 'renew') return {rows:[row({row_version:'9007199254740994'})]};
      if (tag === 'commit_page') return {rows:[row({row_version:'9007199254740994', delta_cursor_ciphertext:values[7], cursor_state:values[8]})]};
      if (tag === 'reset') return {rows:[row({row_version:'9007199254740994', cursor_generation:'3', cursor_state:'reset_required', delta_cursor_ciphertext:null, lease_owner:null, lease_until:null, last_error_code:values[7]})]};
      if (tag === 'release') return {rows:[row({row_version:'9007199254740994', lease_owner:null, lease_until:null})]};
      if (['BEGIN', 'COMMIT', 'ROLLBACK', 'tenant_context', 'timezone', 'persist_page'].includes(tag)) return {rows:[]};
      throw new Error(`Unexpected mock SQL operation: ${tag}`);
    },
    release(error) { releases.push(error); },
  };
  const pool = {async connect() { connections++; return client; }};
  return {repository:new PostgresCheckpointRepository(pool, {entraClientId:CLIENT}), client, calls, releases,
    get connections() { return connections; }};
}
const terminalPage = () => ({cursorCiphertext:Buffer.from([9, 8, 7]), cursorState:'current', coverageFrom:FROM, coverageThrough:NOW});

test('acquire uses a single transaction with bound tenant/app/mailbox, a fresh owner token and bigint-safe version', async () => {
  const f = fixture();
  const input = {...scope, workerId:'ingestion-a', leaseSeconds:90};
  const result = await f.repository.acquire(input);
  assert.deepEqual(f.calls.map(c=>c.tag), ['BEGIN','tenant_context','timezone','approval','acquire','COMMIT']);
  assert.deepEqual(f.calls.find(c=>c.tag==='tenant_context').values, [TENANT]);
  assert.match(f.calls.find(c=>c.tag==='tenant_context').sql, /set_config\('app\.tenant_id', \$1, true\)/);
  assert.deepEqual(f.calls.find(c=>c.tag==='approval').values, [TENANT, MAILBOX, CLIENT]);
  assert.match(f.calls.find(c=>c.tag==='approval').sql, /FOR SHARE OF m, t/);
  const acquisition = f.calls.find(c=>c.tag==='acquire');
  assert.deepEqual(acquisition.values.slice(0,3), [TENANT, MAILBOX, scope.graphFolderId]);
  assert.match(acquisition.values[3], /^ingestion-a:[0-9a-f-]{36}$/);
  assert.equal(acquisition.values[4], 90);
  assert.match(acquisition.sql, /lease_until <= clock_timestamp\(\)/);
  assert.equal(result.ownerToken, acquisition.values[3]);
  assert.equal(result.rowVersion, '9007199254740994');
  assert.equal(result.cursorGeneration, '2');
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(f.releases, [undefined]);
});

test('same worker name never reuses the acquisition token', async () => {
  const f = fixture();
  const a = await f.repository.acquire({...scope,workerId:'worker'});
  const b = await f.repository.acquire({...scope,workerId:'worker'});
  assert.notEqual(a.ownerToken, b.ownerToken);
});

test('unapproved/revoked mailbox, wrong app or disabled tenant fails before checkpoint mutation', async () => {
  const f = fixture({approval:{rows:[]}});
  await assert.rejects(f.repository.acquire({...scope,workerId:'worker'}), errorCode('SCOPE_NOT_APPROVED'));
  assert.equal(f.calls.some(c=>c.tag==='acquire'), false);
  assert.equal(f.calls.at(-1).tag, 'ROLLBACK');
  assert.deepEqual(f.releases, [undefined]);
});

test('a missing, blocked or busy checkpoint returns no lease and does not enroll one', async () => {
  const f = fixture({acquire:{rows:[]}});
  assert.equal(await f.repository.acquire({...scope,workerId:'worker'}), null);
  assert.equal(f.calls.at(-1).tag, 'COMMIT');
  assert.equal(f.calls.some(c=>/INSERT|GRANT|CREATE/.test(c.sql)), false);
});

test('a Sent folder is rejected if only incoming direction is approved, rolling back its attempted claim', async () => {
  const f = fixture({approval:{rows:[{include_incoming:true,include_sent:false,history_start_at:FROM}]},
    acquire:values=>({rows:[row({folder_kind:'sent',lease_owner:values[3]})]})});
  await assert.rejects(f.repository.acquire({...scope,workerId:'worker'}), errorCode('FOLDER_NOT_APPROVED'));
  assert.equal(f.calls.at(-1).tag, 'ROLLBACK');
});

test('all lease writes bind tenant, mailbox, folder, checkpoint, owner token, row version and generation', async () => {
  const f = fixture();
  const result = await f.repository.renew(lease, 120);
  for (const query of f.calls.filter(c=>['lock','renew'].includes(c.tag))) {
    assert.deepEqual(query.values.slice(0,7), [TENANT,MAILBOX,scope.graphFolderId,CHECKPOINT,lease.ownerToken,lease.rowVersion,'2']);
    for (const predicate of ['tenant_id = $1::uuid','mailbox_id = $2::uuid','graph_folder_id = $3','id = $4::uuid',
      'lease_owner = $5','row_version = $6::bigint','cursor_generation = $7::bigint']) assert.ok(query.sql.includes(predicate));
    assert.ok(query.sql.includes('lease_until > clock_timestamp()'));
    if(query.tag==='lock') assert.ok(query.sql.includes("cursor_state <> 'blocked'"));
  }
  assert.equal(result.rowVersion, '9007199254740994');
  assert.equal(f.calls.find(c=>c.tag==='renew').values[7],120);
});

test('an expired/stolen/fenced lease stops before the page persistence hook', async () => {
  const f = fixture({lock:{rows:[]}});
  let called = false;
  await assert.rejects(f.repository.commitPage(lease,terminalPage(),async()=>{called=true;}),errorCode('LEASE_LOST'));
  assert.equal(called,false);
  assert.equal(f.calls.some(c=>c.tag==='commit_page'),false);
  assert.equal(f.calls.at(-1).tag,'ROLLBACK');
});

test('page hook runs on the same leased transaction before cursor CAS; input mutation cannot replace bound ciphertext', async () => {
  const f = fixture();
  const input = {...lease};
  const page = terminalPage();
  const result = await f.repository.commitPage(input,page,async(client,bound)=>{
    assert.equal(client,f.client);
    assert.deepEqual(bound,lease);
    assert.ok(Object.isFrozen(bound));
    page.cursorCiphertext.fill(0);
    input.mailboxId=OTHER;
    await client.query('/* test.persist_page */ SELECT $1::uuid', [bound.mailboxId]);
  });
  assert.deepEqual(f.calls.map(c=>c.tag),['BEGIN','tenant_context','timezone','approval','lock','persist_page','commit_page','COMMIT']);
  const update=f.calls.find(c=>c.tag==='commit_page');
  assert.deepEqual(update.values[7],Buffer.from([9,8,7]));
  assert.deepEqual(update.values.slice(8),['current',FROM,NOW,false]);
  assert.equal(update.values[1],MAILBOX);
  assert.equal(result.rowVersion,'9007199254740994');
});

test('failure in page persistence requests rollback without updating its cursor', async () => {
  const f=fixture();
  const failure=new Error('page writer failed');
  await assert.rejects(f.repository.commitPage(lease,terminalPage(),async()=>{throw failure;}),error=>error===failure);
  assert.equal(f.calls.some(c=>c.tag==='commit_page'),false);
  assert.equal(f.calls.at(-1).tag,'ROLLBACK');
});

test('lease expiry after page hook requests rollback of the same transaction',async()=>{
  const f=fixture({commit_page:{rows:[]}});
  await assert.rejects(f.repository.commitPage(lease,terminalPage(),async client=>{
    await client.query('/* test.persist_page */ SELECT $1::uuid',[MAILBOX]);
  }),errorCode('LEASE_LOST'));
  assert.deepEqual(f.calls.slice(-3).map(c=>c.tag),['persist_page','commit_page','ROLLBACK']);
});

test('paging cursor does not claim completed coverage or a completed recovery',async()=>{
  const f=fixture();
  await f.repository.commitPage(lease,{cursorCiphertext:Buffer.from([4]),cursorState:'paging'},async()=>{});
  const update=f.calls.find(c=>c.tag==='commit_page');
  assert.deepEqual(update.values.slice(8),['paging',null,null,false]);
  await assert.rejects(f.repository.commitPage(lease,{cursorCiphertext:Buffer.from([4]),cursorState:'paging',coverageFrom:FROM},async()=>{}),/terminal current/);
});

test('coverage rejects future, disjoint, regressed and out-of-approval intervals before page writes',async()=>{
  const cases=[
    [{coverageThrough:'2026-11-03T00:00:00Z'},'FUTURE_COVERAGE'],
    [{coverageFrom:'2026-11-02T11:30:00Z'},'COVERAGE_GAP'],
    [{coverageThrough:'2026-11-02T10:00:00Z'},'COVERAGE_GAP'],
    [{coverageFrom:'2026-10-31T00:00:00Z'},'HISTORY_NOT_APPROVED'],
  ];
  for(const [changes,expected] of cases){
    const f=fixture();let called=false;
    await assert.rejects(f.repository.commitPage(lease,{...terminalPage(),...changes},async()=>{called=true;}),errorCode(expected));
    assert.equal(called,false);assert.equal(f.calls.at(-1).tag,'ROLLBACK');
  }
});

test('reset clears encrypted cursor, fences the generation and ends the lease without deleting historical coverage',async()=>{
  const f=fixture();const result=await f.repository.reset(lease,'DELTA_TOKEN_EXPIRED');
  const update=f.calls.find(c=>c.tag==='reset');
  assert.match(update.sql,/cursor_generation = cursor_generation \+ 1/);
  assert.match(update.sql,/delta_cursor_ciphertext = NULL/);
  assert.equal(update.sql.includes('coverage_from ='),false);
  assert.equal(update.values[7],'DELTA_TOKEN_EXPIRED');
  assert.equal(result.cursorGeneration,'3');assert.equal(result.cursorCiphertext,null);
  assert.equal(result.cursorState,'reset_required');assert.equal(result.ownerToken,null);
  assert.equal(result.leaseUntil,null);
});

test('release allows an expired but still matching fence and cannot release a replacement lease',async()=>{
  const f=fixture();const result=await f.repository.release(lease);
  assert.equal(f.calls.find(c=>c.tag==='lock').sql.includes('lease_until >'),false);
  assert.equal(result.ownerToken,null);
  const lost=fixture({lock:{rows:[]}});
  await assert.rejects(lost.repository.release(lease),errorCode('LEASE_LOST'));
  assert.equal(lost.calls.some(c=>c.tag==='release'),false);
});

test('database scope mismatch is never returned even if a mock driver produces another mailbox row',async()=>{
  const f=fixture({lock:{rows:[row({mailbox_id:OTHER})]}});
  await assert.rejects(f.repository.renew(lease),errorCode('SCOPE_MISMATCH'));
  assert.equal(f.calls.at(-1).tag,'ROLLBACK');
});

test('commit acknowledgement failure is explicitly uncertain and discards the connection rather than blindly retrying',async()=>{
  const failure=new Error('socket closed during commit');
  const f=fixture({COMMIT:failure});
  await assert.rejects(f.repository.renew(lease),errorCode('COMMIT_OUTCOME_UNKNOWN'));
  assert.deepEqual(f.calls.slice(-2).map(c=>c.tag),['COMMIT','ROLLBACK']);
  assert.equal(f.connections,1);
  assert.equal(f.releases[0],failure);
});

test('rollback failure discards the connection and preserves the original page writer error',async()=>{
  const rollbackError=new Error('broken rollback');const original=new Error('writer error');
  const f=fixture({ROLLBACK:rollbackError});
  await assert.rejects(f.repository.commitPage(lease,terminalPage(),async()=>{throw original;}),error=>error===original);
  assert.equal(f.releases[0],rollbackError);
});

test('invalid context, plaintext cursor, missing writer, unsafe bigint and error URL fail before connection acquisition',async()=>{
  const f=fixture();
  await assert.rejects(f.repository.acquire({...scope,tenantId:'tenant-from-header',workerId:'worker'}),/UUID/);
  await assert.rejects(f.repository.acquire({...scope,workerId:'worker',leaseSeconds:301}),/leaseSeconds/);
  await assert.rejects(f.repository.commitPage(lease,{...terminalPage(),cursorCiphertext:'https://graph.microsoft.com/?token=secret'},async()=>{}),/encrypted Buffer/);
  await assert.rejects(f.repository.commitPage(lease,terminalPage()),/callback/);
  await assert.rejects(f.repository.renew({...lease,rowVersion:9007199254740994}),/bigint/);
  await assert.rejects(f.repository.reset(lease,'https://graph.microsoft.com/?token=secret'),/symbolic code/);
  assert.equal(f.connections,0);
});

test('opaque folder strings remain SQL values, never SQL fragments',async()=>{
  const f=fixture();const folder="folder' OR 1=1 --";
  await f.repository.acquire({...scope,graphFolderId:folder,workerId:'worker'});
  const query=f.calls.find(c=>c.tag==='acquire');
  assert.equal(query.values[2],folder);assert.equal(query.sql.includes(folder),false);
});
