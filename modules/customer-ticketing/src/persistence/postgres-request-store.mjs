/**
 * Normalized PostgreSQL adapter for db/001_core.sql, requirements version 1.
 * The injected pool implements pg Pool.connect(); every operation pins a client.
 * This is a trusted repository boundary, NOT end-user authorization or enrollment.
 * It never creates roles, ingests mail, calls a model, or sends messages.
 *
 * new PostgresRequestStore(pool, {actorId, actorKind: 'worker'|'human'})
 * createRequest({tenantId,idempotencyKey,input,evidence:{canonicalEmailId,observedAt?}})
 *   -> {tenantId,version:0,request}; input is the domain createRequest input.
 * read(tenantId,requestId) -> {tenantId,version,request}|null.
 * transaction(callback) implements request-transaction.mjs's repository contract.
 * All persisted IDs must be lowercase UUIDs. Logical obligation IDs and receipt
 * keys are strings. Origin and canonical events live in the immutable audit log;
 * read replays that ledger instead of trusting mutable projection columns.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequest as createDomainRequest, replayRequest } from '../domain/response-clock.mjs';

const CREATE_SCOPE = 'request-create:v1';
const KINDS = { initial: 'initial_request', followup: 'customer_follow_up',
  recurring: 'recurring_update', reopened: 'reopened_request' };
const ORIGIN_FIELDS = ['id', 'customerId', 'subject', 'ownerId', 'receivedAt', 'evidenceId'];
function uuid(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase UUID`);
  }
  return value;
}
function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be nonempty`);
  return value;
}
function stable(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  throw new TypeError('command must contain only JSON values');
}
function fingerprint(value) { return createHash('sha256').update(stable(value)).digest('hex'); }
function timestamp(value) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function safeVersion(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('unsupported request version');
  return number;
}
function origin(request) { return Object.fromEntries(ORIGIN_FIELDS.map(key => [key, request[key]])); }
function same(left, right) { return stable(left) === stable(right); }

export class PostgresRequestStore {
  constructor(pool, { actorId, actorKind = 'worker' } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('a pg-compatible pool is required');
    this.pool = pool;
    this.actorId = uuid(actorId, 'actorId');
    if (!['worker', 'human'].includes(actorKind)) throw new TypeError('actorKind must be worker or human');
    this.actorKind = actorKind;
  }

  async transaction(work) {
    if (typeof work !== 'function') throw new TypeError('transaction callback is required');
    const client = await this.pool.connect();
    let begun = false, beginning = true, committing = false, discard = false;
    try {
      await client.query('BEGIN'); begun = true; beginning = false;
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const tx = new RequestTransaction(client, this);
      const result = await work(tx);
      tx.assertComplete();
      committing = true;
      await client.query('COMMIT');
      begun = false;
      return result;
    } catch (error) {
      // A failed COMMIT can have an unknown outcome. Never retry the command here;
      // the caller retries its same idempotency key on a fresh connection.
      discard = beginning || committing;
      if (begun) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
      }
      throw error;
    } finally {
      client.release(discard ? new Error('discard uncertain transaction connection') : undefined);
    }
  }

  async read(tenantId, requestId) {
    uuid(tenantId, 'tenantId'); uuid(requestId, 'requestId');
    // A shared aggregate lock keeps the row version and audit scan coherent at
    // READ COMMITTED, while other readers can proceed concurrently.
    return this.transaction(tx => tx.loadRequest(tenantId, requestId, 'SHARE'));
  }

  async createRequest(command) {
    const frozen = JSON.parse(stable(command)); // capture caller input before awaiting
    const { tenantId, idempotencyKey, input, evidence } = frozen;
    uuid(tenantId, 'tenantId'); nonempty(idempotencyKey, 'idempotencyKey');
    const request = createDomainRequest(input);
    for (const field of ['id', 'customerId', 'evidenceId']) uuid(request[field], `input.${field}`);
    if (request.ownerId !== null) uuid(request.ownerId, 'input.ownerId');
    if (request.subject.length > 500) throw new TypeError('input.subject exceeds 500 characters');
    uuid(evidence?.canonicalEmailId, 'evidence.canonicalEmailId');
    if (evidence.observedAt !== undefined && (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(evidence.observedAt)
        || !Number.isFinite(Date.parse(evidence.observedAt)))) throw new TypeError('evidence.observedAt must be an explicit-offset timestamp');
    const hash = fingerprint(frozen);
    return this.transaction(async tx => {
      await tx.lockIdempotency(tenantId, CREATE_SCOPE, idempotencyKey);
      const receipt = await tx.getReceipt(tenantId, CREATE_SCOPE, idempotencyKey);
      if (receipt) {
        if (receipt.fingerprint !== hash) throw new Error('idempotency key reused with different command');
        return structuredClone(receipt.result);
      }
      const customer = await tx.client.query(`SELECT identity_status FROM bb.customers
        WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [tenantId, request.customerId]);
      if (customer.rows[0]?.identity_status !== 'approved') throw new Error('approved customer required');
      if (request.ownerId !== null) {
        const owner = await tx.client.query(`SELECT status,principal_type FROM bb.principals
          WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [tenantId, request.ownerId]);
        if (owner.rows[0]?.status !== 'active' || owner.rows[0]?.principal_type !== 'user') {
          throw new Error('active user owner required');
        }
      }
      const emailResult = await tx.client.query(`SELECT direction,classification,sensitivity,first_observed_at
        FROM bb.canonical_emails WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [tenantId, evidence.canonicalEmailId]);
      const email = emailResult.rows[0];
      if (!email || email.direction !== 'incoming' || email.classification !== 'request' || email.sensitivity !== 'operational') {
        throw new Error('operational incoming customer request email required');
      }
      const observedAt = timestamp(evidence.observedAt ?? email.first_observed_at);
      await tx.client.query(`INSERT INTO bb.requests
        (tenant_id,id,customer_id,accountable_owner_id,title,request_text,category,state,
         publication_state,sensitivity,first_request_at,first_observed_at)
        VALUES ($1,$2,$3,$4,$5,$5,'uncategorized',$6,'approved','operational',$7,$8)`,
      [tenantId, request.id, request.customerId, request.ownerId, request.subject, request.status, request.receivedAt, observedAt]);
      await tx.client.query(`INSERT INTO bb.request_evidence
        (tenant_id,id,request_id,canonical_email_id,evidence_kind,observed_at,recorded_by,
         requirements_version,assessment_version,rationale)
        VALUES ($1,$2,$3,$4,'customer_request',$5,$6,1,'request-create:v1',
         'Accepted request source supplied by the trusted request-creation boundary')`,
      [tenantId, request.evidenceId, request.id, evidence.canonicalEmailId, observedAt, this.actorId]);
      const auditId = randomUUID();
      await tx.insertAudit(tenantId, request.id, 0, auditId, 'request_created', request.evidenceId,
        { origin: origin(request) }, request.receivedAt);
      await tx.writeObligations(tenantId, request, request.responseObligations);
      await tx.enqueue(tenantId, { eventId: auditId, requestId: request.id, version: 0,
        kind: 'refresh_projection', dedupeKey: `request:${request.id}:version:0` });
      const result = { tenantId, version: 0, request };
      await tx.saveReceipt(tenantId, CREATE_SCOPE, idempotencyKey, { fingerprint: hash, result });
      return structuredClone(result);
    });
  }
}

/** Trusted server helper. Caller owns a REPEATABLE READ READ ONLY transaction,
 * tenant binding and resource authorization; never expose the client to a user.
 * Reuses the canonical ledger/evidence checks without locks or new transactions.
 */
export async function readRequestSnapshot(client, { tenantId, requestId, actorId } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('transaction client required');
  uuid(tenantId, 'tenantId'); uuid(requestId, 'requestId'); uuid(actorId, 'actorId');
  const tx = new RequestTransaction(client, { actorId, actorKind: 'human' }, { readOnly: true });
  return tx.loadRequest(tenantId, requestId, 'SNAPSHOT');
}

class RequestTransaction {
  constructor(client, store, { readOnly = false } = {}) {
    this.client = client; this.store = store; this.tenantId = null;
    this.readOnly = readOnly;
    this.locked = new Map(); this.staged = new Map(); this.receiptLocks = new Set();
  }
  async bind(tenantId) {
    uuid(tenantId, 'tenantId');
    if (this.tenantId && this.tenantId !== tenantId) throw new Error('transaction tenant cannot change');
    if (this.tenantId) return;
    await this.client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const result = await this.client.query(`SELECT p.status,p.principal_type,t.status AS tenant_status
      FROM bb.principals p JOIN bb.tenants t ON t.id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.id=$2${this.readOnly ? '' : ' FOR SHARE OF p,t'}`, [tenantId, this.store.actorId]);
    const actor = result.rows[0];
    if (!actor || actor.status !== 'active' || !['pilot', 'active'].includes(actor.tenant_status)
        || actor.principal_type !== (this.store.actorKind === 'human' ? 'user' : 'service')) {
      throw new Error('active trusted actor and enabled tenant required');
    }
    this.tenantId = tenantId;
  }
  assertComplete() {
    if (this.staged.size) throw new Error('incomplete request transaction');
  }
  async lockIdempotency(tenantId, scope, key) {
    await this.bind(tenantId); nonempty(scope, 'scope'); nonempty(key, 'idempotencyKey');
    const lock = createHash('sha256').update(stable([tenantId, scope, key])).digest().readBigInt64BE(0).toString();
    await this.client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock]);
    this.receiptLocks.add(stable([scope, key]));
  }
  async getReceipt(tenantId, scope, key) {
    await this.bind(tenantId);
    if (!this.receiptLocks.has(stable([scope, key]))) throw new Error('idempotency lock required');
    const result = await this.client.query(`SELECT request_sha256,state,response_projection
      FROM bb.idempotency_records WHERE tenant_id=$1 AND operation_scope=$2 AND idempotency_key=$3`, [tenantId, scope, key]);
    if (!result.rows.length) return null;
    if (result.rows[0].state !== 'completed') throw new Error('incomplete idempotency receipt');
    return { fingerprint: result.rows[0].request_sha256, result: result.rows[0].response_projection };
  }
  async loadRequest(tenantId, requestId, mode = 'UPDATE') {
    await this.bind(tenantId); uuid(requestId, 'requestId');
    if (!['SHARE', 'UPDATE'].includes(mode) && !(mode === 'SNAPSHOT' && this.readOnly)) throw new Error('invalid request lock');
    const result = await this.client.query(`SELECT * FROM bb.requests
      WHERE tenant_id=$1 AND id=$2${mode === 'SNAPSHOT' ? '' : ` FOR ${mode}`}`, [tenantId, requestId]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.current_requirements_version !== 1) throw new Error('only requirements version 1 is supported');
    if (row.sensitivity !== 'operational' || row.publication_state !== 'approved') throw new Error('request is not approved operational data');
    const version = safeVersion(row.row_version);
    if (this.readOnly && version > 1000) throw new Error('request snapshot history limit exceeded');
    const ledger = await this.client.query(`SELECT * FROM bb.audit_events WHERE tenant_id=$1
      AND aggregate_type='request' AND aggregate_id=$2 ORDER BY aggregate_version${this.readOnly ? ' LIMIT 1002' : ''}`, [tenantId, requestId]);
    if (ledger.rows.length !== version + 1) throw new Error('request audit ledger is incomplete');
    for (let i = 0; i < ledger.rows.length; i++) {
      if (safeVersion(ledger.rows[i].aggregate_version) !== i || ledger.rows[i].request_id !== requestId) {
        throw new Error('request audit ledger is inconsistent');
      }
    }
    const first = ledger.rows[0];
    if (first.event_type !== 'request_created' || !first.payload.origin) throw new Error('immutable request origin missing');
    const base = first.payload.origin;
    if (base.id !== requestId || base.customerId !== row.customer_id || base.ownerId !== row.accountable_owner_id
        || base.subject !== row.title || base.receivedAt !== timestamp(row.first_request_at)
        || base.evidenceId !== first.source_evidence_id) throw new Error('immutable request origin mismatch');
    const events = ledger.rows.slice(1).map(audit => {
      const event = audit.payload;
      if (event.id !== audit.id || event.type !== audit.event_type || event.evidenceId !== audit.source_evidence_id
          || event.occurredAt !== timestamp(audit.occurred_at)
          || (event.actor && (event.actor.id !== audit.actor_principal_id || audit.actor_kind !== 'human'))) {
        throw new Error('canonical request event mismatch');
      }
      return event;
    });
    const request = replayRequest({ ...base, events });
    // SQL foreign keys cover source_evidence_id, but JSON recipient/closure refs
    // need an explicit same-request check too, including on ledger replay.
    await this.validateEvidence(tenantId, requestId, base.evidenceId);
    for (const event of request.events) await this.validateEventEvidence(tenantId, requestId, event, false);
    const envelope = { tenantId, version, request };
    if (mode === 'UPDATE') this.locked.set(requestId, { envelope, row });
    return envelope;
  }
  lockRequest(tenantId, requestId) { return this.loadRequest(tenantId, requestId, 'UPDATE'); }
  async validateEvidence(tenantId, requestId, evidenceId) {
    uuid(evidenceId, 'evidenceId');
    const result = await this.client.query(`SELECT e.*,c.direction,c.classification,c.sensitivity AS email_sensitivity,c.sent_at
      FROM bb.request_evidence e LEFT JOIN bb.canonical_emails c
      ON c.tenant_id=e.tenant_id AND c.id=e.canonical_email_id
      WHERE e.tenant_id=$1 AND e.request_id=$2 AND e.id=$3`, [tenantId, requestId, evidenceId]);
    const evidence = result.rows[0];
    if (!evidence || evidence.requirements_version !== 1) throw new Error('same-request requirements-version-1 evidence required');
    if (evidence.canonical_email_id && evidence.email_sensitivity !== 'operational') throw new Error('operational email evidence required');
    return evidence;
  }
  async validateEventEvidence(tenantId, requestId, event, newWrite) {
    uuid(event.id, 'event.id');
    const source = await this.validateEvidence(tenantId, requestId, event.evidenceId);
    if (['customer_followup', 'reopened'].includes(event.type)
        && (source.evidence_kind !== 'customer_request' || source.direction !== 'incoming' || source.classification !== 'request')) {
      throw new Error('inbound customer request evidence required');
    }
    if (event.type === 'response_sent') {
      await this.validateEvidence(tenantId, requestId, event.recipientEvidenceId);
      if (source.evidence_kind !== 'outbound_answer' || !source.meaningful_for_request || source.direction !== 'outgoing'
          || source.classification !== 'meaningful_response' || !source.sent_at || timestamp(source.sent_at) !== event.sentAt) {
        throw new Error('verified sent meaningful outbound evidence required');
      }
    }
    if (event.actor) {
      uuid(event.actor.id, 'event.actor.id');
      if (newWrite && (this.store.actorKind !== 'human' || event.actor.id !== this.store.actorId)) {
        throw new Error('human event actor must match the trusted human actor');
      }
    }
    if (event.type === 'waiting_customer') uuid(event.responseEventId, 'event.responseEventId');
    if (event.type === 'resolution_confirmed') {
      const closure = await this.validateEvidence(tenantId, requestId, event.closureEvidenceId);
      if (closure.evidence_kind !== 'closure_confirmation' || closure.human_confirmed_by !== event.actor.id
          || !closure.human_confirmed_at || timestamp(closure.human_confirmed_at) !== event.occurredAt) {
        throw new Error('matching human closure confirmation evidence required');
      }
    }
  }
  async saveRequest(tenantId, requestId, expectedVersion, version, request) {
    await this.bind(tenantId);
    const current = this.locked.get(requestId);
    if (!current || current.envelope.version !== expectedVersion || version !== expectedVersion + 1) throw new Error('request version conflict');
    if (this.staged.has(requestId)) throw new Error('request already staged');
    const canonical = replayRequest(request);
    if (!same(origin(canonical), origin(current.envelope.request)) || !same(canonical, request)) throw new Error('request origin or replay mismatch');
    this.staged.set(requestId, { request: canonical, expectedVersion, version, event: null });
  }
  async insertAudit(tenantId, requestId, version, id, type, evidenceId, payload, occurredAt) {
    await this.client.query(`INSERT INTO bb.audit_events
      (tenant_id,id,request_id,actor_principal_id,actor_kind,event_type,aggregate_type,aggregate_id,
       aggregate_version,source_evidence_id,idempotency_key,payload,sensitivity,occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,'request',$3,$7,$8,$9,$10::jsonb,'operational',$11)`,
    [tenantId, id, requestId, this.store.actorId, this.store.actorKind, type, version, evidenceId,
      `request:${requestId}:version:${version}`, JSON.stringify(payload), occurredAt]);
  }
  async appendEvent(tenantId, requestId, version, event) {
    await this.bind(tenantId);
    const staged = this.staged.get(requestId);
    if (!staged || staged.version !== version || staged.event || !staged.request.events.some(item => same(item, event))) {
      throw new Error('staged canonical request event required');
    }
    // Human decisions use the current evidence view. They cannot be backdated
    // behind already accepted evidence: that could erase a recurring obligation
    // or retroactively suppress an answer. Delayed incoming/Sent evidence is
    // still accepted and historical decisions are replayed without this gate.
    if (['waiting_customer', 'resolution_confirmed'].includes(event.type)) {
      const prior = this.locked.get(requestId).envelope.request;
      const latest = prior.events.reduce((at, item) => item.occurredAt > at ? item.occurredAt : at, prior.receivedAt);
      if (event.occurredAt < latest) throw new Error('human decision cannot be backdated before accepted evidence');
    }
    await this.validateEventEvidence(tenantId, requestId, event, true);
    await this.insertAudit(tenantId, requestId, version, event.id, event.type, event.evidenceId, event, event.occurredAt);
    staged.event = event;
  }
  async replaceObligations(tenantId, requestId, obligations) {
    await this.bind(tenantId);
    const staged = this.staged.get(requestId);
    if (!staged?.event || !same(obligations, staged.request.responseObligations)) throw new Error('canonical obligations required');
    const { request, expectedVersion, version } = staged;
    const current = this.locked.get(requestId);
    // An open obligation cannot be written against a closed request. Clear
    // closure before reopening, then finish the aggregate after its obligations.
    if (current.row.state === 'resolved' && request.status !== 'resolved') {
      await this.client.query(`UPDATE bb.requests SET state=$3,closure_evidence_id=NULL,
        closure_confirmed_by=NULL,closure_confirmed_at=NULL,closed_requirements_version=NULL
        WHERE tenant_id=$1 AND id=$2 AND row_version=$4`, [tenantId, requestId, request.status, expectedVersion]);
    }
    await this.writeObligations(tenantId, request, obligations);
    const invalid = new Set(request.invalidatedEvents.map(item => item.eventId));
    const closure = request.status === 'resolved'
      ? request.events.filter(item => item.type === 'resolution_confirmed' && !invalid.has(item.id)).at(-1) : null;
    if (request.status === 'resolved' && !closure) throw new Error('resolved request has no verified closure event');
    const update = await this.client.query(`UPDATE bb.requests SET state=$3,last_meaningful_response_at=$4,
      closure_evidence_id=$5,closure_confirmed_by=$6,closure_confirmed_at=$7,closed_requirements_version=$8,
      row_version=$9,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND row_version=$10`,
    [tenantId, requestId, request.status, request.lastMeaningfulResponseAt, closure?.closureEvidenceId ?? null,
      closure?.actor.id ?? null, closure?.occurredAt ?? null, closure ? 1 : null, version, expectedVersion]);
    if (update.rowCount !== 1) throw new Error('request version conflict');
    this.staged.delete(requestId);
  }
  async writeObligations(tenantId, request, obligations) {
    const existing = await this.client.query(`SELECT trigger_key,id FROM bb.response_obligations
      WHERE tenant_id=$1 AND request_id=$2`, [tenantId, request.id]);
    const ids = new Map(existing.rows.map(row => [row.trigger_key, row.id]));
    const expected = new Set(obligations.map(item => item.id));
    if (existing.rows.some(row => !expected.has(row.trigger_key))) throw new Error('replay cannot erase historical obligations');
    for (const obligation of obligations) if (!ids.has(obligation.id)) ids.set(obligation.id, randomUUID());
    const events = new Map(request.events.map(event => [event.id, event]));
    for (const item of obligations) {
      const trigger = item.kind === 'initial' ? request.evidenceId : events.get(item.sourceEventId)?.evidenceId;
      const ending = item.endedByEventId ? events.get(item.endedByEventId) : null;
      const previous = item.previousObligationId ? ids.get(item.previousObligationId) : null;
      if (!KINDS[item.kind] || !trigger || (item.kind === 'recurring' && !previous)) throw new Error('invalid obligation lineage');
      const fulfilled = item.outcome === 'responded';
      const withdrawn = ['waiting_customer', 'resolved'].includes(item.outcome);
      if ((fulfilled && ending?.type !== 'response_sent') || (withdrawn && (!ending?.actor || item.kind !== 'recurring'))
          || (item.outcome !== 'pending' && !ending)) throw new Error('obligation ending event missing');
      await this.client.query(`INSERT INTO bb.response_obligations
        (tenant_id,id,request_id,trigger_kind,trigger_key,trigger_evidence_id,previous_obligation_id,
         opened_at,due_at,state,fulfilled_at,fulfilled_by_evidence_id,withdrawn_at,withdrawn_by,withdrawal_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (tenant_id,request_id,trigger_key) DO UPDATE SET
          previous_obligation_id=EXCLUDED.previous_obligation_id,state=EXCLUDED.state,
          fulfilled_at=EXCLUDED.fulfilled_at,fulfilled_by_evidence_id=EXCLUDED.fulfilled_by_evidence_id,
          withdrawn_at=EXCLUDED.withdrawn_at,withdrawn_by=EXCLUDED.withdrawn_by,
          withdrawal_reason=EXCLUDED.withdrawal_reason,row_version=bb.response_obligations.row_version+1`,
      [tenantId, ids.get(item.id), request.id, KINDS[item.kind], item.id, trigger, previous,
        item.startedAt, item.dueAt, fulfilled ? 'fulfilled' : withdrawn ? 'withdrawn' : 'open',
        fulfilled ? item.endedAt : null, fulfilled ? ending.evidenceId : null,
        withdrawn ? item.endedAt : null, withdrawn ? ending.actor.id : null,
        withdrawn ? (ending.reason ?? 'Human confirmed request resolution') : null]);
    }
  }
  async enqueue(tenantId, job) {
    await this.bind(tenantId); uuid(job.eventId, 'job.eventId'); uuid(job.requestId, 'job.requestId');
    await this.client.query(`INSERT INTO bb.outbox (tenant_id,id,event_id,job_kind,dedupe_key,payload)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [tenantId, randomUUID(), job.eventId, job.kind, job.dedupeKey, JSON.stringify(job)]);
  }
  async saveReceipt(tenantId, scope, key, receipt) {
    await this.bind(tenantId);
    if (!this.receiptLocks.has(stable([scope, key]))) throw new Error('idempotency lock required');
    const requestId = uuid(receipt.result.request.id, 'receipt.request.id');
    const version = safeVersion(receipt.result.version);
    const audit = await this.client.query(`SELECT id FROM bb.audit_events WHERE tenant_id=$1
      AND aggregate_type='request' AND aggregate_id=$2 AND aggregate_version=$3`, [tenantId, requestId, version]);
    if (audit.rows.length !== 1) throw new Error('receipt requires committed aggregate event');
    await this.client.query(`INSERT INTO bb.idempotency_records
      (tenant_id,operation_scope,idempotency_key,request_sha256,state,result_event_id,response_status,response_projection,expires_at)
      VALUES ($1,$2,$3,$4,'completed',$5,200,$6::jsonb,now()+interval '30 days')`,
    [tenantId, scope, key, receipt.fingerprint, audit.rows[0].id, JSON.stringify(receipt.result)]);
  }
}
