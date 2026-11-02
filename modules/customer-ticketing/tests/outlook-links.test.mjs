import test from 'node:test';
import assert from 'node:assert/strict';
import {validatedOutlookWebLink,projectOutlookAction} from '../src/security/outlook-links.mjs';
import {makeFixtures,demoPrincipals} from '../src/fixtures.mjs';
import {projectWorkspace} from '../src/security/workspace.mjs';
const href='https://outlook.office365.com/owa/?ItemID=example-message%3D&exvsurl=1&viewmodel=ReadMessageItem';
const now='2026-11-02T14:00:00Z';
const principal={...demoPrincipals.pm,outlookMailboxIds:['mailbox-avery']};
const request={...makeFixtures(now)[0],replySource:{tenantId:'demo-uniwell',requestId:'r1',provenance:'microsoft_graph',selectionStatus:'verified',purpose:'customer_reply',direction:'inbound',isDraft:false,messageId:'immutable-message-1',mailboxId:'mailbox-avery',readableByPrincipalIds:['avery'],webLink:href}};
const action=(r=request,p=principal)=>projectOutlookAction({principal:p,request:r,coverage:{mode:'live'}});
test('returns exact observed source link only for the current authorized mailbox copy',()=>{
  const before=structuredClone(request); assert.equal(action().href,href); assert.equal(action().channel,'web');
  assert.deepEqual(request,before);
});
test('fictional review never produces a live-looking link even if source data contains one',()=>{
  const result=projectOutlookAction({principal,request,coverage:{mode:'fictional'}});
  assert.equal(result.status,'not_connected'); assert.ok(!Object.hasOwn(result,'href'));
});
test('an executive summary grant alone never exposes an email URL',()=>{
  assert.equal(action(request,demoPrincipals.president).status,'unavailable');
});
test('revoked mailbox/evidence access and unverified internal/foreign sources fail closed',()=>{
  assert.equal(action(request,{...principal,outlookMailboxIds:[]}).status,'unavailable');
  for(const patch of [{tenantId:'other'},{requestId:'different-request'},{readableByPrincipalIds:[]},{direction:'internal'}, {isDraft:true},{selectionStatus:'ambiguous'},{provenance:'model'},{purpose:'internal_handoff'},{messageId:''}]) {
    assert.equal(action({...request,replySource:{...request.replySource,...patch}}).status,'unavailable');
  }
});
test('malicious, guessed, compose and generic inbox URLs are not original-message actions',()=>{
  const unsafe=['javascript:alert(1)','mailto:customer@example.com?subject=Re:test','ms-outlook://message/guessed',
    href.replace('https:','http:'),href.replace('outlook.office365.com','outlook.office365.com.attacker.example'),
    href.replace('https://','https://user:secret@'),href.replace('.com/','.com:444/'),href+'#fragment',href+'&redirect=https://attacker.example',href+'&ItemID=second',href.replace('ReadMessageItem','ComposeItem'),href.replace('ItemID=example-message%3D','ItemID='),'https://outlook.office.com/mail/',` ${href}`,href+'\n'];
  for(const value of unsafe) assert.equal(validatedOutlookWebLink(value),null,value);
  assert.equal(validatedOutlookWebLink(href+'&ispopout=0'),href+'&ispopout=0');
});
test('workspace only includes action in an already authorized request; opening does not count as responding',()=>{
  const state=projectWorkspace({principal,requests:[request],now,coverage:{mode:'live'}});
  assert.equal(state.requests[0].outlookAction.href,href);
  assert.equal(state.requests[0].lastMeaningfulResponseAt,null);
  assert.equal(state.requests[0].band,'overdue');
  assert.equal(projectWorkspace({principal:{...principal,customerIds:[]},requests:[request],now,coverage:{mode:'live'}}).requests.length,0);
});
