import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSamlSessionManager, createAuthRateLimiter } from '../src/security/auth-session.mjs';
import { createMemoryAuthStore } from './helpers/auth-memory-store.mjs';

// Component tests use a deliberately fake protocol adapter. Genuine signed XML
// and HTTPS composition are tested separately, never through this fake in runtime.
const tid='11111111-1111-4111-8111-111111111111', oid='22222222-2222-4222-8222-222222222222';
const cookieValue=cookie=>cookie.split(';')[0].split('=')[1];
const hash=value=>createHash('sha256').update(value).digest('hex');
function setup(options={}) {
  let now=Date.parse('2026-11-02T12:00:00Z'), allowed=true, calls=0;
  const store=options.store??createMemoryAuthStore(), events=[];
  const principal={id:'fictional-pm',tenantId:'fictional-db-tenant',name:'Fictional PM',role:'pm',customerIds:['fictional-customer'],departmentIds:[]};
  const provider={
    async begin(relay){return {url:`https://login.microsoftonline.com/${tid}/saml2?RelayState=${relay}`,requestId:'_request_'+relay};},
    async validate(){calls++;return {entraTenantId:tid,entraObjectId:oid,authnInstantMs:now,assertionId:'_assertion',...options.identity};},
  };
  const manager=createSamlSessionManager({serviceProvider:provider,store,
    resolvePrincipal:options.resolvePrincipal??(async()=>{if(!allowed)throw Object.assign(new Error('private detail'),{statusCode:403});return principal;}),
    audit:options.audit??(async event=>events.push(event)),clock:()=>new Date(now)});
  return {manager,store,events,principal,setNow:time=>{now=time;},advance:ms=>{now+=ms;},deny:()=>{allowed=false;},now:()=>now,calls:()=>calls};
}
async function pending(f,previousSessionToken) {
  const login=await f.manager.startLogin({previousSessionToken});
  return {login,relayState:new URL(login.redirectUrl).searchParams.get('RelayState'),browserToken:cookieValue(login.loginCookie),samlResponse:'test-only-adapter'};
}
async function login(f,old) {
  const p=await pending(f,old);const result=await f.manager.finishLogin(p);
  return {result,token:cookieValue(result.sessionCookie)};
}

test('session manager requires protocol, shared store, authorization and audit dependencies',()=>{
  assert.throws(()=>createSamlSessionManager(),TypeError);
  assert.throws(()=>createSamlSessionManager({serviceProvider:{begin(){},validate(){}},store:createMemoryAuthStore(),resolvePrincipal:async()=>({})}),TypeError);
});
test('login uses independent opaque browser/session tokens and restrictive cookie attributes',async()=>{
  const f=setup(),p=await pending(f);
  assert.match(p.login.loginCookie,/^__Host-bb-login=/);
  assert.match(p.login.loginCookie,/Secure; HttpOnly; Path=\/; SameSite=None/);
  assert.notEqual(p.relayState,p.browserToken);
  const result=await f.manager.finishLogin(p),token=cookieValue(result.sessionCookie);
  assert.match(result.sessionCookie,/^__Host-bb-session=/);assert.match(result.sessionCookie,/SameSite=Lax/);
  assert.equal(result.redirectPath,'/');assert.ok(!result.sessionCookie.includes('Expires='));
  const session=await f.manager.authenticate(token);
  assert.deepEqual(session.principal,f.principal);assert.notEqual(session.csrfToken,token);
  assert.equal(session.reauthAtMs,f.now()+60*60*1000);
  assert.ok(!JSON.stringify(f.events).includes(token));assert.ok(!JSON.stringify(f.events).includes(p.browserToken));
  const persisted=await f.store.readAndTouchSession(hash(token),f.now(),15*60*1000);
  assert.equal(persisted.csrfHash,hash(session.csrfToken));assert.ok(!JSON.stringify(persisted).includes(token));
});
test('wrong browser, missing state and expired login cannot reach the protocol verifier',async()=>{
  const f=setup(),p=await pending(f);
  await assert.rejects(f.manager.finishLogin({...p,browserToken:'a'.repeat(43)}),{statusCode:401});
  await assert.rejects(f.manager.finishLogin({...p,relayState:null}),{statusCode:401});
  f.advance(5*60*1000);await assert.rejects(f.manager.finishLogin(p),{statusCode:401});assert.equal(f.calls(),0);
});
test('one browser-bound login can create at most one session concurrently',async()=>{
  const f=setup(),p=await pending(f);
  const results=await Promise.allSettled([f.manager.finishLogin(p),f.manager.finishLogin(p)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls(),1);
});
test('authorization is reloaded and revoked users cannot use an existing cookie',async()=>{
  const f=setup(),{token}=await login(f);await f.manager.authenticate(token);f.deny();
  await assert.rejects(f.manager.authenticate(token),error=>error.statusCode===403&&!error.message.includes('private'));
});
test('idle expiry is strict while active sessions slide only inside the reauthentication bound',async()=>{
  const f=setup(),{token}=await login(f);
  for(let i=0;i<5;i++){f.advance(10*60*1000);await f.manager.authenticate(token);}
  f.advance(10*60*1000);await assert.rejects(f.manager.authenticate(token),{statusCode:401});
  const second=setup(),s=await login(second);second.advance(15*60*1000);
  await assert.rejects(second.manager.authenticate(s.token),{statusCode:401});
});
test('invalid, stale or future authentication instants cannot establish a session',async()=>{
  for(const instant of [NaN,Date.parse('2026-11-02T11:00:00Z'),Date.parse('2026-11-02T12:00:01Z')]){
    const f=setup({identity:{authnInstantMs:instant}});await assert.rejects(login(f),{statusCode:401});
  }
});
test('IdP session expiry can shorten but never extend application deadlines',async()=>{
  const end=Date.parse('2026-11-02T12:05:00Z'),f=setup({identity:{sessionNotOnOrAfterMs:end}}),{token}=await login(f);
  assert.equal((await f.manager.authenticate(token)).expiresAtMs,end);f.advance(5*60*1000);
  await assert.rejects(f.manager.authenticate(token),{statusCode:401});
});
test('logout requires the correct CSRF token and deletes the server session',async()=>{
  const f=setup(),{token}=await login(f),s=await f.manager.authenticate(token);
  await assert.rejects(f.manager.logout({sessionToken:token,csrfToken:'a'.repeat(43)}),{statusCode:403});
  await f.manager.authenticate(token);
  await f.manager.logout({sessionToken:token,csrfToken:s.csrfToken});
  await assert.rejects(f.manager.authenticate(token),{statusCode:401});
});
test('a new successful login rotates and revokes the previous session',async()=>{
  const f=setup(),first=await login(f),second=await login(f,first.token);
  assert.notEqual(first.token,second.token);await assert.rejects(f.manager.authenticate(first.token),{statusCode:401});
  await f.manager.authenticate(second.token);
});
test('current principal failure and audit failure cannot issue a session cookie',async()=>{
  const denied=setup({resolvePrincipal:async()=>{throw Object.assign(new Error('private'),{statusCode:403});}});
  await assert.rejects(login(denied),{statusCode:403});
  const failed=setup({audit:async()=>{throw new Error('private audit secret');}});
  await assert.rejects(failed.manager.startLogin(),error=>error.statusCode===503&&!error.message.includes('private'));
});
test('logout during a pending permission check prevents returning an authenticated principal',async()=>{
  let gated=false,release,started;const begun=new Promise(r=>{started=r;});const gate=new Promise(r=>{release=r;});
  const f=setup({resolvePrincipal:async()=>{if(gated){started();await gate;}return {id:'fictional',role:'pm'};}});
  const {token}=await login(f);gated=true;const pending=f.manager.authenticate(token);await begun;
  await f.store.deleteSession(hash(token));release();await assert.rejects(pending,{statusCode:401});
});
test('malformed tokens deny before storage or authorization and never echo input',async()=>{
  const f=setup();for(const token of [null,'','Bearer anything','a'.repeat(500),'private@example.test']){
    await assert.rejects(f.manager.authenticate(token),{statusCode:401});
  }
});
test('a slow final session-store read cannot return a session after its deadline',async()=>{
  const original=createMemoryAuthStore();let reads=0,f;
  const store={...original,async readAndTouchSession(...args){const row=await original.readAndTouchSession(...args);if(++reads===2)f.advance(60*60*1000);return row;}};
  f=setup({store});const {token}=await login(f);
  await assert.rejects(f.manager.authenticate(token),{statusCode:401});
});
test('a denied identity loses the existing session instead of restoring it when grants return',async()=>{
  let allowed=true;const f=setup({resolvePrincipal:async()=>{if(!allowed)throw Object.assign(new Error(),{statusCode:403});return {id:'fictional',tenantId:'fictional-db'};}});
  const {token}=await login(f);allowed=false;await assert.rejects(f.manager.authenticate(token),{statusCode:403});
  allowed=true;await assert.rejects(f.manager.authenticate(token),{statusCode:401});
});
test('failed login and denied session decisions have bounded audit records',async()=>{
  const f=setup(),p=await pending(f);
  await assert.rejects(f.manager.finishLogin({...p,browserToken:'a'.repeat(43)}));
  await assert.rejects(f.manager.authenticate('private-cookie-invalid'));
  assert.ok(f.events.some(e=>e.type==='auth.login_denied'));
  assert.ok(f.events.some(e=>e.type==='auth.session_denied'));
  assert.ok(!JSON.stringify(f.events).includes('private-cookie-invalid'));assert.ok(!JSON.stringify(f.events).includes(p.browserToken));
});
test('login correlation expiry during a slow session save prevents issuing the cookie',async()=>{
  const original=createMemoryAuthStore();let f;
  const store={...original,async putSession(record){const saved=await original.putSession(record);f.advance(5*60*1000);return saved;}};
  f=setup({store});await assert.rejects(login(f),{statusCode:401});
});
test('shared rate limiter bounds concurrent login attempts and resets after the window',async()=>{
  let now=Date.parse('2026-11-02T12:00:00Z');const store=createMemoryAuthStore();
  const a=createAuthRateLimiter({store,clock:()=>new Date(now)}),b=createAuthRateLimiter({store,clock:()=>new Date(now)});
  const results=await Promise.all(Array.from({length:25},(_,i)=>(i%2?a:b)({scope:'login',clientKey:'127.0.0.1'})));
  assert.equal(results.filter(Boolean).length,10);now+=15*60*1000;
  assert.equal(await a({scope:'login',clientKey:'127.0.0.1'}),true);
  await assert.rejects(a({scope:'unrecognized',clientKey:'127.0.0.1'}));
});
