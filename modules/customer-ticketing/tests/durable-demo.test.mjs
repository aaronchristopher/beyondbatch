import test from 'node:test';
import assert from 'node:assert/strict';
import {FixturePipeline} from '../src/fixtures/durable-pipeline.mjs';
import {seedDurableWorkspace,durableWorkspace} from '../src/fixtures/durable-workspace.mjs';
import {demoPrincipals} from '../src/fixtures.mjs';
test('persisted fictional demo shows only actual unanswered asks, retaining answered state separately',async t=>{
 const app=new FixturePipeline();t.after(()=>app.close());const now='2026-11-02T11:00:00Z';await seedDurableWorkspace(app,now);
 const view=durableWorkspace(app,demoPrincipals.pm,now);assert.equal(view.requests.length,1);assert.equal(view.requests[0].subject,'Confirm certification');assert.equal(view.requests[0].band,'overdue');assert.match(view.coverage.detail,/persisted/i);assert.equal(view.summary.totalOpen,1);
 assert.equal(app.workspace(demoPrincipals.pm,now).requests.length,2);assert.equal(durableWorkspace(app,demoPrincipals.president,now).requests.length,2);
 await seedDurableWorkspace(app,'2026-11-03T11:00:00Z');assert.equal(app.store.count('requests'),3);assert.equal(app.store.count('events'),1);
});

test('durable executable refuses production and missing demo flag without creating fixture files',async()=>{
 const {spawnSync}=await import('node:child_process');const script=new URL('../src/fixtures/durable-server.mjs',import.meta.url).pathname;
 for(const [args,env] of [[[],process.env],[['--demo'],{...process.env,NODE_ENV:'production'}]]){const result=spawnSync(process.execPath,[script,...args],{env,encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/Production startup blocked/);}
});

test('real persisted pipeline serves the browser assets and scoped waiting lists over local HTTP',async t=>{
 const {createDemoServer}=await import('../src/server.mjs');const app=new FixturePipeline();t.after(()=>app.close());const now='2026-11-02T11:00:00Z';await seedDurableWorkspace(app,now);
 const server=createDemoServer({clock:()=>now,workspaceProvider:({principal,now})=>durableWorkspace(app,principal,now)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${server.address().port}`;
 const pm=await (await fetch(url+'/api/workspace?persona=pm')).json();const president=await(await fetch(url+'/api/workspace?persona=president')).json();assert.equal(pm.requests.length,1);assert.equal(president.requests.length,2);assert.equal(pm.requests[0].subject,'Confirm certification');assert.equal(pm.coverage.mode,'fictional-persisted');
 const html=await(await fetch(url)).text();assert.match(html,/fictional data/);assert.match(html,/does not change real access/);assert.equal((await fetch(url+'/app.js')).status,200);assert.equal((await fetch(url+'/styles.css')).status,200);assert.equal((await(await fetch(url+'/health')).json()).durableFixture,true);
});
