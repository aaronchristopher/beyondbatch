import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequest } from '../src/domain/response-clock.mjs';
import { commitRequestEvent } from '../src/persistence/request-transaction.mjs';
import { SqliteHarness } from './helpers/sqlite-harness.mjs';
const event = (id='e1') => ({id,type:'customer_followup',evidenceId:'mail2',receivedAt:'2026-11-01T11:00:00Z'});
const command = (overrides={}) => ({tenantId:'a',requestId:'r',expectedVersion:0,idempotencyKey:'k',event:event(),...overrides});
function setup(t) { const db=new SqliteHarness(); t.after(()=>db.close()); for(const tenant of ['a','b']) db.seed(tenant,createRequest({id:'r',customerId:'c',subject:'Ask',ownerId:'pm',receivedAt:'2026-11-01T10:00:00Z',evidenceId:'mail1'})); return db; }
test('atomic commit persists version, canonical event, obligations, outbox and receipt',async t=>{const db=setup(t);const result=await commitRequestEvent(db,command());assert.equal(result.version,1);assert.equal(db.read('a','r').request.events.length,1);assert.equal(db.count('events'),1);assert.equal(db.count('obligations'),3);assert.equal(db.count('outbox'),1);assert.equal(db.count('receipts'),1);});
test('retry after lost commit acknowledgment returns original receipt without duplicate effects',async t=>{const db=setup(t);const first=await commitRequestEvent(db,command());assert.deepEqual(await commitRequestEvent(db,command()),first);assert.equal(db.count('outbox'),1);});
test('idempotency key cannot be reused for changed payload or another request',async t=>{const db=setup(t);await commitRequestEvent(db,command());await assert.rejects(commitRequestEvent(db,command({event:event('different')})),/idempotency/i);await assert.rejects(commitRequestEvent(db,command({requestId:'other'})),/idempotency/i);});
test('tenant isolation allows same key and IDs without cross-tenant writes',async t=>{const db=setup(t);await commitRequestEvent(db,command());assert.equal(db.read('b','r').version,0);await commitRequestEvent(db,command({tenantId:'b'}));assert.equal(db.count('outbox'),2);});
for(const stage of ['saveRequest','appendEvent','replaceObligations','enqueue','saveReceipt'])test(`failure after ${stage} rolls back every table and can replay`,async t=>{const db=setup(t);db.failAfter=stage;await assert.rejects(commitRequestEvent(db,command()),/injected/);assert.equal(db.read('a','r').version,0);assert.equal(db.count('events'),0);assert.equal(db.count('outbox'),0);assert.equal(db.count('receipts'),0);assert.equal(db.count('obligations'),2);db.failAfter=null;assert.equal((await commitRequestEvent(db,command())).version,1);});
test('concurrent stale commands cannot overwrite accepted work',async t=>{const db=setup(t);const results=await Promise.allSettled([commitRequestEvent(db,command()),commitRequestEvent(db,command({idempotencyKey:'k2',event:event('e2')}))]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.match(results.find(x=>x.status==='rejected').reason.message,/version/i);assert.equal(db.count('outbox'),1);});
test('same canonical event with a fresh key remains a no-op',async t=>{const db=setup(t);await commitRequestEvent(db,command());const result=await commitRequestEvent(db,command({expectedVersion:1,idempotencyKey:'k2'}));assert.equal(result.version,1);assert.equal(db.count('events'),1);assert.equal(db.count('outbox'),1);});
test('invalid reducer evidence and absent request do not commit receipts',async t=>{const db=setup(t);await assert.rejects(commitRequestEvent(db,command({event:{...event(),type:'draft'}})));await assert.rejects(commitRequestEvent(db,command({requestId:'missing'})),/not found/i);assert.equal(db.count('receipts'),0);});
test('partial sent coverage leaves original unanswered obligation deadline intact',async t=>{const db=setup(t);await commitRequestEvent(db,command());const reply={id:'reply',type:'response_sent',evidenceId:'sent1',sentAt:'2026-11-01T12:00:00Z',meaningful:true,customerFacing:true,recipientVerified:true,recipientEvidenceId:'recipient1',addressedObligationIds:['followup:e1']};const result=await commitRequestEvent(db,command({expectedVersion:1,idempotencyKey:'reply',event:reply}));assert.equal(result.request.dueAt,'2026-11-02T10:00:00.000Z');assert.equal(result.request.responseObligations.find(x=>x.id==='initial:r').outcome,'pending');});

test('committed ledger and receipt survive database close and reopen',async t=>{
  const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'bb-transaction-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'local.db');
  let db=new SqliteHarness(path);db.seed('a',createRequest({id:'r',customerId:'c',subject:'Ask',ownerId:'pm',receivedAt:'2026-11-01T10:00:00Z',evidenceId:'mail1'}));
  const result=await commitRequestEvent(db,command());db.close();db=new SqliteHarness(path);t.after(()=>db.close());
  assert.deepEqual(await commitRequestEvent(db,command()),result);assert.equal(db.count('outbox'),1);assert.equal(db.read('a','r').version,1);
});

test('caller mutation during queued transaction cannot change committed evidence',async t=>{
 const db=setup(t);const input=command();const pending=commitRequestEvent(db,input);input.event.id='mutated';const result=await pending;assert.equal(result.request.events[0].id,'e1');
});

test('an event ID collision in another request rolls back the aggregate write',async t=>{
 const db=setup(t);db.seed('a',createRequest({id:'r2',customerId:'c',subject:'Different issue',ownerId:'pm',receivedAt:'2026-11-01T10:00:00Z',evidenceId:'mail3'}));
 await commitRequestEvent(db,command());await assert.rejects(commitRequestEvent(db,command({requestId:'r2',idempotencyKey:'other'})),/UNIQUE/);assert.equal(db.read('a','r2').version,0);assert.equal(db.count('outbox'),1);
});

test('process crash before commit leaves no partial rows and replay succeeds',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'bb-crash-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'crash.db');let db=new SqliteHarness(path);
 db.seed('a',createRequest({id:'r',customerId:'c',subject:'Ask',ownerId:'pm',receivedAt:'2026-11-01T10:00:00Z',evidenceId:'mail1'}));db.close();
 const script=`import {SqliteHarness} from ${JSON.stringify(new URL('./helpers/sqlite-harness.mjs',import.meta.url).href)};
 import {commitRequestEvent} from ${JSON.stringify(new URL('../src/persistence/request-transaction.mjs',import.meta.url).href)};
 const db=new SqliteHarness(${JSON.stringify(path)});const transaction=db.transaction.bind(db);
 db.transaction=work=>transaction(tx=>{const save=tx.saveReceipt;tx.saveReceipt=(...args)=>{save(...args);process.exit(73);};return work(tx);});
 await commitRequestEvent(db,${JSON.stringify(command())});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(child.status,73,child.stderr);
 db=new SqliteHarness(path);t.after(()=>db.close());assert.equal(db.read('a','r').version,0);for(const table of ['events','outbox','receipts'])assert.equal(db.count(table),0);assert.equal(db.count('obligations'),1);
 assert.equal((await commitRequestEvent(db,command())).version,1);
});
