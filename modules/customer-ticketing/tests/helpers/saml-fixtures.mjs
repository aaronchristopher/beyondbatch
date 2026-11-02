// Fictional SAML IdP used only in tests. Private keys exist only in a temporary
// directory/in process memory and are never committed or used for real identity.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { SignedXml } from 'xml-crypto';

const SAML='urn:oasis:names:tc:SAML:2.0:assertion';
const SAMLP='urn:oasis:names:tc:SAML:2.0:protocol';
const DS='http://www.w3.org/2000/09/xmldsig#';
const EXC='http://www.w3.org/2001/10/xml-exc-c14n#';
const RSA='http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const DIGEST='http://www.w3.org/2001/04/xmlenc#sha256';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const instant=value=>value instanceof Date?value.toISOString():String(value);
const attribute=(name,values)=>`<saml:Attribute Name="${escape(name)}">${values.map(value=>`<saml:AttributeValue>${escape(value)}</saml:AttributeValue>`).join('')}</saml:Attribute>`;

export function createSamlFixture({keyBits=2048}={}) {
  if(![1024,2048].includes(keyBits))throw new TypeError('Unsupported fictional test key size');
  const dir=mkdtempSync(join(tmpdir(),'beyondbatch-fictional-saml-'));
  const certFor=name=>{
    const keyPath=join(dir,`${name}.key`),certPath=join(dir,`${name}.crt`);
    execFileSync('openssl',['req','-x509','-newkey',`rsa:${keyBits}`,'-sha256','-nodes','-days','2',
      '-subj',`/CN=fictional-${name}.example.test`,'-keyout',keyPath,'-out',certPath],{stdio:'ignore'});
    return {key:readFileSync(keyPath,'utf8'),cert:readFileSync(certPath,'utf8')};
  };
  let idp,sp;
  try {idp=certFor('idp');sp=certFor('sp');} catch(error){rmSync(dir,{recursive:true,force:true});throw error;}
  const tenantId='11111111-1111-4111-8111-111111111111';
  const config={tenantId,entityId:'https://ticketing.example.test/saml',
    acsUrl:'https://ticketing.example.test/auth/saml/acs',
    entryPoint:`https://login.microsoftonline.com/${tenantId}/saml2`,idpIssuer:`https://sts.windows.net/${tenantId}/`,
    idpCertificates:[idp.cert],spPrivateKey:sp.key,spCertificate:sp.cert};
  function sign(xml,kind,options) {
    const signer=new SignedXml({privateKey:idp.key,publicCert:idp.cert,signatureAlgorithm:options.signatureAlgorithm??RSA,canonicalizationAlgorithm:EXC});
    const xpath=`/*[local-name()='${kind}']`;
    signer.addReference({xpath,transforms:[`${DS}enveloped-signature`,EXC],digestAlgorithm:options.digestAlgorithm??DIGEST});
    signer.computeSignature(xml,{prefix:'ds',location:{reference:`${xpath}/*[local-name()='Issuer']`,action:'after'}});
    return signer.getSignedXml();
  }
  function createResponse(options={}) {
    const now=Date.now(),id=options.assertionId??`_${randomBytes(20).toString('hex')}`;
    const issuer=options.issuer??config.idpIssuer;
    const issue=instant(options.issueInstant??new Date(now-1000));
    const before=instant(options.notBefore??new Date(now-5000));
    const after=instant(options.notOnOrAfter??new Date(now+240000));
    const authn=instant(options.authnInstant??new Date(now-2000));
    const oid=options.objectId??'22222222-2222-4222-8222-222222222222';
    const claims=[attribute('http://schemas.microsoft.com/identity/claims/tenantid',[options.tenantId??tenantId]),
      attribute('http://schemas.microsoft.com/identity/claims/objectidentifier',[oid]),
      attribute('http://schemas.microsoft.com/claims/authnmethodsreferences',options.mfa===false?
        ['http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password']:
        ['http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/fido','http://schemas.microsoft.com/claims/multipleauthn'])].join('');
    let assertion=`<saml:Assertion xmlns:saml="${SAML}" ID="${escape(id)}" Version="2.0" IssueInstant="${escape(issue)}"><saml:Issuer>${escape(issuer)}</saml:Issuer><saml:Subject><saml:NameID>${escape(oid)}</saml:NameID><saml:SubjectConfirmation Method="${escape(options.method??'urn:oasis:names:tc:SAML:2.0:cm:bearer')}"><saml:SubjectConfirmationData InResponseTo="${escape(options.subjectRequestId??options.requestId)}" Recipient="${escape(options.recipient??config.acsUrl)}" NotOnOrAfter="${escape(after)}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${escape(before)}" NotOnOrAfter="${escape(after)}"><saml:AudienceRestriction><saml:Audience>${escape(options.audience??config.entityId)}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AttributeStatement>${claims}</saml:AttributeStatement><saml:AuthnStatement AuthnInstant="${escape(authn)}" SessionIndex="fixture-session"${options.sessionNotOnOrAfter?` SessionNotOnOrAfter="${escape(instant(options.sessionNotOnOrAfter))}"`:''}><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion>`;
    if(options.assertionTransform)assertion=options.assertionTransform(assertion);
    if(options.signAssertion!==false)assertion=sign(assertion,'Assertion',options);
    let xml=`<samlp:Response xmlns:samlp="${SAMLP}" xmlns:saml="${SAML}" ID="_${randomBytes(20).toString('hex')}" Version="2.0" IssueInstant="${escape(issue)}" Destination="${escape(options.destination??config.acsUrl)}" InResponseTo="${escape(options.requestId)}"><saml:Issuer>${escape(issuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${escape(options.responseStatus??'urn:oasis:names:tc:SAML:2.0:status:Success')}"/></samlp:Status>${assertion}</samlp:Response>`;
    if(options.responseTransform)xml=options.responseTransform(xml);
    if(options.signResponse!==false)xml=sign(xml,'Response',options);
    return options.format==='xml'?xml:Buffer.from(xml).toString('base64');
  }
  return {config,createResponse,dispose(){rmSync(dir,{recursive:true,force:true});}};
}

/** Atomic in-process fixture only; production must use the reviewed shared store. */
export function createSamlTestStore() {
  const values=new Map();
  return {
    async insert(key,value,expiresAtMs){if(values.has(key))return false;values.set(key,{value,expiresAtMs});return true;},
    async get(key,nowMs){const row=values.get(key);return row&&row.expiresAtMs>nowMs?structuredClone(row):null;},
    async consume(key,nowMs){const row=values.get(key);values.delete(key);return row&&row.expiresAtMs>nowMs?structuredClone(row):null;},
    async remove(key){return values.delete(key);},
  };
}
