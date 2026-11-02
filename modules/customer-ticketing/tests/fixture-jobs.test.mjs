import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FixtureJobs} from '../src/persistence/fixture-jobs.mjs';
const setup=()=>{const db=new DatabaseSync(':memory:');return {db,q:new FixtureJobs(db)}};
const item=(patch={})=>({tenantId:'t',id:'job',payload:{requestId:'r'},availableAt:100,maxAttempts:2,...patch});
test('same tenant/id deduplicates equal enqueue, conflicting payload/config rejects',()=>{
 const {db,q}=setup();assert.equal(q.enqueue(item()),true);assert.equal(q.enqueue(item({payload:{requestId:'r'}})),false);
 assert.throws(()=>q.enqueue(item({payload:{requestId:'other'}})),/conflict/);
 assert.throws(()=>q.enqueue(item({maxAttempts:3})),/conflict/);
 assert.equal(q.enqueue(item({tenantId:'other'})),true);db.close();
});
test('only due tenant jobs lease, claims carry independent tokens',()=>{
 const {db,q}=setup();q.enqueue(item());q.enqueue(item({id:'future',availableAt:200}));q.enqueue(item({tenantId:'other'}));
 assert.equal(q.lease({tenantId:'t',now:99,leaseMs:10}),null);
 const job=q.lease({tenantId:'t',now:100,leaseMs:10});assert.equal(job.id,'job');assert.equal(job.attempts,1);
 assert.equal(q.lease({tenantId:'t',now:100,leaseMs:10}),null);
 assert.ok(q.lease({tenantId:'other',now:100,leaseMs:10}));db.close();
});
test('expired lease is reclaimed and old tokens cannot complete or retry',()=>{
 const {db,q}=setup();q.enqueue(item());const a=q.lease({tenantId:'t',now:100,leaseMs:10});
 const b=q.lease({tenantId:'t',now:110,leaseMs:10});assert.notEqual(a.token,b.token);assert.equal(b.attempts,2);
 assert.throws(()=>q.complete({tenantId:'t',id:'job',token:a.token,now:111}),/lease/);
 assert.throws(()=>q.retry({tenantId:'t',id:'job',token:a.token,now:111,delayMs:1,error:'x'}),/lease/);
 q.complete({tenantId:'t',id:'job',token:b.token,now:111});assert.equal(q.get('t','job').state,'done');db.close();
});
test('expired token cannot complete even before another worker claims it',()=>{
 const {db,q}=setup();q.enqueue(item());const a=q.lease({tenantId:'t',now:100,leaseMs:10});
 assert.throws(()=>q.complete({tenantId:'t',id:'job',token:a.token,now:110}),/lease/);db.close();
});
test('retry delay is respected and exhausted jobs dead letter',()=>{
 const {db,q}=setup();q.enqueue(item());const a=q.lease({tenantId:'t',now:100,leaseMs:10});
 q.retry({tenantId:'t',id:'job',token:a.token,now:101,delayMs:10,error:'temporary'});
 assert.equal(q.lease({tenantId:'t',now:110,leaseMs:10}),null);
 const b=q.lease({tenantId:'t',now:111,leaseMs:10});q.retry({tenantId:'t',id:'job',token:b.token,now:112,delayMs:0,error:'failed'});
 assert.equal(q.get('t','job').state,'dead');assert.equal(q.get('t','job').lastError,'failed');assert.equal(q.lease({tenantId:'t',now:200,leaseMs:10}),null);db.close();
});
test('repeated crashes cannot exceed attempt bound',()=>{
 const {db,q}=setup();q.enqueue(item({maxAttempts:1}));q.lease({tenantId:'t',now:100,leaseMs:10});
 assert.equal(q.lease({tenantId:'t',now:110,leaseMs:10}),null);assert.equal(q.get('t','job').state,'dead');db.close();
});
test('enqueue can participate in caller transaction and rollback',()=>{
 const {db,q}=setup();db.exec('BEGIN IMMEDIATE');q.enqueue(item());db.exec('ROLLBACK');assert.equal(q.get('t','job'),null);db.close();
});
test('file reopen retains jobs and recovers expired lease',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fixture-jobs-'));try {
 let db=new DatabaseSync(join(dir,'jobs.sqlite'));let q=new FixtureJobs(db);q.enqueue(item());q.lease({tenantId:'t',now:100,leaseMs:10});db.close();
 db=new DatabaseSync(join(dir,'jobs.sqlite'));q=new FixtureJobs(db);assert.equal(q.lease({tenantId:'t',now:110,leaseMs:10}).attempts,2);db.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('invalid timing/attempt bounds reject and cross-tenant completion cannot mutate',()=>{
 const {db,q}=setup();for(const patch of [{maxAttempts:0},{availableAt:NaN},{tenantId:''}])assert.throws(()=>q.enqueue(item(patch)));
 q.enqueue(item());assert.throws(()=>q.lease({tenantId:'t',now:100,leaseMs:0}));const a=q.lease({tenantId:'t',now:100,leaseMs:10});
 assert.throws(()=>q.complete({tenantId:'other',id:'job',token:a.token,now:101}),/lease/);assert.equal(q.get('t','job').state,'leased');db.close();
});
