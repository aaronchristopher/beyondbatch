import { randomUUID } from 'node:crypto';

/** PostgreSQL repository for EXISTING, enrolled folder checkpoints only.
 * Inject a pg-compatible pool; this module does not install pg, connect by itself,
 * enroll mailboxes, grant access, fetch Graph, encrypt cursors, or send messages.
 * The caller must authenticate/authorize the worker and supply a trusted tenant.
 */
export class CheckpointError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? {cause} : undefined);
    this.name = 'CheckpointError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BIGINT = 9223372036854775807n;
const COLUMNS = `id, tenant_id, mailbox_id, graph_folder_id, folder_kind,
  delta_cursor_ciphertext, cursor_generation, cursor_state, last_success_at,
  last_full_recovery_at, coverage_from, coverage_through, lease_owner,
  lease_until, last_error_code, row_version`;

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
  return value.toLowerCase();
}
function boundedText(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}
function decimal(value, field) {
  if (typeof value === 'bigint') value = String(value);
  else if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > MAX_BIGINT) {
    throw new TypeError(`${field} must be a nonnegative PostgreSQL bigint`);
  }
  return value;
}
function seconds(value = 60) {
  if (!Number.isSafeInteger(value) || value < 5 || value > 300) throw new TypeError('leaseSeconds must be between 5 and 300');
  return value;
}
function instant(value, field) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new TypeError(`${field} must be a UTC ISO-8601 instant`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new TypeError(`${field} is invalid`);
  }
  return parsed.toISOString();
}
function scope(input) {
  return Object.freeze({
    tenantId: uuid(input?.tenantId, 'tenantId'),
    mailboxId: uuid(input?.mailboxId, 'mailboxId'),
    graphFolderId: boundedText(input?.graphFolderId, 'graphFolderId', 2048),
  });
}
function leaseSnapshot(input) {
  return Object.freeze({...scope(input),
    checkpointId: uuid(input?.checkpointId, 'checkpointId'),
    ownerToken: boundedText(input?.ownerToken, 'ownerToken', 180),
    rowVersion: decimal(input?.rowVersion, 'rowVersion'),
    cursorGeneration: decimal(input?.cursorGeneration, 'cursorGeneration'),
  });
}
function leaseBindings(lease) {
  return [lease.tenantId, lease.mailboxId, lease.graphFolderId, lease.checkpointId,
    lease.ownerToken, lease.rowVersion, lease.cursorGeneration];
}
const FENCE = `tenant_id = $1::uuid AND mailbox_id = $2::uuid
  AND graph_folder_id = $3 AND id = $4::uuid AND lease_owner = $5
  AND row_version = $6::bigint AND cursor_generation = $7::bigint`;

function rowDescriptor(row, expected) {
  if (!row || uuid(row.tenant_id, 'row.tenant_id') !== expected.tenantId
      || uuid(row.mailbox_id, 'row.mailbox_id') !== expected.mailboxId
      || row.graph_folder_id !== expected.graphFolderId
      || (expected.checkpointId && uuid(row.id, 'row.id') !== expected.checkpointId)) {
    throw new CheckpointError('SCOPE_MISMATCH', 'Database checkpoint scope mismatch');
  }
  if (row.delta_cursor_ciphertext != null && !Buffer.isBuffer(row.delta_cursor_ciphertext)) {
    throw new CheckpointError('INVALID_DB_RESULT', 'Database cursor must be bytea');
  }
  return Object.freeze({
    ...scope(expected), checkpointId: uuid(row.id, 'row.id'), folderKind: row.folder_kind,
    rowVersion: decimal(row.row_version, 'row.row_version'),
    cursorGeneration: decimal(row.cursor_generation, 'row.cursor_generation'),
    cursorState: row.cursor_state,
    cursorCiphertext: row.delta_cursor_ciphertext == null ? null : Buffer.from(row.delta_cursor_ciphertext),
    ownerToken: row.lease_owner ?? null,
    leaseUntil: row.lease_until == null ? null : instant(row.lease_until, 'row.lease_until'),
    lastSuccessAt: row.last_success_at == null ? null : instant(row.last_success_at, 'row.last_success_at'),
    lastFullRecoveryAt: row.last_full_recovery_at == null ? null : instant(row.last_full_recovery_at, 'row.last_full_recovery_at'),
    coverageFrom: row.coverage_from == null ? null : instant(row.coverage_from, 'row.coverage_from'),
    coverageThrough: row.coverage_through == null ? null : instant(row.coverage_through, 'row.coverage_through'),
    lastErrorCode: row.last_error_code ?? null,
  });
}

function folderAllowed(row, approval) {
  const allowed = row.folder_kind === 'inbox' ? approval.include_incoming === true
    : row.folder_kind === 'sent' ? approval.include_sent === true
    : ['custom', 'deleted'].includes(row.folder_kind)
      && approval.include_incoming === true && approval.include_sent === true;
  if (!allowed) throw new CheckpointError('FOLDER_NOT_APPROVED', 'Folder direction is outside the mailbox approval');
}
function stale() { return new CheckpointError('LEASE_LOST', 'Checkpoint lease expired, changed or does not match this scope'); }

export class PostgresCheckpointRepository {
  constructor(pool, {entraClientId} = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool = pool;
    this.entraClientId = uuid(entraClientId, 'entraClientId');
  }

  async #transaction(boundScope, work) {
    const client = await this.pool.connect();
    let began = false;
    let commitAttempted = false;
    let discardError;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [boundScope.tenantId]);
      await client.query(`SET LOCAL TIME ZONE 'UTC'`);
      // Same lock order for every method: approved tenant/mailbox, then checkpoint.
      // FOR SHARE prevents revocation/tenant disable from racing this short commit.
      const {rows} = await client.query(`/* bb.checkpoint.approval */
        SELECT m.include_incoming, m.include_sent, m.history_start_at
        FROM bb.mailbox_approvals m JOIN bb.tenants t ON t.id = m.tenant_id
        WHERE m.tenant_id = $1::uuid AND m.id = $2::uuid
          AND m.entra_client_id = $3::uuid AND m.status = 'approved'
          AND t.status IN ('pilot', 'active')
        FOR SHARE OF m, t`, [boundScope.tenantId, boundScope.mailboxId, this.entraClientId]);
      if (rows.length !== 1) throw new CheckpointError('SCOPE_NOT_APPROVED', 'Mailbox, app and tenant approval is required');
      const result = await work(client, rows[0]);
      commitAttempted = true;
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { discardError = rollbackError; }
      } else {
        // A failed BEGIN can indicate a broken connection. Do not return it to the pool.
        discardError = error;
      }
      if (commitAttempted) {
        discardError = error;
        throw new CheckpointError('COMMIT_OUTCOME_UNKNOWN', 'Commit outcome is unknown; reconcile before retrying the page', error);
      }
      throw error;
    } finally {
      client.release(discardError);
    }
  }

  /** Returns a newly fenced lease, or null if missing, blocked or already leased.
   * The cryptographically random owner token prevents worker-name reuse from
   * reviving an old lease. PostgreSQL's clock decides expiry, never the caller.
   */
  async acquire(input) {
    const bound = scope(input);
    const leaseSeconds = seconds(input?.leaseSeconds);
    const workerId = boundedText(input?.workerId, 'workerId', 100);
    const ownerToken = `${workerId}:${randomUUID()}`;
    return this.#transaction(bound, async (client, approval) => {
      const result = await client.query(`/* bb.checkpoint.acquire */
        UPDATE bb.sync_folder_checkpoints
        SET lease_owner = $4, lease_until = clock_timestamp() + $5::integer * interval '1 second',
            row_version = row_version + 1
        WHERE tenant_id = $1::uuid AND mailbox_id = $2::uuid AND graph_folder_id = $3
          AND cursor_state <> 'blocked'
          AND (lease_until IS NULL OR lease_until <= clock_timestamp())
        RETURNING ${COLUMNS}`, [bound.tenantId, bound.mailboxId, bound.graphFolderId, ownerToken, leaseSeconds]);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new CheckpointError('INVALID_DB_RESULT', 'Expected one checkpoint');
      folderAllowed(result.rows[0], approval);
      return rowDescriptor(result.rows[0], bound);
    });
  }

  async #lock(client, lease, approval, allowExpired = false) {
    const result = await client.query(`/* bb.checkpoint.lock */
      SELECT ${COLUMNS}, clock_timestamp() AS observed_db_now FROM bb.sync_folder_checkpoints
      WHERE ${FENCE} ${allowExpired ? '' : "AND cursor_state <> 'blocked' AND lease_until > clock_timestamp()"}
      FOR UPDATE`, leaseBindings(lease));
    if (result.rows.length !== 1) throw stale();
    folderAllowed(result.rows[0], approval);
    rowDescriptor(result.rows[0], lease);
    return result.rows[0];
  }

  async renew(input, leaseSeconds = 60) {
    const lease = leaseSnapshot(input);
    const duration = seconds(leaseSeconds);
    return this.#transaction(lease, async (client, approval) => {
      await this.#lock(client, lease, approval);
      const result = await client.query(`/* bb.checkpoint.renew */
        UPDATE bb.sync_folder_checkpoints
        SET lease_until = clock_timestamp() + $8::integer * interval '1 second', row_version = row_version + 1
        WHERE ${FENCE} AND lease_until > clock_timestamp()
        RETURNING ${COLUMNS}`, [...leaseBindings(lease), duration]);
      if (result.rows.length !== 1) throw stale();
      return rowDescriptor(result.rows[0], lease);
    });
  }

  /** Advance only in the SAME transaction as real page persistence.
   * persistPage is trusted server code, not supplied by an HTTP client. It must
   * persist/reuse each page item OR durable processing job with audit/outbox refs
   * on this client, with stable source dedupe keys. No network/model calls here.
   * This module supplies the transaction seam; it does not implement that writer.
   */
  async commitPage(input, page, persistPage) {
    const lease = leaseSnapshot(input);
    if (typeof persistPage !== 'function') throw new TypeError('A same-transaction persistPage callback is required');
    if (!page || !Buffer.isBuffer(page.cursorCiphertext) || page.cursorCiphertext.length < 1 || page.cursorCiphertext.length > 65536) {
      throw new TypeError('cursorCiphertext must be a nonempty encrypted Buffer of at most 64 KiB');
    }
    const cursorCiphertext = Buffer.from(page.cursorCiphertext);
    if (!['paging', 'current'].includes(page.cursorState)) throw new TypeError('cursorState must be paging or current');
    const cursorState = page.cursorState;
    if (page.fullRecoveryCompleted !== undefined && typeof page.fullRecoveryCompleted !== 'boolean') throw new TypeError('fullRecoveryCompleted must be boolean');
    const fullRecoveryCompleted = page.fullRecoveryCompleted === true;
    let coverageFrom = null;
    let coverageThrough = null;
    if (cursorState === 'current') {
      coverageFrom = instant(page.coverageFrom, 'coverageFrom');
      coverageThrough = instant(page.coverageThrough, 'coverageThrough');
      if (coverageThrough < coverageFrom) throw new TypeError('Coverage interval is reversed');
    } else if (page.coverageFrom != null || page.coverageThrough != null || fullRecoveryCompleted) {
      throw new TypeError('Only a terminal current cursor can establish coverage or completed recovery');
    }
    return this.#transaction(lease, async (client, approval) => {
      const current = await this.#lock(client, lease, approval);
      if (cursorState === 'current') {
        if (coverageThrough > instant(current.observed_db_now, 'database observation time')) {
          throw new CheckpointError('FUTURE_COVERAGE', 'Coverage cannot extend beyond the database observation time');
        }
        if (coverageFrom < instant(approval.history_start_at, 'approved history_start_at')) {
          throw new CheckpointError('HISTORY_NOT_APPROVED', 'Coverage starts before approved mailbox history');
        }
        if (current.coverage_through != null) {
          const oldThrough = instant(current.coverage_through, 'current coverage_through');
          if (coverageFrom > oldThrough || coverageThrough < oldThrough) {
            throw new CheckpointError('COVERAGE_GAP', 'Coverage must be contiguous and must not move backwards');
          }
        }
      }
      // Do not expose mutable lease/cursor objects or the whole input page here.
      await persistPage(client, Object.freeze({...lease}));
      const result = await client.query(`/* bb.checkpoint.commit_page */
        UPDATE bb.sync_folder_checkpoints
        SET delta_cursor_ciphertext = $8::bytea, cursor_state = $9,
            coverage_from = CASE WHEN $9 = 'current' THEN
              LEAST(coverage_from, $10::timestamptz) ELSE coverage_from END,
            coverage_through = CASE WHEN $9 = 'current' THEN $11::timestamptz ELSE coverage_through END,
            last_success_at = CASE WHEN $9 = 'current' THEN clock_timestamp() ELSE last_success_at END,
            last_full_recovery_at = CASE WHEN $12::boolean THEN clock_timestamp() ELSE last_full_recovery_at END,
            last_error_code = NULL, row_version = row_version + 1
        WHERE ${FENCE} AND lease_until > clock_timestamp()
        RETURNING ${COLUMNS}`, [...leaseBindings(lease), cursorCiphertext, cursorState,
          coverageFrom, coverageThrough, fullRecoveryCompleted]);
      if (result.rows.length !== 1) throw stale();
      return rowDescriptor(result.rows[0], lease);
    });
  }

  /** Invalid delta token: fence previous workers, discard cursor and end this
   * lease. Historical coverage stays historical; state says recovery is needed.
   * The recovery coordinator must acquire a new lease before any backfill.
   */
  async reset(input, errorCode) {
    const lease = leaseSnapshot(input);
    if (typeof errorCode !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(errorCode)) {
      throw new TypeError('errorCode must be a bounded symbolic code, never a Graph URL or response body');
    }
    return this.#transaction(lease, async (client, approval) => {
      await this.#lock(client, lease, approval);
      const result = await client.query(`/* bb.checkpoint.reset */
        UPDATE bb.sync_folder_checkpoints
        SET delta_cursor_ciphertext = NULL, cursor_generation = cursor_generation + 1,
            cursor_state = 'reset_required', lease_owner = NULL, lease_until = NULL,
            last_error_code = $8, row_version = row_version + 1
        WHERE ${FENCE} AND lease_until > clock_timestamp()
        RETURNING ${COLUMNS}`, [...leaseBindings(lease), errorCode]);
      if (result.rows.length !== 1) throw stale();
      return rowDescriptor(result.rows[0], lease);
    });
  }

  async release(input) {
    const lease = leaseSnapshot(input);
    return this.#transaction(lease, async (client, approval) => {
      // An expired lease can be released only if no new claimant changed its fence.
      await this.#lock(client, lease, approval, true);
      const result = await client.query(`/* bb.checkpoint.release */
        UPDATE bb.sync_folder_checkpoints
        SET lease_owner = NULL, lease_until = NULL, row_version = row_version + 1
        WHERE ${FENCE}
        RETURNING ${COLUMNS}`, leaseBindings(lease));
      if (result.rows.length !== 1) throw stale();
      return rowDescriptor(result.rows[0], lease);
    });
  }
}
