/** Shared authentication storage. Namespace is trusted SP/tenant configuration,
 * never selected by HTTP input. This adapter neither authenticates callers nor
 * grants app access. Use a separately approved narrow database runtime role.
 * Only hashes, bounded correlation metadata and immutable identity IDs belong
 * here; never persist raw cookies, CSRF tokens, assertions or role snapshots.
 */
const HASH = /^[0-9a-f]{64}$/;
const KEY = /^[a-z][a-z0-9:_-]{0,100}:[0-9a-f]{64}$/;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TIME = 253402300799999;
const SESSION_FIELDS = ['key','entraTenantId','entraObjectId','csrfHash','createdAtMs','lastSeenAtMs','expiresAtMs','reauthAtMs'];
const SESSION_COLUMNS = 'key, entra_tenant_id, entra_object_id, csrf_hash, created_at, last_seen_at, expires_at, reauth_at';
// CASE keeps malformed JSON counters out of integer casts even if PostgreSQL
// reorders other predicates. Corrupt/foreign payloads never reset themselves.
const RATE_COUNTER = `(CASE WHEN jsonb_typeof(target.payload)='number'
  AND target.payload::text ~ '^([1-9][0-9]{0,2}|1000)$'
  THEN (target.payload::text)::integer ELSE NULL END)`;

export class AuthStoreError extends Error {
  constructor() { super('Authentication storage unavailable'); this.name = 'AuthStoreError';
    this.code = 'AUTH_STORE_UNAVAILABLE'; this.statusCode = 503; }
}
function invalid() { throw new TypeError('Invalid authentication storage input'); }
function check(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) invalid(); return value; }
function instant(value) { if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIME) invalid(); return value; }
function json(value) {
  const visited = new Set();
  function validate(node, depth) {
    if (depth > 8) invalid();
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return;
    if (typeof node === 'number') { if (!Number.isFinite(node)) invalid(); return; }
    if (typeof node !== 'object' || visited.has(node)) invalid();
    if (!Array.isArray(node) && ![Object.prototype, null].includes(Object.getPrototypeOf(node))) invalid();
    visited.add(node);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
      if (key.length > 256 || descriptor.get || descriptor.set) invalid();
      if (Array.isArray(node) && key === 'length') continue;
      validate(descriptor.value, depth + 1);
    }
    visited.delete(node);
  }
  validate(value, 0);
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 8192) invalid();
  return encoded;
}
function sessionRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).length !== SESSION_FIELDS.length
      || SESSION_FIELDS.some(field => !Object.hasOwn(record, field))) invalid();
  check(record.key, HASH); check(record.csrfHash, HASH);
  check(record.entraTenantId, UUID); check(record.entraObjectId, UUID);
  for (const field of ['createdAtMs','lastSeenAtMs','expiresAtMs','reauthAtMs']) instant(record[field]);
  if (record.createdAtMs > record.lastSeenAtMs || record.lastSeenAtMs >= record.reauthAtMs
      || record.reauthAtMs > record.expiresAtMs) invalid();
  return { ...record, entraTenantId: record.entraTenantId.toLowerCase(), entraObjectId: record.entraObjectId.toLowerCase() };
}
function dateMs(value) {
  const result = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return instant(result);
}
function fromRow(row) {
  return sessionRecord({ key: row.key, entraTenantId: row.entra_tenant_id,
    entraObjectId: row.entra_object_id, csrfHash: row.csrf_hash,
    createdAtMs: dateMs(row.created_at), lastSeenAtMs: dateMs(row.last_seen_at),
    expiresAtMs: dateMs(row.expires_at), reauthAtMs: dateMs(row.reauth_at) });
}

export function createPostgresAuthStore({ pool, namespace } = {}) {
  if (!pool || typeof pool.query !== 'function') invalid();
  check(namespace, NAMESPACE);
  async function query(sql, parameters, decode) {
    try {
      const result = await pool.query(sql, parameters);
      if (!result || !Array.isArray(result.rows) || !Number.isInteger(result.rowCount) || result.rowCount < 0) throw new Error();
      return decode(result);
    } catch { throw new AuthStoreError(); }
  }
  const boolean = result => result.rowCount === 1;
  const entry = result => {
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error();
    return { value: JSON.parse(json(result.rows[0].payload)), expiresAtMs: dateMs(result.rows[0].expires_at) };
  };
  return Object.freeze({
    async insert(key, value, expiresAtMs) {
      check(key, KEY); const payload = json(value); instant(expiresAtMs);
      return query(`INSERT INTO bb_auth.entries(namespace,key,payload,expires_at) VALUES($1,$2,$3::jsonb,$4)
        ON CONFLICT(namespace,key) DO NOTHING RETURNING key`,
      [namespace, key, payload, new Date(expiresAtMs)], boolean);
    },
    async get(key, nowMs) {
      check(key, KEY); instant(nowMs);
      return query('SELECT payload,expires_at FROM bb_auth.entries WHERE namespace=$1 AND key=$2 AND expires_at>$3',
        [namespace, key, new Date(nowMs)], entry);
    },
    async consume(key, nowMs) {
      check(key, KEY); instant(nowMs);
      return query('DELETE FROM bb_auth.entries WHERE namespace=$1 AND key=$2 AND expires_at>$3 RETURNING payload,expires_at',
        [namespace, key, new Date(nowMs)], entry);
    },
    async remove(key) {
      check(key, KEY);
      return query('DELETE FROM bb_auth.entries WHERE namespace=$1 AND key=$2 RETURNING key', [namespace, key], boolean);
    },
    async takeRateLimit(key, nowMs, windowMs, limit) {
      check(key, /^rate:[0-9a-f]{64}$/); instant(nowMs);
      if (!Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > 900_000
          || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) invalid();
      const expiresAtMs = instant(nowMs + windowMs);
      return query(`INSERT INTO bb_auth.entries AS target(namespace,key,payload,expires_at)
        VALUES($1,$2,'1'::jsonb,$4) ON CONFLICT(namespace,key) DO UPDATE SET
          payload=to_jsonb(CASE WHEN target.expires_at<=$3 THEN 1 ELSE ${RATE_COUNTER}+1 END),
          expires_at=CASE WHEN target.expires_at<=$3 THEN $4 ELSE target.expires_at END
        WHERE ${RATE_COUNTER} IS NOT NULL AND (target.expires_at<=$3 OR ${RATE_COUNTER}<$5)
        RETURNING key`, [namespace, key, new Date(nowMs), new Date(expiresAtMs), limit], boolean);
    },
    async putSession(record) {
      const r = sessionRecord(record);
      return query(`INSERT INTO bb_auth.sessions(namespace,key,entra_tenant_id,entra_object_id,csrf_hash,created_at,last_seen_at,expires_at,reauth_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(namespace,key) DO NOTHING RETURNING key`,
      [namespace, r.key, r.entraTenantId, r.entraObjectId, r.csrfHash, new Date(r.createdAtMs), new Date(r.lastSeenAtMs),
        new Date(r.expiresAtMs), new Date(r.reauthAtMs)], boolean);
    },
    async readAndTouchSession(key, nowMs, idleMs) {
      check(key, HASH); instant(nowMs);
      if (!Number.isSafeInteger(idleMs) || idleMs <= 0 || idleMs > 86_400_000) invalid();
      return query(`UPDATE bb_auth.sessions SET last_seen_at=$3 WHERE namespace=$1 AND key=$2
        AND created_at<=$3 AND last_seen_at<=$3 AND expires_at>$3 AND reauth_at>$3
        AND last_seen_at + ($4::double precision * interval '1 millisecond') > $3 RETURNING ${SESSION_COLUMNS}`,
      [namespace, key, new Date(nowMs), idleMs], result => {
        if (result.rowCount === 0) return null;
        if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error();
        return fromRow(result.rows[0]);
      });
    },
    async deleteSession(key) {
      check(key, HASH);
      return query('DELETE FROM bb_auth.sessions WHERE namespace=$1 AND key=$2 RETURNING key', [namespace, key], boolean);
    },
    async deleteIdentitySessions({ entraTenantId, entraObjectId } = {}) {
      check(entraTenantId, UUID); check(entraObjectId, UUID);
      return query('DELETE FROM bb_auth.sessions WHERE namespace=$1 AND entra_tenant_id=$2 AND entra_object_id=$3 RETURNING key',
        [namespace, entraTenantId.toLowerCase(), entraObjectId.toLowerCase()], result => result.rowCount);
    },
    async prune(nowMs) {
      instant(nowMs);
      return query(`WITH removed_entries AS (DELETE FROM bb_auth.entries WHERE namespace=$1 AND expires_at<=$2 RETURNING key),
        removed_sessions AS (DELETE FROM bb_auth.sessions WHERE namespace=$1 AND LEAST(expires_at,reauth_at)<=$2 RETURNING key)
        SELECT (SELECT count(*)::integer FROM removed_entries) AS entries,
          (SELECT count(*)::integer FROM removed_sessions) AS sessions`, [namespace, new Date(nowMs)], result => {
        const row = result.rows[0];
        if (result.rowCount !== 1 || !Number.isInteger(row?.entries) || row.entries < 0
            || !Number.isInteger(row?.sessions) || row.sessions < 0) throw new Error();
        return { entries: row.entries, sessions: row.sessions };
      });
    },
  });
}
