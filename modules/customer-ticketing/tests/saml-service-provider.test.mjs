import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createSamlServiceProvider,SamlAuthenticationError } from '../src/security/saml-service-provider.mjs';
import { createSamlFixture,createSamlTestStore } from './helpers/saml-fixtures.mjs';

const fixture=createSamlFixture();after(()=>fixture.dispose());
const relay='abcdefghijklmnopqrstuvwx0123456789ABCDEFG';
const make=(extra={})=>createSamlServiceProvider({config:fixture.config,store:createSamlTestStore(),...extra});
async function denied(extra={},transform=value=>value){const sp=make();const {requestId}=await sp.begin(relay);await assert.rejects(sp.validate({samlResponse:transform(fixture.createResponse({requestId,...extra})),expectedRequestId:requestId}),error=>error instanceof SamlAuthenticationError&&error.statusCode===401&&!error.cause);}

test('SP creates a signed bounded Entra authentication request',async()=>{
  const {url,requestId}=await make().begin(relay);const parsed=new URL(url);
  assert.equal(parsed.origin,'https://login.microsoftonline.com');
  assert.equal(parsed.searchParams.get('RelayState'),relay);
  const signed=['SAMLRequest','RelayState','SigAlg'].map(key=>`${key}=${encodeURIComponent(parsed.searchParams.get(key))}`).join('&');
  assert.equal(verify('RSA-SHA256',Buffer.from(signed),fixture.config.spCertificate,Buffer.from(parsed.searchParams.get('Signature'),'base64')),true);
  const xml=inflateRawSync(Buffer.from(parsed.searchParams.get('SAMLRequest'),'base64')).toString();
  assert.ok(xml.includes(`ID="${requestId}"`));assert.ok(xml.includes('ForceAuthn="true"'));
  assert.ok(!xml.includes('RequestedAuthnContext'));assert.ok(xml.includes(fixture.config.acsUrl));
});
test('genuine signed response and assertion with immutable identity and MFA succeed',async()=>{
  const sp=make();const {requestId}=await sp.begin(relay);
  const identity=await sp.validate({samlResponse:fixture.createResponse({requestId}),expectedRequestId:requestId});
  assert.equal(identity.entraTenantId,fixture.config.tenantId);assert.equal(identity.entraObjectId,'22222222-2222-4222-8222-222222222222');
  assert.ok(identity.authnInstantMs<=Date.now());assert.ok(identity.assertionId.startsWith('_'));assert.ok(Object.isFrozen(identity));
});
test('unsigned response, unsigned assertion and modified signed identity are rejected',async()=>{
  await denied({signResponse:false});await denied({signAssertion:false});
  await denied({},value=>Buffer.from(Buffer.from(value,'base64').toString().replaceAll('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333')).toString('base64'));
});
test('wrong tenant, wrong issuer, wrong audience and missing MFA deny',async()=>{
  for(const extra of [{tenantId:'33333333-3333-4333-8333-333333333333'},{issuer:'https://sts.windows.net/33333333-3333-4333-8333-333333333333/'},{audience:'https://other.example.test/saml'},{mfa:false}])await denied(extra);
});
test('wrong destination, recipient, confirmation method and failure status deny',async()=>{
  for(const extra of [{destination:'https://other.example.test/acs'},{recipient:'https://other.example.test/acs'},{method:'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key'},{responseStatus:'urn:oasis:names:tc:SAML:2.0:status:Requester'}])await denied(extra);
});
test('duplicate identity/MFA attributes and duplicate authentication statements deny',async()=>{
  for(const pattern of [/<saml:Attribute Name="http:\/\/schemas.microsoft.com\/identity\/claims\/tenantid">.*?<\/saml:Attribute>/,/<saml:Attribute Name="http:\/\/schemas.microsoft.com\/claims\/authnmethodsreferences">.*?<\/saml:Attribute>/,/<saml:AuthnStatement[\s\S]*?<\/saml:AuthnStatement>/])await denied({assertionTransform:xml=>xml.replace(pattern,match=>match+match)});
});
test('missing immutable identity never falls back to NameID or email',async()=>{
  await denied({assertionTransform:xml=>xml.replace(/<saml:Attribute Name="http:\/\/schemas.microsoft.com\/identity\/claims\/objectidentifier">.*?<\/saml:Attribute>/,'')});
});
test('expired, future, over-age and stale authentication timestamps deny',async()=>{
  const now=Date.now();for(const extra of [{notOnOrAfter:new Date(now-1000)},{notBefore:new Date(now+60000)},{issueInstant:new Date(now-600000)},{issueInstant:new Date(now+60000)},{authnInstant:new Date(now+60000)},{authnInstant:new Date(now-3601000)},{authnInstant:'not-a-date'}])await denied(extra);
});
test('subject and top-level request correlation cannot be substituted',async()=>{
  await denied({subjectRequestId:'_different'});
  const sp=make(),a=await sp.begin(relay),b=await sp.begin(relay);
  await assert.rejects(sp.validate({samlResponse:fixture.createResponse({requestId:a.requestId}),expectedRequestId:b.requestId}),{statusCode:401});
});
test('a replay and two concurrent uses produce only one identity',async()=>{
  const sp=make(),{requestId}=await sp.begin(relay),input={samlResponse:fixture.createResponse({requestId}),expectedRequestId:requestId};
  const outcomes=await Promise.allSettled([sp.validate(input),sp.validate(input)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  await assert.rejects(sp.validate(input),{statusCode:401});
});
test('assertion ID replay is denied even when re-signed for a different valid request',async()=>{
  const sp=make(),first=await sp.begin(relay),assertionId='_same_assertion';
  await sp.validate({samlResponse:fixture.createResponse({requestId:first.requestId,assertionId}),expectedRequestId:first.requestId});
  const second=await sp.begin(relay);await assert.rejects(sp.validate({samlResponse:fixture.createResponse({requestId:second.requestId,assertionId}),expectedRequestId:second.requestId}),{statusCode:401});
});
test('DTD, multiple assertions, signature wrapping and invalid base64 deny',async()=>{
  await denied({},value=>Buffer.from('<!DOCTYPE x [<!ENTITY x "hello">]>'+Buffer.from(value,'base64').toString()).toString('base64'));
  await denied({responseTransform:xml=>xml.replace('</samlp:Response>','<saml:Assertion ID="_extra"/></samlp:Response>')});
  await denied({responseTransform:xml=>xml.replace('<saml:Subject>','<saml:Subject ID="_same_assertion">'),assertionId:'_same_assertion'});
  for(const value of ['not base64','%%%%','AAAA===','x'.repeat(200000)])await assert.rejects(make().validate({samlResponse:value,expectedRequestId:'_expected'}),{statusCode:401});
});
test('missing confirmations, conditions, deadlines and multiple XML roots deny',async()=>{
  await denied({assertionTransform:xml=>xml.replace(/<saml:SubjectConfirmation .*?<\/saml:SubjectConfirmation>/,'')});
  await denied({assertionTransform:xml=>xml.replace(/<saml:Conditions .*?<\/saml:Conditions>/,'')});
  await denied({assertionTransform:xml=>xml.replaceAll(/ NotOnOrAfter="[^"]*"/g,'')});
  await denied({},value=>Buffer.from(Buffer.from(value,'base64').toString()+'<extra/>').toString('base64'));
});
test('config and key/issuer mistakes fail without revealing private material',()=>{
  for(const config of [{...fixture.config,entryPoint:'https://evil.example.test/saml2'},{...fixture.config,idpIssuer:'https://evil.example.test/'},{...fixture.config,acsUrl:'http://ticketing.example.test/acs'},{...fixture.config,spPrivateKey:'secret-private-material'},{...fixture.config,idpCertificates:[]},{...fixture.config,forceAuthn:false}])assert.throws(()=>make({config}),error=>error.statusCode===503&&!JSON.stringify(error).includes('secret-private-material'));
  assert.throws(()=>createSamlServiceProvider({config:fixture.config}),{statusCode:503});
});
test('shared-store failure returns bounded service-unavailable errors',async()=>{
  const store=createSamlTestStore();store.insert=async()=>{throw Error('database secret and assertion');};
  await assert.rejects(make({store}).begin(relay),error=>error.statusCode===503&&!JSON.stringify(error).includes('database secret'));
});
test('genuine SHA1 signatures and malformed ECDSA signature methods are refused',async()=>{
  await denied({signatureAlgorithm:'http://www.w3.org/2000/09/xmldsig#rsa-sha1',digestAlgorithm:'http://www.w3.org/2000/09/xmldsig#sha1'});
  await denied({responseTransform:xml=>xml.replace('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256','http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256')});
});
test('unexpected namespaces, excessive nesting and invalid UTF8 are refused',async()=>{
  await denied({assertionTransform:xml=>xml.replace('<saml:AttributeStatement>','<saml:AttributeStatement xmlns:saml="urn:untrusted">')});
  await denied({assertionTransform:xml=>xml.replace('</saml:Assertion>',`${'<saml:AttributeValue>'.repeat(70)}x${'</saml:AttributeValue>'.repeat(70)}</saml:Assertion>`)});
  await denied({},value=>Buffer.concat([Buffer.from(value,'base64'),Buffer.from([0xc3,0x28])]).toString('base64'));
});
test('invalid calendar dates are not normalized into an acceptable validity deadline',async()=>{
  await denied({notOnOrAfter:`${new Date().getUTCFullYear()+1}-02-30T00:00:00Z`});
});
test('SP certificate must match its private key',()=>{
  assert.throws(()=>make({config:{...fixture.config,spCertificate:fixture.config.idpCertificates[0]}}),{statusCode:503});
});
test('untrusted signing certificates are rejected; explicitly configured rotation certificates work',async()=>{
  const rotated=createSamlFixture();
  try {
    const sp=make(),{requestId}=await sp.begin(relay);
    await assert.rejects(sp.validate({samlResponse:rotated.createResponse({requestId}),expectedRequestId:requestId}),{statusCode:401});
    const approved=make({config:{...fixture.config,idpCertificates:[...fixture.config.idpCertificates,...rotated.config.idpCertificates]}});
    const next=await approved.begin(relay);
    assert.equal((await approved.validate({samlResponse:rotated.createResponse({requestId:next.requestId}),expectedRequestId:next.requestId})).entraTenantId,fixture.config.tenantId);
  }finally{rotated.dispose();}
});
test('valid but weak RSA certificate/key pairs are rejected for both IdP and SP',()=>{
  const weak=createSamlFixture({keyBits:1024});
  try {
    assert.throws(()=>make({config:{...fixture.config,idpCertificates:weak.config.idpCertificates}}),{statusCode:503});
    assert.throws(()=>make({config:{...fixture.config,spCertificate:weak.config.spCertificate,spPrivateKey:weak.config.spPrivateKey}}),{statusCode:503});
  }finally{weak.dispose();}
});
test('a shared cache cannot let another SP consume this SP request IDs',async()=>{
  const store=createSamlTestStore(),first=make({store}),{requestId}=await first.begin(relay);
  const secondConfig={...fixture.config,entityId:'https://other.example.test/saml',acsUrl:'https://other.example.test/acs'};
  const second=make({store,config:secondConfig});
  await assert.rejects(second.validate({samlResponse:fixture.createResponse({requestId,audience:secondConfig.entityId,destination:secondConfig.acsUrl,recipient:secondConfig.acsUrl}),expectedRequestId:requestId}),{statusCode:401});
});
test('startup-enabled SAML dependency debug logging blocks the factory even if NODE_DEBUG is later cleared',()=>{
  const script=`
    import {debuglog} from 'node:util';
    import {createSamlServiceProvider} from ${JSON.stringify(new URL('../src/security/saml-service-provider.mjs',import.meta.url).href)};
    import {createSamlFixture,createSamlTestStore} from ${JSON.stringify(new URL('./helpers/saml-fixtures.mjs',import.meta.url).href)};
    const loggerEnabled=debuglog('node-saml').enabled;
    process.env.NODE_DEBUG='';
    const fixture=createSamlFixture();
    let report={loggerEnabled,code:null,statusCode:null};
    try {createSamlServiceProvider({config:fixture.config,store:createSamlTestStore()});}
    catch(error){report={loggerEnabled,code:error.code,statusCode:error.statusCode,message:error.message};}
    finally{fixture.dispose();}
    console.log(JSON.stringify(report));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,NODE_DEBUG:'node-saml'},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{loggerEnabled:true,code:'SAML_CONFIG_INVALID',statusCode:503,message:'Authentication service unavailable'});
  assert.equal(result.stderr,'');
  assert.ok(!`${result.stdout}${result.stderr}`.includes('BEGIN CERTIFICATE'));
  assert.ok(!`${result.stdout}${result.stderr}`.includes('PRIVATE KEY'));
});
