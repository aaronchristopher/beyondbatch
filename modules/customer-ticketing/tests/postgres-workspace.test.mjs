import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresWorkspaceRepository } from '../src/persistence/postgres-workspace.mjs';

const tenantId='11111111-1111-1111-1111-111111111111';
const userId='22222222-2222-2222-2222-222222222222';
const customerId='33333333-3333-3333-3333-333333333333';
const requestId='44444444-4444-4444-4444-444444444444';
const at='2026-01-05T09:00:00.000Z';
const principal=()=>({id:userId,tenantId,name:'Fictional PM',role:'pm',customerIds:[customerId],departmentIds:[]});
function harness({actor={id:userId,display_name:'Fictional PM',status:'active',principal_type:'user',tenant_status:'pilot'},grants=[{scope_kind:'customer',customer_id:customerId,department_key:null}],rows=[],failOn,failRollback=false,connectError=false}={}) {
  const queries=[],releases=[];
  const client={async query(sql,values){
    queries.push({sql,values});
    if(failOn&&sql.includes(failOn)||failRollback&&sql==='ROLLBACK')throw new Error('secret database material');
    return {rows:sql.includes('FROM bb.principals p')?(actor?[actor]:[]):sql.includes('FROM bb.role_grants')?grants:sql.includes('FROM bb.requests r')?rows:[]};
  },release(value){releases.push(value);}};
  const pool={async connect(){if(connectError)throw new Error('secret database material');return client;}};
  return {queries,releases,repository:createPostgresWorkspaceRepository({pool,dbTenantId:tenantId,clock:()=>new Date(at),maxRequests:2})};
}

test('requires a pool, fixed tenant, clock and bounded result limit',()=>{
  assert.throws(()=>createPostgresWorkspaceRepository({}),/pool/);
  assert.throws(()=>createPostgresWorkspaceRepository({pool:{connect(){}},dbTenantId:'*'}),/tenant/);
  assert.throws(()=>createPostgresWorkspaceRepository({pool:{connect(){}},dbTenantId:tenantId,maxRequests:10001}),/limit/);
});

test('invalid or different-tenant principals never open a database connection',async()=>{
  const {repository,queries}=harness();
  for(const input of [null,{...principal(),tenantId:userId},{...principal(),role:'admin'},{...principal(),customerIds:['*']}])
    await assert.rejects(repository.workspace(input),error=>error.statusCode===403);
  assert.equal(queries.length,0);
});

test('empty saved workspace is explicit about missing email coverage and leaks no source fields',async()=>{
  const {repository,queries,releases}=harness();
  const result=await repository.workspace(principal());
  assert.deepEqual(result.summary,{totalOpen:0,overdue:0,dueSoon:0,unassigned:0});
  assert.deepEqual(result.requests,[]);
  assert.equal(result.coverage.mode,'not_connected');
  assert.equal(result.coverage.persisted,true);
  assert.equal(result.coverage.complete,false);
  assert.match(result.coverage.detail,/not connected/i);
  assert.match(queries[0].sql,/REPEATABLE READ READ ONLY/);
  assert.equal(queries.at(-1).sql,'COMMIT');
  assert.deepEqual(releases,[undefined]);
});

test('current disabled identity or removed selected role denies stale session projections',async()=>{
  for(const options of [{actor:null},{actor:{id:userId,status:'disabled',principal_type:'user',tenant_status:'pilot'}},{grants:[]}])
    await assert.rejects(harness(options).repository.workspace(principal()),error=>error.statusCode===403);
});

test('revoked customer scope is removed even when the supplied session still includes it',async()=>{
  const {repository,queries}=harness({grants:[{scope_kind:'tenant',customer_id:null,department_key:null}]});
  const result=await repository.workspace(principal());
  assert.deepEqual(result.requests,[]);
  assert.ok(!queries.some(q=>q.sql.includes('FROM bb.requests r')));
});

test('out-of-scope direct IDs and unknown IDs are indistinguishable',async()=>{
  const {repository}=harness();
  assert.equal(await repository.request(principal(),requestId),null);
  await assert.rejects(repository.request(principal(),"' OR 1=1 --"),error=>error.statusCode===400);
  await assert.rejects(repository.request(principal()),error=>error.statusCode===400);
});

test('result cap fails explicitly instead of reporting misleading partial counts',async()=>{
  const {repository}=harness({rows:[{id:requestId},{id:requestId},{id:requestId}]});
  await assert.rejects(repository.workspace(principal()),error=>error.statusCode===503&&error.code==='WORKSPACE_LIMIT_EXCEEDED');
});

test('dependency failure suppresses database details and rolls back',async()=>{
  const {repository,queries,releases}=harness({failOn:'FROM bb.role_grants'});
  await assert.rejects(repository.workspace(principal()),error=>error.statusCode===503&&!error.message.includes('secret')&&!error.cause);
  assert.equal(queries.at(-1).sql,'ROLLBACK'); assert.deepEqual(releases,[undefined]);
});

test('uncertain connection outcomes discard the pooled client',async()=>{
  for(const options of [{failOn:'BEGIN'},{failOn:'COMMIT'},{failOn:'FROM bb.role_grants',failRollback:true}]){
    const {repository,releases}=harness(options);
    await assert.rejects(repository.workspace(principal()),error=>error.statusCode===503);
    assert.ok(releases[0] instanceof Error); assert.ok(!releases[0].message.includes('secret'));
  }
  await assert.rejects(harness({connectError:true}).repository.workspace(principal()),error=>error.statusCode===503);
});
