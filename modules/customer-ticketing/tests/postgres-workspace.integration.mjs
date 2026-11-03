import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresWorkspaceRepository } from '../src/persistence/postgres-workspace.mjs';
import { PostgresRequestStore } from '../src/persistence/postgres-request-store.mjs';
import { commitRequestEvent } from '../src/persistence/request-transaction.mjs';
import { createPostgresFixture, AT } from './helpers/postgres-fixture.mjs';

const NOW='2026-01-05T10:00:00.000Z';
// Native PostgreSQL only; no skip/emulated persistence claim when unconfigured.
// All records are fictional. No tenant/network/mail permissions are changed.
test('native PostgreSQL saved workspace projections',{timeout:90000},async t=>{
  const f=await createPostgresFixture();t.after(()=>f.close());
  const {rows:[{role}]}=await f.pool.query('SELECT current_user AS role');
  assert.match(role,/^bb_test_app_[0-9a-f]{16}$/);
  await f.admin.query(`GRANT SELECT ON bb.role_grants,bb.customer_pm_assignments,bb.raw_blob_refs TO "${role}"`);
  async function grant(tenant,{id=tenant.ownerId,roleName='pm',kind='customer',customerId=tenant.customerId,department=null}={}){
    const grantId=randomUUID();
    await f.admin.query(`INSERT INTO bb.role_grants(tenant_id,id,principal_id,role_name,scope_kind,customer_id,department_key,granted_by,granted_at,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'Fictional saved-workspace acceptance')`,
    [tenant.tenantId,grantId,id,roleName,kind,kind==='customer'?customerId:null,department,tenant.actorId,AT]);
    return grantId;
  }
  async function seed(){
    const tenant=await f.tenant(),store=new PostgresRequestStore(f.pool,{actorId:tenant.workerId});
    const input={id:randomUUID(),customerId:tenant.customerId,ownerId:tenant.ownerId,subject:'Fictional request for approved specification',receivedAt:AT,evidenceId:randomUUID()};
    const emailId=await f.email(tenant);
    await store.createRequest({tenantId:tenant.tenantId,idempotencyKey:randomUUID(),input,evidence:{canonicalEmailId:emailId}});
    const grantId=await grant(tenant);
    const principal={id:tenant.ownerId,tenantId:tenant.tenantId,name:'Fictional PM',role:'pm',customerIds:[tenant.customerId],departmentIds:[]};
    const repository=createPostgresWorkspaceRepository({pool:f.pool,dbTenantId:tenant.tenantId,clock:()=>new Date(NOW)});
    return {tenant,store,input,emailId,principal,grantId,repository};
  }
  async function dependency(s,department,promisedAt=null){
    const id=randomUUID();
    await f.admin.query(`INSERT INTO bb.dependencies(tenant_id,id,request_id,department_key,deliverable,promised_at)
      VALUES($1,$2,$3,$4,'Fictional approved departmental input',$5)`,[s.tenant.tenantId,id,s.input.id,department,promisedAt]);
    return id;
  }
  async function internal(s){
    const evidenceId=await f.evidence(s.tenant,s.input.id,{at:'2026-01-05T09:00:00.000Z'});
    const event={id:randomUUID(),type:'internal_update',occurredAt:'2026-01-05T09:00:00.000Z',evidenceId};
    return commitRequestEvent(s.store,{tenantId:s.tenant.tenantId,requestId:s.input.id,idempotencyKey:randomUUID(),expectedVersion:0,event});
  }

  await t.test('saved PM list and safe history survive a new connection pool',async()=>{
    const s=await seed();await internal(s);
    await f.admin.query('UPDATE bb.requests SET next_action=$1 WHERE tenant_id=$2 AND id=$3',['Review the approved specification',s.tenant.tenantId,s.input.id]);
    const workspace=await s.repository.workspace(s.principal);
    assert.equal(workspace.summary.totalOpen,1);assert.equal(workspace.requests[0].subject,s.input.subject);
    assert.equal(workspace.requests[0].owner,'Fictional PM');assert.equal(workspace.requests[0].dueAt,'2026-01-06T08:00:00.000Z');
    assert.equal(workspace.requests[0].outlookAction.status,'unavailable');
    assert.equal(workspace.requests[0].nextAction,'Review the approved specification');
    const detail=await s.repository.request(s.principal,s.input.id);
    assert.equal(detail.version,1);assert.deepEqual(detail.history.map(e=>e.type),['request_created','internal_update']);
    assert.equal(detail.emailTrail.status,'unavailable');
    const serialized=JSON.stringify(detail);
    for(const omitted of ['sender@example.invalid','recipient@example.invalid','canonical_email_id','source_locator','reference_headers','payload','evidenceId','request_text'])assert.ok(!serialized.includes(omitted),omitted);
    const restored=createPostgresWorkspaceRepository({pool:f.newPool(),dbTenantId:s.tenant.tenantId,clock:()=>new Date(NOW)});
    assert.deepEqual(await restored.workspace(s.principal),workspace);
    assert.deepEqual(await restored.request(s.principal,s.input.id),detail);
  });

  await t.test('another PM with customer scope cannot see an unowned request',async()=>{
    const s=await seed();await grant(s.tenant,{id:s.tenant.actorId});
    const other={...s.principal,id:s.tenant.actorId};
    assert.equal((await s.repository.workspace(other)).requests.length,0);
    assert.equal(await s.repository.request(other,s.input.id),null);
    assert.equal(await s.repository.request(other,randomUUID()),null);
  });

  await t.test('backup visibility requires an effective mapping to the current request owner',async()=>{
    const s=await seed();await grant(s.tenant,{id:s.tenant.actorId});
    const backup={...s.principal,id:s.tenant.actorId};const mappingId=randomUUID();
    await f.admin.query(`INSERT INTO bb.customer_pm_assignments
      (tenant_id,id,customer_id,primary_pm_id,backup_pm_id,effective_from,accepted_by,accepted_at,reason)
      VALUES($1,$2,$3,$4,$5,$6,$5,$6,'Fictional backup acceptance')`,
    [s.tenant.tenantId,mappingId,s.tenant.customerId,s.tenant.ownerId,s.tenant.actorId,AT]);
    assert.equal((await s.repository.workspace(backup)).requests.length,1);
    await f.admin.query('UPDATE bb.customer_pm_assignments SET effective_until=$1 WHERE tenant_id=$2 AND id=$3',['2026-01-05T09:00:00.000Z',s.tenant.tenantId,mappingId]);
    assert.equal((await s.repository.workspace(backup)).requests.length,0);
  });

  await t.test('department requires both customer and active department scopes',async()=>{
    const s=await seed();await grant(s.tenant,{id:s.tenant.actorId,roleName:'department_member'});
    const department={...s.principal,id:s.tenant.actorId,role:'department',departmentIds:['qa']};
    const qa=await dependency(s,'qa','2026-01-06T08:00:00.000Z');await dependency(s,'warehouse','2026-01-05T20:00:00.000Z');
    assert.equal((await s.repository.workspace(department)).requests.length,0);
    await grant(s.tenant,{id:s.tenant.actorId,roleName:'department_member',kind:'department',department:'qa'});
    const detail=await s.repository.request(department,s.input.id);
    assert.equal(detail.request.department,'qa');assert.deepEqual(detail.dependencies.map(d=>d.department),['qa']);
    await f.admin.query("UPDATE bb.dependencies SET state='cancelled' WHERE tenant_id=$1 AND id=$2",[s.tenant.tenantId,qa]);
    assert.equal(await s.repository.request(department,s.input.id),null);
  });

  await t.test('president sees only explicit customer scope and primary pending department',async()=>{
    const s=await seed();await grant(s.tenant,{id:s.tenant.actorId,roleName:'president',kind:'tenant'});
    const president={...s.principal,id:s.tenant.actorId,role:'president'};
    assert.equal((await s.repository.workspace(president)).requests.length,0);
    await grant(s.tenant,{id:s.tenant.actorId,roleName:'president'});
    await dependency(s,'qa','2026-01-06T08:00:00.000Z');await dependency(s,'purchasing','2026-01-05T18:00:00.000Z');
    const detail=await s.repository.request(president,s.input.id);
    assert.equal(detail.request.department,'purchasing');assert.deepEqual(detail.dependencies.map(d=>d.department),['purchasing','qa']);
    const other=await seed();
    assert.equal(await s.repository.request({...president,customerIds:[...president.customerIds,other.tenant.customerId]},other.input.id),null);
  });

  await t.test('grant revocation and expiration remove stale session visibility',async()=>{
    const s=await seed();
    await f.admin.query('UPDATE bb.role_grants SET revoked_at=$1 WHERE tenant_id=$2 AND id=$3',['2026-01-05T09:00:00.000Z',s.tenant.tenantId,s.grantId]);
    await assert.rejects(s.repository.workspace(s.principal),error=>error.statusCode===403);
    await f.admin.query('UPDATE bb.role_grants SET revoked_at=NULL,expires_at=$1 WHERE tenant_id=$2 AND id=$3',[NOW,s.tenant.tenantId,s.grantId]);
    await assert.rejects(s.repository.request(s.principal,s.input.id),error=>error.statusCode===403);
  });

  await t.test('disabled user and wrong-tenant principals fail closed',async()=>{
    const s=await seed();
    await assert.rejects(s.repository.workspace({...s.principal,tenantId:randomUUID()}),error=>error.statusCode===403);
    await f.admin.query("UPDATE bb.principals SET status='disabled' WHERE tenant_id=$1 AND id=$2",[s.tenant.tenantId,s.principal.id]);
    await assert.rejects(s.repository.workspace(s.principal),error=>error.statusCode===403);
  });

  await t.test('excluded requests and restricted evidence disappear from summaries and direct detail',async()=>{
    const s=await seed();
    await f.admin.query("UPDATE bb.requests SET publication_state='excluded' WHERE tenant_id=$1 AND id=$2",[s.tenant.tenantId,s.input.id]);
    assert.equal((await s.repository.workspace(s.principal)).summary.totalOpen,0);
    assert.equal(await s.repository.request(s.principal,s.input.id),null);
    await f.admin.query("UPDATE bb.requests SET publication_state='approved' WHERE tenant_id=$1 AND id=$2",[s.tenant.tenantId,s.input.id]);
    await f.admin.query("UPDATE bb.canonical_emails SET sensitivity='restricted_legal' WHERE tenant_id=$1 AND id=$2",[s.tenant.tenantId,s.emailId]);
    assert.equal((await s.repository.workspace(s.principal)).summary.totalOpen,0);
    assert.equal(await s.repository.request(s.principal,s.input.id),null);
  });

  await t.test('corrupt canonical request data is unavailable, not a stale or invented projection',async()=>{
    const s=await seed();
    await f.admin.query('UPDATE bb.requests SET title=$1 WHERE tenant_id=$2 AND id=$3',['Untracked projection change',s.tenant.tenantId,s.input.id]);
    await assert.rejects(s.repository.workspace(s.principal),error=>error.statusCode===503&&!error.message.includes('mismatch'));
  });

  await t.test('transaction snapshot stays coherent when a concurrent internal event commits',async()=>{
    const s=await seed();let committed=false;
    const pool={async connect(){const client=await f.pool.connect();return {async query(sql,values){
      const result=await client.query(sql,values);
      if(sql.includes('FROM bb.requests r')&&!committed){committed=true;await internal(s);}
      return result;
    },release(error){client.release(error);}};}};
    const repo=createPostgresWorkspaceRepository({pool,dbTenantId:s.tenant.tenantId,clock:()=>new Date(NOW)});
    assert.equal((await repo.request(s.principal,s.input.id)).version,0);
    assert.equal((await s.repository.request(s.principal,s.input.id)).version,1);
  });

  await t.test('read path uses a real read-only snapshot and leaves no pooled tenant context',async()=>{
    const s=await seed();const observed=[];
    const pool={async connect(){const client=await f.pool.connect();return {async query(sql,values){
      if(sql.includes('FROM bb.requests r'))observed.push((await client.query(`SELECT current_setting('transaction_read_only') AS read_only,
        current_setting('transaction_isolation') AS isolation,current_setting('app.tenant_id',true) AS tenant`)).rows[0]);
      return client.query(sql,values);
    },release(error){client.release(error);}};}};
    const repo=createPostgresWorkspaceRepository({pool,dbTenantId:s.tenant.tenantId,clock:()=>new Date(NOW)});
    await repo.workspace(s.principal);
    assert.deepEqual(observed,[{read_only:'on',isolation:'repeatable read',tenant:s.tenant.tenantId}]);
    assert.equal((await f.pool.query('SELECT * FROM bb.requests')).rowCount,0);
    assert.equal((await f.pool.query('SELECT * FROM bb.role_grants')).rowCount,0);
  });
});
