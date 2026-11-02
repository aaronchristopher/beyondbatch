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
test('importing the demo factory in production cannot expose a custom provider or managed preview',()=>{
  const script=`
    import {createDemoServer} from ${JSON.stringify(new URL('../src/server.mjs',import.meta.url).href)};
    let providerCalls=0;
    let error=null;
    try {
      createDemoServer({managedPreview:true,allowProduction:true,
        workspaceProvider:()=>{providerCalls++;return {private:'must not be served'};}});
    } catch (failure) { error=failure.message; }
    console.log(JSON.stringify({providerCalls,error}));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,NODE_ENV:'production',SITES_MANAGED_LINUX_CONTAINER:'1'},encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.providerCalls,0);
  assert.match(report.error,/Production startup is blocked/);
});
test('an existing demo server refuses every route if its environment becomes production',()=>{
  const script=`
    import {createDemoServer} from ${JSON.stringify(new URL('../src/server.mjs',import.meta.url).href)};
    let providerCalls=0;
    const server=createDemoServer({managedPreview:true,
      workspaceProvider:()=>{providerCalls++;return {private:'must not be served'};}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    process.env.NODE_ENV='production';
    const responses=[];
    try {
      for (const path of ['/api/workspace?persona=president','/api/email-trail?persona=president&requestId=r1','/','/health']) {
        const response=await fetch('http://127.0.0.1:'+server.address().port+path);
        responses.push({status:response.status,body:await response.text()});
      }
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    console.log(JSON.stringify({providerCalls,responses}));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,NODE_ENV:'development'},encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.providerCalls,0);
  assert.ok(report.responses.every(response=>response.status===503));
  assert.ok(report.responses.every(response=>JSON.parse(response.body).error==='Preview unavailable'));
  assert.ok(!result.stdout.includes('must not be served'));
});
test('an in-flight demo provider cannot emit data after the environment becomes production',()=>{
  const script=`
    import {createDemoServer} from ${JSON.stringify(new URL('../src/server.mjs',import.meta.url).href)};
    let providerCalls=0;
    let signalStarted,releaseProvider;
    const started=new Promise(resolve=>{signalStarted=resolve;});
    const released=new Promise(resolve=>{releaseProvider=resolve;});
    const server=createDemoServer({workspaceProvider:async()=>{
      providerCalls++;signalStarted();await released;return {private:'must not be served'};
    }});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    let status,body;
    try {
      const pending=fetch('http://127.0.0.1:'+server.address().port+'/api/workspace?persona=president');
      await started;
      process.env.NODE_ENV='production';
      releaseProvider();
      const response=await pending;
      status=response.status;body=await response.text();
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    console.log(JSON.stringify({providerCalls,status,body}));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,NODE_ENV:'development'},encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.providerCalls,1);
  assert.equal(report.status,503);
  assert.deepEqual(JSON.parse(report.body),{error:'Preview unavailable'});
  assert.ok(!result.stdout.includes('must not be served'));
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
