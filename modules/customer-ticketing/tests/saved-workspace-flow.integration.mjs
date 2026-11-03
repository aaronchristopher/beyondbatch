// Native PostgreSQL + real signed SAML + local HTTPS. All records, signing keys
// and identities are fictional; Entra eligibility/audit remain test providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createPostgresFixture, AT } from './helpers/postgres-fixture.mjs';
import { createPostgresAuthFixture } from './helpers/postgres-auth-fixture.mjs';
import { createSamlFixture } from './helpers/saml-fixtures.mjs';
import { PostgresRequestStore } from '../src/persistence/postgres-request-store.mjs';
import { createPostgresWorkspaceRepository } from '../src/persistence/postgres-workspace.mjs';
import { createPostgresAuthStore } from '../src/persistence/postgres-auth-store.mjs';
import { createPostgresPrincipalRecordLoader } from '../src/persistence/postgres-principal-loader.mjs';
import { createApplicationPrincipalResolver } from '../src/security/application-principal.mjs';
import { createSamlServiceProvider } from '../src/security/saml-service-provider.mjs';
import { createSamlSessionManager, createAuthRateLimiter } from '../src/security/auth-session.mjs';
import { createSamlAuthHandler } from '../src/security/saml-http.mjs';

test('saved requests behind signed MFA sessions survive service recreation and enforce live permissions', {timeout:120000}, async t=>{
  const f=await createPostgresFixture();t.after(()=>f.close());
  const auth=await createPostgresAuthFixture();t.after(()=>auth.close());
  const saml=createSamlFixture();t.after(()=>saml.dispose());
  const tenant=await f.tenant(),requestId=randomUUID();
  await f.admin.query('UPDATE bb.tenants SET entra_tenant_id=$1 WHERE id=$2',[saml.config.tenantId,tenant.tenantId]);
  const {rows:[{role}]}=await f.pool.query('SELECT current_user AS role');
  assert.match(role,/^bb_test_app_[0-9a-f]{16}$/);
  await f.admin.query(`GRANT SELECT ON bb.role_grants,bb.customer_pm_assignments,bb.raw_blob_refs TO "${role}"`);
  const identities=new Map();
  for(const id of [tenant.ownerId,tenant.actorId]){
    const {rows:[row]}=await f.admin.query('SELECT entra_object_id FROM bb.principals WHERE tenant_id=$1 AND id=$2',[tenant.tenantId,id]);
    identities.set(id,row.entra_object_id);
    await f.admin.query(`INSERT INTO bb.role_grants
      (tenant_id,id,principal_id,role_name,scope_kind,customer_id,granted_by,granted_at,reason)
      VALUES ($1,$2,$3,'pm','customer',$4,$5,$6,'Fictional composed workspace access')`,
    [tenant.tenantId,randomUUID(),id,tenant.customerId,tenant.actorId,AT]);
  }
  const departmentId=randomUUID(),departmentObjectId=randomUUID();
  identities.set(departmentId,departmentObjectId);
  await f.admin.query(`INSERT INTO bb.principals
    (tenant_id,id,entra_object_id,principal_type,display_name,status)
    VALUES($1,$2,$3,'user','Fictional QA reviewer','active')`,[tenant.tenantId,departmentId,departmentObjectId]);
  for(const scope of ['customer','department'])await f.admin.query(`INSERT INTO bb.role_grants
    (tenant_id,id,principal_id,role_name,scope_kind,customer_id,department_key,granted_by,granted_at,reason)
    VALUES($1,$2,$3,'department_member',$4,$5,$6,$7,$8,'Fictional composed department access')`,
  [tenant.tenantId,randomUUID(),departmentId,scope,scope==='customer'?tenant.customerId:null,scope==='department'?'qa':null,tenant.actorId,AT]);
  const canonicalEmailId=await f.email(tenant);
  const store=new PostgresRequestStore(f.pool,{actorId:tenant.workerId});
  const created=await store.createRequest({tenantId:tenant.tenantId,idempotencyKey:'fictional-workspace-flow',
    input:{id:requestId,customerId:tenant.customerId,subject:'Confirm the approved specification',ownerId:tenant.ownerId,
      receivedAt:AT,evidenceId:randomUUID()},evidence:{canonicalEmailId}});
  const audit=[],origin=new URL(saml.config.acsUrl).origin;
  let afterPreparedRead=null;
  async function writeHttpAudit(event){
    audit.push(event);
    if(event.type==='workspace.read_prepared'&&afterPreparedRead){
      const change=afterPreparedRead;afterPreparedRead=null;
      await change();
    }
  }
  function makeHandler(){
    const pool=f.newPool(),authStore=createPostgresAuthStore({pool:auth.newPool(),namespace:'fictional-workspace-flow'});
    const resolvePrincipal=createApplicationPrincipalResolver({
      loadPrincipalRecord:createPostgresPrincipalRecordLoader({pool,dbTenantId:tenant.tenantId,entraTenantId:saml.config.tenantId}),
      loadEligibility:async identity=>({...identity,accountEnabled:true,appAssigned:true,checkedAt:new Date().toISOString()}),
    });
    return createSamlAuthHandler({publicOrigin:origin,networkAccess:{allowedClientIps:['127.0.0.1']},
      manager:createSamlSessionManager({store:authStore,resolvePrincipal,audit:async event=>audit.push(event),
        serviceProvider:createSamlServiceProvider({config:saml.config,store:authStore})}),
      rateLimit:createAuthRateLimiter({store:authStore}),audit:writeHttpAudit,
      workspace:createPostgresWorkspaceRepository({pool,dbTenantId:tenant.tenantId})});
  }
  let handler=makeHandler();
  const server=https.createServer({key:saml.config.spPrivateKey,cert:saml.config.spCertificate},(req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  function request(path,{method='GET',headers={},body,localAddress='127.0.0.1'}={}){
    return new Promise((resolve,reject)=>{
      const req=https.request({hostname:'127.0.0.1',port:server.address().port,path,method,localAddress,
        rejectUnauthorized:false, // Ephemeral self-signed LOCAL test server only.
        headers:{host:new URL(origin).host,...headers}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,
          headers:res.headers,body:Buffer.concat(chunks).toString()}));
      });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error('Local test request timed out')));req.end(body);
    });
  }
  async function login(id){
    const start=await request('/auth/saml/login');assert.equal(start.status,303,start.body);
    const url=new URL(start.headers.location),xml=inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest'),'base64')).toString();
    const requestId=xml.match(/\bID="([^"]+)"/)[1];
    const body=new URLSearchParams({SAMLResponse:saml.createResponse({requestId,objectId:identities.get(id)}),RelayState:url.searchParams.get('RelayState')}).toString();
    const response=await request('/auth/saml/acs',{method:'POST',body,headers:{
      cookie:start.headers['set-cookie'][0].split(';')[0],'content-type':'application/x-www-form-urlencoded'}});
    assert.equal(response.status,303,response.body);
    return response.headers['set-cookie'].find(value=>value.startsWith('__Host-bb-session=')).split(';')[0];
  }
  await t.test('unauthenticated caller cannot read saved records',async()=>{
    assert.equal((await request('/api/workspace')).status,401);
  });
  const ownerCookie=await login(tenant.ownerId),otherCookie=await login(tenant.actorId),departmentCookie=await login(departmentId);
  async function rejectsChangedResource(cookie,path,change){
    const before=await request('/auth/session',{headers:{cookie}});assert.equal(before.status,200,before.body);
    const available=await request(path,{headers:{cookie}});assert.equal(available.status,200,available.body);
    assert.ok(available.body.includes(requestId));
    let changed=false;
    afterPreparedRead=async()=>{await change();changed=true;};
    let response;
    try{response=await request(path,{headers:{cookie}});}finally{afterPreparedRead=null;}
    assert.ok(changed,'resource mutation ran after the saved projection was prepared');
    assert.equal(response.status,403,response.body);
    for(const value of [requestId,created.request.subject,'Fictional Cedar Customer'])assert.ok(!response.body.includes(value));
    const after=await request('/auth/session',{headers:{cookie}});assert.equal(after.status,200,after.body);
    assert.deepEqual(JSON.parse(after.body).principal,JSON.parse(before.body).principal,'principal and grant scopes did not change');
  }
  await t.test('accountable PM sees the persisted task and original response deadline',async()=>{
    const response=await request('/api/workspace',{headers:{cookie:ownerCookie}});assert.equal(response.status,200,response.body);
    const data=JSON.parse(response.body);assert.equal(data.requests.length,1);
    assert.equal(data.requests[0].id,requestId);assert.equal(data.requests[0].subject,created.request.subject);
    assert.equal(data.requests[0].dueAt,'2026-01-06T08:00:00.000Z');
    const detail=await request(`/api/requests/${requestId}`,{headers:{cookie:ownerCookie}});
    assert.equal(detail.status,200,detail.body);assert.equal(JSON.parse(detail.body).version,0);
    for(const key of ['raw_blob','reference_headers','sender@example.invalid'])assert.ok(!response.body.includes(key));
  });
  await t.test('another PM has no list entry and a direct ID is indistinguishable from missing',async()=>{
    const response=await request('/api/workspace',{headers:{cookie:otherCookie}});assert.equal(response.status,200,response.body);
    assert.equal(JSON.parse(response.body).requests.length,0);
    const denied=await request(`/api/requests/${requestId}`,{headers:{cookie:otherCookie}});
    const missing=await request(`/api/requests/${randomUUID()}`,{headers:{cookie:otherCookie}});
    assert.equal(denied.status,404);assert.equal(missing.status,404);assert.equal(denied.body,missing.body);
  });
  await t.test('new service instance and database pools reload the existing session and saved task',async()=>{
    handler=makeHandler();
    const response=await request(`/api/requests/${requestId}`,{headers:{cookie:ownerCookie}});
    assert.equal(response.status,200,response.body);assert.equal(JSON.parse(response.body).request.id,requestId);
  });
  await t.test('real off-network TCP source is denied even with an MFA session and spoofed forwarded address',async()=>{
    const response=await request('/api/workspace',{localAddress:'127.0.0.2',headers:{cookie:ownerCookie,'x-forwarded-for':'127.0.0.1'}});
    assert.equal(response.status,403);assert.ok(!response.body.includes(requestId));
  });
  await t.test('backup revocation during the awaited read audit suppresses prepared detail',async()=>{
    const mappingId=randomUUID();
    await f.admin.query(`INSERT INTO bb.customer_pm_assignments
      (tenant_id,id,customer_id,primary_pm_id,backup_pm_id,effective_from,accepted_by,accepted_at,reason)
      VALUES($1,$2,$3,$4,$5,$6,$5,$6,'Fictional backup assignment')`,
    [tenant.tenantId,mappingId,tenant.customerId,tenant.ownerId,tenant.actorId,AT]);
    await rejectsChangedResource(otherCookie,`/api/requests/${requestId}`,()=>f.admin.query(
      'UPDATE bb.customer_pm_assignments SET effective_until=now() WHERE tenant_id=$1 AND id=$2',[tenant.tenantId,mappingId]));
  });
  await t.test('dependency cancellation during the awaited read audit suppresses a department list',async()=>{
    const dependencyId=randomUUID();
    await f.admin.query(`INSERT INTO bb.dependencies(tenant_id,id,request_id,department_key,deliverable)
      VALUES($1,$2,$3,'qa','Fictional approved specification')`,[tenant.tenantId,dependencyId,requestId]);
    await rejectsChangedResource(departmentCookie,'/api/workspace',()=>f.admin.query(
      "UPDATE bb.dependencies SET state='cancelled' WHERE tenant_id=$1 AND id=$2",[tenant.tenantId,dependencyId]));
  });
  await t.test('request sensitivity changed during the awaited read audit suppresses a PM list',async()=>{
    try{
      await rejectsChangedResource(ownerCookie,'/api/workspace',()=>f.admin.query(
        "UPDATE bb.requests SET sensitivity='restricted_hr',publication_state='quarantined' WHERE tenant_id=$1 AND id=$2",[tenant.tenantId,requestId]));
    }finally{
      await f.admin.query("UPDATE bb.requests SET sensitivity='operational',publication_state='approved' WHERE tenant_id=$1 AND id=$2",[tenant.tenantId,requestId]);
    }
  });
  await t.test('evidence sensitivity changed during the awaited read audit suppresses PM detail',async()=>{
    try{
      await rejectsChangedResource(ownerCookie,`/api/requests/${requestId}`,()=>f.admin.query(
        "UPDATE bb.canonical_emails SET sensitivity='restricted_legal' WHERE tenant_id=$1 AND id=$2",[tenant.tenantId,canonicalEmailId]));
    }finally{
      await f.admin.query("UPDATE bb.canonical_emails SET sensitivity='operational' WHERE tenant_id=$1 AND id=$2",[tenant.tenantId,canonicalEmailId]);
    }
  });
  await t.test('revoking the current grant removes access from the issued session',async()=>{
    await f.admin.query('UPDATE bb.role_grants SET revoked_at=now() WHERE tenant_id=$1 AND principal_id=$2',[tenant.tenantId,tenant.ownerId]);
    const response=await request('/api/workspace',{headers:{cookie:ownerCookie}});assert.equal(response.status,403,response.body);
    assert.ok(!response.body.includes(requestId));
  });
});
