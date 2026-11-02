import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequest, applyEvent, deriveClock, replayRequest } from '../src/domain/response-clock.mjs';

const base = overrides => createRequest({ id: 'r1', customerId: 'c1', subject: 'Send approved specification',
  ownerId: 'pm1', receivedAt: '2026-11-01T08:00:00-06:00', evidenceId: 'mail1', ...overrides });
const response = (overrides = {}) => ({ id: 'response1', type: 'response_sent', sentAt: '2026-11-01T16:00:00Z',
  evidenceId: 'sent1', meaningful: true, customerFacing: true, recipientVerified: true, coversAllOutstandingAsks: true,
  recipientEvidenceId: 'contact-proof1', ...overrides });
const resolution = (overrides = {}) => ({ id: 'close1', type: 'resolution_confirmed',
  occurredAt: '2026-11-01T17:00:00Z', evidenceId: 'confirmation1',
  closureEvidenceId: 'approved-artifact1', actor: { id: 'pm1', type: 'human' }, ...overrides });
const followup = (overrides = {}) => ({ id: 'follow1', type: 'customer_followup',
  receivedAt: '2026-11-02T12:00:00Z', evidenceId: 'mail2', ...overrides });
const askingResponse = (overrides = {}) => response({ requestsCustomerInput: true, coversAllOutstandingAsks: true, ...overrides });
const waiting = (overrides = {}) => ({ id: 'wait1', type: 'waiting_customer', occurredAt: '2026-11-01T17:00:00Z',
  evidenceId: 'question-sent1', responseEventId: 'response1', actor: { id: 'pm1', type: 'human' }, reason: 'Customer must confirm the lot', ...overrides });

test('obligations identify the exact ending event even when partial replies share a timestamp', () => {
  let request = applyEvent(base(), followup({ receivedAt: '2026-11-01T15:00:00Z' }));
  request = applyEvent(request, response({ id: 'reply-a', coversAllOutstandingAsks: false,
    addressedObligationIds: ['initial:r1'] }));
  request = applyEvent(request, response({ id: 'reply-b', evidenceId: 'sent-b', coversAllOutstandingAsks: false,
    addressedObligationIds: ['followup:follow1'] }));
  const byId = Object.fromEntries(request.responseObligations.map(o => [o.id, o]));
  assert.equal(byId['initial:r1'].endedByEventId, 'reply-a');
  assert.equal(byId['followup:follow1'].endedByEventId, 'reply-b');
  assert.equal(byId['recurring:reply-a'].endedByEventId, 'reply-b');
  assert.equal(byId['recurring:reply-b'].endedByEventId, null);
  assert.equal(byId['recurring:reply-a'].previousObligationId, 'followup:follow1');
  assert.equal(byId['recurring:reply-b'].previousObligationId, 'recurring:reply-a');
  assert.equal(byId['initial:r1'].previousObligationId, null);
  assert.deepEqual(replayRequest(JSON.parse(JSON.stringify(request))), request);
});

test('human pause and closure retain their own ending event provenance', () => {
  const paused = applyEvent(applyEvent(base(), askingResponse()), waiting());
  assert.equal(paused.responseObligations.at(-1).endedByEventId, 'wait1');
  const closed = applyEvent(applyEvent(base(), response()), resolution());
  assert.equal(closed.responseObligations.at(-1).endedByEventId, 'close1');
});

test('initial clock is exactly 24 elapsed hours, including weekend', () => {
  const request = base();
  assert.equal(request.dueAt, '2026-11-02T14:00:00.000Z');
  assert.equal(deriveClock(request, '2026-11-01T14:00:00Z').remainingMs, 86_400_000);
  assert.equal(request.status, 'open');
});

test('DST fall-back and spring-forward do not use a local calendar day', () => {
  const fall = base({ receivedAt: '2026-11-01T01:30:00-05:00' });
  const spring = base({ receivedAt: '2026-03-08T01:30:00-06:00' });
  assert.equal(fall.dueAt, '2026-11-02T06:30:00.000Z');
  assert.equal(spring.dueAt, '2026-03-09T07:30:00.000Z');
});

test('bands include exact two-hour, six-hour and deadline boundaries', () => {
  const request = base();
  for (const [now, band] of [
    ['2026-11-02T07:59:59Z', 'on_track'], ['2026-11-02T08:00:00Z', 'due_soon'],
    ['2026-11-02T12:00:00Z', 'urgent'], ['2026-11-02T14:00:00Z', 'overdue'],
    ['2026-11-02T15:00:00Z', 'overdue'],
  ]) assert.equal(deriveClock(request, now).band, band);
});

test('customer follow-up records its obligation without extending an unanswered deadline', () => {
  const request = applyEvent(base(), followup());
  assert.equal(request.dueAt, base().dueAt);
  assert.equal(request.responseObligations.length, 2);
  assert.equal(request.responseObligations[1].dueAt, '2026-11-03T12:00:00.000Z');
});

test('internal progress never resets the customer-facing response clock', () => {
  const request = applyEvent(base(), { id: 'internal1', type: 'internal_update',
    occurredAt: '2026-11-01T18:00:00Z', evidenceId: 'qa-update1' });
  assert.equal(request.dueAt, base().dueAt);
  assert.equal(request.lastMeaningfulResponseAt, null);
});

test('a meaningful partial update starts a new response clock without resolving the request', () => {
  const request = applyEvent(base(), response());
  assert.equal(request.dueAt, '2026-11-02T16:00:00.000Z');
  assert.equal(request.lastMeaningfulResponseAt, '2026-11-01T16:00:00.000Z');
  assert.equal(request.status, 'open');
  assert.equal(request.owesUpdate, true);
  assert.equal(request.responseObligations[0].outcome, 'responded');
});

test('late response preserves the breached original deadline instead of overwriting history', () => {
  const request = applyEvent(base(), response({ sentAt: '2026-11-03T16:00:00Z' }));
  const original = request.responseObligations[0];
  assert.equal(original.dueAt, '2026-11-02T14:00:00.000Z');
  assert.ok(Date.parse(original.endedAt) > Date.parse(original.dueAt));
  assert.equal(request.dueAt, '2026-11-04T16:00:00.000Z');
});

test('responses require meaningful content and verified customer-facing recipient evidence', () => {
  for (const patch of [
    { meaningful: false }, { customerFacing: false }, { recipientVerified: false },
    { recipientEvidenceId: '' }, { evidenceId: '' }, { messageKind: 'auto_ack' },
    { deliveryState: 'draft' }, { direction: 'internal' },
  ]) assert.throws(() => applyEvent(base(), response(patch)), TypeError);
  const noMeaningful = response(); delete noMeaningful.meaningful;
  assert.throws(() => applyEvent(base(), noMeaningful), /meaningful/);
});

test('acknowledgments and drafts cannot masquerade as response events', () => {
  for (const type of ['auto_ack', 'acknowledgment_sent', 'draft', 'draft_created']) {
    assert.throws(() => applyEvent(base(), { id: type, type, occurredAt: '2026-11-01T16:00:00Z', evidenceId: 'mail' }), /unsupported/);
  }
});

test('a response can satisfy multiple follow-ups but cannot resolve the request', () => {
  let request = applyEvent(base(), followup());
  request = applyEvent(request, response({ sentAt: '2026-11-02T13:00:00Z' }));
  assert.equal(request.responseObligations.filter(o => o.outcome === 'responded').length, 2);
  assert.equal(request.responseObligations.filter(o => o.outcome === 'pending').length, 1);
  assert.equal(request.status, 'open');
});

test('human closure needs evidence and follows verified response fulfillment', () => {
  assert.throws(() => applyEvent(base(), resolution({ actor: { id: 'agent1', type: 'agent' } })), /human/);
  assert.throws(() => applyEvent(base(), resolution({ closureEvidenceId: '' })), /closureEvidenceId/);
  const request = applyEvent(applyEvent(base(), response()), resolution());
  assert.equal(request.lastMeaningfulResponseAt, '2026-11-01T16:00:00.000Z');
  assert.equal(request.responseObligations[0].outcome, 'responded');
  assert.equal(request.responseObligations[1].outcome, 'resolved');
  assert.deepEqual(deriveClock(request, '2026-11-01T18:00:00Z'), { dueAt: null, remainingMs: null, band: 'resolved' });
});

test('explicit reopening starts a clock at the actual incoming instant', () => {
  let request = applyEvent(applyEvent(base(), response()), resolution());
  request = applyEvent(request, { id: 'reopen1', type: 'reopened', receivedAt: '2026-11-03T09:00:00-06:00', evidenceId: 'wrong-revision1' });
  assert.equal(request.status, 'open');
  assert.equal(request.dueAt, '2026-11-04T15:00:00.000Z');
  assert.equal(request.responseObligations[0].outcome, 'responded');
  assert.throws(() => applyEvent(base(), { id: 'bad-reopen', type: 'reopened', receivedAt: '2026-11-03T15:00:00Z', evidenceId: 'mail' }), /previously resolved/);
});

test('follow-up after closure requires explicit reopening classification', () => {
  const request = applyEvent(applyEvent(base(), response()), resolution());
  assert.throws(() => applyEvent(request, followup()), /reopened/);
});

test('waiting on customer requires explicit human approval and evidence, follow-up reactivates', () => {
  assert.throws(() => applyEvent(base(), waiting({ actor: { id: 'agent', type: 'agent' } })), /human/);
  assert.throws(() => applyEvent(base(), waiting({ evidenceId: '' })), /evidenceId/);
  assert.throws(() => applyEvent(base(), waiting({ reason: '' })), /reason/);
  assert.throws(() => applyEvent(base(), waiting()), /latest verified response/);
  let request = applyEvent(applyEvent(base(), askingResponse()), waiting());
  assert.deepEqual(deriveClock(request, '2026-11-02T18:00:00Z'), { dueAt: null, remainingMs: null, band: 'waiting_customer' });
  request = applyEvent(request, followup());
  assert.equal(request.dueAt, '2026-11-03T12:00:00.000Z');
  assert.equal(request.status, 'open');
});

test('outgoing response while waiting or resolved does not create an owed update', () => {
  for (const event of [waiting(), resolution()]) {
    const start = event.type === 'waiting_customer' ? applyEvent(base(), askingResponse()) : applyEvent(base(), response());
    const request = applyEvent(applyEvent(start, event), response({ id: 'later-response', sentAt: '2026-11-01T18:00:00Z' }));
    assert.equal(request.owesUpdate, false);
    assert.equal(request.dueAt, null);
  }
});

test('late evidence recomputes chronologically and never replaces a later meaningful response', () => {
  const later = response({ id: 'later', sentAt: '2026-11-02T16:00:00Z' });
  const earlier = response({ id: 'earlier', sentAt: '2026-11-01T16:00:00Z' });
  const outOfOrder = applyEvent(applyEvent(base(), later), earlier);
  const ordered = applyEvent(applyEvent(base(), earlier), later);
  // Acceptance-time evidence scopes may differ; the chronological clock projection must agree.
  const { events: delayedLedger, ...delayedProjection } = outOfOrder;
  const { events: orderedLedger, ...orderedProjection } = ordered;
  assert.deepEqual(delayedProjection, orderedProjection);
  assert.equal(outOfOrder.dueAt, '2026-11-03T16:00:00.000Z');
});

test('late-discovered follow-up is not silently covered by an earlier all-known-asks decision', () => {
  const latest = response({ sentAt: '2026-11-02T13:00:00Z' });
  const request = applyEvent(applyEvent(base(), latest), followup());
  assert.equal(request.dueAt, '2026-11-03T12:00:00.000Z');
  assert.equal(request.responseObligations.find(o => o.kind === 'followup').outcome, 'pending');
});

test('same-time inbound is not presumed answered by a simultaneous outbound', () => {
  let request = applyEvent(base(), response());
  request = applyEvent(request, followup({ receivedAt: '2026-11-01T16:00:00Z' }));
  assert.equal(request.responseObligations.find(o => o.kind === 'followup').outcome, 'pending');
});

test('same event ID is idempotent but conflicting payload throws', () => {
  const request = applyEvent(base(), response());
  assert.deepEqual(applyEvent(request, response()), request);
  assert.throws(() => applyEvent(request, response({ evidenceId: 'different' })), /conflicting payload/);
  assert.throws(() => applyEvent(request, response({ sentAt: '2026-11-01T17:00:00Z' })), /conflicting payload/);
});

test('equivalent explicit-offset timestamp aliases are semantic retries', () => {
  const request = applyEvent(base(), response());
  const retry = response({ sentAt: '2026-11-01T10:00:00-06:00', occurredAt: '2026-11-01T16:00:00Z' });
  assert.deepEqual(applyEvent(request, retry), request);
  assert.throws(() => applyEvent(base(), response({ occurredAt: '2026-11-01T17:00:00Z' })), /disagree/);
});

test('input state and caller event are not mutated; all returned nested data is frozen', () => {
  const request = base(); const event = response();
  const before = JSON.stringify(request); const eventBefore = JSON.stringify(event);
  const changed = applyEvent(request, event);
  assert.equal(JSON.stringify(request), before);
  assert.equal(JSON.stringify(event), eventBefore);
  assert.ok(Object.isFrozen(changed.events[0]));
  assert.ok(Object.isFrozen(changed.responseObligations[0]));
  assert.throws(() => { changed.events.push(event); }, TypeError);
});

test('date validation rejects missing zones, nonexistent dates, rollover and invalid offsets', () => {
  for (const receivedAt of ['2026-11-01T08:00:00', '2026-02-30T08:00:00Z',
    '2026-11-01T24:00:00Z', '2026-11-01T08:60:00Z', '2026-11-01T08:00:00+25:00',
    '2026-11-01T08:00:00+06:99', 'not-a-date']) {
    assert.throws(() => base({ receivedAt }), TypeError);
  }
});

test('events before the source request and future-evidence clock queries fail explicitly', () => {
  assert.throws(() => applyEvent(base(), response({ sentAt: '2026-10-31T16:00:00Z' })), /predates/);
  assert.throws(() => deriveClock(base(), '2026-11-01T13:59:59Z'), /precede/);
  assert.throws(() => deriveClock(applyEvent(base(), response()), '2026-11-01T15:00:00Z'), /precede/);
});

test('deserialized state is recomputed from the ledger instead of trusting forged projections', () => {
  const request = JSON.parse(JSON.stringify(applyEvent(base(), response())));
  request.dueAt = '2027-01-01T00:00:00Z'; request.status = 'resolved'; request.owesUpdate = false;
  assert.equal(deriveClock(request, '2026-11-01T17:00:00Z').dueAt, '2026-11-02T16:00:00.000Z');
});

test('unsupported fields and malformed request identity fail closed', () => {
  assert.throws(() => base({ ownerId: '' }), /ownerId/);
  assert.throws(() => applyEvent(base(), response({ resolve: true })), /not supported/);
  assert.throws(() => applyEvent(base(), null), /plain object/);
});


test('unassigned request stays in assignment review while the 24h clock runs', () => {
  const request = base({ ownerId: null });
  assert.equal(request.status, 'needs_review');
  assert.equal(request.dueAt, base().dueAt);
  assert.equal(deriveClock(request, '2026-11-02T14:00:00Z').band, 'overdue');
});

test('waiting cannot pause an obligation using an acknowledgment, generic reply, or uncovered asks', () => {
  assert.throws(() => applyEvent(applyEvent(base(), response()), waiting()), /latest verified response/);
  for (const patch of [{ requestsCustomerInput: false }, { coversAllOutstandingAsks: false }]) {
    const request = applyEvent(base(), askingResponse(patch));
    assert.throws(() => applyEvent(request, waiting()), /latest verified response/);
  }
  const afterQuestion = applyEvent(base(), askingResponse());
  const withFollowup = applyEvent(afterQuestion, followup({ receivedAt: '2026-11-01T16:30:00Z' }));
  assert.throws(() => applyEvent(withFollowup, waiting()), /no unanswered inbound obligation/);
});

test('valid waiting only retires the recurring update; original response fulfillment is retained', () => {
  const request = applyEvent(applyEvent(base(), askingResponse()), waiting());
  assert.equal(request.status, 'waiting_on_customer');
  assert.equal(request.responseObligations[0].outcome, 'responded');
  assert.equal(request.responseObligations[1].kind, 'recurring');
  assert.equal(request.responseObligations[1].outcome, 'waiting_customer');
});

test('late discovered unanswered inbound invalidates an old pause and keeps the active deadline', () => {
  let request = applyEvent(applyEvent(base(), askingResponse()), waiting());
  request = applyEvent(request, followup({ receivedAt: '2026-11-01T16:30:00Z' }));
  assert.equal(request.status, 'open');
  assert.equal(request.owesUpdate, true);
  assert.equal(request.dueAt, '2026-11-02T16:00:00.000Z');
  assert.equal(request.invalidatedEvents[0].eventId, 'wait1');
  assert.equal(request.events.length, 3);
});


test('partial reply covering one of three inbound obligations preserves the earliest unanswered deadline', () => {
  let request = applyEvent(base(), followup({ receivedAt: '2026-11-01T15:00:00Z' }));
  request = applyEvent(request, followup({ id: 'follow2', receivedAt: '2026-11-01T15:30:00Z', evidenceId: 'mail3' }));
  request = applyEvent(request, response({ coversAllOutstandingAsks: false, addressedObligationIds: ['initial:r1'] }));
  assert.equal(request.responseObligations[0].outcome, 'responded');
  assert.equal(request.responseObligations.find(o => o.id === 'followup:follow1').outcome, 'pending');
  assert.equal(request.responseObligations.find(o => o.id === 'followup:follow2').outcome, 'pending');
  assert.equal(request.dueAt, '2026-11-02T15:00:00.000Z');
  assert.equal(request.lastMeaningfulResponseAt, '2026-11-01T16:00:00.000Z');
});

test('unknown response coverage cannot clear or extend an unanswered incoming request', () => {
  const event = response(); delete event.coversAllOutstandingAsks;
  const request = applyEvent(base(), event);
  assert.equal(request.responseObligations[0].outcome, 'pending');
  assert.equal(request.dueAt, base().dueAt);
  assert.equal(request.lastMeaningfulResponseAt, '2026-11-01T16:00:00.000Z');
  assert.equal(request.responseObligations.find(o => o.kind === 'recurring').dueAt, '2026-11-02T16:00:00.000Z');
});

test('subsequent partial response covers one follow-up without erasing the third unanswered ask', () => {
  let request = applyEvent(base(), followup({ receivedAt: '2026-11-01T15:00:00Z' }));
  request = applyEvent(request, followup({ id: 'follow2', receivedAt: '2026-11-01T15:30:00Z', evidenceId: 'mail3' }));
  request = applyEvent(request, response({ coversAllOutstandingAsks: false, addressedObligationIds: ['initial:r1'] }));
  request = applyEvent(request, response({ id: 'response2', sentAt: '2026-11-01T18:00:00Z',
    coversAllOutstandingAsks: false, addressedObligationIds: ['followup:follow1'] }));
  assert.equal(request.responseObligations.find(o => o.id === 'followup:follow2').outcome, 'pending');
  assert.equal(request.responseObligations.find(o => o.id === 'recurring:response1').outcome, 'responded');
  assert.equal(request.dueAt, '2026-11-02T15:30:00.000Z');
});

test('coverage evidence cannot reference invented obligations or contradictory scope', () => {
  for (const addressedObligationIds of [['not-a-real-obligation'], [], ['initial:r1', 'initial:r1']]) {
    assert.throws(() => applyEvent(base(), response({ coversAllOutstandingAsks: false, addressedObligationIds })), TypeError);
  }
  assert.throws(() => applyEvent(base(), response({ addressedObligationIds: ['initial:r1'] })), /not both/);
});


test('late-discovered pre-response ask invalidates a waiting pause without expanding old response coverage', () => {
  let request = applyEvent(applyEvent(base(), askingResponse()), waiting());
  request = applyEvent(request, followup({ receivedAt: '2026-11-01T15:00:00Z' }));
  assert.equal(request.status, 'open');
  assert.equal(request.dueAt, '2026-11-02T15:00:00.000Z');
  assert.equal(request.responseObligations.find(o => o.id === 'followup:follow1').outcome, 'pending');
  assert.equal(request.invalidatedEvents[0].eventId, 'wait1');
  const retry = applyEvent(request, askingResponse());
  assert.deepEqual(retry, request);
});


test('human closure cannot hide an unanswered request even with closure evidence', () => {
  assert.throws(() => applyEvent(base(), resolution()), /covering every unanswered inbound obligation/);
  const unknownCoverage = response(); delete unknownCoverage.coversAllOutstandingAsks;
  assert.throws(() => applyEvent(applyEvent(base(), unknownCoverage), resolution()), /unanswered inbound obligation/);
});

test('late evidence invalidates earlier closure and restores the unanswered customer deadline', () => {
  let request = applyEvent(applyEvent(base(), response()), resolution());
  request = applyEvent(request, followup({ receivedAt: '2026-11-01T15:00:00Z' }));
  assert.equal(request.status, 'open');
  assert.equal(request.resolvedAt, null);
  assert.equal(request.owesUpdate, true);
  assert.equal(request.dueAt, '2026-11-02T15:00:00.000Z');
  assert.equal(request.invalidatedEvents[0].eventId, 'close1');
  assert.equal(request.responseObligations.find(item => item.id === 'followup:follow1').outcome, 'pending');
  assert.equal(deriveClock(request, '2026-11-02T16:00:00Z').band, 'overdue');
});

test('replayRequest replaces forged persisted lifecycle and deadline projections with frozen canonical state', () => {
  const request = JSON.parse(JSON.stringify(base()));
  request.status = 'resolved'; request.owesUpdate = false; request.dueAt = null; request.resolvedAt = '2026-11-01T14:01:00Z';
  request.responseObligations = [];
  const restored = replayRequest(request);
  assert.equal(restored.status, 'open');
  assert.equal(restored.owesUpdate, true);
  assert.equal(restored.dueAt, base().dueAt);
  assert.equal(restored.resolvedAt, null);
  assert.equal(restored.responseObligations.length, 1);
  assert.ok(Object.isFrozen(restored.responseObligations[0]));
  assert.equal(deriveClock(restored, '2026-11-02T15:00:00Z').band, 'overdue');
});

test('canonical replay and clock derivation reject duplicate ledger event IDs', () => {
  const request = JSON.parse(JSON.stringify(applyEvent(base(), response())));
  request.events.push({ ...request.events[0] });
  assert.throws(() => replayRequest(request), /duplicate event IDs/);
  assert.throws(() => deriveClock(request, '2026-11-02T15:00:00Z'), /duplicate event IDs/);
  assert.throws(() => applyEvent(request, followup()), /duplicate event IDs/);
});


test('late evidence invalidating a historical closure survives an already-recorded reopening', () => {
  let request = applyEvent(applyEvent(base(), response()), resolution());
  request = applyEvent(request, { id: 'reopen1', type: 'reopened', receivedAt: '2026-11-03T15:00:00Z', evidenceId: 'wrong-document' });
  request = applyEvent(request, followup({ receivedAt: '2026-11-01T15:00:00Z' }));
  assert.equal(request.status, 'open');
  assert.equal(request.dueAt, '2026-11-02T15:00:00.000Z');
  assert.equal(request.responseObligations.find(item => item.id === 'followup:follow1').outcome, 'pending');
  assert.equal(request.responseObligations.find(item => item.id === 'reopened:reopen1').outcome, 'pending');
  assert.deepEqual(request.invalidatedEvents.map(item => item.eventId), ['close1', 'reopen1']);
  assert.deepEqual(replayRequest(request), request);
});
