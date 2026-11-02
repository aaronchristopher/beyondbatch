/**
 * Pure 24-elapsed-hour response clock; it never sends mail or verifies identity.
 *
 * Request shape: { id, customerId, subject, ownerId, receivedAt, evidenceId,
 *   status: 'open'|'needs_review'|'waiting_on_customer'|'resolved', owesUpdate, dueAt,
 *   lastMeaningfulResponseAt, lastCustomerMessageAt, resolvedAt,
 *   events: readonly canonical events[], responseObligations: readonly[] }.
 * Each obligation retains its original start/deadline and outcome even when the
 * active clock stops. endedByEventId names its exact ending evidence event;
 * previousObligationId links recurring clocks to the last obligation created in
 * source-time replay order (lineage only, never the source of a new deadline).
 * Response and resolution are deliberately separate facts.
 *
 * Events have id, type, evidenceId and an explicit-offset ISO timestamp.
 * Use receivedAt for customer_followup/reopened; sentAt for response_sent;
 * occurredAt for internal_update/waiting_customer/resolution_confirmed.
 * occurredAt is also accepted as the timestamp alias for incoming/sent events.
 * If both timestamp fields are supplied, they must identify the same instant.
 *
 * response_sent requires meaningful, customerFacing, recipientVerified === true
 * and recipientEvidenceId. It fulfills inbound obligations only when explicitly
 * listed in addressedObligationIds, or coversAllOutstandingAsks is verified true.
 * Unknown/partial coverage never extends an unanswered inbound deadline.
 * A verified all-asks response snapshots known inbound obligation IDs internally;
 * late-discovered earlier asks are never silently added to its coverage scope.
 * Optional messageKind/deliveryState/direction, if
 * supplied, must be response/sent/outbound. These are VERIFIED facts supplied by
 * the trusted application boundary, never unchecked model or email assertions.
 * resolution_confirmed requires actor:{id,type:'human'}, closureEvidenceId, and
 * prior verified responses covering every inbound obligation. Closure can retire
 * only the recurring progress clock; it cannot waive an unanswered customer ask.
 * waiting_customer requires the same human actor, reason and responseEventId.
 * The linked latest response must have requestsCustomerInput=true and
 * coversAllOutstandingAsks=true, with no unanswered inbound obligation.
 * ownerId may be null for an assignment-review candidate; its clock still runs.
 * All events require evidenceId; caller authorization is outside this module.
 *
 * Replaying the immutable event ledger by actual event time makes delayed source
 * evidence safe. The earliest pending obligation controls the current deadline.
 * Reopened is explicit and valid only after a resolved event. An unmatched ask
 * belongs in review; this module does not decide whether mail belongs to a request.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TYPES = new Set(['customer_followup', 'internal_update', 'response_sent',
  'resolution_confirmed', 'reopened', 'waiting_customer']);
const TIME_FIELDS = {
  customer_followup: 'receivedAt', reopened: 'receivedAt', response_sent: 'sentAt',
  internal_update: 'occurredAt', resolution_confirmed: 'occurredAt', waiting_customer: 'occurredAt',
};
// At identical timestamps, an inbound ask comes after a reply: never assume a
// simultaneous response already addressed that ask. ID breaks remaining ties.
const ORDER = { internal_update: 0, response_sent: 1, waiting_customer: 2,
  resolution_confirmed: 3, customer_followup: 4, reopened: 5 };
const COMMON_FIELDS = ['id', 'type', 'evidenceId', 'occurredAt'];
const EXTRA_FIELDS = {
  customer_followup: ['receivedAt'], reopened: ['receivedAt'], internal_update: [],
  response_sent: ['sentAt', 'meaningful', 'customerFacing', 'recipientVerified',
    'recipientEvidenceId', 'messageKind', 'deliveryState', 'direction',
    'requestsCustomerInput', 'coversAllOutstandingAsks', 'addressedObligationIds'],
  resolution_confirmed: ['actor', 'closureEvidenceId'],
  waiting_customer: ['actor', 'reason', 'responseEventId'],
};

function fail(message) { throw new TypeError(message); }
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain object`);
}
function string(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a nonempty string`);
  return value;
}
function keys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}.${key} is not supported`);
}
function instant(value, label) {
  string(value, label);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) fail(`${label} must be an ISO timestamp with seconds and an explicit Z or offset`);
  const [, year, month, day, hour, minute, second, , offset] = m;
  const local = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(local.getTime()) || local.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    fail(`${label} is not a valid calendar instant`);
  }
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) {
    fail(`${label} has an invalid UTC offset`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail(`${label} is not a valid instant`);
  return new Date(ms).toISOString();
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function human(value) {
  record(value, 'event.actor');
  keys(value, ['id', 'type'], 'event.actor');
  if (value.type !== 'human') fail('event.actor must be an authorized human');
  return { id: string(value.id, 'event.actor.id'), type: 'human' };
}
function canonicalEvent(event, { stored = false } = {}) {
  record(event, 'event');
  if (!TYPES.has(event.type)) fail('event.type is unsupported; acknowledgments, drafts and unmatched messages cannot reset the clock');
  keys(event, [...COMMON_FIELDS, ...EXTRA_FIELDS[event.type],
    ...(stored ? ['_verifiedInboundObligationIds'] : [])], 'event');
  const timeField = TIME_FIELDS[event.type];
  const occurredAt = instant(event[timeField] ?? event.occurredAt, `event.${timeField}`);
  if (event.occurredAt !== undefined && instant(event.occurredAt, 'event.occurredAt') !== occurredAt) {
    fail('event timestamps disagree');
  }
  const out = { id: string(event.id, 'event.id'), type: event.type,
    evidenceId: string(event.evidenceId, 'event.evidenceId'), occurredAt };
  if (timeField !== 'occurredAt') out[timeField] = occurredAt;
  if (event.type === 'response_sent') {
    for (const field of ['meaningful', 'customerFacing', 'recipientVerified']) {
      if (event[field] !== true) fail(`response_sent requires verified ${field}=true`);
      out[field] = true;
    }
    out.recipientEvidenceId = string(event.recipientEvidenceId, 'event.recipientEvidenceId');
    for (const field of ['requestsCustomerInput', 'coversAllOutstandingAsks']) {
      if (event[field] !== undefined && typeof event[field] !== 'boolean') fail(`event.${field} must be boolean`);
      out[field] = event[field] ?? false;
    }
    if (event.addressedObligationIds !== undefined) {
      if (!Array.isArray(event.addressedObligationIds) || !event.addressedObligationIds.length) {
        fail('event.addressedObligationIds must be a nonempty array when provided');
      }
      out.addressedObligationIds = event.addressedObligationIds.map(id => string(id, 'event.addressedObligationIds item')).sort();
      if (new Set(out.addressedObligationIds).size !== out.addressedObligationIds.length) {
        fail('event.addressedObligationIds contains duplicates');
      }
      if (out.coversAllOutstandingAsks) fail('use addressedObligationIds or coversAllOutstandingAsks, not both');
    }
    if (stored && out.coversAllOutstandingAsks) {
      if (!Array.isArray(event._verifiedInboundObligationIds)) fail('stored all-asks response is missing its verified obligation scope');
      out._verifiedInboundObligationIds = event._verifiedInboundObligationIds.map(id => string(id, 'verified obligation scope item')).sort();
      if (new Set(out._verifiedInboundObligationIds).size !== out._verifiedInboundObligationIds.length) fail('verified obligation scope contains duplicates');
    }
    for (const [field, expected] of [['messageKind', 'response'], ['deliveryState', 'sent'], ['direction', 'outbound']]) {
      if (event[field] !== undefined && event[field] !== expected) fail(`response_sent requires ${field}=${expected}`);
      out[field] = expected;
    }
  }
  if (event.type === 'resolution_confirmed') {
    out.actor = human(event.actor);
    out.closureEvidenceId = string(event.closureEvidenceId, 'event.closureEvidenceId');
  }
  if (event.type === 'waiting_customer') {
    out.actor = human(event.actor);
    out.reason = string(event.reason, 'event.reason');
    out.responseEventId = string(event.responseEventId, 'event.responseEventId');
  }
  return out;
}
function origin(input) {
  record(input, 'request');
  return {
    id: string(input.id, 'request.id'), customerId: string(input.customerId, 'request.customerId'),
    subject: string(input.subject, 'request.subject'),
    ownerId: input.ownerId === null ? null : string(input.ownerId, 'request.ownerId'),
    receivedAt: instant(input.receivedAt, 'request.receivedAt'), evidenceId: string(input.evidenceId, 'request.evidenceId'),
  };
}
function plusDay(at) { return new Date(Date.parse(at) + DAY_MS).toISOString(); }
function replay(base, events, newEventId = null) {
  const activeStatus = base.ownerId === null ? 'needs_review' : 'open';
  const state = { ...base, status: activeStatus, owesUpdate: true, dueAt: null,
    lastMeaningfulResponseAt: null, lastCustomerMessageAt: base.receivedAt,
    resolvedAt: null, events, responseObligations: [], invalidatedEvents: [] };
  const add = (sourceEventId, kind, at) => state.responseObligations.push({
    id: `${kind}:${sourceEventId}`, sourceEventId, kind, startedAt: at,
    dueAt: plusDay(at), outcome: 'pending', endedAt: null, endedByEventId: null,
    previousObligationId: kind === 'recurring' ? state.responseObligations.at(-1)?.id ?? null : null,
  });
  add(base.id, 'initial', base.receivedAt);
  for (const event of events) {
    const at = event.occurredAt;
    if (Date.parse(at) < Date.parse(base.receivedAt)) fail('event predates the original receivedAt; correct the source request explicitly');
    switch (event.type) {
      case 'internal_update': break;
      case 'customer_followup':
        if (state.status === 'resolved') fail('a follow-up after resolution requires an explicit reopened event');
        state.status = activeStatus; state.owesUpdate = true; state.lastCustomerMessageAt = at;
        add(event.id, 'followup', at);
        break;
      case 'response_sent': {
        const addressed = new Set(event.addressedObligationIds ?? event._verifiedInboundObligationIds ?? []);
        const known = new Set(state.responseObligations.map(item => item.id));
        if ([...addressed].some(id => !known.has(id))) fail('response references an unknown addressed obligation');
        state.lastMeaningfulResponseAt = at;
        if (state.owesUpdate) {
          for (const obligation of state.responseObligations) {
            if (obligation.outcome === 'pending' && (obligation.kind === 'recurring'
                || addressed.has(obligation.id))) {
              obligation.outcome = 'responded'; obligation.endedAt = at; obligation.endedByEventId = event.id;
            }
          }
          add(event.id, 'recurring', at);
        }
        break;
      }
      case 'waiting_customer': {
        const linkedResponse = events.find(item => item.id === event.responseEventId && item.type === 'response_sent');
        const pending = state.responseObligations.filter(item => item.outcome === 'pending');
        const recurring = pending.find(item => item.kind === 'recurring' && item.sourceEventId === event.responseEventId);
        const valid = state.status !== 'resolved' && linkedResponse
          && linkedResponse.occurredAt === state.lastMeaningfulResponseAt
          && linkedResponse.requestsCustomerInput && linkedResponse.coversAllOutstandingAsks
          && recurring && pending.every(item => item.kind === 'recurring' && item.sourceEventId === event.responseEventId);
        if (!valid) {
          const reason = 'waiting_customer requires the latest verified response requesting customer input, all asks covered, and no unanswered inbound obligation';
          if (event.id === newEventId) fail(reason);
          // Newly discovered earlier inbound evidence can invalidate an old pause.
          // Keep that evidence and resume the clock instead of dropping the input.
          state.invalidatedEvents.push({ eventId: event.id, reason });
          break;
        }
        recurring.outcome = 'waiting_customer'; recurring.endedAt = at; recurring.endedByEventId = event.id;
        state.status = 'waiting_on_customer'; state.owesUpdate = false;
        break;
      }
      case 'resolution_confirmed': {
        if (state.status === 'resolved') fail('request is already resolved; replay the same event ID for an idempotent retry');
        const unanswered = state.responseObligations.some(item => item.outcome === 'pending' && item.kind !== 'recurring');
        if (unanswered) {
          const reason = 'resolution requires a verified meaningful response covering every unanswered inbound obligation';
          if (event.id === newEventId) fail(reason);
          state.invalidatedEvents.push({ eventId: event.id, reason });
          break;
        }
        for (const obligation of state.responseObligations) {
          if (obligation.outcome === 'pending' && obligation.kind === 'recurring') {
            obligation.outcome = 'resolved'; obligation.endedAt = at; obligation.endedByEventId = event.id;
          }
        }
        state.status = 'resolved'; state.owesUpdate = false; state.resolvedAt = at;
        break;
      }
      case 'reopened':
        if (state.status !== 'resolved') {
          if (event.id === newEventId) fail('reopened requires a previously resolved request');
          // If late evidence invalidated the historical closure, this already
          // accepted inbound event still exists. Preserve it as an additional
          // obligation without resetting or losing the earlier unanswered ask.
          state.invalidatedEvents.push({ eventId: event.id,
            reason: 'prior closure invalidated; reopening retained as an additional inbound obligation' });
        }
        state.status = activeStatus; state.owesUpdate = true; state.resolvedAt = null;
        state.lastCustomerMessageAt = at;
        add(event.id, 'reopened', at);
        break;
    }
  }
  const pending = state.responseObligations.filter(item => item.outcome === 'pending');
  state.dueAt = pending.length ? pending.map(item => item.dueAt).sort()[0] : null;
  return freeze(state);
}

function storedLedger(request) {
  if (!Array.isArray(request.events)) fail('request.events must be an array');
  const events = request.events.map(event => canonicalEvent(event, { stored: true }));
  const seen = new Set();
  for (const event of events) {
    if (seen.has(event.id)) fail('request ledger contains duplicate event IDs');
    seen.add(event.id);
  }
  return events.sort(compareEvents);
}

/** Rebuild and freeze ALL projection fields from the validated stored ledger.
 * Consumers must use this result, never a persisted status/dueAt beside a fresh
 * clock. The caller must separately authenticate the origin and stored evidence.
 */
export function replayRequest(request) {
  return replay(origin(request), storedLedger(request));
}

/** Create an accepted request, or an assignment-review request with ownerId:null. */
export function createRequest(input) {
  return replay(origin(input), []);
}

/** Apply one verified event without mutating input. Exact semantic retries are no-ops. */
export function applyEvent(request, event) {
  const base = origin(request);
  const next = canonicalEvent(event);
  const events = storedLedger(request);
  const prior = events.find(item => item.id === next.id);
  if (prior) {
    if (eventPayload(prior) !== eventPayload(next)) fail('event ID was reused with a conflicting payload');
    // Rebuild rather than trust mutable or deserialized projection fields.
    return replay(base, events.sort(compareEvents));
  }
  if (next.type === 'response_sent' && next.coversAllOutstandingAsks) {
    const before = replay(base, events.filter(item => compareEvents(item, next) < 0).sort(compareEvents));
    next._verifiedInboundObligationIds = before.responseObligations
      .filter(item => item.outcome === 'pending' && item.kind !== 'recurring').map(item => item.id).sort();
  }
  events.push(next);
  return replay(base, events.sort(compareEvents), next.id);
}
function eventPayload(event) {
  const { _verifiedInboundObligationIds, ...payload } = event;
  return JSON.stringify(payload);
}
function compareEvents(a, b) {
  return Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
    || ORDER[a.type] - ORDER[b.type] || a.id.localeCompare(b.id, 'en');
}

/** Derive the response clock at an explicit instant; no wall-clock/global state. */
export function deriveClock(request, now) {
  const nowAt = instant(now, 'now');
  const current = replayRequest(request);
  if (Date.parse(nowAt) < Date.parse(current.receivedAt)
      || current.events.some(event => Date.parse(event.occurredAt) > Date.parse(nowAt))) {
    fail('now cannot precede source evidence; use a historical event-ledger snapshot');
  }
  if (!current.owesUpdate) return freeze({ dueAt: null, remainingMs: null,
    band: current.status === 'waiting_on_customer' ? 'waiting_customer' : current.status });
  const remainingMs = Date.parse(current.dueAt) - Date.parse(nowAt);
  const band = remainingMs <= 0 ? 'overdue' : remainingMs <= 2 * HOUR_MS ? 'urgent'
    : remainingMs <= 6 * HOUR_MS ? 'due_soon' : 'on_track';
  return freeze({ dueAt: current.dueAt, remainingMs, band });
}
