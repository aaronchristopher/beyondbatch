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
  // Explicit loopback allowlist is isolated to this local TLS fixture.
  const networkAccess=Object.hasOwn(patch,'networkAccess')?patch.networkAccess:{allowedClientIps:['127.0.0.1']};
  const handler=createSamlAuthHandler({manager:deps.manager,rateLimit:deps.rateLimit,audit:deps.audit,publicOrigin,networkAccess});
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
  const deps={...dependencies(),networkAccess:{allowedClientIps:['127.0.0.1']}};
  for(const origin of ['http://ticketing.example.test','https://user:pass@ticketing.example.test','https://ticketing.example.test/path','https://ticketing.example.test?x=1','https://ticketing.example.test/#x']) {
    assert.throws(()=>createSamlAuthHandler({...deps,publicOrigin:origin}),TypeError);
  }
  assert.throws(()=>createSamlAuthHandler({publicOrigin,networkAccess:deps.networkAccess,manager:deps.manager}),TypeError);
  assert.throws(()=>createSamlAuthHandler({publicOrigin,networkAccess:deps.networkAccess,manager:{},rateLimit:deps.rateLimit}),TypeError);
  assert.throws(()=>createSamlAuthHandler({publicOrigin,networkAccess:deps.networkAccess,manager:deps.manager,rateLimit:deps.rateLimit}),TypeError);
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

// These are fictional documentation addresses, never a production allowlist.
const fictionalVpnIp='198.51.100.9',fictionalOutsideIp='203.0.113.27';
const proxyNetwork=()=>({allowedClientIps:[fictionalVpnIp],trustedProxy:{peerIps:['127.0.0.1'],clientIpHeader:'x-bb-client-ip'}});

test('network configuration is mandatory and cannot be replaced by an allow callback',()=>{
  const deps={...dependencies(),publicOrigin};
  assert.throws(()=>createSamlAuthHandler(deps),TypeError);
  for(const networkAccess of [null,{},false,{allowedClientIps:[]},()=>true,{authorize:()=>fictionalVpnIp}]) {
    assert.throws(()=>createSamlAuthHandler({...deps,networkAccess}),TypeError);
  }
});

test('an off-network peer receives no health, redirect, cookie, session or private-route response',async()=>harness(async(send,calls)=>{
  for(const path of ['/health','/auth/saml/login','/auth/saml/acs','/auth/session','/auth/logout','/api/workspace','/attachments/guessed-id','/export']) {
    const post=['/auth/saml/acs','/auth/logout'].includes(path);
    const response=await send({path,method:post?'POST':'GET',headers:{
      Cookie:`__Host-bb-session=${sessionToken}; __Host-bb-login=${browserToken}`,
      'X-Forwarded-For':fictionalVpnIp,'X-BB-Client-IP':fictionalVpnIp,
      ...(post?{'Content-Type':'application/x-www-form-urlencoded',Origin:publicOrigin,'X-CSRF-Token':csrfToken}:{}),
    },...(post?{body:'SAMLResponse=private&RelayState=private'}:{})});
    assert.equal(response.status,403,path);assert.deepEqual(JSON.parse(response.body),{error:'Access denied'});
    assert.equal(response.headers.location,undefined);assert.equal(response.headers['set-cookie'],undefined);
    assert.equal(response.headers['cache-control'],'no-store');
    assert.ok(!response.body.includes('customer1'));
  }
  assert.equal(calls.start,0);assert.equal(calls.finish.length,0);assert.equal(calls.authenticate.length,0);
  assert.equal(calls.logout.length,0);assert.equal(calls.rate.length,0);
  assert.equal(calls.audit.length,8);assert.ok(calls.audit.every(event=>event.reason==='network'));
},{networkAccess:{allowedClientIps:[fictionalVpnIp]}}));

test('trusted proxy mode uses only its validated client address for the network gate and rate key',async()=>harness(async(send,calls)=>{
  const response=await send({path:'/auth/session',headers:{Cookie:`__Host-bb-session=${sessionToken}`,
    'X-BB-Client-IP':fictionalVpnIp,'X-Forwarded-For':'untrusted-client-chain','X-Real-IP':fictionalOutsideIp}});
  assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body).principal,principal);
  assert.deepEqual(calls.authenticate,[sessionToken]);
  assert.deepEqual(calls.rate,[{scope:'session',clientKey:fictionalVpnIp}]);
},{networkAccess:proxyNetwork()}));

test('an approved network still requires a session and CSRF protection',async()=>harness(async(send,calls)=>{
  const headers={'X-BB-Client-IP':fictionalVpnIp};
  assert.equal((await send({path:'/auth/session',headers})).status,401);
  assert.equal((await send({path:'/auth/logout',method:'POST',headers:{...headers,Cookie:`__Host-bb-session=${sessionToken}`,Origin:publicOrigin}})).status,403);
  assert.equal(calls.authenticate.length,0);assert.equal(calls.logout.length,0);
  assert.ok(calls.audit.every(event=>event.reason===undefined));
},{networkAccess:proxyNetwork()}));

test('a saved session cannot continue when its next request comes from outside the VPN allowlist',async()=>harness(async(send,calls)=>{
  const headers={Cookie:`__Host-bb-session=${sessionToken}`};
  assert.equal((await send({path:'/auth/session',headers:{...headers,'X-BB-Client-IP':fictionalVpnIp}})).status,200);
  assert.equal((await send({path:'/auth/session',headers:{...headers,'X-BB-Client-IP':fictionalOutsideIp}})).status,403);
  assert.deepEqual(calls.authenticate,[sessionToken]);assert.equal(calls.rate.length,1);
  assert.equal(calls.audit.at(-1).reason,'network');
},{networkAccess:proxyNetwork()}));

test('a forwarded approved address cannot bypass an untrusted proxy peer',async()=>harness(async(send,calls)=>{
  const response=await send({path:'/auth/session',headers:{Cookie:`__Host-bb-session=${sessionToken}`,
    'X-BB-Client-IP':fictionalVpnIp,'X-Forwarded-For':fictionalVpnIp}});
  assert.equal(response.status,403);assert.equal(calls.authenticate.length,0);assert.equal(calls.rate.length,0);
  assert.equal(calls.audit[0].reason,'network');
},{networkAccess:{allowedClientIps:[fictionalVpnIp],trustedProxy:{peerIps:['192.0.2.20'],clientIpHeader:'x-bb-client-ip'}}}));

test('proxy mode denies missing, duplicate and malformed client headers without a direct-address fallback',async()=>harness(async(send,calls)=>{
  const invalidHeaders=[{}, {'X-Forwarded-For':fictionalVpnIp}, {'Forwarded':`for=${fictionalVpnIp}`},
    {'X-BB-Client-IP':[fictionalVpnIp,fictionalVpnIp]}, {'X-BB-Client-IP':`${fictionalVpnIp}, ${fictionalOutsideIp}`},
    {'X-BB-Client-IP':`${fictionalVpnIp}:443`}, {'X-BB-Client-IP':'vpn.example.test'},
    {'X-BB-Client-IP':'PRIVATE-HEADER-DO-NOT-LOG'}, {'X-BB-Client-IP':'[2001:db8::10]'}];
  for(const headers of invalidHeaders) {
    const response=await send({path:'/auth/session',headers:{Cookie:`__Host-bb-session=${sessionToken}`,...headers}});
    assert.equal(response.status,403,JSON.stringify(headers));assert.deepEqual(JSON.parse(response.body),{error:'Access denied'});
  }
  assert.equal(calls.authenticate.length,0);assert.equal(calls.rate.length,0);
  assert.ok(calls.audit.every(event=>event.reason==='network'));
},{networkAccess:{...proxyNetwork(),allowedClientIps:[fictionalVpnIp,'127.0.0.1']}}));

test('the running HTTP network policy is an immutable snapshot of its configuration',async()=>{
  const networkAccess=proxyNetwork();
  await harness(async(send,calls)=>{
    networkAccess.allowedClientIps.push(fictionalOutsideIp);
    networkAccess.trustedProxy.peerIps.splice(0,1,'192.0.2.20');
    networkAccess.trustedProxy.clientIpHeader='x-forwarded-for';
    assert.equal((await send({path:'/auth/session',headers:{Cookie:`__Host-bb-session=${sessionToken}`,'X-BB-Client-IP':fictionalOutsideIp}})).status,403);
    assert.equal((await send({path:'/auth/session',headers:{Cookie:`__Host-bb-session=${sessionToken}`,'X-BB-Client-IP':fictionalVpnIp}})).status,200);
    assert.deepEqual(calls.authenticate,[sessionToken]);
  },{networkAccess});
});

test('network denials have a bounded audit reason without raw address, header, route or cookie data',async()=>harness(async(send,calls)=>{
  const secret='PRIVATE-HEADER-DO-NOT-LOG';
  const response=await send({path:`/attachments/${secret}`,headers:{Cookie:`__Host-bb-session=${sessionToken}`,'X-BB-Client-IP':secret}});
  assert.equal(response.status,403);assert.equal(calls.audit.length,1);
  const event=calls.audit[0];assert.deepEqual(Object.keys(event).sort(),['at','reason','route','statusCode','type']);
  assert.equal(event.reason,'network');assert.equal(event.route,'unknown');assert.equal(event.statusCode,403);
  assert.equal(event.type,'auth.http_denied');assert.equal(Object.isFrozen(event),true);
  const serialized=JSON.stringify(event);
  for(const value of [secret,sessionToken,fictionalVpnIp,'127.0.0.1'])assert.ok(!serialized.includes(value));
  assert.equal(calls.authenticate.length,0);assert.equal(calls.rate.length,0);
},{networkAccess:proxyNetwork()}));

test('an unavailable mandatory network-denial audit still denies access without disclosing its failure',async()=>harness(async(send,calls)=>{
  const response=await send({path:'/auth/session',headers:{Cookie:`__Host-bb-session=${sessionToken}`,'X-BB-Client-IP':fictionalOutsideIp}});
  assert.equal(response.status,503);assert.deepEqual(JSON.parse(response.body),{error:'Authentication service unavailable'});
  assert.equal(response.headers.location,undefined);assert.equal(response.headers['set-cookie'],undefined);
  assert.equal(calls.authenticate.length,0);assert.equal(calls.rate.length,0);
},{networkAccess:proxyNetwork(),audit:async()=>{throw new Error('private audit credentials');}}));
