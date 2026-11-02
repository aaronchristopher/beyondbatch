import { createHash,createPrivateKey,createPublicKey,randomBytes,X509Certificate } from 'node:crypto';
import { debuglog } from 'node:util';
import { SAML } from '@node-saml/node-saml';
import { DOMParser } from '@xmldom/xmldom';

// Node-SAML remains the cryptographic authority. The maintained DOM parser below
// performs restrictive, deny-only preflight; identities come ONLY from the
// library's verified assertion. No raw response or flattened profile is trusted.
const NS={assertion:'urn:oasis:names:tc:SAML:2.0:assertion',protocol:'urn:oasis:names:tc:SAML:2.0:protocol',
  signature:'http://www.w3.org/2000/09/xmldsig#',exclusive:'http://www.w3.org/2001/10/xml-exc-c14n#'};
const RSA_SHA256='http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256='http://www.w3.org/2001/04/xmlenc#sha256';
const BEARER='urn:oasis:names:tc:SAML:2.0:cm:bearer';
const SUCCESS='urn:oasis:names:tc:SAML:2.0:status:Success';
const CLAIMS={tenant:'http://schemas.microsoft.com/identity/claims/tenantid',object:'http://schemas.microsoft.com/identity/claims/objectidentifier',
  methods:'http://schemas.microsoft.com/claims/authnmethodsreferences',mfa:'http://schemas.microsoft.com/claims/multipleauthn'};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ID=/^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/;
const FIVE_MINUTES=300000,ONE_HOUR=3600000,MAX_XML_BYTES=131072;
const CONFIG_FIELDS=['tenantId','entityId','acsUrl','entryPoint','idpIssuer','idpCertificates','spPrivateKey','spCertificate'];
const SAML_NAMES=new Set(['Assertion','Issuer','Subject','NameID','SubjectConfirmation','SubjectConfirmationData',
  'Conditions','AudienceRestriction','Audience','AttributeStatement','Attribute','AttributeValue','AuthnStatement','AuthnContext','AuthnContextClassRef']);
const SIGNATURE_NAMES=new Set(['Signature','SignedInfo','CanonicalizationMethod','SignatureMethod','Reference','Transforms','Transform',
  'DigestMethod','DigestValue','SignatureValue','KeyInfo','X509Data','X509Certificate']);

export class SamlAuthenticationError extends Error {
  constructor(code='INVALID_SAML_RESPONSE',statusCode=401) {
    super(statusCode===503?'Authentication service unavailable':'Authentication required');
    this.name='SamlAuthenticationError';this.code=code;this.statusCode=statusCode;
  }
}
const invalid=()=>new SamlAuthenticationError();
const unavailable=()=>new SamlAuthenticationError('SAML_DEPENDENCY_UNAVAILABLE',503);
const configInvalid=()=>new SamlAuthenticationError('SAML_CONFIG_INVALID',503);
function requireValue(condition){if(!condition)throw invalid();}
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function nowMs(clock){try{const now=clock();if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw Error();return now.getTime();}catch{throw unavailable();}}
function time(value){
  requireValue(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value));
  const result=Date.parse(value);requireValue(Number.isFinite(result));
  // Date.parse normalizes e.g. February 30. A signed invalid deadline is still
  // invalid; compare calendar/time components while allowing Entra's fractions.
  requireValue(new Date(result).toISOString().slice(0,19)===value.slice(0,19));return result;
}
function one(value){requireValue(Array.isArray(value)&&value.length===1&&plain(value[0]));return value[0];}
function textValue(value){requireValue(plain(value)&&typeof value._==='string'&&value._.length>0&&value._.length<=2048&&Object.keys(value).every(key=>key==='_'||key==='$'));return value._;}
function attrs(value){requireValue(plain(value?.$));return value.$;}
function httpsUrl(value){try{const url=new URL(value);return typeof value==='string'&&url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.href===value;}catch{return false;}}
function checkRsa(key){if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails?.modulusLength<2048)throw configInvalid();}
function certificate(pem){if(typeof pem!=='string'||pem.length>32768||(pem.match(/-----BEGIN CERTIFICATE-----/g)??[]).length!==1)throw configInvalid();const cert=new X509Certificate(pem);checkRsa(cert.publicKey);return cert;}
function currentCertificate(cert,now){if(!Number.isFinite(Date.parse(cert.validFrom))||!Number.isFinite(Date.parse(cert.validTo))||now<Date.parse(cert.validFrom)||now>=Date.parse(cert.validTo))throw configInvalid();}

function validateConfiguration(input,clock) {
  try {
    if(!plain(input)||Object.keys(input).some(key=>!CONFIG_FIELDS.includes(key))||CONFIG_FIELDS.some(key=>!Object.hasOwn(input,key)))throw configInvalid();
    if(typeof input.tenantId!=='string'||!UUID.test(input.tenantId)||!httpsUrl(input.entityId)||!httpsUrl(input.acsUrl))throw configInvalid();
    const config={...input,tenantId:input.tenantId.toLowerCase(),idpCertificates:[...input.idpCertificates]};
    if(config.entryPoint!==`https://login.microsoftonline.com/${config.tenantId}/saml2`||config.idpIssuer!==`https://sts.windows.net/${config.tenantId}/`)throw configInvalid();
    if(!Array.isArray(input.idpCertificates)||config.idpCertificates.length<1||config.idpCertificates.length>3)throw configInvalid();
    const idpCerts=config.idpCertificates.map(certificate),spCert=certificate(config.spCertificate);
    if(typeof config.spPrivateKey!=='string'||config.spPrivateKey.length>32768)throw configInvalid();
    const privateKey=createPrivateKey(config.spPrivateKey);checkRsa(privateKey);
    if(!createPublicKey(privateKey).export({type:'spki',format:'der'}).equals(spCert.publicKey.export({type:'spki',format:'der'})))throw configInvalid();
    const certificates=[...idpCerts,spCert];certificates.forEach(cert=>currentCertificate(cert,nowMs(clock)));
    Object.freeze(config.idpCertificates);Object.freeze(config);
    return {config,certificates};
  }catch(error){if(error instanceof SamlAuthenticationError)throw error;throw configInvalid();}
}

const elements=node=>Array.from(node.childNodes??[]).filter(child=>child.nodeType===1);
function child(node,namespace,name){const found=elements(node).filter(item=>item.namespaceURI===namespace&&item.localName===name);requireValue(found.length===1);return found[0];}
function domText(node){requireValue(elements(node).length===0);return node.textContent;}
function signaturePreflight(node,parent) {
  const info=child(node,NS.signature,'SignedInfo');
  requireValue(child(info,NS.signature,'CanonicalizationMethod').getAttribute('Algorithm')===NS.exclusive);
  requireValue(child(info,NS.signature,'SignatureMethod').getAttribute('Algorithm')===RSA_SHA256);
  const reference=child(info,NS.signature,'Reference');
  requireValue(reference.getAttribute('URI')===`#${parent.getAttribute('ID')}`);
  requireValue(child(reference,NS.signature,'DigestMethod').getAttribute('Algorithm')===SHA256);
  const transforms=elements(child(reference,NS.signature,'Transforms'));
  requireValue(transforms.length===2&&transforms.every(item=>item.namespaceURI===NS.signature&&item.localName==='Transform')
    &&transforms[0].getAttribute('Algorithm')===`${NS.signature}enveloped-signature`&&transforms[1].getAttribute('Algorithm')===NS.exclusive);
  child(node,NS.signature,'SignatureValue');child(reference,NS.signature,'DigestValue');
}

function decodeResponse(encoded) {
  requireValue(typeof encoded==='string'&&encoded.length>0&&encoded.length<=4*Math.ceil(MAX_XML_BYTES/3)
    &&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded));
  const bytes=Buffer.from(encoded,'base64');requireValue(bytes.length<=MAX_XML_BYTES&&bytes.toString('base64')===encoded);
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}

function preflight(xml,config,requestId,now) {
  requireValue(!/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml));
  const fail=()=>{throw invalid();};
  const doc=new DOMParser({errorHandler:{warning:fail,error:fail,fatalError:fail}}).parseFromString(xml,'application/xml');
  const roots=elements(doc);requireValue(roots.length===1);
  const root=roots[0];requireValue(root.namespaceURI===NS.protocol&&root.localName==='Response');
  const seenIds=new Set();let count=0;
  function visit(node,depth,inSignature=false) {
    requireValue(++count<=2048&&depth<=64&&node.nodeType!==10&&node.nodeType!==8);
    if(node.nodeType===7)requireValue(node.nodeName==='xml'&&node.parentNode===doc);
    if(node.nodeType===1){
      const signature=node.namespaceURI===NS.signature&&node.localName==='Signature';
      if(inSignature||signature)requireValue(node.namespaceURI===NS.signature&&SIGNATURE_NAMES.has(node.localName)
        ||node.namespaceURI===NS.exclusive&&node.localName==='InclusiveNamespaces');
      else requireValue(node.namespaceURI===NS.assertion&&SAML_NAMES.has(node.localName)
        ||node.namespaceURI===NS.protocol&&['Response','Status','StatusCode'].includes(node.localName));
      requireValue(node.attributes.length<=32);
      for(const attr of Array.from(node.attributes))if(['ID','Id','id','xml:id'].includes(attr.name)){
        requireValue(ID.test(attr.value)&&!seenIds.has(attr.value));seenIds.add(attr.value);
      }
      inSignature ||= signature;
    }
    for(const next of Array.from(node.childNodes??[]))visit(next,depth+1,inSignature);
  }
  visit(doc,0);
  requireValue(root.getAttribute('Version')==='2.0'&&ID.test(root.getAttribute('ID'))&&root.getAttribute('Destination')===config.acsUrl&&root.getAttribute('InResponseTo')===requestId);
  const issued=time(root.getAttribute('IssueInstant'));requireValue(issued<=now&&issued>now-FIVE_MINUTES);
  requireValue(domText(child(root,NS.assertion,'Issuer'))===config.idpIssuer);
  const status=child(root,NS.protocol,'Status'),statusCode=child(status,NS.protocol,'StatusCode');
  requireValue(elements(status).length===1&&elements(statusCode).length===0&&statusCode.getAttribute('Value')===SUCCESS);
  const assertion=child(root,NS.assertion,'Assertion');
  requireValue(doc.getElementsByTagNameNS(NS.assertion,'Assertion').length===1&&elements(root).length===4);
  requireValue(doc.getElementsByTagNameNS(NS.signature,'Signature').length===2);
  signaturePreflight(child(root,NS.signature,'Signature'),root);
  signaturePreflight(child(assertion,NS.signature,'Signature'),assertion);
}

function verifiedIdentity(profile,config,requestId,now) {
  requireValue(profile&&profile.issuer===config.idpIssuer&&profile.inResponseTo===requestId&&typeof profile.getAssertion==='function');
  const envelope=profile.getAssertion();requireValue(plain(envelope)&&plain(envelope.Assertion));
  const assertion=envelope.Assertion,a=attrs(assertion);
  requireValue(a.Version==='2.0'&&typeof a.ID==='string'&&ID.test(a.ID));
  const issued=time(a.IssueInstant);requireValue(issued<=now&&issued>now-FIVE_MINUTES);
  requireValue(textValue(one(assertion.Issuer))===config.idpIssuer);
  const conditions=one(assertion.Conditions),c=attrs(conditions),notBefore=time(c.NotBefore),expires=time(c.NotOnOrAfter);
  requireValue(notBefore<=now&&expires>now&&expires>notBefore);
  const audience=one(conditions.AudienceRestriction);requireValue(textValue(one(audience.Audience))===config.entityId);
  const subject=one(assertion.Subject);one(subject.NameID);
  const confirmation=one(subject.SubjectConfirmation);requireValue(attrs(confirmation).Method===BEARER);
  const data=attrs(one(confirmation.SubjectConfirmationData));
  requireValue(data.Recipient===config.acsUrl&&data.InResponseTo===requestId&&time(data.NotOnOrAfter)>now);
  if(data.NotBefore!==undefined)requireValue(time(data.NotBefore)<=now);
  const authn=one(assertion.AuthnStatement),authnAttrs=attrs(authn),authnInstantMs=time(authnAttrs.AuthnInstant);
  requireValue(authnInstantMs<=now&&authnInstantMs>now-ONE_HOUR);
  textValue(one(one(authn.AuthnContext).AuthnContextClassRef));
  let sessionNotOnOrAfterMs;
  if(authnAttrs.SessionNotOnOrAfter!==undefined){sessionNotOnOrAfterMs=time(authnAttrs.SessionNotOnOrAfter);requireValue(sessionNotOnOrAfterMs>now);}
  const statement=one(assertion.AttributeStatement);requireValue(Array.isArray(statement.Attribute)&&statement.Attribute.length>0&&statement.Attribute.length<=64);
  const claims=new Map();
  for(const attribute of statement.Attribute){
    const name=attrs(attribute).Name;requireValue(typeof name==='string'&&name.length>0&&name.length<=512&&!claims.has(name));
    requireValue(Array.isArray(attribute.AttributeValue)&&attribute.AttributeValue.length>0&&attribute.AttributeValue.length<=32);
    claims.set(name,attribute.AttributeValue.map(textValue));
  }
  const tenant=claims.get(CLAIMS.tenant),object=claims.get(CLAIMS.object),methods=claims.get(CLAIMS.methods);
  requireValue(tenant?.length===1&&object?.length===1&&UUID.test(tenant[0])&&UUID.test(object[0]));
  requireValue(tenant[0].toLowerCase()===config.tenantId&&methods?.includes(CLAIMS.mfa)&&new Set(methods).size===methods.length);
  return Object.freeze({entraTenantId:config.tenantId,entraObjectId:object[0].toLowerCase(),authnInstantMs,assertionId:a.ID,
    ...(sessionNotOnOrAfterMs===undefined?{}:{sessionNotOnOrAfterMs})});
}

/** Shared store is mandatory; callbacks are trusted infrastructure, not HTTP input. */
export function createSamlServiceProvider({config:input,store,clock=()=>new Date()}={}) {
  // The dependency can print source-derived validation errors in debug mode.
  // Node caches debug enablement at startup: checking the mutable environment
  // string would miss an active logger after NODE_DEBUG is cleared.
  if(debuglog('node-saml').enabled)throw configInvalid();
  if(typeof clock!=='function'||!store||['insert','get','consume','remove'].some(method=>typeof store[method]!=='function'))throw configInvalid();
  const {config,certificates}=validateConfiguration(input,clock);
  const scope=JSON.stringify([config.idpIssuer,config.entityId,config.acsUrl]);
  const key=(kind,value)=>`saml-${kind}:${createHash('sha256').update(scope).update('\0').update(value).digest('hex')}`;
  const call=async(method,...args)=>{try{return await store[method](...args);}catch{throw unavailable();}};
  const rowValue=(row,now)=>{if(row===null)return null;if(!plain(row)||typeof row.value!=='string'||!Number.isFinite(row.expiresAtMs))throw unavailable();return row.expiresAtMs>now?row.value:null;};
  const cacheProvider={
    async saveAsync(id,value){const now=nowMs(clock);if(await call('insert',key('request',id),value,now+FIVE_MINUTES)!==true)throw unavailable();return {value,createdAt:now};},
    async getAsync(id){const now=nowMs(clock);return rowValue(await call('get',key('request',id),now),now);},
    async consumeAsync(id){const now=nowMs(clock);return rowValue(await call('consume',key('request',id),now),now);},
    async removeAsync(id){if(id===null)return null;const removed=await call('remove',key('request',id));if(typeof removed!=='boolean')throw unavailable();return removed?id:null;},
    async saveIfAbsentAsync(id,value,expiresAtMs){if(!Number.isFinite(expiresAtMs)||expiresAtMs>nowMs(clock)+FIVE_MINUTES*2)throw unavailable();const saved=await call('insert',key('replay',id),value,expiresAtMs);if(typeof saved!=='boolean')throw unavailable();return saved;},
  };
  const options={issuer:config.entityId,audience:config.entityId,callbackUrl:config.acsUrl,entryPoint:config.entryPoint,
    idpIssuer:config.idpIssuer,idpCert:config.idpCertificates,privateKey:config.spPrivateKey,publicCert:config.spCertificate,
    signatureAlgorithm:'sha256',digestAlgorithm:'sha256',wantAssertionsSigned:true,wantAuthnResponseSigned:true,
    validateInResponseTo:'always',rejectReplayedAssertions:true,acceptedClockSkewMs:0,maxAssertionAgeMs:FIVE_MINUTES,
    requestIdExpirationPeriodMs:FIVE_MINUTES,disableRequestedAuthnContext:true,forceAuthn:true,identifierFormat:null,cacheProvider};
  const validator=new SAML(options);
  function checkCertificates(){certificates.forEach(cert=>currentCertificate(cert,nowMs(clock)));}
  return Object.freeze({
    async begin(relayState){
      try {
        requireValue(typeof relayState==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(relayState));checkCertificates();
        const requestId=`_${randomBytes(32).toString('hex')}`;
        const requestSp=new SAML({...options,generateUniqueId:()=>requestId});
        const url=await requestSp.getAuthorizeUrlAsync(relayState,{});
        return Object.freeze({url,requestId});
      }catch(error){if(error instanceof SamlAuthenticationError)throw error;throw unavailable();}
    },
    async validate({samlResponse,expectedRequestId}={}){
      try {
        requireValue(typeof expectedRequestId==='string'&&/^_[a-f0-9]{64}$/.test(expectedRequestId));checkCertificates();
        const xml=decodeResponse(samlResponse);preflight(xml,config,expectedRequestId,nowMs(clock));
        const result=await validator.validatePostResponseAsync({SAMLResponse:samlResponse});
        requireValue(result.loggedOut===false&&result.profile!==null);
        checkCertificates();return verifiedIdentity(result.profile,config,expectedRequestId,nowMs(clock));
      }catch(error){if(error instanceof SamlAuthenticationError)throw error;throw invalid();}
    },
  });
}
