import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeCorrelation, reviewedSentResponse } from '../src/integrations/correlation.mjs';
import { createRequest, applyEvent } from '../src/domain/response-clock.mjs';
const request = () => ({ tenantId:'t', ...createRequest({id:'r',customerId:'c',subject:'Quote',ownerId:'pm',receivedAt:'2026-11-01T10:00:00Z',evidenceId:'in'}) });
const message = () => ({tenantId:'t',id:'m',customerId:'c',subject:'Quote',inReplyTo:'<original>',direction:'inbound'});
const link = () => ({tenantId:'t',customerId:'c',requestId:'r',messageId:'original',internetMessageId:'<original>'});
const sent = () => ({...message(),direction:'outbound',sourceFolder:'sent',deliveryState:'sent',isDraft:false,sentAt:'2026-11-01T12:00:00Z',recipientCustomerId:'c',recipientVerified:true,recipientEvidenceId:'recipients'});
const review = () => ({tenantId:'t',requestId:'r',messageId:'m',reviewerId:'human',evidenceId:'coverage-review',meaningful:true,addressedObligationIds:['initial:r']});
test('subject alone cannot associate a customer message',()=>{
 assert.deepEqual(proposeCorrelation({tenantId:'t',message:message(),requests:[request()],links:[]}),{status:'needs_review',reason:'no_strong_link',candidateRequestIds:[],reviewRequired:true});
});
test('reply header nominates a candidate, never applies a merge',()=>{
 const result=proposeCorrelation({tenantId:'t',message:message(),requests:[request()],links:[link()]});
 assert.equal(result.status,'candidate'); assert.deepEqual(result.candidateRequestIds,['r']); assert.equal(result.reviewRequired,true);
});
test('known explicit message link is a strong candidate without reply header',()=>{
 const result=proposeCorrelation({tenantId:'t',message:{...message(),inReplyTo:null},requests:[request()],links:[{...link(),messageId:'m'}]});
 assert.equal(result.status,'candidate');
});
test('multiple issues in the same source stay separate and require review',()=>{
 const result=proposeCorrelation({tenantId:'t',message:message(),requests:[request(),{...request(),id:'r2'}],links:[link(),{...link(),requestId:'r2'}]});
 assert.equal(result.reason,'ambiguous_links'); assert.deepEqual(result.candidateRequestIds,['r','r2']);
});
test('unknown customer and customer conflicts cannot nominate a link',()=>{
 for (const customerId of [null,'different']) {
 const result=proposeCorrelation({tenantId:'t',message:{...message(),customerId},requests:[request()],links:[link()]});
 assert.equal(result.status,'needs_review'); assert.deepEqual(result.candidateRequestIds,[]);
 }
});
test('tenant mismatch fails closed rather than leaking candidates',()=>{
 for (const field of ['message','requests','links']) {
 const input={tenantId:'t',message:message(),requests:[request()],links:[link()]};
 input[field]=field==='message'?{...input[field],tenantId:'other'}:input[field].map(x=>({...x,tenantId:'other'}));
 assert.throws(()=>proposeCorrelation(input),/tenant/i);
 }
});
test('conflicting product facts force review despite a reply header',()=>{
 const result=proposeCorrelation({tenantId:'t',message:{...message(),productId:'new'},requests:[{...request(),productId:'old'}],links:[link()]});
 assert.equal(result.reason,'conflicting_entities'); assert.deepEqual(result.candidateRequestIds,[]);
});
test('partial reviewed sent coverage leaves the other ask on its original clock',()=>{
 const r={tenantId:'t',...applyEvent(request(),{id:'follow',type:'customer_followup',evidenceId:'in2',receivedAt:'2026-11-01T11:00:00Z'})};
 const {event,audit}=reviewedSentResponse({tenantId:'t',request:r,message:sent(),review:review(),eventId:'reply'});
 const result=applyEvent(r,event);
 assert.equal(result.responseObligations.find(x=>x.id==='initial:r').outcome,'responded');
 assert.equal(result.responseObligations.find(x=>x.id==='followup:follow').outcome,'pending');
 assert.equal(result.dueAt,'2026-11-02T11:00:00.000Z');
 assert.equal(event.coversAllOutstandingAsks,false); assert.equal(audit.reviewerId,'human'); assert.equal(r.events.length,1);
});
test('drafts, missing sent provenance, delivery uncertainty and unverified recipients cannot clear asks',()=>{
 for (const patch of [{isDraft:true},{sourceFolder:'drafts'},{sourceFolder:undefined},{deliveryState:'unknown'},{deliveryState:'bounced'},{direction:'inbound'},{recipientVerified:false},{recipientCustomerId:'other'}]) {
 assert.throws(()=>reviewedSentResponse({tenantId:'t',request:request(),message:{...sent(),...patch},review:review(),eventId:'reply'}));
 }
});
test('coverage must be reviewed, explicit, bound to this message and request, and currently outstanding',()=>{
 for (const patch of [{reviewerId:''},{messageId:'other'},{requestId:'other'},{meaningful:false},{addressedObligationIds:[]},{addressedObligationIds:['unknown']},{addressedObligationIds:['initial:r','initial:r']},{tenantId:'other'}]) {
 assert.throws(()=>reviewedSentResponse({tenantId:'t',request:request(),message:sent(),review:{...review(),...patch},eventId:'reply'}));
 }
});
test('reply timestamp cannot precede addressed evidence',()=>{
 assert.throws(()=>reviewedSentResponse({tenantId:'t',request:request(),message:{...sent(),sentAt:'2026-11-01T09:00:00Z'},review:review(),eventId:'reply'}));
});
test('already answered obligations cannot be counted as a new answer',()=>{
 const first=reviewedSentResponse({tenantId:'t',request:request(),message:sent(),review:review(),eventId:'reply'});
 const answered={tenantId:'t',...applyEvent(request(),first.event)};
 assert.throws(()=>reviewedSentResponse({tenantId:'t',request:answered,message:{...sent(),id:'m2'},review:{...review(),messageId:'m2'},eventId:'reply2'}),/pending/);
});
test('an existing answered portion is not implicitly expanded to cover late discovered evidence',()=>{
 const first=reviewedSentResponse({tenantId:'t',request:request(),message:sent(),review:review(),eventId:'reply'});
 const answered=applyEvent(request(),first.event);
 const late=applyEvent(answered,{id:'late',type:'customer_followup',receivedAt:'2026-11-01T11:00:00Z',evidenceId:'late-in'});
 assert.equal(late.responseObligations.find(x=>x.id==='followup:late').outcome,'pending');
 assert.equal(late.dueAt,'2026-11-02T11:00:00.000Z');
});
