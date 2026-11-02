/** Real SQLite transaction contract harness, NOT the PostgreSQL production adapter.
 * JSON columns intentionally model reducer state, not db/001_core.sql. */
import { DatabaseSync } from 'node:sqlite';
export class SqliteFixtureStore {
  constructor(path=':memory:') {
    this.db=new DatabaseSync(path); this.tail=Promise.resolve();
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS requests(tenant TEXT, id TEXT, version INTEGER, payload TEXT, PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS events(tenant TEXT,id TEXT, request TEXT, version INTEGER,payload TEXT,PRIMARY KEY(tenant,id),UNIQUE(tenant,request,version));
      CREATE TABLE IF NOT EXISTS obligations(tenant TEXT,request TEXT,id TEXT,payload TEXT,PRIMARY KEY(tenant,request,id));
      CREATE TABLE IF NOT EXISTS outbox(tenant TEXT,id TEXT,payload TEXT,PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS receipts(tenant TEXT,scope TEXT,id TEXT,payload TEXT,PRIMARY KEY(tenant,scope,id));`);
  }
  close(){this.db.close();}
  seed(tenant,request){this.db.prepare('INSERT INTO requests VALUES(?,?,0,?)').run(tenant,request.id,JSON.stringify(request));this.replaceObligations(tenant,request.id,request.responseObligations);}
  read(tenant,id){const row=this.db.prepare('SELECT * FROM requests WHERE tenant=? AND id=?').get(tenant,id);return row && {tenantId:row.tenant,version:row.version,request:JSON.parse(row.payload)};}
  count(table){if(!['requests','events','obligations','outbox','receipts'].includes(table))throw Error('table');return this.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;}
  replaceObligations(tenant,request,items){this.db.prepare('DELETE FROM obligations WHERE tenant=? AND request=?').run(tenant,request);for(const item of items)this.db.prepare('INSERT INTO obligations VALUES(?,?,?,?)').run(tenant,request,item.id,JSON.stringify(item));}
  transaction(work){
    const run=async()=>{this.db.exec('BEGIN IMMEDIATE');try{
      const wrap=(name,fn)=>(...args)=>{const result=fn(...args);if(this.failAfter===name)throw Error(`injected ${name}`);return result;};
      const result=await work({
        lockIdempotency:()=>{}, // BEGIN IMMEDIATE obtains SQLite's database write lock.
        getReceipt:(t,s,k)=>{const row=this.db.prepare('SELECT payload FROM receipts WHERE tenant=? AND scope=? AND id=?').get(t,s,k);return row&&JSON.parse(row.payload);},
        lockRequest:(t,r)=>this.read(t,r),
        saveRequest:wrap('saveRequest',(t,r,old,v,p)=>{const result=this.db.prepare('UPDATE requests SET version=?,payload=? WHERE tenant=? AND id=? AND version=?').run(v,JSON.stringify(p),t,r,old);if(result.changes!==1)throw Error('version conflict');}),
        appendEvent:wrap('appendEvent',(t,r,v,e)=>this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(t,e.id,r,v,JSON.stringify(e))),
        replaceObligations:wrap('replaceObligations',(t,r,o)=>this.replaceObligations(t,r,o)),
        enqueue:wrap('enqueue',(t,o)=>this.db.prepare('INSERT INTO outbox VALUES(?,?,?)').run(t,o.dedupeKey,JSON.stringify(o))),
        saveReceipt:wrap('saveReceipt',(t,s,k,p)=>this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(t,s,k,JSON.stringify(p)))
      });this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}};
    const pending=this.tail.then(run);this.tail=pending.catch(()=>{});return pending;
  }
}
