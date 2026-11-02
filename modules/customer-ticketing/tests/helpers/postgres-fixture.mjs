import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
export const AT = '2026-01-05T08:00:00.000Z';

/** Destructive test fixture, deliberately restricted to an explicitly named,
 * empty, local disposable database. Never use a production connection here.
 * The administrator owns setup; the code under test uses a real restricted
 * LOGIN role, not a superuser connection with tenant predicates bolted on.
 */
export async function createPostgresFixture() {
  const configured = process.env.TICKETING_TEST_DATABASE_URL;
  if (!configured) throw new Error('TICKETING_TEST_DATABASE_URL must identify a disposable local PostgreSQL database');
  const url = new URL(configured);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !/^\/beyondbatch_ticketing_test(?:_[a-z0-9_]+)?$/.test(url.pathname)
      || url.search || url.hash) {
    throw new Error('integration tests require a loopback beyondbatch_ticketing_test database without URL options');
  }
  const admin = new Pool({ connectionString: configured, max: 2 });
  const setup = await admin.connect();
  const role = `bb_test_app_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const pools = [];
  let ownsSchema = false;
  let ownsRole = false;
  let locked = false;
  try {
    await setup.query('SELECT pg_advisory_lock(764230831)');
    locked = true;
    if ((await setup.query("SELECT 1 FROM pg_namespace WHERE nspname = 'bb'")).rowCount) {
      throw new Error('refusing to replace an existing bb schema; supply a fresh disposable test database');
    }
    await setup.query(await readFile(new URL('../../db/001_core.sql', import.meta.url), 'utf8'));
    ownsSchema = true;
    // Generated identifiers/passwords contain only a fixed prefix and hex.
    await setup.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    ownsRole = true;
    await setup.query(`GRANT CONNECT ON DATABASE ${url.pathname.slice(1)} TO ${role}`);
    await setup.query(`GRANT USAGE ON SCHEMA bb TO ${role}`);
    await setup.query(`GRANT SELECT ON bb.tenants,bb.principals,bb.customers,bb.canonical_emails,
      bb.requests,bb.request_evidence,bb.response_obligations,bb.audit_events,
      bb.idempotency_records,bb.dependencies TO ${role}`);
    await setup.query(`GRANT INSERT, UPDATE ON bb.requests,bb.response_obligations TO ${role}`);
    await setup.query(`GRANT INSERT ON bb.request_evidence,bb.audit_events,bb.outbox,bb.idempotency_records TO ${role}`);
    // PostgreSQL SELECT ... FOR SHARE requires UPDATE on at least one column.
    // These narrow identity-column grants enable the adapter's locked reads in
    // this disposable test only. They are NOT a reviewed production role policy;
    // deployment must separately decide its row-lock/privilege boundary.
    await setup.query(`GRANT UPDATE(id) ON bb.tenants,bb.principals,bb.customers,bb.canonical_emails TO ${role}`);
    await setup.query(`GRANT EXECUTE ON FUNCTION bb.current_tenant_id() TO ${role}`);
    const appUrl = new URL(url);
    appUrl.username = role;
    appUrl.password = password;
    const newPool = () => {
      const pool = new Pool({ connectionString: appUrl.href, max: 4, idleTimeoutMillis: 1000 });
      pools.push(pool);
      return pool;
    };
    const pool = newPool();
    let closed = false;
    return {
      admin, pool, newPool,
      async tenant() {
        const ids = { tenantId: randomUUID(), actorId: randomUUID(), workerId: randomUUID(), ownerId: randomUUID(), customerId: randomUUID() };
        await admin.query(`INSERT INTO bb.tenants(id, entra_tenant_id, display_name, status)
          VALUES ($1,$2,'Fictional laboratory test tenant','pilot')`, [ids.tenantId, randomUUID()]);
        for (const [id, kind, name] of [[ids.actorId, 'user', 'Fictional reviewer'], [ids.workerId, 'service', 'Fictional ingestion worker'], [ids.ownerId, 'user', 'Fictional PM']]) {
          await admin.query(`INSERT INTO bb.principals(tenant_id,id,entra_object_id,principal_type,display_name,email_address,status)
            VALUES ($1,$2,$3,$4,$5,$6,'active')`, [ids.tenantId, id, randomUUID(), kind, name, `${id}@example.invalid`]);
        }
        await admin.query(`INSERT INTO bb.customers(tenant_id,id,display_name,identity_status,approved_by,approved_at)
          VALUES ($1,$2,'Fictional Cedar Customer','approved',$3,$4)`, [ids.tenantId, ids.customerId, ids.actorId, AT]);
        return ids;
      },
      async email(tenant, { id = randomUUID(), at = AT, direction = 'incoming', classification = 'request', sensitivity = 'operational' } = {}) {
        await admin.query(`INSERT INTO bb.canonical_emails(tenant_id,id,dedup_version,dedup_fingerprint,sender_address,recipients,subject,sent_at,first_observed_at,direction,classification,sensitivity)
          VALUES ($1,$2,'fixture-v1',$3,'sender@example.invalid','[{"address":"recipient@example.invalid"}]','Fictional specification request',$4,$4,$5,$6,$7)`,
        [tenant.tenantId, id, createHash('sha256').update(id).digest('hex'), at, direction, classification, sensitivity]);
        return id;
      },
      async evidence(tenant, requestId, { id = randomUUID(), at = AT, kind = 'human_note', emailId = null, meaningful = false, confirmedBy = null, requirementsVersion = 1 } = {}) {
        await admin.query(`INSERT INTO bb.request_evidence(tenant_id,id,request_id,canonical_email_id,evidence_kind,observed_at,recorded_by,requirements_version,meaningful_for_request,human_confirmed_by,human_confirmed_at,assessment_version,rationale)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'fixture-v1','Explicitly fictional integration-test evidence')`,
        [tenant.tenantId, id, requestId, emailId, kind, at, tenant.actorId, requirementsVersion, meaningful, confirmedBy, confirmedBy ? at : null]);
        return id;
      },
      async close() {
        if (closed) return;
        closed = true;
        await Promise.all(pools.map(p => p.end()));
        try {
          await setup.query('DROP SCHEMA bb CASCADE');
          await setup.query(`DROP OWNED BY ${role}`);
          await setup.query(`DROP ROLE ${role}`);
          await setup.query('SELECT pg_advisory_unlock(764230831)');
        } finally {
          setup.release();
          await admin.end();
        }
      },
    };
  } catch (error) {
    try {
      await setup.query('ROLLBACK');
      if (ownsSchema) await setup.query('DROP SCHEMA bb CASCADE');
      if (ownsRole) {
        await setup.query(`DROP OWNED BY ${role}`);
        await setup.query(`DROP ROLE ${role}`);
      }
      if (locked) await setup.query('SELECT pg_advisory_unlock(764230831)');
    } finally {
      setup.release();
      await admin.end();
    }
    throw error;
  }
}
