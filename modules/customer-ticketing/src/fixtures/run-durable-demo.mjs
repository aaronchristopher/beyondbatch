import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FixturePipeline} from './durable-pipeline.mjs';
// Always isolated and fictional. No credentials, connectors, models or send calls.
const directory=mkdtempSync(join(tmpdir(),'beyond-batch-fixture-'));
const database=join(directory,'fixture.db');
let app=new FixturePipeline(database);
const tenantId='fixture-tenant',mailboxId='fixture-mailbox',receivedAt='2026-11-01T10:00:00Z',now='2026-11-01T12:00:00Z';
const principal={tenantId,id:'fixture-pm',name:'Fixture PM',role:'pm',customerIds:['fixture-customer'],departmentIds:[]};
const item=(id,subject)=>({id,subject,customerId:'fixture-customer',customer:'Fictional Customer',ownerId:'fixture-pm',owner:'Fixture PM',classification:'customer_operations',departmentId:'qa',department:'QA',nextAction:'Answer the outstanding question',operationalEvidenceSummary:'Reviewed fictional source; not real client data'});
try{
 app.ingestPage({tenantId,mailboxId,folder:'inbox',pageId:'inbound-page',checkpoint:'fixture-cursor-1',messages:[{id:'inbound-message',customerId:'fixture-customer',receivedAt,direction:'inbound',isDraft:false,subject:'Please confirm availability and certification'}]});
 app.approveIncoming({tenantId,copyId:app.pendingReviews(tenantId)[0].copyId,reviewerId:'fixture-human',reviewId:'incoming-review',requests:[item('availability','Confirm availability'),item('certification','Confirm certification')]});
 // Demonstrate durable work across an actual database reopen before execution.
 app.close();app=new FixturePipeline(database);await app.runNext({tenantId,now});
 app.ingestPage({tenantId,mailboxId,folder:'sent',pageId:'sent-page',checkpoint:'fixture-sent-cursor-1',messages:[{id:'sent-message',customerId:'fixture-customer',recipientCustomerId:'fixture-customer',recipientVerified:true,recipientEvidenceId:'fixture-recipient-review',direction:'outbound',isDraft:false,deliveryState:'sent',sentAt:now}]});
 app.approveSent({tenantId,copyId:app.pendingReviews(tenantId)[0].copyId,reviewerId:'fixture-human',reviewId:'sent-review',requestId:'availability',meaningful:true,addressedObligationIds:['initial:availability']});
 await app.runNext({tenantId,now});
 const asOf='2026-11-02T11:00:00Z';
 console.log(JSON.stringify({mode:'FICTIONAL LOCAL DEMONSTRATION — NOT LIVE',database,asOf,waitingForAnswer:app.waitingOnFirstAnswer(principal,asOf),workspace:app.workspace(principal,asOf)},null,2));
}finally{app.close();}
