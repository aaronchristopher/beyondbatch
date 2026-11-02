// These tests exercise a real local TLS transport with a deliberately mocked
// session manager. Signed SAML and session composition have separate suites.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createSamlAuthHandler } from '../src/security/saml-http.mjs';
import { createSamlFixture } from './helpers/saml-fixtures.mjs';

const fixture=createSamlFixture();
after(()=>fixture.dispose());
const publicOrigin='https://ticketing.example.test';
const sessionToken='s'.repeat(43),browserToken='b'.repeat(43),csrfToken='c'.repeat(43);
const principal={id:'pm1',tenantId:'tenant1',name:'Fictional PM',role:'pm',customerIds:['customer1'],departmentIds:[]};
const sessionCookie=`__Host-bb-session=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const loginCookie=`__Host-bb-login=${browserToken}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=300`;
const clearLoginCookie='__Host-bb-login=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0';
const redirectUrl='https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/saml2?SAMLRequest=fixture&RelayState=fixture&SigAlg=fixture&Signature=fixture';

function dependencies(patch={}) {
  const calls={start:0,startInputs:[],finish:[],authenticate:[],logout:[],rate:[],audit:[]};
  const manager={
    async startLogin(value){calls.start++;calls.startInputs.push(value);return {redirectUrl,loginCookie};},
    async finishLogin(value){calls.finish.push(value);return {sessionCookie,clearLoginCookie,redirectPath:'/',principal};},
    async authenticate(token){calls.authenticate.push(token);if(token!==sessionToken)throw Object.assign(new Error('private failure details'),{statusCode:401});return {principal,csrfToken,expiresAtMs:2_000_000,reauthAtMs:1_000_000};},
    async logout(value){calls.logout.push(value);},
    ...patch.manager,
  };
  const rateLimit=patch.rateLimit??(async value=>{calls.rate.push(value);return true;});
  const audit=patch.audit??(async value=>{calls.audit.push(value);});
  return {calls,manager,rateLimit,audit};
}

async function harness(run,patch={},tls=true) {
  const deps=dependencies(patch);
  const handler=createSamlAuthHandler({manager:deps.manager,rateLimit:deps.rateLimit,audit:deps.audit,publicOrigin});
  const server=tls?createHttpsServer({key:fixture.config.spPrivateKey,cert:fixture.config.spCertificate},handler):createHttpServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const send=({path='/health',method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
    const request=(tls?httpsRequest:httpRequest)({host:'127.0.0.1',port:server.address().port,path,method,
      // Self-signed, ephemeral localhost test certificate only.
      ...(tls?{rejectUnauthorized:false}:{}),headers:{Host:'ticketing.example.test',...headers}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error',reject);request.setTimeout(7000,()=>request.destroy(new Error('test request timed out')));
    request.end(body);
  });
  try {await run(send,deps.calls);} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

test('SAML HTTP factory requires every dependency and a canonical HTTPS origin',()=>{
  const deps=dependencies();
  for(const origin of ['http://ticketing.example.test','https://user:pass@ticketing.example.test','https://ticketing.example.test/path','https://ticketing.example.test?x=1','https://ticketing.example.test/#x']) {
    assert.throws(()=>createSamlAuthHandler({...deps,publicOrigin:origin}),TypeError);
  }
  assert.throws(()=>createSamlAuthHandler({publicOrigin,manager:deps.manager}),TypeError);
  assert.throws(()=>createSamlAuthHandler({publicOrigin,manager:{},rateLimit:deps.rateLimit}),TypeError);
  assert.throws(()=>createSamlAuthHandler({publicOrigin,manager:deps.manager,rateLimit:deps.rateLimit}),TypeError);
});

test('minimal TLS health response exposes no data and sets security headers',async()=>harness(async(send,calls)=>{
  const response=await send();assert.equal(response.status,200);
  assert.deepEqual(JSON.parse(response.body),{ready:false,mode:'saml-integration'});
  assert.equal(response.headers['cache-control'],'no-store');
  assert.match(response.headers['strict-transport-security'],/max-age=/);
  assert.match(response.headers['content-security-policy'],/frame-ancestors 'none'/);
  assert.equal(response.headers['x-content-type-options'],'nosniff');
  assert.equal(response.headers['access-control-allow-origin'],undefined);
  assert.equal(calls.authenticate.length,0);
}));

test('unencrypted and alternate-host requests fail even with forwarded header spoofing',async()=>{
  await harness(async send=>{
    assert.equal((await send({headers:{Host:'unprotected-origin.example.test','X-Forwarded-Host':'ticketing.example.test','X-Forwarded-Proto':'https'}})).status,403);
  });
  await harness(async send=>{assert.equal((await send({headers:{'X-Forwarded-Proto':'https'}})).status,403);},{},false);
});

test('login produces an allowlisted redirect and secure browser-correlation cookie',async()=>harness(async(send,calls)=>{
  const response=await send({path:'/auth/saml/login'});
  assert.equal(response.status,303);assert.equal(response.headers.location,redirectUrl);
  assert.deepEqual(response.headers['set-cookie'],[loginCookie]);assert.equal(calls.start,1);
  assert.equal(calls.rate[0].scope,'login');assert.match(calls.rate[0].clientKey,/127\.0\.0\.1/);
}));

test('login captures the existing application session before the cross-site ACS',async()=>harness(async(send,calls)=>{
  const response=await send({path:'/auth/saml/login',headers:{Cookie:`__Host-bb-session=${sessionToken}`}});
  assert.equal(response.status,303);assert.deepEqual(calls.startInputs,[{previousSessionToken:sessionToken}]);
}));

test('login does not accept an arbitrary return URL or alternate identity query',async()=>harness(async(send,calls)=>{
  for(const path of ['/auth/saml/login?next=https://evil.example','/auth/session?persona=president'])assert.equal((await send({path})).status,400);
  assert.equal(calls.start,0);assert.equal(calls.authenticate.length,0);
}));

test('bearer and platform identity headers never authenticate a human request',async()=>harness(async(send,calls)=>{
  for(const header of ['Authorization','X-MS-Client-Principal','X-MS-Token-AAD-Access-Token','X-Auth-Request-User']) {
    assert.equal((await send({path:'/auth/session',headers:{[header]:'forged',Cookie:`__Host-bb-session=${sessionToken}`}})).status,403);
  }
  assert.equal(calls.authenticate.length,0);
}));

test('private and unknown routes require a session before returning anything',async()=>harness(async(send)=>{
  for(const path of ['/auth/session','/api/workspace','/attachments/guessed-id','/export']) {
    const response=await send({path});assert.equal(response.status,401);assert.ok(!response.body.includes('private failure details'));
  }
  const allowed=await send({path:'/api/workspace',headers:{Cookie:`__Host-bb-session=${sessionToken}`}});
  assert.equal(allowed.status,404);assert.ok(!allowed.body.includes('customer1'));
}));

test('session endpoint returns only the manager-authorized session projection',async()=>harness(async(send,calls)=>{
  const response=await send({path:'/auth/session',headers:{Cookie:`__Host-bb-session=${sessionToken}`,'X-Forwarded-For':'spoofed-user'}});
  assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),{principal,csrfToken,expiresAtMs:2_000_000,reauthAtMs:1_000_000});
  assert.deepEqual(calls.authenticate,[sessionToken]);assert.ok(calls.rate.every(call=>call.clientKey!=='spoofed-user'));
}));

test('session serialization excludes unexpected private fields from a manager result',async()=>harness(async send=>{
  const response=await send({path:'/auth/session',headers:{Cookie:`__Host-bb-session=${sessionToken}`}});
  assert.equal(response.status,200);assert.ok(!response.body.includes('do-not-publish'));
  assert.deepEqual(JSON.parse(response.body).principal,principal);
},{manager:{authenticate:async()=>({principal:{...principal,rawEmail:'do-not-publish'},csrfToken,expiresAtMs:2_000_000,reauthAtMs:1_000_000,providerToken:'do-not-publish'})}}));

test('duplicate authentication cookies fail before manager invocation',async()=>harness(async(send,calls)=>{
  const response=await send({path:'/auth/session',headers:{Cookie:`__Host-bb-session=${sessionToken}; __Host-bb-session=${'z'.repeat(43)}`}});
  assert.equal(response.status,400);assert.equal(calls.authenticate.length,0);
}));

const form=values=>new URLSearchParams(values).toString();
test('ACS forwards only singular form fields and browser-bound cookies to the manager',async()=>harness(async(send,calls)=>{
  const response=await send({path:'/auth/saml/acs',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:`__Host-bb-login=${browserToken}; __Host-bb-session=${sessionToken}`},body:form({SAMLResponse:'c2lnbmVkLWZpeHR1cmU=',RelayState:'r'.repeat(32)})});
  assert.equal(response.status,303);assert.equal(response.headers.location,'/');
  assert.deepEqual(response.headers['set-cookie'],[sessionCookie,clearLoginCookie]);
  assert.deepEqual(calls.finish,[{samlResponse:'c2lnbmVkLWZpeHR1cmU=',relayState:'r'.repeat(32),browserToken,previousSessionToken:sessionToken}]);
}));

test('ACS rejects missing correlation cookie and ambiguous or malformed form data',async()=>harness(async(send,calls)=>{
  const headers={'Content-Type':'application/x-www-form-urlencoded',Cookie:`__Host-bb-login=${browserToken}`};
  for(const body of ['SAMLResponse=a&RelayState=b&RelayState=c','SAMLResponse=a','SAMLResponse=a&RelayState=b&role=president','SAMLResponse=%ZZ&RelayState=b','SAMLResponse=%C0%AF&RelayState=b']) {
    assert.equal((await send({path:'/auth/saml/acs',method:'POST',headers,body})).status,400);
  }
  assert.equal((await send({path:'/auth/saml/acs',method:'POST',headers:{'Content-Type':headers['Content-Type']},body:'SAMLResponse=a&RelayState=b'})).status,401);
  assert.equal(calls.finish.length,0);
}));

test('ACS accepts only bounded URL-encoded input',async()=>harness(async(send,calls)=>{
  assert.equal((await send({path:'/auth/saml/acs',method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,415);
  for(const lengthHeaders of [{'Content-Length':String(180*1024+1)},{'Transfer-Encoding':'chunked'}]) {
    const response=await send({path:'/auth/saml/acs',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:`__Host-bb-login=${browserToken}`,...lengthHeaders},body:'x'.repeat(180*1024+1)});
    assert.equal(response.status,413);
  }
  assert.equal(calls.finish.length,0);
}));

test('too many inbound headers are rejected before any authorization dependency',async()=>harness(async(send,calls)=>{
  const headers=Object.fromEntries(Array.from({length:101},(_,index)=>[`X-Noise-${index}`,'x']));
  assert.equal((await send({path:'/auth/session',headers})).status,400);
  assert.equal(calls.rate.length,0);assert.equal(calls.authenticate.length,0);
}));

test('logout requires POST, the exact origin and CSRF token',async()=>harness(async(send,calls)=>{
  assert.equal((await send({path:'/auth/logout'})).status,405);
  const headers={Cookie:`__Host-bb-session=${sessionToken}`,'X-CSRF-Token':csrfToken};
  for(const origin of [undefined,'https://evil.example'])assert.equal((await send({path:'/auth/logout',method:'POST',headers:{...headers,...(origin?{Origin:origin}:{})}})).status,403);
  assert.equal((await send({path:'/auth/logout',method:'POST',headers:{Cookie:headers.Cookie,Origin:publicOrigin}})).status,403);
  assert.equal(calls.logout.length,0);
  const response=await send({path:'/auth/logout',method:'POST',headers:{...headers,Origin:publicOrigin}});
  assert.equal(response.status,204);assert.equal(response.body,'');assert.deepEqual(calls.logout,[{sessionToken,csrfToken}]);
  assert.equal(response.headers['set-cookie'].length,2);assert.ok(response.headers['set-cookie'].every(value=>value.includes('Max-Age=0')));
}));

test('rate denial stops work and dependency failures disclose no internal detail',async()=>{
  await harness(async(send,calls)=>{assert.equal((await send({path:'/auth/saml/login'})).status,429);assert.equal(calls.start,0);},{rateLimit:async()=>false});
  await harness(async send=>{const response=await send({path:'/auth/saml/login'});assert.equal(response.status,503);assert.ok(!response.body.includes('secret'));},{rateLimit:async()=>{throw new Error('secret directory token');}});
  await harness(async send=>{const response=await send({path:'/auth/session',headers:{Cookie:`__Host-bb-session=${sessionToken}`}});assert.equal(response.status,503);assert.ok(!response.body.includes('secret'));},{manager:{authenticate:async()=>{throw new Error('secret SQL credentials');}}});
});

test('unsafe redirects and insecure manager cookies fail closed',async()=>{
  for(const result of [{redirectUrl:'https://evil.example',loginCookie},{redirectUrl,loginCookie:`__Host-bb-login=${browserToken}; Path=/; SameSite=None`}]) {
    await harness(async send=>{const response=await send({path:'/auth/saml/login'});assert.equal(response.status,503);assert.equal(response.headers.location,undefined);assert.equal(response.headers['set-cookie'],undefined);},{manager:{startLogin:async()=>result}});
  }
});

test('ACS refuses persistent application session cookies',async()=>harness(async send=>{
  const response=await send({path:'/auth/saml/acs',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:`__Host-bb-login=${browserToken}`},body:form({SAMLResponse:'c2lnbmVkLWZpeHR1cmU=',RelayState:'r'.repeat(32)})});
  assert.equal(response.status,503);assert.equal(response.headers['set-cookie'],undefined);
},{manager:{finishLogin:async()=>({sessionCookie:`${sessionCookie}; Max-Age=28800`,clearLoginCookie,redirectPath:'/'})}}));

test('HTTP denials are audited without request secrets, arbitrary routes or error detail',async()=>harness(async(send,calls)=>{
  const secret='PRIVATE-MESSAGE-TOKEN-DO-NOT-LOG';
  const response=await send({path:`/auth/session?private=${secret}`,headers:{Authorization:secret,Cookie:`__Host-bb-session=${sessionToken}`}});
  assert.equal(response.status,403);assert.equal(calls.audit.length,1);
  assert.deepEqual(Object.keys(calls.audit[0]).sort(),['at','route','statusCode','type']);
  assert.equal(calls.audit[0].type,'auth.http_denied');assert.equal(calls.audit[0].statusCode,403);
  assert.equal(calls.audit[0].route,'unknown');assert.ok(Number.isFinite(Date.parse(calls.audit[0].at)));
  assert.equal(Object.isFrozen(calls.audit[0]),true);
  assert.ok(!JSON.stringify(calls.audit).includes(secret));assert.ok(!JSON.stringify(calls.audit).includes(sessionToken));
  const invalidBody=await send({path:'/auth/saml/acs',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:`__Host-bb-login=${browserToken}`},body:`SAMLResponse=${secret}&RelayState=x&extra=x`});
  assert.equal(invalidBody.status,400);assert.equal(calls.audit[1].route,'/auth/saml/acs');
  assert.ok(!JSON.stringify(calls.audit).includes(secret));assert.ok(!JSON.stringify(calls.audit).includes(browserToken));
}));

test('a failed mandatory denial audit fails closed with a generic unavailable result',async()=>harness(async(send,calls)=>{
  const response=await send({path:'/auth/session',headers:{Authorization:'forged'}});
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{error:'Authentication service unavailable'});
  assert.equal(calls.authenticate.length,0);
},{audit:async()=>{throw new Error('private audit connection string');}}));
