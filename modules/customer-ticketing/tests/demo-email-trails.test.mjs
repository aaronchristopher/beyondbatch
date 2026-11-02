import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixtures, demoPrincipals } from '../src/fixtures.mjs';
import { getDemoEmailTrail } from '../src/fixtures/email-trails.mjs';
import { projectWorkspace } from '../src/security/workspace.mjs';
import { createDemoServer } from '../src/server.mjs';

const now = '2026-11-02T14:00:00.000Z';
async function start(t, options = {}) {
  const server = createDemoServer({ clock: () => new Date(now), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('sample trails match the exact requests visible in each demo view', () => {
  const requests = makeFixtures(now);
  for (const principal of Object.values(demoPrincipals)) {
    const visible = projectWorkspace({ principal, requests, now, coverage: { mode: 'fictional' } }).requests;
    const trails = requests.map(request => getDemoEmailTrail({ request, principal })).filter(Boolean);
    assert.deepEqual(trails.map(trail => trail.requestId).sort(), visible.map(row => row.id).sort());
    for (const row of visible) {
      assert.equal(typeof row.emailSubject, 'string');
      assert.equal(Object.hasOwn(row, 'threads'), false);
      assert.equal(Object.hasOwn(row, 'rawEmail'), false);
      assert.equal(Object.hasOwn(row, 'fixtureSource'), false);
    }
  }
});

test('linked sample threads preserve separate subjects and use only example addresses', () => {
  const request = makeFixtures(now)[0];
  const trail = getDemoEmailTrail({ request, principal: demoPrincipals.president });
  assert.equal(trail.mode, 'fictional');
  assert.equal(trail.threads.length, 2);
  assert.notEqual(trail.threads[0].subject, trail.threads[1].subject);
  assert.equal(trail.threads[0].subject, request.emailSubject);
  assert.equal(trail.threads[0].messages[0].sentAt, request.clock.receivedAt);
  for (const thread of trail.threads) {
    for (const message of thread.messages) {
      assert.match(message.from.address, /\.example$/);
      for (const address of message.to) assert.match(address, /\.example$/);
      assert.ok(message.body.length > 20);
      assert.ok(Date.parse(message.sentAt) <= Date.parse(now));
      assert.ok(['incoming', 'internal'].includes(message.direction));
      for (const attachment of message.attachments) assert.deepEqual(Object.keys(attachment), ['name']);
    }
  }
});

test('trail responses are fresh copies and never source bodies from request fields', () => {
  const request = makeFixtures(now)[0];
  request.rawEmail = 'PRIVATE RAW BODY SENTINEL';
  request.rawBody = 'PRIVATE RAW BODY SENTINEL';
  const first = getDemoEmailTrail({ request, principal: demoPrincipals.pm });
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE RAW BODY SENTINEL/);
  first.threads[0].messages[0].from.address = 'changed@evil.test';
  const second = getDemoEmailTrail({ request, principal: demoPrincipals.pm });
  assert.match(second.threads[0].messages[0].from.address, /\.example$/);
  assert.equal(getDemoEmailTrail({ request: { ...request, fixtureSource: undefined }, principal: demoPrincipals.pm }), null);
  assert.equal(getDemoEmailTrail({ request: { ...request, tenantId: 'other' }, principal: demoPrincipals.pm }), null);
  assert.equal(getDemoEmailTrail({ request: { ...request, classification: 'restricted' }, principal: demoPrincipals.pm }), null);
  assert.equal(getDemoEmailTrail({ request: { ...request, customerId: 'other' }, principal: demoPrincipals.pm }), null);
});

test('email-trail endpoint scopes sample reads and does not change request clocks', async t => {
  const requests = makeFixtures(now);
  const before = structuredClone(requests);
  const base = await start(t, { requests });
  const read = (persona, requestId) => fetch(`${base}/api/email-trail?persona=${persona}&requestId=${requestId}`);
  const allowed = await read('pm', 'r1');
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).requestId, 'r1');
  assert.equal((await read('pm', 'r3')).status, 404);
  assert.equal((await read('pm', 'r6')).status, 404);
  assert.equal((await read('department', 'r2')).status, 404);
  assert.equal((await read('department', 'r5')).status, 200);
  assert.equal((await read('president', 'r6')).status, 200);
  assert.equal((await read('president', 'unknown')).status, 404);
  assert.deepEqual(requests, before);
});

test('email-trail route rejects invalid personas, ambiguous query parameters and writes', async t => {
  const base = await start(t);
  for (const query of ['persona=unknown&requestId=r1', 'requestId=r1', 'persona=pm&persona=president&requestId=r1', 'persona=pm&requestId=r1&role=president']) {
    assert.equal((await fetch(`${base}/api/email-trail?${query}`)).status, 400, query);
  }
  assert.equal((await fetch(`${base}/api/email-trail?persona=pm&requestId=r1`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/email-trail?persona=pm&requestId=r1`, { headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('persisted fixture workspace never substitutes unrelated static conversations', async t => {
  let called = false;
  const base = await start(t, { workspaceProvider: () => { called = true; return { requests: [] }; } });
  const response = await fetch(`${base}/api/email-trail?persona=president&requestId=r1`);
  assert.equal(response.status, 404);
  assert.equal(called, false);
  assert.deepEqual(await response.json(), { error: 'Sample email trail unavailable' });
});
