import test from 'node:test';
import {get} from 'node:http';
const rawStatus=(url,headers)=>new Promise((resolve,reject)=>get(url,{headers},res=>{res.resume();resolve(res.statusCode)}).on('error',reject));
import assert from 'node:assert/strict';
import {createDemoServer} from '../src/server.mjs';
import {demoPrincipals} from '../src/fixtures.mjs';
async function start(t,options){const server=createDemoServer(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));return `http://127.0.0.1:${server.address().port}`;}
test('durable fixture provider receives only resolved demo identity and server clock',async t=>{
 const seen=[];const now=new Date('2026-11-01T12:00:00Z');const base=await start(t,{clock:()=>now,workspaceProvider:async context=>{seen.push(context);return {requests:[{id:'durable'}]}}});
 const response=await fetch(`${base}/api/workspace?persona=pm&tenantId=evil&role=president&principal=attacker`);
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{requests:[{id:'durable'}]});assert.equal(seen.length,1);
 assert.deepEqual(seen[0].principal,demoPrincipals.pm);assert.equal(seen[0].now,now);
 const health=await (await fetch(`${base}/health`)).json();assert.equal(health.durableFixture,true);assert.equal(health.microsoftConnected,false);assert.equal(health.productionReady,false);
});
test('invalid persona, writes, unapproved host and cross-site reads never invoke provider',async t=>{
 let calls=0;const base=await start(t,{workspaceProvider:()=>{calls++;return {requests:[]}}});
 assert.equal((await fetch(`${base}/api/workspace?persona=unknown`)).status,400);
 assert.equal((await fetch(`${base}/api/workspace`,{method:'POST'})).status,405);
 assert.equal((await fetch(`${base}/api/workspace`,{headers:{Origin:'https://evil.test'}})).status,403);
 assert.equal(await rawStatus(`${base}/api/workspace`,{Host:'evil.test'}),403);
 assert.equal(await rawStatus(`${base}/api/workspace`,{'Sec-Fetch-Site':'cross-site'}),403);
 assert.equal(calls,0);
});
test('provider errors are generic and do not disclose local data',async t=>{
 const base=await start(t,{workspaceProvider:()=>{throw Error('sensitive database detail')}});
 const response=await fetch(`${base}/api/workspace`);assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'Preview request failed'});
});
test('default fixture path remains disconnected and invalid provider fails at construction',async t=>{
 assert.throws(()=>createDemoServer({workspaceProvider:{}}),/provider/i);
 const base=await start(t,{});const health=await (await fetch(`${base}/health`)).json();assert.equal(health.durableFixture,false);
 assert.equal((await fetch(`${base}/api/workspace`)).status,200);
});
