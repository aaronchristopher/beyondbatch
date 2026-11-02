import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Trusted server composition only. The SAML adapter establishes identity;
// current-grant/eligibility resolution establishes permission. No bearer login,
// persona, browser-supplied identity, memory fallback or default audit sink.
const LOGIN_MS=5*60*1000, IDLE_MS=15*60*1000, REAUTH_MS=60*60*1000, ABSOLUTE_MS=8*60*60*1000;
const TOKEN=/^[A-Za-z0-9_-]{43}$/, UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha=value=>createHash('sha256').update(value).digest('hex');
const freshToken=()=>randomBytes(32).toString('base64url');
// A separate one-way token derived from the unreadable cookie. It can be
// returned by the same-origin session endpoint without revealing the session ID.
const csrfFor=token=>createHmac('sha256',token).update('beyondbatch-csrf-v1').digest('base64url');
const cookie=(name,value,sameSite,maxAge)=>`${name}=${value}; Secure; HttpOnly; Path=/; SameSite=${sameSite}${maxAge===undefined?'':`; Max-Age=${maxAge}`}`;
export const CLEAR_SESSION_COOKIE=cookie('__Host-bb-session','','Lax',0);
export const CLEAR_LOGIN_COOKIE=cookie('__Host-bb-login','','None',0);

export class AuthSessionError extends Error {
  constructor(statusCode=401){
    super(statusCode===401?'Authentication required':statusCode===403?'Access denied':'Authentication service unavailable');
    this.name='AuthSessionError';this.statusCode=statusCode;
    this.code=statusCode===401?'INVALID_SESSION':statusCode===403?'SESSION_ACCESS_DENIED':'AUTH_DEPENDENCY_UNAVAILABLE';
  }
}
function fail(status=401){throw new AuthSessionError(status);}
function time(clock){const value=clock();const now=value instanceof Date?value.getTime():NaN;if(!Number.isSafeInteger(now)||now<0)fail(503);return now;}
function validToken(value){if(typeof value!=='string'||!TOKEN.test(value)||Buffer.from(value,'base64url').toString('base64url')!==value)fail();return value;}
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function dependency(value,methods,label){if(!value||methods.some(method=>typeof value[method]!=='function'))throw new TypeError(`Required ${label} dependency`);}
async function bounded(action){try{return await action();}catch(error){if(error instanceof AuthSessionError)throw error;throw new AuthSessionError([401,403].includes(error?.statusCode)?error.statusCode:503);}}
function identityOf(value){
  if(!value||!UUID.test(value.entraTenantId??'')||!UUID.test(value.entraObjectId??''))fail();
  return Object.freeze({entraTenantId:value.entraTenantId.toLowerCase(),entraObjectId:value.entraObjectId.toLowerCase()});
}
function sessionValid(row,key,now){
  if(!row||row.key!==key||!Number.isSafeInteger(row.createdAtMs)||!Number.isSafeInteger(row.lastSeenAtMs)
    ||!Number.isSafeInteger(row.expiresAtMs)||!Number.isSafeInteger(row.reauthAtMs)
    ||row.createdAtMs>now||row.lastSeenAtMs>now||now>=row.expiresAtMs||now>=row.reauthAtMs
    ||now>=row.lastSeenAtMs+IDLE_MS||row.expiresAtMs>row.createdAtMs+ABSOLUTE_MS
    ||row.reauthAtMs>row.expiresAtMs||row.reauthAtMs>row.createdAtMs+REAUTH_MS)fail();
  return identityOf(row);
}

export function createSamlSessionManager({serviceProvider,store,resolvePrincipal,audit,clock=()=>new Date()}={}){
  dependency(serviceProvider,['begin','validate'],'SAML protocol');
  dependency(store,['insert','get','consume','putSession','readAndTouchSession','deleteSession'],'shared authentication store');
  if(typeof resolvePrincipal!=='function'||typeof audit!=='function'||typeof clock!=='function')throw new TypeError('Required current authorization, audit and clock dependencies');
  const record=(type,fields={})=>audit(Object.freeze({type,at:new Date(time(clock)).toISOString(),...fields}));
  const run=(denialType,action)=>bounded(async()=>{
    try{return await bounded(action);}catch(error){await record(denialType,{reason:error.code});throw error;}
  });
  return Object.freeze({
    startLogin({previousSessionToken}={}){return run('auth.login_denied',async()=>{
      const now=time(clock),relay=freshToken(),browser=freshToken();
      const previousSessionHash=previousSessionToken===undefined||previousSessionToken===null?null:sha(validToken(previousSessionToken));
      const {url,requestId}=await serviceProvider.begin(relay);
      const target=new URL(url);
      if(target.protocol!=='https:'||target.hostname!=='login.microsoftonline.com'||target.username||target.password||target.hash
        ||!/^\/[0-9a-f-]{36}\/saml2$/.test(target.pathname)||target.searchParams.get('RelayState')!==relay
        ||typeof requestId!=='string'||!/^_[A-Za-z0-9_-]{1,199}$/.test(requestId)||time(clock)>=now+LOGIN_MS)fail(503);
      const saved=await store.insert(`login:${sha(relay)}`,{requestId,browserHash:sha(browser),createdAtMs:now,previousSessionHash},now+LOGIN_MS);
      if(!saved)fail(503);
      await record('auth.login_started');
      return {redirectUrl:target.href,loginCookie:cookie('__Host-bb-login',browser,'None',LOGIN_MS/1000)};
    });},
    finishLogin({samlResponse,relayState,browserToken,previousSessionToken}={}){return run('auth.login_denied',async()=>{
      validToken(relayState);validToken(browserToken);
      const now=time(clock),key=`login:${sha(relayState)}`,pending=await store.get(key,now);
      if(!pending||!Number.isSafeInteger(pending.value?.createdAtMs)||pending.value.createdAtMs>now
        ||pending.expiresAtMs>pending.value.createdAtMs+LOGIN_MS
        ||!equal(pending.value.browserHash,sha(browserToken))
        ||(pending.value.previousSessionHash!==null&&!/^[0-9a-f]{64}$/.test(pending.value.previousSessionHash??'')))fail();
      const consumed=await store.consume(key,time(clock));
      if(!consumed||consumed.value.requestId!==pending.value.requestId||!equal(consumed.value.browserHash,sha(browserToken))
        ||consumed.value.previousSessionHash!==pending.value.previousSessionHash||time(clock)>=pending.expiresAtMs)fail();
      const verified=await serviceProvider.validate({samlResponse,expectedRequestId:pending.value.requestId});
      const identity=identityOf(verified),principal=await resolvePrincipal(identity),createdAtMs=time(clock);
      if(createdAtMs>=pending.expiresAtMs||!Number.isSafeInteger(verified.authnInstantMs)
        ||verified.authnInstantMs>createdAtMs||createdAtMs>=verified.authnInstantMs+REAUTH_MS)fail();
      const idpExpires=verified.sessionNotOnOrAfterMs??createdAtMs+ABSOLUTE_MS;
      if(!Number.isSafeInteger(idpExpires)||idpExpires<=createdAtMs)fail();
      const expiresAtMs=Math.min(createdAtMs+ABSOLUTE_MS,idpExpires),reauthAtMs=Math.min(expiresAtMs,verified.authnInstantMs+REAUTH_MS);
      const token=freshToken(),sessionKey=sha(token),csrfHash=sha(csrfFor(token));
      if(!await store.putSession({key:sessionKey,...identity,csrfHash,createdAtMs,lastSeenAtMs:createdAtMs,expiresAtMs,reauthAtMs}))fail(503);
      try{
        // The Lax session cookie is omitted on the IdP's cross-site POST. Its
        // server-generated hash was bound at the same-origin login initiation.
        if(pending.value.previousSessionHash)await store.deleteSession(pending.value.previousSessionHash);
        if(previousSessionToken!==undefined&&previousSessionToken!==null){validToken(previousSessionToken);await store.deleteSession(sha(previousSessionToken));}
        if(time(clock)>=Math.min(pending.expiresAtMs,reauthAtMs,createdAtMs+IDLE_MS))fail();
        await record('auth.login_succeeded',{principalId:principal.id,tenantId:principal.tenantId,sessionRef:sha(`audit:${token}`)});
        if(time(clock)>=Math.min(pending.expiresAtMs,reauthAtMs,createdAtMs+IDLE_MS))fail();
      }catch(error){await store.deleteSession(sessionKey);throw error;}
      return {sessionCookie:cookie('__Host-bb-session',token,'Lax'),clearLoginCookie:CLEAR_LOGIN_COOKIE,redirectPath:'/',principal};
    });},
    authenticate(sessionToken){return run('auth.session_denied',async()=>{
      validToken(sessionToken);const key=sha(sessionToken),now=time(clock);
      const row=await store.readAndTouchSession(key,now,IDLE_MS),identity=sessionValid(row,key,time(clock));
      if(!equal(row.csrfHash,sha(csrfFor(sessionToken))))fail();
      let principal;
      try{principal=await resolvePrincipal(identity);}catch(error){if(error?.statusCode===403)await store.deleteSession(key);throw error;}
      await record('auth.session_accepted',{principalId:principal.id,tenantId:principal.tenantId,sessionRef:sha(`audit:${sessionToken}`)});
      // Recheck after awaited permission work: logout/expiry must not be undone
      // by a request that was already in flight. Every write still needs its own
      // resource/grant check in the database transaction.
      const end=time(clock),current=await store.readAndTouchSession(key,end,IDLE_MS),currentIdentity=sessionValid(current,key,time(clock));
      if(!equal(currentIdentity.entraTenantId,identity.entraTenantId)||!equal(currentIdentity.entraObjectId,identity.entraObjectId)
        ||current.createdAtMs!==row.createdAtMs||current.expiresAtMs!==row.expiresAtMs||current.reauthAtMs!==row.reauthAtMs
        ||!equal(current.csrfHash,row.csrfHash))fail();
      return {principal,csrfToken:csrfFor(sessionToken),expiresAtMs:row.expiresAtMs,reauthAtMs:row.reauthAtMs};
    });},
    logout({sessionToken,csrfToken}={}){return run('auth.logout_denied',async()=>{
      validToken(sessionToken);
      if(typeof csrfToken!=='string'||!TOKEN.test(csrfToken)||!equal(csrfToken,csrfFor(sessionToken)))fail(403);
      await store.deleteSession(sha(sessionToken));
      await record('auth.logout',{sessionRef:sha(`audit:${sessionToken}`)});
    });},
  });
}

const LIMITS=Object.freeze({login:[10,15*60*1000],acs:[20,15*60*1000],session:[120,60*1000],logout:[20,15*60*1000],data:[120,60*1000]});
export function createAuthRateLimiter({store,clock=()=>new Date()}={}){
  dependency(store,['takeRateLimit'],'shared rate-limit store');
  if(typeof clock!=='function')throw new TypeError('Required rate-limit clock');
  return ({scope,clientKey}={})=>bounded(async()=>{
    if(!Object.hasOwn(LIMITS,scope)||typeof clientKey!=='string'||!clientKey.length||clientKey.length>200||/[\u0000-\u0020\u007f]/.test(clientKey))fail(503);
    const [limit,windowMs]=LIMITS[scope];
    return store.takeRateLimit(`rate:${sha(`${scope}\0${clientKey}`)}`,time(clock),windowMs,limit);
  });
}
