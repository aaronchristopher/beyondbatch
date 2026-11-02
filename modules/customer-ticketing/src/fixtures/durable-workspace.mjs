import {demoPrincipals} from '../fixtures.mjs';
/** Idempotently seeds ONLY fictional data. Anchor is persisted, never refreshed. */
export async function seedDurableWorkspace(app,now=new Date().toISOString()){
 app.db.exec('CREATE TABLE IF NOT EXISTS fixture_demo_config(id TEXT PRIMARY KEY, anchor TEXT NOT NULL)');
 app.db.prepare("INSERT INTO fixture_demo_config VALUES('anchor',?) ON CONFLICT(id) DO NOTHING").run(new Date(now).toISOString());
 const anchor=app.db.prepare("SELECT anchor FROM fixture_demo_config WHERE id='anchor'").get().anchor;
 const receivedAt=new Date(Date.parse(anchor)-25*3600000).toISOString(),sentAt=new Date(Date.parse(anchor)-2*3600000).toISOString();
 const tenantId=demoPrincipals.pm.tenantId,mailboxId='fictional-pm-mailbox';
 const request=(id,subject,customerId='cedar',ownerId='avery')=>({id,subject,customerId,ownerId,customer:customerId==='cedar'?'Cedar Nutrition (fictional)':'Meadow Health (fictional)',owner:ownerId==='avery'?'Avery':'Jordan',classification:'customer_operations',departmentId:'qa',department:'QA',nextAction:'Review the requested certification and send a verified answer.',operationalEvidenceSummary:'Fictional persisted email evidence. Only the availability portion has a reviewed Sent response; certification remains unanswered.'});
 app.ingestPage({tenantId,mailboxId,folder:'inbox',pageId:'demo-inbox',checkpoint:'fixture-inbox-cursor',messages:[{id:'cedar-incoming',customerId:'cedar',receivedAt,direction:'inbound',isDraft:false,subject:'Availability and certification'},{id:'meadow-incoming',customerId:'meadow',receivedAt,direction:'inbound',isDraft:false,subject:'Certificate for next order'}]});
 const copy=id=>app.db.prepare('SELECT payload FROM fixture_copies WHERE tenant=?').all(tenantId).map(row=>JSON.parse(row.payload)).find(row=>row.id===id);
 app.approveIncoming({tenantId,copyId:copy('cedar-incoming').copyId,reviewerId:'fictional-human',reviewId:'cedar-review',requests:[request('availability','Confirm availability'),request('certification','Confirm certification')]});
 app.approveIncoming({tenantId,copyId:copy('meadow-incoming').copyId,reviewerId:'fictional-human',reviewId:'meadow-review',requests:[request('other-pm-certificate','Provide order certificate','meadow','jordan')]});
 while(await app.runNext({tenantId,now:anchor})){};
 app.ingestPage({tenantId,mailboxId,folder:'sent',pageId:'demo-sent',checkpoint:'fixture-sent-cursor',messages:[{id:'availability-sent',customerId:'cedar',recipientCustomerId:'cedar',recipientVerified:true,recipientEvidenceId:'fictional-recipient-review',direction:'outbound',isDraft:false,deliveryState:'sent',sentAt}]});
 app.approveSent({tenantId,copyId:copy('availability-sent').copyId,reviewerId:'fictional-human',reviewId:'sent-review',requestId:'availability',meaningful:true,addressedObligationIds:['initial:availability']});
 while(await app.runNext({tenantId,now:anchor})){};
}
/** Only scoped unanswered-inbound rows are shown in this read-only demo route.
 * Responded but unresolved requests remain in storage; no false resolution. */
export function durableWorkspace(app,principal,now){
 const all=app.workspace(principal,now),rows=app.waitingOnFirstAnswer(principal,now);
 const counts=new Map();for(const row of rows)counts.set(row.department,(counts.get(row.department)??0)+1);
 return {...all,requests:rows,summary:{totalOpen:rows.length,overdue:rows.filter(r=>r.band==='overdue').length,dueSoon:rows.filter(r=>['urgent','due_soon'].includes(r.band)).length,unassigned:rows.filter(r=>r.owner==='Assignment needs review').length},departments:[...counts].map(([name,waiting])=>({name,waiting})),coverage:{mode:'fictional-persisted',status:'Persisted fixture · unanswered asks',detail:'Fictional evidence and reviewed partial Sent coverage persisted in local SQLite. Answered but unresolved work remains stored. Demo personas are not sign-in; no real mailbox is connected.'}};
}
