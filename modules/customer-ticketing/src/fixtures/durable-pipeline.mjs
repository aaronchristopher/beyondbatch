/** LOCAL FICTIONAL-DATA HARNESS ONLY. No production auth, Graph tokens or send API.
 * Reviewer/principal arguments are fixture inputs, not authentication. Never expose
 * this module as a live API. PostgreSQL and Entra integration remain separate. */
import {createHash} from 'node:crypto';
import {SqliteFixtureStore} from '../persistence/sqlite-fixture-store.mjs';
import {FixtureJobs} from '../persistence/fixture-jobs.mjs';
import {createRequest, replayRequest} from '../domain/response-clock.mjs';
import {commitRequestEvent} from '../persistence/request-transaction.mjs';
import {reviewedSentResponse} from '../integrations/correlation.mjs';
import {projectWorkspace,canReadRequest} from '../security/workspace.mjs';
function json(value){if(Array.isArray(value))return `[${value.map(json).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${json(value[k])}`).join(',')}}`;return JSON.stringify(value);}
const hash=value=>createHash('sha256').update(json(value)).digest('hex');
const required=(value,label)=>{if(typeof value!=='string'||!value.trim())throw new TypeError(`${label} required`);};
export class FixturePipeline {
 constructor(path=':memory:'){
  this.workerTail=Promise.resolve();this.workerBusy=false;this.store=new SqliteFixtureStore(path);this.db=this.store.db;this.jobs=new FixtureJobs(this.db);
  this.db.exec(`CREATE TABLE IF NOT EXISTS fixture_pages(tenant TEXT,mailbox TEXT,folder TEXT,id TEXT,fingerprint TEXT,PRIMARY KEY(tenant,mailbox,folder,id));
   CREATE TABLE IF NOT EXISTS fixture_checkpoints(tenant TEXT,mailbox TEXT,folder TEXT,cursor TEXT,PRIMARY KEY(tenant,mailbox,folder));
   CREATE TABLE IF NOT EXISTS fixture_copies(tenant TEXT,id TEXT,payload TEXT,fingerprint TEXT,reviewed INTEGER DEFAULT 0,PRIMARY KEY(tenant,id));
   CREATE TABLE IF NOT EXISTS fixture_reviews(tenant TEXT,id TEXT,payload TEXT,fingerprint TEXT,PRIMARY KEY(tenant,id));
   CREATE TABLE IF NOT EXISTS fixture_metadata(tenant TEXT,id TEXT,payload TEXT,PRIMARY KEY(tenant,id));`);
 }
 close(){this.store.close();}
 atomic(work){if(this.workerBusy)throw Error('fixture worker busy; retry after runNext settles');this.db.exec('BEGIN IMMEDIATE');try{const result=work();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 checkpoint(tenant,mailbox,folder){return this.db.prepare('SELECT cursor FROM fixture_checkpoints WHERE tenant=? AND mailbox=? AND folder=?').get(tenant,mailbox,folder)?.cursor??null;}
 ingestPage(input){
  const page=structuredClone(input);for(const key of ['tenantId','mailboxId','folder','pageId','checkpoint'])required(page[key],key);
  if(!Array.isArray(page.messages))throw new TypeError('messages required');const fingerprint=hash(page);
  return this.atomic(()=>{
   const prior=this.db.prepare('SELECT fingerprint FROM fixture_pages WHERE tenant=? AND mailbox=? AND folder=? AND id=?').get(page.tenantId,page.mailboxId,page.folder,page.pageId);
   if(prior){if(prior.fingerprint!==fingerprint)throw Error('page replay conflict');return;}
   if(this.checkpoint(page.tenantId,page.mailboxId,page.folder)!==(page.expectedCheckpoint??null))throw Error('checkpoint conflict');
   for(const message of page.messages){required(message.id,'message.id');
    if(message.tenantId!==undefined&&message.tenantId!==page.tenantId)throw Error('tenant scope mismatch');
    const copyId=hash([page.tenantId,page.mailboxId,page.folder,message.id]);
    const payload={...message,tenantId:page.tenantId,sourceFolder:page.folder,mailboxId:page.mailboxId,copyId};const digest=hash(payload);
    const existing=this.db.prepare('SELECT fingerprint FROM fixture_copies WHERE tenant=? AND id=?').get(page.tenantId,copyId);
    if(existing&&existing.fingerprint!==digest)throw Error('immutable evidence conflict; changed source requires a new evidence version');
    if(!existing)this.db.prepare('INSERT INTO fixture_copies(tenant,id,payload,fingerprint) VALUES(?,?,?,?)').run(page.tenantId,copyId,JSON.stringify(payload),digest);
   }
   this.db.prepare('INSERT INTO fixture_pages VALUES(?,?,?,?,?)').run(page.tenantId,page.mailboxId,page.folder,page.pageId,fingerprint);
   this.db.prepare('INSERT INTO fixture_checkpoints VALUES(?,?,?,?) ON CONFLICT(tenant,mailbox,folder) DO UPDATE SET cursor=excluded.cursor').run(page.tenantId,page.mailboxId,page.folder,page.checkpoint);
  });
 }
 pendingReviews(tenantId){return this.db.prepare('SELECT payload FROM fixture_copies WHERE tenant=? AND reviewed=0 ORDER BY id').all(tenantId).map(row=>JSON.parse(row.payload));}
 copy(tenantId,copyId){const row=this.db.prepare('SELECT payload FROM fixture_copies WHERE tenant=? AND id=?').get(tenantId,copyId);if(!row)throw Error('evidence not found');return JSON.parse(row.payload);}
 approve(input,build){
  for(const key of ['tenantId','copyId','reviewerId','reviewId'])required(input[key],key);const fingerprint=hash(input);
  return this.atomic(()=>{
   const previous=this.db.prepare('SELECT fingerprint FROM fixture_reviews WHERE tenant=? AND id=?').get(input.tenantId,input.reviewId);
   if(previous){if(previous.fingerprint!==fingerprint)throw Error('review replay conflict');return;}
   const copy=this.copy(input.tenantId,input.copyId);const payload=build(copy);
   this.jobs.enqueue({tenantId:input.tenantId,id:`review:${input.reviewId}`,payload,availableAt:Date.parse(copy.sentAt??copy.receivedAt)});
   this.db.prepare('INSERT INTO fixture_reviews VALUES(?,?,?,?)').run(input.tenantId,input.reviewId,JSON.stringify(input),fingerprint);
   this.db.prepare('UPDATE fixture_copies SET reviewed=1 WHERE tenant=? AND id=?').run(input.tenantId,input.copyId);
  });
 }
 approveIncoming(input){return this.approve(input,copy=>{
  if(copy.direction!=='inbound'||copy.isDraft!==false)throw Error('observed incoming evidence required');
  if(!Array.isArray(input.requests)||!input.requests.length)throw Error('reviewed requests required');
  const ids=new Set();const requests=input.requests.map(item=>{
   if(ids.has(item.id))throw Error('duplicate request ID');ids.add(item.id);
   if(item.customerId!==copy.customerId||item.classification!=='customer_operations')throw Error('reviewed customer/classification mismatch');
   const clock=createRequest({id:item.id,customerId:item.customerId,subject:item.subject,ownerId:item.ownerId,receivedAt:copy.receivedAt,evidenceId:copy.copyId});
   return {metadata:{...item,tenantId:input.tenantId},clock};
  });return {kind:'create_requests',requests,reviewId:input.reviewId,copyId:copy.copyId};
 });}
 approveSent(input){return this.approve(input,copy=>{
  if(copy.sourceFolder!=='sent'||copy.isDraft!==false||copy.direction!=='outbound'||copy.deliveryState!=='sent')throw Error('observed non-draft Sent evidence required');
  const current=this.store.read(input.tenantId,input.requestId);if(!current)throw Error('request not found');
  const {event,audit}=reviewedSentResponse({tenantId:input.tenantId,request:{...current.request,tenantId:input.tenantId},message:{...copy,id:copy.copyId},eventId:`review:${input.reviewId}`,review:{tenantId:input.tenantId,requestId:input.requestId,messageId:copy.copyId,reviewerId:input.reviewerId,evidenceId:input.reviewId,meaningful:input.meaningful,addressedObligationIds:input.addressedObligationIds}});
  return {kind:'sent_response',command:{tenantId:input.tenantId,requestId:input.requestId,expectedVersion:current.version,idempotencyKey:`review:${input.reviewId}`,event},audit};
 });}
 runNext(input){const pending=this.workerTail.then(async()=>{this.workerBusy=true;try{return await this.processNext(input);}finally{this.workerBusy=false;}});this.workerTail=pending.catch(()=>{});return pending;}
 async processNext({tenantId,now,owner='fixture-worker'}){
  now=Date.parse(now);const job=this.jobs.lease({tenantId,owner,now,leaseMs:30000});if(!job)return null;
  try{
   if(job.payload.kind==='create_requests'){
    await this.store.transaction(async()=>{
     for(const item of job.payload.requests){
      const prior=this.store.read(tenantId,item.clock.id);
      if(prior){const metadata=this.db.prepare('SELECT payload FROM fixture_metadata WHERE tenant=? AND id=?').get(tenantId,item.clock.id);if(!metadata||hash(JSON.parse(metadata.payload))!==hash(item.metadata)||prior.request.evidenceId!==item.clock.evidenceId)throw Error('request identity conflict');continue;}
      this.store.seed(tenantId,item.clock);this.db.prepare('INSERT INTO fixture_metadata VALUES(?,?,?)').run(tenantId,item.clock.id,JSON.stringify(item.metadata));
     }
    });
   }else if(job.payload.kind==='sent_response')await commitRequestEvent(this.store,job.payload.command);
   else throw Error('unsupported fixture job');
   this.jobs.complete({tenantId,id:job.id,token:job.token,now});return {id:job.id,status:'completed'};
  }catch(error){this.jobs.retry({tenantId,id:job.id,token:job.token,now,error:'FIXTURE_PROCESSING_FAILED',delayMs:1000});throw error;}
 }
 records(tenantId){if(this.workerBusy)throw Error('fixture worker busy; retry after runNext settles');return this.db.prepare('SELECT m.payload metadata,r.payload clock FROM fixture_metadata m JOIN requests r ON r.tenant=m.tenant AND r.id=m.id WHERE m.tenant=?').all(tenantId).map(row=>({...JSON.parse(row.metadata),clock:JSON.parse(row.clock)}));}
 workspace(principal,now){return projectWorkspace({principal,requests:this.records(principal.tenantId),now,coverage:{state:'fixture_only',liveMailboxConnected:false}});}
 waitingOnFirstAnswer(principal,now){const pending=new Set(this.records(principal.tenantId).filter(r=>canReadRequest(principal,r)&&replayRequest(r.clock).responseObligations.some(o=>o.kind!=='recurring'&&o.outcome==='pending')).map(r=>r.id));return this.workspace(principal,now).requests.filter(r=>pending.has(r.id));}
}
