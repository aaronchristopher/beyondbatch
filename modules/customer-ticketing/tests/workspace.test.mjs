import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixtures, demoPrincipals } from '../src/fixtures.mjs';
import { projectWorkspace } from '../src/security/workspace.mjs';
import { createDemoServer } from '../src/server.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const now='2026-11-01T12:00:00Z';
const requests=makeFixtures(now);
const workspace=(principal,rows=requests)=>projectWorkspace({principal,requests:rows,now,coverage:{mode:'fictional'}});
test('production configuration refuses the demo entry point before listening',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../src/server.mjs',import.meta.url)),'--demo'],{env:{...process.env,NODE_ENV:'production'},encoding:'utf8'});
  assert.equal(result.status,1); assert.match(result.stderr,/Production startup is blocked/);
});
test('PM sees only own/backup work; president sees explicitly scoped operational requests',()=>{
  assert.equal(workspace(demoPrincipals.pm).requests.length,3);
  assert.equal(workspace(demoPrincipals.president).requests.length,6);
  assert.equal(workspace(demoPrincipals.department).requests.length,2);
});
test('private, other tenant, and customer scope exclusions apply before aggregates',()=>{
  const rows=[...requests,{...requests[0],id:'private',classification:'restricted'}, {...requests[0],id:'other',tenantId:'other'}, {...requests[0],id:'unapproved',customerId:'unapproved'}];
  const result=workspace(demoPrincipals.president,rows);
  assert.equal(result.requests.length,6); assert.equal(result.summary.totalOpen,6);
  assert.equal(result.summary.overdue,1); assert.equal(result.summary.unassigned,1);
  assert.ok(!JSON.stringify(result).includes('rawEmail'));
  assert.ok(!JSON.stringify(result).includes('Fixture content must never'));
});
test('unknown role receives no records and missing principal is rejected',()=>{
  assert.equal(workspace({...demoPrincipals.president,role:'self-declared-admin'}).requests.length,0);
  assert.throws(()=>workspace(null),/principal/);
});
test('revoked customer access overrides current or historical owner/backup relationships',()=>{
  const revoked={...demoPrincipals.pm,customerIds:[]};
  assert.equal(workspace(revoked).requests.length,0);
  const backupRows=requests.map(row=>({...row,ownerId:'someone-else',backupId:demoPrincipals.pm.id}));
  assert.equal(workspace(revoked,backupRows).summary.totalOpen,0);
  assert.equal(workspace({...demoPrincipals.pm,customerIds:['cedar']},backupRows).requests.length,2);
});
test('stale or forged materialized status cannot hide an unanswered request or its department',()=>{
  const rows=structuredClone(requests);
  rows[0].clock.status='resolved'; rows[0].clock.lastMeaningfulResponseAt=now;
  const result=workspace(demoPrincipals.pm,rows);
  const request=result.requests.find(row=>row.id==='r1');
  assert.equal(request.status,'open'); assert.equal(request.band,'overdue');
  assert.equal(request.lastMeaningfulResponseAt,null);
  assert.equal(result.summary.totalOpen,3);
  assert.equal(result.departments.find(row=>row.name==='QA').waiting,1);
});
test('server serves scoped API, rejects writes/cross-site reads, and advertises disconnected state',async()=>{
  const server=createDemoServer({requests,clock:()=>new Date(now)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const health=await (await fetch(`${base}/health`)).json(); assert.equal(health.productionReady,false);
    const response=await fetch(`${base}/api/workspace?persona=pm`); const result=await response.json();
    assert.equal(result.requests.length,3); assert.equal(result.coverage.mode,'fictional');
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(`${base}/api/workspace`,{method:'POST'})).status,405);
    assert.equal((await fetch(`${base}/api/workspace`,{headers:{origin:'https://untrusted.example'}})).status,403);
    assert.equal((await fetch(`${base}/api/workspace?persona=unknown`)).status,400);
    assert.equal((await fetch(`${base}/src/fixtures.mjs`)).status,404);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
