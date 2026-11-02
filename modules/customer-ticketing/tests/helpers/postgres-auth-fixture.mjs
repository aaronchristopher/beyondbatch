import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
const LOCK_ID = 764230832;

/** Disposable native test database only. This fixture owns bb_auth and its
 * generated role; it never drops an existing schema or touches the bb schema.
 * The auth adapter runs as a restricted LOGIN, never through the admin pool.
 */
export async function createPostgresAuthFixture() {
  const configured = process.env.TICKETING_TEST_DATABASE_URL;
  if (!configured) throw new Error('TICKETING_TEST_DATABASE_URL must identify a disposable local PostgreSQL database');
  const url = new URL(configured);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !/^\/beyondbatch_ticketing_test(?:_[a-z0-9_]+)?$/.test(url.pathname)
      || url.search || url.hash) {
    throw new Error('auth integration tests require a loopback beyondbatch_ticketing_test database without URL options');
  }
  const admin = new Pool({ connectionString: configured, max: 2 });
  const setup = await admin.connect();
  const role = `bb_auth_test_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const pools = [];
  let ownsSchema = false, ownsRole = false, locked = false, closed = false;
  async function dispose() {
    if (closed) return;
    closed = true;
    await Promise.all(pools.map(pool => pool.end()));
    try {
      await setup.query('ROLLBACK');
      if (ownsSchema) await setup.query('DROP SCHEMA bb_auth CASCADE');
      if (ownsRole) {
        await setup.query(`DROP OWNED BY ${role}`);
        await setup.query(`DROP ROLE ${role}`);
      }
      if (locked) await setup.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    } finally {
      setup.release();
      await admin.end();
    }
  }
  try {
    await setup.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    locked = true;
    if ((await setup.query("SELECT 1 FROM pg_namespace WHERE nspname='bb_auth'")).rowCount) {
      throw new Error('refusing to replace an existing bb_auth schema; supply a fresh disposable test database');
    }
    await setup.query(await readFile(new URL('../../db/002_auth.sql', import.meta.url), 'utf8'));
    ownsSchema = true;
    // Only internally generated fixed-prefix/hex identifiers enter this DDL.
    await setup.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    ownsRole = true;
    await setup.query(`GRANT CONNECT ON DATABASE ${url.pathname.slice(1)} TO ${role}`);
    await setup.query(`GRANT USAGE ON SCHEMA bb_auth TO ${role}`);
    await setup.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON bb_auth.entries,bb_auth.sessions TO ${role}`);
    const appUrl = new URL(url);
    appUrl.username = role;
    appUrl.password = password;
    function newPool() {
      const pool = new Pool({ connectionString: appUrl.href, max: 8, idleTimeoutMillis: 1000 });
      pools.push(pool);
      return pool;
    }
    return { admin, pool: newPool(), newPool, close: dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
