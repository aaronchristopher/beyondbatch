/** LOCAL FIXTURE ONLY: durable SQLite queue, not a production scheduler/outbox
 * implementation. Tenant IDs are storage scopes, not authenticated identities.
 * No dispatch/network side effects. Caller supplies integer epoch milliseconds.
 * enqueue is a single insert and may join an existing transaction; lease,
 * complete and retry own BEGIN IMMEDIATE and must not be called in a transaction.
 */
import {randomUUID} from 'node:crypto';
const text=(v,n)=>{if(typeof v!=='string'||!v.trim())throw new TypeError(`${n} required`);};
const integer=(v,n,min=0)=>{if(!Number.isSafeInteger(v)||v<min)throw new TypeError(`invalid ${n}`);};
const sum=(a,b)=>{const value=a+b;integer(value,'time overflow');return value;};
function canonical(v){
 if(v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v)))return JSON.stringify(v);
 if(Array.isArray(v))return '['+Array.from(v,canonical).join(',')+']';
 if(v&&Object.getPrototypeOf(v)===Object.prototype)return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
 throw new TypeError('payload must contain plain JSON values');
}
export class FixtureJobs {
 constructor(db){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS fixture_jobs(
 tenant TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,enqueue_config TEXT NOT NULL,
 available_at INTEGER NOT NULL,max_attempts INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'pending',token TEXT,lease_until INTEGER,last_error TEXT,
 PRIMARY KEY(tenant,id),CHECK(state IN ('pending','leased','done','dead')));
 CREATE INDEX IF NOT EXISTS fixture_jobs_due ON fixture_jobs(tenant,state,available_at);`);}
 enqueue({tenantId,id,payload,availableAt,maxAttempts=3}){
  text(tenantId,'tenantId');text(id,'id');integer(availableAt,'availableAt');integer(maxAttempts,'maxAttempts',1);
  const json=canonical(payload),config=canonical({payload,availableAt,maxAttempts});
  const result=this.db.prepare(`INSERT INTO fixture_jobs(tenant,id,payload,enqueue_config,available_at,max_attempts)
   VALUES(?,?,?,?,?,?) ON CONFLICT(tenant,id) DO NOTHING`).run(tenantId,id,json,config,availableAt,maxAttempts);
  if(result.changes)return true;
  if(this.db.prepare('SELECT enqueue_config FROM fixture_jobs WHERE tenant=? AND id=?').get(tenantId,id).enqueue_config!==config)
   throw new Error('enqueue conflict: same tenant/id has different payload or configuration');
  return false;
 }
 get(tenantId,id){text(tenantId,'tenantId');text(id,'id');const row=this.db.prepare('SELECT * FROM fixture_jobs WHERE tenant=? AND id=?').get(tenantId,id);
  return row?{tenantId:row.tenant,id:row.id,payload:JSON.parse(row.payload),state:row.state,availableAt:row.available_at,
   attempts:row.attempts,maxAttempts:row.max_attempts,token:row.token,leaseUntil:row.lease_until,lastError:row.last_error}:null;
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 lease({tenantId,now,leaseMs}){
  text(tenantId,'tenantId');integer(now,'now');integer(leaseMs,'leaseMs',1);const until=sum(now,leaseMs);
  return this.transaction(()=>{
   this.db.prepare(`UPDATE fixture_jobs SET state='dead',token=NULL,lease_until=NULL,last_error='lease expired at attempt limit'
    WHERE tenant=? AND state='leased' AND lease_until<=? AND attempts>=max_attempts`).run(tenantId,now);
   const row=this.db.prepare(`SELECT id FROM fixture_jobs WHERE tenant=? AND attempts<max_attempts AND
    ((state='pending' AND available_at<=?) OR (state='leased' AND lease_until<=?)) ORDER BY available_at,id LIMIT 1`).get(tenantId,now,now);
   if(!row)return null;
   this.db.prepare(`UPDATE fixture_jobs SET state='leased',token=?,lease_until=?,attempts=attempts+1 WHERE tenant=? AND id=?`)
    .run(randomUUID(),until,tenantId,row.id);
   return this.get(tenantId,row.id);
  });
 }
 validateClaim({tenantId,id,token,now}){text(tenantId,'tenantId');text(id,'id');text(token,'token');integer(now,'now');
  const row=this.get(tenantId,id);
  if(!row||row.state!=='leased'||row.token!==token||row.leaseUntil<=now)throw new Error('active lease token required');
  return row;
 }
 complete(claim){return this.transaction(()=>{this.validateClaim(claim);
  this.db.prepare(`UPDATE fixture_jobs SET state='done',token=NULL,lease_until=NULL WHERE tenant=? AND id=?`).run(claim.tenantId,claim.id);
  return this.get(claim.tenantId,claim.id);
 });}
 retry({...claim}){
  integer(claim.delayMs,'delayMs');integer(claim.now,'now');const available=sum(claim.now,claim.delayMs);text(claim.error,'error');
  // Bounded diagnostic storage; do not store source mail or secrets in errors.
  if(claim.error.length>2000)throw new TypeError('error exceeds 2000 characters');
  return this.transaction(()=>{const row=this.validateClaim(claim);
   this.db.prepare(`UPDATE fixture_jobs SET state=?,available_at=?,token=NULL,lease_until=NULL,last_error=? WHERE tenant=? AND id=?`)
    .run(row.attempts>=row.maxAttempts?'dead':'pending',available,claim.error,claim.tenantId,claim.id);
   return this.get(claim.tenantId,claim.id);
  });
 }
}
