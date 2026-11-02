import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrincipalResolver, PrincipalResolutionError } from '../src/security/entra-principal.mjs';
import { canReadRequest } from '../src/security/workspace.mjs';
import { spawnSync } from 'node:child_process';

// Boundary tests use an explicitly injected verifier double. They do NOT prove a
// real JWT's signature, JWKS rotation, live Entra consent, or deployed SSO.
const tid = '11111111-1111-1111-1111-111111111111';
const oid = '22222222-2222-2222-2222-222222222222';
const otherTid = '33333333-3333-3333-3333-333333333333';
const otherOid = '44444444-4444-4444-4444-444444444444';
const audience = '55555555-5555-5555-5555-555555555555';
const issuer = `https://login.microsoftonline.com/${tid}/v2.0`;
const now = '2026-11-02T12:00:00.000Z';
const nowSeconds = Date.parse(now) / 1000;
const claims = (patch = {}) => ({ tid, oid, iss: issuer, aud: audience,
  exp: nowSeconds + 3600, nbf: nowSeconds - 60, iat: nowSeconds - 60, scp: 'access_as_user', ...patch });
const grant = (patch = {}) => ({ id: 'grant1', tenantId: 'db-tenant1', principalId: 'db-user1',
  roleName: 'pm', scopeKind: 'customer', customerId: 'customer1',
  grantedAt: '2026-11-01T12:00:00.000Z', expiresAt: null, revokedAt: null, ...patch });
const principal = (patch = {}) => ({ id: 'db-user1', tenantId: 'db-tenant1', entraTenantId: tid,
  entraObjectId: oid, name: 'Authorized PM', principalType: 'user', status: 'active', tenantStatus: 'active',
  grants: [grant()], ...patch });
function setup({ claimPatch, verification, row, verifier, loader, clock, ...config } = {}) {
  const seen = { verify: [], load: [] };
  const resolve = createPrincipalResolver({ tenantId: tid, audience, issuer,
    clock: clock ?? (() => new Date(now)),
    verifyAccessToken: async (token, policy) => { seen.verify.push({ token, policy }); return verifier
      ? verifier(token, policy) : verification ?? { tokenUse: 'access_token', claims: claims(claimPatch) }; },
    loadPrincipal: async input => { seen.load.push(input); return loader ? loader(input) : row === undefined ? principal() : row; },
    ...config });
  return { resolve, seen };
}
async function deniedWith(resolve, token = 'opaque-access-token', status = 401) {
  await assert.rejects(resolve(token), error => error instanceof PrincipalResolutionError && error.statusCode === status);
}

function legacyProductionProbe(body, environment) {
  const script=`
    import {createPrincipalResolver} from ${JSON.stringify(new URL('../src/security/entra-principal.mjs',import.meta.url).href)};
    const seen={verify:0,load:0};
    const options={tenantId:${JSON.stringify(tid)},audience:${JSON.stringify(audience)},issuer:${JSON.stringify(issuer)},
      allowProduction:true,clock:()=>new Date(${JSON.stringify(now)}),
      verifyAccessToken:async()=>{seen.verify++;return ${JSON.stringify({tokenUse:'access_token',claims:claims()})};},
      loadPrincipal:async()=>{seen.load++;return ${JSON.stringify(principal())};}};
    ${body}
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,NODE_ENV:environment},encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}

test('legacy bearer resolver construction is disabled in production even with valid dependencies',()=>{
  const report=legacyProductionProbe(`
    let failure=null;
    try {createPrincipalResolver(options);} catch(error) {failure={code:error.code,status:error.statusCode};}
    console.log(JSON.stringify({seen,failure}));
  `,'production');
  assert.deepEqual(report,{seen:{verify:0,load:0},failure:{code:'LEGACY_BEARER_DISABLED',status:503}});
});

test('legacy bearer resolution is disabled if production starts after resolver construction',()=>{
  const report=legacyProductionProbe(`
    const resolve=createPrincipalResolver(options);
    process.env.NODE_ENV='production';
    let failure=null;
    try {await resolve('opaque-access-token');} catch(error) {failure={code:error.code,status:error.statusCode};}
    console.log(JSON.stringify({seen,failure}));
  `,'development');
  assert.deepEqual(report,{seen:{verify:0,load:0},failure:{code:'LEGACY_BEARER_DISABLED',status:503}});
});

test('an in-flight legacy principal loader cannot return a principal after production starts',()=>{
  const report=legacyProductionProbe(`
    let signalStarted,releaseLoader;
    const started=new Promise(resolve=>{signalStarted=resolve;});
    const released=new Promise(resolve=>{releaseLoader=resolve;});
    const originalLoader=options.loadPrincipal;
    options.loadPrincipal=async input=>{
      const row=await originalLoader(input);signalStarted();await released;return row;
    };
    const resolve=createPrincipalResolver(options);
    let failure=null,resolved=null;
    const pending=resolve('opaque-access-token');
    await started;
    process.env.NODE_ENV='production';
    releaseLoader();
    try {resolved=await pending;} catch(error) {failure={code:error.code,status:error.statusCode};}
    console.log(JSON.stringify({seen,failure,resolved}));
  `,'development');
  assert.deepEqual(report,{seen:{verify:1,load:1},failure:{code:'LEGACY_BEARER_DISABLED',status:503},resolved:null});
});

test('requires explicit cryptographic verifier and DB loader; has no decode or fixture fallback', () => {
  assert.throws(() => createPrincipalResolver({ tenantId: tid, audience, issuer, loadPrincipal() {} }), /verifyAccessToken/);
  assert.throws(() => createPrincipalResolver({ tenantId: tid, audience, issuer, verifyAccessToken() {} }), /loadPrincipal/);
  assert.throws(() => setup({ tenantId: 'common' }), /tenantId/);
  assert.throws(() => setup({ issuer: 'http://issuer.example' }), /issuer/);
});

test('passes strict access-token policy to verifier before mapping verified tid+oid', async () => {
  const { resolve, seen } = setup();
  const result = await resolve('opaque-access-token');
  assert.deepEqual(seen.verify[0].policy, { tenantId: tid, audience, issuer,
    requiredScope: 'access_as_user', tokenUse: 'access_token', clockToleranceSeconds: 0, now });
  assert.deepEqual(seen.load, [{ entraTenantId: tid, entraObjectId: oid, now }]);
  assert.deepEqual(result, { id: 'db-user1', tenantId: 'db-tenant1', name: 'Authorized PM', role: 'pm', customerIds: ['customer1'], departmentIds: [] });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.customerIds));
});

test('rejects missing bearer tokens and identity headers/objects without calling verifier or loader', async () => {
  for (const token of [undefined, null, '', 'Bearer token', 'token\r\ninjected', 'x'.repeat(16_385),
    { 'x-ms-client-principal': 'encoded-role-president' }, { role: 'president' }]) {
    const { resolve, seen } = setup();
    await assert.rejects(resolve(token), error => error instanceof PrincipalResolutionError && error.statusCode === 401);
    assert.equal(seen.verify.length, 0); assert.equal(seen.load.length, 0);
  }
});

test('verifier rejection of tampered token fails closed and suppresses sensitive exception content', async () => {
  const { resolve, seen } = setup({ verifier: () => { throw new Error('signature invalid: secret-token-value'); } });
  await assert.rejects(resolve('tampered-token'), error => {
    assert.equal(error.statusCode, 401); assert.equal(error.message, 'Authentication required');
    assert.equal(error.cause, undefined); assert.ok(!JSON.stringify(error).includes('secret-token')); return true;
  });
  assert.equal(seen.load.length, 0);
});

test('rejects decoded claims without access-token verification envelope and rejects ID token purpose', async () => {
  for (const verification of [claims(), { claims: claims() }, { tokenUse: 'id_token', claims: claims() }, { tokenUse: 'access_token', claims: null }]) {
    const { resolve, seen } = setup({ verification }); await deniedWith(resolve); assert.equal(seen.load.length, 0);
  }
});

test('every required identity/lifetime/scope claim is mandatory', async () => {
  for (const field of ['tid', 'oid', 'iss', 'aud', 'exp', 'nbf', 'iat', 'scp']) {
    const payload = claims(); delete payload[field];
    const { resolve, seen } = setup({ verification: { tokenUse: 'access_token', claims: payload } });
    await deniedWith(resolve); assert.equal(seen.load.length, 0);
  }
});

test('external tenant, changed issuer, wrong audience and malformed oid deny before DB lookup', async () => {
  for (const claimPatch of [{ tid: otherTid }, { iss: `https://login.microsoftonline.com/${otherTid}/v2.0` },
    { iss: `${issuer}/` }, { aud: 'graph-audience' }, { oid: 'email@example.test' }, { tid: 'common' }]) {
    const { resolve, seen } = setup({ claimPatch }); await deniedWith(resolve); assert.equal(seen.load.length, 0);
  }
});

test('audience arrays require an exact intended audience and valid unambiguous array contents', async () => {
  assert.equal((await setup({ claimPatch: { aud: ['another-api', audience] } }).resolve('token')).id, 'db-user1');
  for (const aud of [[], ['other-api'], [audience, 12], [audience, audience], { includes: () => true }]) {
    await deniedWith(setup({ claimPatch: { aud } }).resolve);
  }
});

test('ID/app-only tokens and missing API delegated scope cannot enter a human workspace', async () => {
  for (const claimPatch of [{ idtyp: 'app' }, { scp: '' }, { scp: 'Mail.Read' }, { scp: ['access_as_user'] },
    { scp: 'access_as_user_fake' }, { scp: 'user_impersonation', roles: ['president'] }]) {
    await deniedWith(setup({ claimPatch }).resolve);
  }
  assert.equal((await setup({ requiredScope: 'requests.read', claimPatch: { scp: 'requests.read requests.write' } }).resolve('token')).role, 'pm');
});

test('expired, future and invalid lifetime claims are rejected', async () => {
  for (const claimPatch of [{ exp: nowSeconds }, { exp: nowSeconds - 1 }, { nbf: nowSeconds + 1 },
    { iat: nowSeconds + 1 }, { exp: String(nowSeconds + 3600) }, { exp: Infinity }, { nbf: -1 }]) {
    await deniedWith(setup({ claimPatch }).resolve);
  }
});

test('token that expires during DB lookup is rejected before principal return', async () => {
  let reads = 0;
  const { resolve } = setup({ clock: () => new Date(reads++ === 0 ? now : Date.parse(now) + 4_000_000) });
  await deniedWith(resolve);
});

test('missing, disabled, revoked, wrong-type and disabled-tenant DB principals deny', async () => {
  for (const row of [null, principal({ status: 'disabled' }), principal({ status: 'revoked' }),
    principal({ principalType: 'service' }), principal({ revokedAt: now }),
    principal({ tenantStatus: 'disabled' }), principal({ tenantStatus: undefined })]) {
    await deniedWith(setup({ row }).resolve, 'token', 403);
  }
});

test('DB identity must match BOTH the verified tenant and object ID, never email/name', async () => {
  for (const row of [principal({ entraTenantId: otherTid }), principal({ entraObjectId: otherOid }),
    principal({ entraTenantId: undefined, email: 'same@example.test' })]) {
    await deniedWith(setup({ row }).resolve, 'token', 403);
  }
});

test('JWT roles, groups, names, customer grants and client persona values are ignored', async () => {
  const { resolve } = setup({ claimPatch: { roles: ['president'], groups: ['all-customers'],
    name: 'Forged President', customerIds: ['customer-secret'], departmentIds: ['finance'], role: 'president' } });
  const result = await resolve('token');
  assert.equal(result.role, 'pm'); assert.equal(result.name, 'Authorized PM');
  assert.deepEqual(result.customerIds, ['customer1']); assert.deepEqual(result.departmentIds, []);
  assert.equal(canReadRequest(result, { tenantId: result.tenantId, classification: 'customer_operations',
    customerId: 'customer-secret', ownerId: result.id }), false);
});

test('revoked, expired and not-yet-effective grants never authorize a role', async () => {
  for (const patch of [{ revokedAt: now }, { revokedAt: 'not-a-date' }, { expiresAt: now },
    { grantedAt: '2026-11-03T12:00:00Z' }]) {
    await deniedWith(setup({ row: principal({ grants: [grant(patch)] }) }).resolve, 'token', 403);
  }
});

test('same principal is reloaded on every call so customer grant revocation takes effect immediately', async () => {
  let record = principal({ grants: [grant(), grant({ id: 'grant2', customerId: 'customer2' })] });
  const { resolve, seen } = setup({ loader: () => record });
  assert.deepEqual((await resolve('token')).customerIds, ['customer1', 'customer2']);
  record = principal({ grants: [grant({ revokedAt: now }), grant({ id: 'grant2', customerId: 'customer2' })] });
  assert.deepEqual((await resolve('token')).customerIds, ['customer2']);
  assert.equal(seen.load.length, 2);
});

test('cross-tenant/principal grants and wildcard scopes fail closed', async () => {
  for (const patch of [{ tenantId: 'another-db-tenant' }, { principalId: 'another-user' },
    { customerId: '*' }, { departmentKey: 'qa' }, { expiresAt: undefined }, { revokedAt: undefined }]) {
    await deniedWith(setup({ row: principal({ grants: [grant(patch)] }) }).resolve, 'token', 403);
  }
});

test('role selection never combines a president role with PM-only customer scopes', async () => {
  const grants = [grant(), grant({ id: 'executive-grant', roleName: 'president', customerId: 'customer2' })];
  await deniedWith(setup({ row: principal({ grants }) }).resolve, 'token', 403);
  const result = await setup({ row: principal({ grants, workspaceRole: 'president' }) }).resolve('token');
  assert.equal(result.role, 'president'); assert.deepEqual(result.customerIds, ['customer2']);
  await deniedWith(setup({ row: principal({ grants, workspaceRole: 'security_admin' }) }).resolve, 'token', 403);
});

test('department mapping uses only explicit same-role department and customer scopes', async () => {
  const row = principal({ grants: [grant({ roleName: 'department_member' }),
    grant({ id: 'qa-grant', roleName: 'department_member', scopeKind: 'department', customerId: null, departmentKey: 'qa' })] });
  const result = await setup({ row }).resolve('token');
  assert.equal(result.role, 'department'); assert.deepEqual(result.customerIds, ['customer1']); assert.deepEqual(result.departmentIds, ['qa']);
});

test('tenant/request scopes are never expanded into wildcard customer access', async () => {
  const result = await setup({ row: principal({ grants: [grant({ scopeKind: 'tenant', customerId: null }),
    grant({ id: 'request-grant', scopeKind: 'request', customerId: null, requestId: 'request1' })] }) }).resolve('token');
  assert.deepEqual(result.customerIds, []); assert.deepEqual(result.departmentIds, []);
});

test('duplicate grants and missing grant fields fail closed', async () => {
  const missingRevocation = grant(); delete missingRevocation.revokedAt;
  for (const grants of [[grant(), grant()], [missingRevocation], null]) {
    await deniedWith(setup({ row: principal({ grants }) }).resolve, 'token', 403);
  }
});

test('DB failure returns a bounded unavailable error without sensitive data', async () => {
  const { resolve } = setup({ loader: () => { throw new Error('postgres://secret-password/private-customer'); } });
  await assert.rejects(resolve('token'), error => {
    assert.equal(error.statusCode, 503); assert.equal(error.message, 'Authentication service unavailable');
    assert.equal(error.cause, undefined); assert.ok(!JSON.stringify(error).includes('secret-password')); return true;
  });
});
