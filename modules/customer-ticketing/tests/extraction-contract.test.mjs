import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractionInput,validateProposals } from '../src/integrations/extraction-contract.mjs';
const args={tenantId:'t',messages:[{id:'m1',tenantId:'t',classification:'customer_operations',receivedAt:'2026-11-01T09:00:00Z',subject:'Documents',body:'Please send the specification and the lot certificate.'}],customers:[{id:'c1',tenantId:'t'}],possibleOwners:[{id:'p1',tenantId:'t'}]};
const input=buildExtractionInput(args);
const task={summary:'Send the specification',category:'specification',customerId:'c1',suggestedOwnerId:'p1',confidence:0.99,evidence:[{messageId:'m1',excerpt:'Please send the specification'}]};
test('separate tasks retain evidence and require review even at high confidence',()=>{
  const result=validateProposals({classification:'actionable',tasks:[task,{...task,summary:'Send the lot certificate',category:'document',evidence:[{messageId:'m1',excerpt:'lot certificate'}]}]},input);
  assert.equal(result.tasks.length,2); assert.ok(result.tasks.every(row=>row.reviewRequired));
});
test('unknown customer/owner can remain null without being invented',()=>{
  const result=validateProposals({classification:'uncertain',tasks:[{...task,customerId:null,suggestedOwnerId:null}]},input);
  assert.equal(result.tasks[0].suggestedOwnerId,null);
});
test('restricted or cross-tenant mail never reaches model input',()=>{
  for(const replacement of [{classification:'restricted'},{tenantId:'other'}]) {
    assert.throws(()=>buildExtractionInput({...args,messages:[{...args.messages[0],...replacement}]}),/Unauthorized/);
  }
});
test('fabricated evidence, out-of-scope entities and model-supplied actions are rejected',()=>{
  for(const patch of [{suggestedOwnerId:'invented'},{customerId:'other'}, {status:'resolved'}, {sendTo:'attacker@example.com'}, {evidence:[{messageId:'m1',excerpt:'Customer confirmed resolution'}]}]) {
    assert.throws(()=>validateProposals({classification:'actionable',tasks:[{...task,...patch}]},input));
  }
});
test('non-actionable messages cannot create tasks',()=>{
  assert.throws(()=>validateProposals({classification:'marketing',tasks:[task]},input));
  assert.throws(()=>validateProposals({classification:'actionable',tasks:[]},input),/request proposal/);
});
