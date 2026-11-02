import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { inflateRawSync } from 'node:zlib';
import { createSamlFixture } from './helpers/saml-fixtures.mjs';
import { createMemoryAuthStore } from './helpers/auth-memory-store.mjs';
import { createSamlServiceProvider } from '../src/security/saml-service-provider.mjs';
import { createSamlSessionManager,createAuthRateLimiter } from '../src/security/auth-session.mjs';
import { createApplicationPrincipalResolver } from '../src/security/application-principal.mjs';
import { createSamlAuthHandler } from '../src/security/saml-http.mjs';

// Actual SP/signature/session/authorization/HTTPS composition, fictional identity
// directory and shared test store. Native store tests independently cover SQL.
async function app(t){
  const fixture=createSamlFixture(),store=createMemoryAuthStore(),audit=[];
  let enabled=true;
  const oid='22222222-2222-4222-8222-222222222222',tid=fixture.config.tenantId;
  const resolvePrincipal=createApplicationPrincipalResolver({
    loadPrincipalRecord:async identity=>identity.entraObjectId!==oid?null:{
      id:'fictional-pm',tenantId:'fictional-db',name:'Fictional PM',...identity,
      principalType:'user',status:enabled?'active':'disabled',tenantStatus:'active',
      grants:[{id:'fictional-grant',tenantId:'fictional-db',principalId:'fictional-pm',roleName:'pm',scopeKind:'customer',customerId:'fictional-customer',
        grantedAt:'2026-01-01T00:00:00Z',expiresAt:null,revokedAt:null}],
    },
    loadEligibility:async identity=>({...identity,accountEnabled:enabled,appAssigned:enabled,checkedAt:new Date().toISOString()}),
  });
  const makeHandler=()=>createSamlAuthHandler({publicOrigin:new URL(fixture.config.acsUrl).origin,
    manager:createSamlSessionManager({store,resolvePrincipal,audit:async event=>audit.push(event),serviceProvider:createSamlServiceProvider({config:fixture.config,store})}),
    rateLimit:createAuthRateLimiter({store}),audit:async event=>audit.push(event)});
  let handler=makeHandler();
  const server=https.createServer({key:fixture.config.spPrivateKey,cert:fixture.config.spCertificate},(req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fixture.dispose();});
  function request(path,{method='GET',headers={},body}={}){
    return new Promise((resolve,reject)=>{
      // Self-signed local test server only. Runtime requires verified HTTPS.
      const req=https.request({hostname:'127.0.0.1',port:server.address().port,path,method,rejectUnauthorized:false,
        headers:{host:new URL(fixture.config.acsUrl).host,...headers}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
      });req.on('error',reject);req.end(body);
    });
  }
  async function begin(cookie){
    const response=await request('/auth/saml/login',{headers:cookie?{cookie}:{}});assert.equal(response.status,303,response.body);
    const url=new URL(response.headers.location),requestXml=inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest'),'base64')).toString();
    const requestId=requestXml.match(/\bID="([^"]+)"/)[1];
    return {cookie:response.headers['set-cookie'][0].split(';')[0],requestId,relayState:url.searchParams.get('RelayState')};
  }
  async function complete(login,overrides={}){
    const body=new URLSearchParams({SAMLResponse:fixture.createResponse({requestId:login.requestId,...overrides}),RelayState:login.relayState}).toString();
    return request('/auth/saml/acs',{method:'POST',body,headers:{cookie:login.cookie,'content-type':'application/x-www-form-urlencoded'}});
  }
  return {request,begin,complete,audit,origin:new URL(fixture.config.acsUrl).origin,disable:()=>{enabled=false;},replica:()=>{handler=makeHandler();},tid};
}
const sessionCookie=response=>response.headers['set-cookie'].find(c=>c.startsWith('__Host-bb-session=')).split(';')[0];

test('genuine signed MFA login works across service instances; session logout removes access',async t=>{
  const f=await app(t);assert.equal((await f.request('/auth/session')).status,401);
  const start=await f.begin();f.replica();const accepted=await f.complete(start);assert.equal(accepted.status,303,accepted.body);
  const cookie=sessionCookie(accepted),session=await f.request('/auth/session',{headers:{cookie}});
  assert.equal(session.status,200,session.body);const data=JSON.parse(session.body);
  assert.equal(data.principal.role,'pm');assert.deepEqual(data.principal.customerIds,['fictional-customer']);
  const logout=await f.request('/auth/logout',{method:'POST',headers:{cookie,origin:f.origin,'x-csrf-token':data.csrfToken}});
  assert.equal(logout.status,204,logout.body);assert.equal((await f.request('/auth/session',{headers:{cookie}})).status,401);
  assert.ok(f.audit.some(e=>e.type==='auth.login_succeeded'));assert.ok(f.audit.some(e=>e.type==='auth.logout'&&e.sessionRef));
  assert.ok(!JSON.stringify(f.audit).includes(cookie.split('=')[1]));
});
test('cross-site ACS without the old Lax cookie still rotates the existing session',async t=>{
  const f=await app(t),first=await f.complete(await f.begin());assert.equal(first.status,303,first.body);
  const old=sessionCookie(first),start=await f.begin(old);
  // complete() sends ONLY the correlation cookie, matching cross-site POST.
  const second=await f.complete(start);assert.equal(second.status,303,second.body);
  assert.equal((await f.request('/auth/session',{headers:{cookie:old}})).status,401);
  assert.equal((await f.request('/auth/session',{headers:{cookie:sessionCookie(second)}})).status,200);
});
test('signed password-only and unassigned identities fail without issuing session cookies',async t=>{
  const f=await app(t);
  for(const overrides of [{mfa:false},{objectId:'33333333-3333-4333-8333-333333333333'}]){
    const response=await f.complete(await f.begin(),overrides);
    assert.ok([401,403].includes(response.status),response.body);
    assert.ok(!(response.headers['set-cookie']??[]).some(c=>/^__Host-bb-session=[^;]/.test(c)));
  }
  assert.ok(f.audit.some(e=>e.type==='auth.login_denied'));
});
test('replayed login and newly disabled identity cannot regain an existing session',async t=>{
  const f=await app(t),start=await f.begin(),first=await f.complete(start);assert.equal(first.status,303,first.body);
  const replay=await f.complete(start);assert.equal(replay.status,401,replay.body);
  f.disable();const denied=await f.request('/auth/session',{headers:{cookie:sessionCookie(first)}});assert.equal(denied.status,403,denied.body);
  assert.equal((await f.request('/auth/session',{headers:{cookie:sessionCookie(first)}})).status,401);
});
