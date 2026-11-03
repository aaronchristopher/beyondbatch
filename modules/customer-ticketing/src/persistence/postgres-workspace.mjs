/** Saved operational projections. All inputs are trusted SAML-session principals,
 * never browser-supplied identity. Each read rechecks current DB status/grants in
 * one repeatable-read snapshot. The HTTP boundary reauthenticates before sending
 * the result. Source mail, attachments and mailbox ACLs remain a separate seam.
 */
import { projectWorkspace } from '../security/workspace.mjs';
import { readRequestSnapshot } from './postgres-request-store.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid=value=>typeof value==='string'&&UUID.test(value);
const ROLES={pm:'pm',department:'department_member',president:'president'};
const ACTIVE_DEPENDENCIES=['requested','accepted','working','blocked','delivered'];
const COVERAGE=Object.freeze({mode:'not_connected',persisted:true,complete:false,status:'Saved requests · email not connected',
  detail:'Requests and history are saved. Live email is not connected; source trails and sending are unavailable.'});
const LABELS={request_created:'Request recorded',customer_followup:'Customer follow-up recorded',internal_update:'Internal progress recorded',
  response_sent:'Meaningful customer response recorded',waiting_customer:'Waiting on customer confirmed',
  resolution_confirmed:'Resolution confirmed',reopened:'Request reopened'};
export class WorkspaceReadError extends Error {
  constructor(code,statusCode){super(statusCode===403?'Access denied':statusCode===400?'Invalid request':'Saved workspace unavailable');this.code=code;this.statusCode=statusCode;}
}
const denied=()=>new WorkspaceReadError('WORKSPACE_ACCESS_DENIED',403);
const unavailable=()=>new WorkspaceReadError('WORKSPACE_UNAVAILABLE',503);
const validText=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value);
const date=value=>new Date(value).toISOString();
function capturePrincipal(value,tenantId){
  if(!value||value.tenantId!==tenantId||!isUuid(value.id)||typeof value.role!=='string'||!Object.hasOwn(ROLES,value.role)
    ||!validText(value.name)||!Array.isArray(value.customerIds)||value.customerIds.length>10000||!value.customerIds.every(isUuid)
    ||!Array.isArray(value.departmentIds)||value.departmentIds.length>10000||!value.departmentIds.every(validText))throw denied();
  return {id:value.id,tenantId,name:value.name,role:value.role,customerIds:[...new Set(value.customerIds)],departmentIds:[...new Set(value.departmentIds)]};
}
async function currentPrincipal(client,input,now){
  const identity=await client.query(`SELECT p.id,p.display_name,p.status,p.principal_type,t.status AS tenant_status
    FROM bb.principals p JOIN bb.tenants t ON t.id=p.tenant_id
    WHERE p.tenant_id=$1 AND p.id=$2`,[input.tenantId,input.id]);
  const actor=identity.rows[0];
  if(identity.rows.length!==1||actor.id!==input.id||actor.status!=='active'||actor.principal_type!=='user'
    ||!['pilot','active'].includes(actor.tenant_status)||!validText(actor.display_name))throw denied();
  const grants=await client.query(`SELECT scope_kind,customer_id,department_key FROM bb.role_grants
    WHERE tenant_id=$1 AND principal_id=$2 AND role_name=$3 AND revoked_at IS NULL
      AND granted_at <= $4 AND (expires_at IS NULL OR expires_at > $4) LIMIT 10001`,[input.tenantId,input.id,ROLES[input.role],now]);
  if(!grants.rows.length)throw denied();
  if(grants.rows.length>10000)throw unavailable();
  const customers=new Set(grants.rows.filter(g=>g.scope_kind==='customer').map(g=>g.customer_id));
  const departments=new Set(grants.rows.filter(g=>g.scope_kind==='department').map(g=>g.department_key));
  return {...input,name:actor.display_name,customerIds:input.customerIds.filter(id=>customers.has(id)),departmentIds:input.departmentIds.filter(id=>departments.has(id))};
}

/** One monotonic deadline covers acquisition, all queries and cleanup. Releasing
 * a node-postgres client with an Error removes/destroys its socket; a timed-out
 * query is never returned to the pool. Late acquisition is disposed separately.
 */
async function withReadDeadline(pool,timeoutMs,work){
  const endsAt=performance.now()+timeoutMs;
  const timeout=new WorkspaceReadError('WORKSPACE_READ_TIMEOUT',503);
  let raw,released=false,expired=false,finished=false,discard=false,releaseFailed=false,rejectDeadline;
  const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
  deadline.catch(()=>{}); // check() can expire before the first race subscribes
  const release=(client,error)=>{
    try{client.release(error);}catch{releaseFailed=true;}
  };
  const dispose=()=>{
    if(raw&&!released){released=true;release(raw,discard?new Error('discard uncertain workspace connection'):undefined);}
  };
  const expire=()=>{
    if(expired||finished)return;
    expired=true;discard=true;dispose();rejectDeadline(timeout);
  };
  const timer=setTimeout(expire,timeoutMs); // referenced: stalled dependencies must still reject
  const check=()=>{
    if(expired||performance.now()>=endsAt){expire();throw timeout;}
    if(finished)throw unavailable();
  };
  const bounded=async(operation)=>{
    check();
    const pending=Promise.resolve().then(()=>{check();return operation();});
    const result=await Promise.race([pending,deadline]);check();return result;
  };
  try{
    await bounded(async()=>{
      const acquired=await pool.connect();
      if(expired||finished||performance.now()>=endsAt){
        release(acquired,new Error('discard late workspace connection'));expire();throw timeout;
      }
      raw=acquired;
      if(!raw||typeof raw.query!=='function'||typeof raw.release!=='function')throw unavailable();
    });
    const client={query:(...args)=>bounded(()=>raw.query(...args))};
    return await bounded(()=>work(client,{expired:()=>expired,discard:()=>{discard=true;}}));
  }finally{
    finished=true;clearTimeout(timer);dispose();
    if(releaseFailed)throw unavailable();
  }
}

export function createPostgresWorkspaceRepository({pool,dbTenantId,clock=()=>new Date(),maxRequests=200,readTimeoutMs=8000}={}){
  if(!pool||typeof pool.connect!=='function')throw new TypeError('pool.connect required');
  if(!isUuid(dbTenantId))throw new TypeError('fixed tenant UUID required');
  if(typeof clock!=='function')throw new TypeError('clock required');
  if(!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>1000)throw new TypeError('workspace limit must be 1–1000');
  if(!Number.isSafeInteger(readTimeoutMs)||readTimeoutMs<1||readTimeoutMs>8000)throw new TypeError('read timeout must be 1–8000ms');
  async function read(input,requestId,authorizationIds){
    let captured;
    try{captured=capturePrincipal(input,dbTenantId);}catch(error){if(authorizationIds!==undefined&&error.statusCode===403)return false;throw error;}
    if(requestId!==undefined&&!isUuid(requestId))throw new WorkspaceReadError('INVALID_REQUEST_ID',400);
    try{
      return await withReadDeadline(pool,readTimeoutMs,async(client,control)=>{
        let begun=false,beginning=true,committing=false;
        try{
          const now=date(clock());
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;beginning=false;
          await client.query("SELECT set_config('app.tenant_id',$1,true)",[dbTenantId]);
          await client.query("SET LOCAL statement_timeout = '5000ms'");
          const principal=await currentPrincipal(client,captured,now);
          const hasScope=principal.customerIds.length&&(principal.role!=='department'||principal.departmentIds.length);
          let result;
          if(authorizationIds!==undefined){
            const rows=authorizationIds.length&&hasScope?await eligibleRows(client,principal,now,authorizationIds,maxRequests,true):[];
            const found=new Set(rows.map(row=>row.id));
            result=rows.length===authorizationIds.length&&found.size===authorizationIds.length
              &&authorizationIds.every(id=>found.has(id));
          }else{
            const records=hasScope?await loadRecords(client,principal,now,requestId,maxRequests):[];
            const workspace=projectWorkspace({principal,requests:records.map(record=>record.projection),now,coverage:{...COVERAGE}});
            result=requestId===undefined?workspace:records.length?{
              request:workspace.requests[0],version:records[0].version,history:records[0].history,
              dependencies:records[0].dependencies,coverage:{...COVERAGE},emailTrail:{status:'unavailable',reason:'Authorized source-email access is not connected'},
            }:null;
          }
          committing=true;await client.query('COMMIT');begun=false;return result;
        }catch(error){
          if(beginning||committing)control.discard();
          if(begun&&!control.expired()){try{await client.query('ROLLBACK');}catch{control.discard();}}
          throw error;
        }
      });
    }catch(error){
      if(authorizationIds!==undefined&&error instanceof WorkspaceReadError&&error.statusCode===403)return false;
      if(error instanceof WorkspaceReadError)throw error;
      throw unavailable();
    }
  }
  return Object.freeze({workspace:principal=>read(principal),request:async(principal,id)=>{
    if(!isUuid(id))throw new WorkspaceReadError('INVALID_REQUEST_ID',400);
    return read(principal,id);
  },authorize:async(principal,requestIds)=>{
    if(!Array.isArray(requestIds)||requestIds.length>maxRequests||!requestIds.every(isUuid)||new Set(requestIds).size!==requestIds.length)
      throw new WorkspaceReadError('INVALID_REQUEST_IDS',400);
    return read(principal,undefined,[...requestIds]);
  }});
}

async function eligibleRows(client,principal,now,requestIds,maxRequests,idsOnly=false){
  const fields=idsOnly?'r.id,r.customer_id':`r.id,r.customer_id,r.accountable_owner_id,r.next_action,
      c.display_name AS customer_name,p.display_name AS owner_name,
      EXISTS(SELECT 1 FROM bb.customer_pm_assignments a WHERE a.tenant_id=r.tenant_id AND a.customer_id=r.customer_id
        AND a.primary_pm_id=r.accountable_owner_id AND a.backup_pm_id=$3 AND a.effective_from<=$6
        AND (a.effective_until IS NULL OR a.effective_until>$6)) AS is_backup`;
  const result=await client.query(`SELECT ${fields}
    FROM bb.requests r JOIN bb.customers c ON c.tenant_id=r.tenant_id AND c.id=r.customer_id
    LEFT JOIN bb.principals p ON p.tenant_id=r.tenant_id AND p.id=r.accountable_owner_id
    WHERE r.tenant_id=$1 AND r.customer_id=ANY($2::uuid[]) AND c.identity_status='approved'
      AND r.publication_state='approved' AND r.sensitivity='operational'
      AND ($4='president' OR ($4='pm' AND (r.accountable_owner_id=$3 OR EXISTS(
        SELECT 1 FROM bb.customer_pm_assignments a WHERE a.tenant_id=r.tenant_id AND a.customer_id=r.customer_id
          AND a.primary_pm_id=r.accountable_owner_id AND a.backup_pm_id=$3 AND a.effective_from<=$6
          AND (a.effective_until IS NULL OR a.effective_until>$6)))) OR ($4='department' AND EXISTS(
        SELECT 1 FROM bb.dependencies d WHERE d.tenant_id=r.tenant_id AND d.request_id=r.id
          AND d.department_key=ANY($5::text[]) AND d.state=ANY($9::text[]))))
      AND ($7::uuid[] IS NULL OR r.id=ANY($7::uuid[]))
      AND NOT EXISTS(SELECT 1 FROM bb.request_evidence e
        LEFT JOIN bb.canonical_emails m ON m.tenant_id=e.tenant_id AND m.id=e.canonical_email_id
        LEFT JOIN bb.raw_blob_refs b ON b.tenant_id=e.tenant_id AND b.id=e.blob_id
        WHERE e.tenant_id=r.tenant_id AND e.request_id=r.id AND (
          (e.canonical_email_id IS NOT NULL AND (m.id IS NULL OR m.sensitivity<>'operational'))
          OR (e.blob_id IS NOT NULL AND (b.id IS NULL OR b.sensitivity<>'operational'))))
      AND NOT EXISTS(SELECT 1 FROM bb.audit_events a WHERE a.tenant_id=r.tenant_id
        AND a.aggregate_type='request' AND a.aggregate_id=r.id AND a.sensitivity<>'operational')
    ORDER BY r.id LIMIT $8`,[principal.tenantId,principal.customerIds,principal.id,principal.role,
    principal.departmentIds,now,requestIds,requestIds?requestIds.length+1:maxRequests+1,ACTIVE_DEPENDENCIES]);
  if(result.rows.some(row=>!isUuid(row.id)||!principal.customerIds.includes(row.customer_id)))throw unavailable();
  return result.rows;
}

async function loadRecords(client,principal,now,requestId,maxRequests){
  const rows=await eligibleRows(client,principal,now,requestId?[requestId]:null,maxRequests);
  if(rows.length>maxRequests)throw new WorkspaceReadError('WORKSPACE_LIMIT_EXCEEDED',503);
  const records=[];
  for(const row of rows){
    const envelope=await readRequestSnapshot(client,{tenantId:principal.tenantId,requestId:row.id,actorId:principal.id});
    if(!envelope)throw unavailable();
    const deps=await client.query(`SELECT id,department_key,state,promised_at,assigned_principal_id
      FROM bb.dependencies WHERE tenant_id=$1 AND request_id=$2 AND state=ANY($3::text[])
        AND ($4<>'department' OR department_key=ANY($5::text[]))
      ORDER BY promised_at ASC NULLS LAST,created_at,id LIMIT 101`,[principal.tenantId,row.id,ACTIVE_DEPENDENCIES,principal.role,principal.departmentIds]);
    if(deps.rows.length>100)throw new WorkspaceReadError('WORKSPACE_LIMIT_EXCEEDED',503);
    const dependencies=deps.rows.map(dep=>({id:dep.id,department:dep.department_key,status:dep.state,
      promisedAt:dep.promised_at===null?null:date(dep.promised_at),assignedPrincipalId:dep.assigned_principal_id}));
    const primary=dependencies[0]?.department??null;
    if(principal.role==='department'&&!principal.departmentIds.includes(primary))throw unavailable();
    const history=[{type:'request_created',occurredAt:envelope.request.receivedAt,label:LABELS.request_created},
      ...envelope.request.events.map(event=>({type:event.type,occurredAt:event.occurredAt,label:LABELS[event.type],
        effective:!envelope.request.invalidatedEvents.some(item=>item.eventId===event.id)}))];
    records.push({version:envelope.version,history,dependencies,projection:{
      id:row.id,tenantId:principal.tenantId,customerId:row.customer_id,customer:row.customer_name,
      ownerId:row.accountable_owner_id,owner:row.owner_name,backupId:row.is_backup?principal.id:null,
      subject:envelope.request.subject,classification:'customer_operations',departmentId:primary,department:primary,
      nextAction:row.next_action??'Next action awaits review',clock:envelope.request,
      operationalEvidenceSummary:'Saved operational history. Source email access is not connected.',
    }});
  }
  return records;
}
