import test from 'node:test';
import assert from 'node:assert/strict';
import { FixturePipeline } from '../src/fixtures/durable-pipeline.mjs';
const inbox={tenantId:'t',mailboxId:'pm-mail',folder:'inbox',pageId:'page1',checkpoint:'cursor1',messages:[{id:'in1',customerId:'c',receivedAt:'2026-11-01T10:00:00Z',subject:'Two questions',direction:'inbound',isDraft:false}]};
const principal={tenantId:'t',id:'pm',name:'PM',role:'pm',customerIds:['c'],departmentIds:[]};
const proposed=id=>({id,customerId:'c',subject:`Question ${id}`,ownerId:'pm',customer:'Fixture Customer',owner:'PM',departmentId:'qa',department:'QA',classification:'customer_operations',operationalEvidenceSummary:'Reviewed fictional question',nextAction:'Answer customer'});
const time='2026-11-01T12:00:00Z';
function setup(t){const app=new FixturePipeline();t.after(()=>app.close());return app;}
test('incoming page durably creates reviews and checkpoint but no unreviewed customer requests',t=>{const app=setup(t);app.ingestPage(inbox);assert.equal(app.pendingReviews('t').length,1);assert.equal(app.checkpoint('t','pm-mail','inbox'),'cursor1');assert.equal(app.workspace(principal,time).requests.length,0);});
test('exact page replay is idempotent while conflicting page reuse fails atomically',t=>{const app=setup(t);app.ingestPage(inbox);app.ingestPage(inbox);assert.equal(app.pendingReviews('t').length,1);assert.throws(()=>app.ingestPage({...inbox,checkpoint:'different'}),/conflict/);assert.equal(app.checkpoint('t','pm-mail','inbox'),'cursor1');});
test('reviewed multi-ask incoming then reviewed actual Sent answers only one request',async t=>{const app=setup(t);app.ingestPage(inbox);const review=app.pendingReviews('t')[0];app.approveIncoming({tenantId:'t',copyId:review.copyId,reviewerId:'human',reviewId:'rev-in',requests:[proposed('r1'),proposed('r2')]});await app.runNext({tenantId:'t',now:time});
assert.equal(app.workspace(principal,time).requests.length,2);
app.ingestPage({tenantId:'t',mailboxId:'pm-mail',folder:'sent',pageId:'sentpage',checkpoint:'sentcursor',messages:[{id:'sent1',customerId:'c',recipientCustomerId:'c',recipientVerified:true,recipientEvidenceId:'recipients',direction:'outbound',isDraft:false,deliveryState:'sent',sentAt:time}]});
const sent=app.pendingReviews('t')[0];app.approveSent({tenantId:'t',copyId:sent.copyId,reviewerId:'human',reviewId:'rev-sent',requestId:'r1',addressedObligationIds:['initial:r1'],meaningful:true});await app.runNext({tenantId:'t',now:time});
const rows=app.workspace(principal,'2026-11-02T11:00:00Z').requests;assert.equal(rows.find(r=>r.id==='r2').band,'overdue');assert.equal(rows.find(r=>r.id==='r1').lastMeaningfulResponseAt,'2026-11-01T12:00:00.000Z');assert.equal(app.waitingOnFirstAnswer(principal,'2026-11-02T11:00:00Z').length,1);assert.equal(app.waitingOnFirstAnswer(principal,'2026-11-02T11:00:00Z')[0].id,'r2');
assert.equal(app.workspace({...principal,tenantId:'other'},time).requests.length,0);
});
test('draft evidence cannot be approved as a sent answer',t=>{const app=setup(t);app.ingestPage({...inbox,folder:'drafts',messages:[{...inbox.messages[0],isDraft:true,direction:'outbound'}]});const copy=app.pendingReviews('t')[0];assert.throws(()=>app.approveSent({tenantId:'t',copyId:copy.copyId,reviewerId:'human',reviewId:'rev',requestId:'r',addressedObligationIds:['initial:r'],meaningful:true}),/Sent/);});

test('page checkpoint conflict and mid-page evidence conflict never partially persist',t=>{
 const app=setup(t);app.ingestPage(inbox);
 assert.throws(()=>app.ingestPage({...inbox,pageId:'page2',checkpoint:'cursor2',messages:[{...inbox.messages[0],id:'in2'}]}),/checkpoint conflict/);
 assert.throws(()=>app.ingestPage({...inbox,pageId:'page2',expectedCheckpoint:'cursor1',checkpoint:'cursor2',messages:[{...inbox.messages[0],id:'in2'},{...inbox.messages[0],subject:'tampered'}]}),/evidence conflict/);
 assert.equal(app.pendingReviews('t').length,1);assert.equal(app.checkpoint('t','pm-mail','inbox'),'cursor1');
});
test('mailbox copies preserve separate provenance and conflicting review key is rejected',t=>{
 const app=setup(t);app.ingestPage(inbox);app.ingestPage({...inbox,mailboxId:'backup-mail'});const reviews=app.pendingReviews('t');assert.equal(reviews.length,2);assert.notEqual(reviews[0].copyId,reviews[1].copyId);
 const approval={tenantId:'t',copyId:reviews[0].copyId,reviewerId:'human',reviewId:'review',requests:[proposed('r')]};app.approveIncoming(approval);app.approveIncoming(approval);assert.throws(()=>app.approveIncoming({...approval,requests:[proposed('other')]}),/review replay conflict/);
});
test('durable approved job survives restart then yields scoped waiting list',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const dir=mkdtempSync(join(tmpdir(),'fixture-pipeline-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'pipeline.db');let app=new FixturePipeline(path);
 app.ingestPage(inbox);app.approveIncoming({tenantId:'t',copyId:app.pendingReviews('t')[0].copyId,reviewerId:'human',reviewId:'rev',requests:[proposed('r')]});app.close();app=new FixturePipeline(path);t.after(()=>app.close());await app.runNext({tenantId:'t',now:time});assert.equal(app.waitingOnFirstAnswer(principal,time).length,1);assert.equal(app.workspace({...principal,id:'not-owner'},time).requests.length,0);assert.equal(app.checkpoint('t','pm-mail','inbox'),'cursor1');
});
test('separate accepted jobs are safely processed by simultaneous worker calls',async t=>{
 const app=setup(t);app.ingestPage(inbox);const copyId=app.pendingReviews('t')[0].copyId;
 for(const id of ['r1','r2'])app.approveIncoming({tenantId:'t',copyId,reviewerId:'human',reviewId:id,requests:[proposed(id)]});
 await Promise.all([app.runNext({tenantId:'t',now:time}),app.runNext({tenantId:'t',now:time})]);assert.equal(app.workspace(principal,time).requests.length,2);
});

test('worker commit before lost job acknowledgment replays without duplicate requests',async t=>{
 const app=setup(t);app.ingestPage(inbox);app.approveIncoming({tenantId:'t',copyId:app.pendingReviews('t')[0].copyId,reviewerId:'human',reviewId:'rev',requests:[proposed('r')]});
 const complete=app.jobs.complete.bind(app.jobs);app.jobs.complete=()=>{throw Error('lost ack');};await assert.rejects(app.runNext({tenantId:'t',now:time}),/lost ack/);assert.equal(app.workspace(principal,time).requests.length,1);app.jobs.complete=complete;
 await app.runNext({tenantId:'t',now:'2026-11-01T12:00:02Z'});assert.equal(app.workspace(principal,time).requests.length,1);assert.equal(app.jobs.get('t','review:rev').state,'done');
});

test('fixture public writes and projections refuse access while an async worker transaction is active',async t=>{
 const app=setup(t);app.ingestPage(inbox);app.approveIncoming({tenantId:'t',copyId:app.pendingReviews('t')[0].copyId,reviewerId:'human',reviewId:'rev',requests:[proposed('r')]});
 const original=app.store.transaction.bind(app.store);let release,entered;const ready=new Promise(resolve=>entered=resolve);app.store.transaction=work=>original(async tx=>{entered();await new Promise(resolve=>release=resolve);return work(tx);});
 const pending=app.runNext({tenantId:'t',now:time});await ready;
 assert.throws(()=>app.ingestPage({...inbox,pageId:'later'}),/busy/);assert.throws(()=>app.workspace(principal,time),/busy/);release();await pending;
});
