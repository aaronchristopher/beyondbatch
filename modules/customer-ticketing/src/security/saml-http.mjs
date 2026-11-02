/**
 * HTTPS-only SAML transport boundary. This does not listen, configure Microsoft,
 * or attach customer-data routes. Compose only with the reviewed SAML manager
 * and shared limiter; neither may be selected from request input.
 */
const SESSION_COOKIE='__Host-bb-session',LOGIN_COOKIE='__Host-bb-login';
const MAX_BODY=180*1024, BODY_TIMEOUT_MS=5000, DEPENDENCY_TIMEOUT_MS=10000;
const CLEAR_SESSION=`${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
const CLEAR_LOGIN=`${LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`;
const TOKEN=/^[A-Za-z0-9_-]{32,128}$/;
const REQUIRED_METHODS={
  '/auth/saml/login':'GET', '/auth/saml/acs':'POST',
  '/auth/session':'GET', '/auth/logout':'POST', '/health':'GET',
};
const HEADERS=Object.freeze({
  'Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security':'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer', 'Cross-Origin-Resource-Policy':'same-origin',
  'Cross-Origin-Opener-Policy':'same-origin',
});
const MESSAGES={400:'Invalid request',401:'Authentication required',403:'Access denied',404:'Not found',405:'Method not allowed',413:'Request too large',415:'Unsupported content type',429:'Too many requests',503:'Authentication service unavailable'};
class BoundaryError extends Error {constructor(statusCode){super(MESSAGES[statusCode]);this.statusCode=statusCode;}}
const fail=status=>{throw new BoundaryError(status);};

function oneHeader(req,name) {
  let count=0;
  for(let i=0;i<(req.rawHeaders?.length??0);i+=2)if(req.rawHeaders[i].toLowerCase()===name)count++;
  if(count>1||Array.isArray(req.headers[name]))fail(400);
  const value=req.headers[name];
  if(value!==undefined&&typeof value!=='string')fail(400);
  return value;
}
function rejectAlternateIdentity(req) {
  for(const name of Object.keys(req.headers)) {
    if(['authorization','proxy-authorization','remote-user','x-remote-user','x-forwarded-user','x-auth-request-user','x-auth-request-email'].includes(name)
        ||name.startsWith('x-ms-client-principal')||name.startsWith('x-ms-token-'))fail(403);
  }
}
function cookies(req) {
  const raw=oneHeader(req,'cookie');
  if(!raw)return {};
  if(raw.length>8192)fail(400);
  const result={};
  const parts=raw.split(';');if(parts.length>50)fail(400);
  for(const part of parts) {
    const separator=part.indexOf('=');
    const name=(separator<0?part:part.slice(0,separator)).trim();
    if(name!==SESSION_COOKIE&&name!==LOGIN_COOKIE)continue;
    if(separator<0||Object.hasOwn(result,name))fail(400);
    const token=part.slice(separator+1).trim();
    if(!TOKEN.test(token))fail(401);
    result[name]=token;
  }
  return result;
}
function noBody(req) {
  const length=oneHeader(req,'content-length');
  if(oneHeader(req,'transfer-encoding')!==undefined||(length!==undefined&&length!=='0'))fail(400);
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new BoundaryError(503)),DEPENDENCY_TIMEOUT_MS);timer.unref?.();
    })]);
  } finally {clearTimeout(timer);}
}
function readForm(req) {
  const type=oneHeader(req,'content-type');
  if(typeof type!=='string'||!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(type))fail(415);
  const encoding=oneHeader(req,'content-encoding');
  if(encoding!==undefined&&encoding!=='identity')fail(415);
  const length=oneHeader(req,'content-length');
  if(length!==undefined&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))))fail(400);
  if(Number(length)>MAX_BODY)fail(413);
  return new Promise((resolve,reject)=>{
    let total=0,done=false;const chunks=[];
    const finish=(error,value)=>{
      if(done)return;done=true;clearTimeout(timer);
      req.removeListener('data',onData);req.removeListener('end',onEnd);req.removeListener('aborted',onAbort);req.removeListener('error',onError);
      if(error){req.resume();reject(error);}else resolve(value);
    };
    const onData=chunk=>{total+=chunk.length;if(total>MAX_BODY)return finish(new BoundaryError(413));chunks.push(chunk);};
    const onEnd=()=>{
      try {
        const body=Buffer.concat(chunks).toString('utf8');
        const fields={};const pairs=body.split('&');
        if(pairs.length!==2)fail(400);
        for(const pair of pairs) {
          const separator=pair.indexOf('=');if(separator<0)fail(400);
          const key=decodeURIComponent(pair.slice(0,separator).replaceAll('+',' '));
          const value=decodeURIComponent(pair.slice(separator+1).replaceAll('+',' '));
          if(!['SAMLResponse','RelayState'].includes(key)||Object.hasOwn(fields,key)||!value)fail(400);
          fields[key]=value;
        }
        if(!fields.SAMLResponse||!fields.RelayState||fields.RelayState.length>80||fields.SAMLResponse.length>175*1024)fail(400);
        finish(null,fields);
      } catch {finish(new BoundaryError(400));}
    };
    const onAbort=()=>finish(new BoundaryError(400));
    const onError=()=>finish(new BoundaryError(400));
    const timer=setTimeout(()=>finish(new BoundaryError(503)),BODY_TIMEOUT_MS);timer.unref?.();
    req.on('data',onData);req.once('end',onEnd);req.once('aborted',onAbort);req.once('error',onError);
  });
}
function approvedRedirect(value) {
  let url;try{url=new URL(value);}catch{fail(503);}
  if(typeof value!=='string'||value.length>65536||/[\u0000-\u0020\u007f]/.test(value)||url.protocol!=='https:'||url.hostname!=='login.microsoftonline.com'
      ||url.port||url.username||url.password||url.hash||!/^\/[0-9a-f-]{36}\/saml2$/i.test(url.pathname)
      ||!url.searchParams.has('SAMLRequest')||!url.searchParams.has('RelayState')||!url.searchParams.has('Signature'))fail(503);
  return value;
}
function approvedCookie(value,name,{clear=false}={}) {
  if(typeof value!=='string'||value.length>1024||/[\r\n]/.test(value))fail(503);
  const parts=value.split(';').map(part=>part.trim());
  if(!parts[0].startsWith(`${name}=`))fail(503);
  const token=parts[0].slice(name.length+1);
  if(clear?token!=='':!TOKEN.test(token))fail(503);
  const attributes=new Map();
  for(const part of parts.slice(1)) {
    const separator=part.indexOf('=');
    const key=(separator<0?part:part.slice(0,separator)).toLowerCase();
    const content=separator<0?'':part.slice(separator+1);
    if(attributes.has(key)||!['path','secure','httponly','samesite','max-age'].includes(key))fail(503);
    attributes.set(key,content);
  }
  const age=attributes.get('max-age');
  // Application sessions are browser-session cookies, not remember-me cookies.
  // Correlation cookies have a short lifetime; deletions explicitly use zero.
  const validAge=clear?age==='0':name===SESSION_COOKIE?age===undefined:
    /^\d+$/.test(age??'')&&Number.isSafeInteger(Number(age))&&Number(age)>=1&&Number(age)<=300;
  if(attributes.get('path')!=='/'||attributes.get('secure')!==''||attributes.get('httponly')!==''
      ||attributes.get('samesite')?.toLowerCase()!==(name===SESSION_COOKIE?'lax':'none')
      ||!validAge)fail(503);
  return value;
}
function sessionProjection(result) {
  const principal=result?.principal;
  const text=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value);
  if(!principal||!['pm','department','president'].includes(principal.role)||!text(principal.id)||!text(principal.tenantId)||!text(principal.name)
      ||!['customerIds','departmentIds'].every(key=>Array.isArray(principal[key])&&principal[key].length<=10000&&principal[key].every(text))
      ||!TOKEN.test(result.csrfToken??'')||!Number.isSafeInteger(result.expiresAtMs)||!Number.isSafeInteger(result.reauthAtMs))fail(503);
  return {principal:{id:principal.id,tenantId:principal.tenantId,name:principal.name,role:principal.role,
    customerIds:[...principal.customerIds],departmentIds:[...principal.departmentIds]},
    csrfToken:result.csrfToken,expiresAtMs:result.expiresAtMs,reauthAtMs:result.reauthAtMs};
}

export function createSamlAuthHandler({manager,publicOrigin,rateLimit,audit}={}) {
  let origin;try{origin=new URL(publicOrigin);}catch{throw new TypeError('Invalid public origin');}
  if(typeof publicOrigin!=='string'||publicOrigin!==origin.origin||origin.protocol!=='https:'||origin.username||origin.password)throw new TypeError('Invalid public origin');
  if(!manager||!['startLogin','finishLogin','authenticate','logout'].every(key=>typeof manager[key]==='function')
      ||typeof rateLimit!=='function'||typeof audit!=='function')throw new TypeError('SAML manager, shared rate limiter and audit sink are required');
  return async function samlAuthHandler(req,res) {
    const auditRoute=Object.hasOwn(REQUIRED_METHODS,req.url)?req.url:'unknown';
    const respond=(status,body=null,extra={})=>{
      if(res.destroyed||res.writableEnded)return;
      res.writeHead(status,{...HEADERS,...(body===null?{}:{'Content-Type':'application/json; charset=utf-8'}),...extra});
      res.end(body===null?'':JSON.stringify(body));
    };
    try {
      if(!Array.isArray(req.rawHeaders)||req.rawHeaders.length>200
          ||req.rawHeaders.reduce((total,value)=>total+Buffer.byteLength(String(value)),0)>16384)fail(400);
      if(req.socket?.encrypted!==true||oneHeader(req,'host')!==origin.host)fail(403);
      rejectAlternateIdentity(req);
      if(typeof req.url!=='string'||req.url.length>2048||!req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('#'))fail(400);
      const url=new URL(req.url,publicOrigin);
      if(Object.hasOwn(REQUIRED_METHODS,url.pathname)) {
        if(url.search||url.pathname!==req.url)fail(400);
        if(req.method!==REQUIRED_METHODS[url.pathname])fail(405);
      }
      if(url.pathname==='/health'){noBody(req);return respond(200,{ready:false,mode:'saml-integration'});}
      const scope={'/auth/saml/login':'login','/auth/saml/acs':'acs','/auth/session':'session','/auth/logout':'logout'}[url.pathname]??'data';
      const clientKey=req.socket.remoteAddress;
      if(typeof clientKey!=='string'||!clientKey||clientKey.length>128)fail(503);
      if(await bounded(rateLimit({scope,clientKey}))!==true)fail(429);
      if(url.pathname==='/auth/saml/login') {
        noBody(req);const requestOrigin=oneHeader(req,'origin');if(requestOrigin!==undefined&&requestOrigin!==publicOrigin)fail(403);
        // Capture the old session while a same-site GET still includes its Lax
        // cookie. The subsequent cross-site IdP POST normally omits that cookie.
        const previousSessionToken=cookies(req)[SESSION_COOKIE];
        const result=await bounded(manager.startLogin({previousSessionToken}));
        const location=approvedRedirect(result?.redirectUrl),cookie=approvedCookie(result?.loginCookie,LOGIN_COOKIE);
        return respond(303,null,{Location:location,'Set-Cookie':cookie});
      }
      if(url.pathname==='/auth/saml/acs') {
        const fields=await readForm(req),values=cookies(req);
        if(!values[LOGIN_COOKIE])fail(401);
        const result=await bounded(manager.finishLogin({samlResponse:fields.SAMLResponse,relayState:fields.RelayState,
          browserToken:values[LOGIN_COOKIE],previousSessionToken:values[SESSION_COOKIE]}));
        if(result?.redirectPath!=='/')fail(503);
        const issued=approvedCookie(result.sessionCookie,SESSION_COOKIE),cleared=approvedCookie(result.clearLoginCookie,LOGIN_COOKIE,{clear:true});
        return respond(303,null,{Location:'/', 'Set-Cookie':[issued,cleared]});
      }
      noBody(req);
      const values=cookies(req),sessionToken=values[SESSION_COOKIE];
      if(!sessionToken)fail(401);
      if(url.pathname==='/auth/logout') {
        if(oneHeader(req,'origin')!==publicOrigin)fail(403);
        const csrfToken=oneHeader(req,'x-csrf-token');if(!TOKEN.test(csrfToken??''))fail(403);
        await bounded(manager.logout({sessionToken,csrfToken}));
        return respond(204,null,{'Set-Cookie':[CLEAR_SESSION,CLEAR_LOGIN]});
      }
      const result=await bounded(manager.authenticate(sessionToken));
      if(url.pathname==='/auth/session')return respond(200,sessionProjection(result));
      fail(404);
    } catch(error) {
      let status=Number.isInteger(error?.statusCode)&&Object.hasOwn(MESSAGES,error.statusCode)?error.statusCode:503;
      try {
        await bounded(audit(Object.freeze({type:'auth.http_denied',statusCode:status,at:new Date().toISOString(),route:auditRoute})));
      } catch {status=503;}
      // Close rejected body streams; do not leave the process buffering input.
      return respond(status,{error:MESSAGES[status]},{...(req.method==='POST'?{Connection:'close'}:{}),
        ...(status===429?{'Retry-After':auditRoute==='/auth/saml/login'||auditRoute==='/auth/saml/acs'?'900':'60'}:{})});
    }
  };
}
