import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphReader, GraphReadError } from '../src/integrations/graph-reader.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const MAILBOX = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const base = `https://graph.microsoft.com/v1.0/users/${MAILBOX}/mailFolders/Inbox/messages/delta`;
const finalCursor = `${base}?$deltatoken=opaque%2Bfinal%3D`;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

function fixture(responses, overrides = {}) {
  const calls = [];
  const tokens = [];
  const sleeps = [];
  const reader = createGraphReader({ tenantId: TENANT, allowedMailboxIds: [MAILBOX],
    getAccessToken: async context => { tokens.push(context); return 'fake-token'; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.ok(responses.length, 'unexpected extra HTTP request');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(url, options) : next;
    },
    sleep: async ms => { sleeps.push(ms); },
    ...overrides,
  });
  return { reader, calls, tokens, sleeps };
}

const callbacks = () => ({ onPage: async () => {}, commitCursor: async () => {} });
const code = expected => error => error instanceof GraphReadError && error.code === expected;

test('requires explicit approved tenant/mailbox GUIDs and bounds retry configuration', () => {
  assert.throws(() => createGraphReader({}), code('INVALID_CONFIG'));
  assert.throws(() => fixture([], { allowedMailboxIds: [] }), code('INVALID_CONFIG'));
  assert.throws(() => fixture([], { allowedMailboxIds: ['pm@example.test'] }), code('INVALID_CONFIG'));
  assert.throws(() => fixture([], { maxRetries: 100 }), code('INVALID_CONFIG'));
});

test('unapproved mailbox fails before token acquisition or HTTP for both operations', async () => {
  const { reader, calls, tokens } = fixture([]);
  await assert.rejects(reader.listFolders(OTHER), code('MAILBOX_NOT_ALLOWED'));
  await assert.rejects(reader.readDelta(OTHER, 'Inbox', callbacks()), code('MAILBOX_NOT_ALLOWED'));
  assert.equal(tokens.length, 0);
  assert.equal(calls.length, 0);
});

test('initial read explicitly excludes bodies, attachments, and date filter; uses immutable IDs', async () => {
  const { reader, calls, tokens } = fixture([json({ value: [], '@odata.deltaLink': finalCursor })]);
  const result = await reader.readDelta(MAILBOX, 'Inbox', callbacks());
  const url = new URL(calls[0].url);
  const fields = url.searchParams.get('$select').split(',');
  assert.ok(fields.includes('id'));
  for (const excluded of ['body', 'bodyPreview', 'uniqueBody', 'attachments']) assert.ok(!fields.includes(excluded));
  assert.equal(url.searchParams.has('$filter'), false);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.match(calls[0].options.headers.Prefer, /IdType="ImmutableId"/);
  assert.deepEqual(tokens, [{ tenantId: TENANT, scope: 'https://graph.microsoft.com/.default' }]);
  assert.deepEqual(result, { deltaLink: finalCursor, pages: 1, messages: 0 });
});

test('follows empty pages unchanged and waits for each durable page before final commit', async () => {
  const next = `${base}?$skiptoken=untouched%2B%2F%3D`;
  const { reader, calls } = fixture([
    json({ value: [], '@odata.nextLink': next }),
    json({ value: [{ id: 'message-1', subject: 'Demo request' }], '@odata.deltaLink': finalCursor }),
  ]);
  const order = [];
  const result = await reader.readDelta(MAILBOX, 'Inbox', {
    onPage: async (records, context) => {
      order.push(`start:${context.pageNumber}`);
      await Promise.resolve();
      assert.equal(calls.length, context.pageNumber);
      assert.equal(context.mailboxId, MAILBOX);
      order.push(`durable:${context.pageNumber}:${records.length}`);
    },
    commitCursor: async cursor => {
      assert.equal(cursor, finalCursor);
      order.push('commit');
    },
  });
  assert.equal(calls[1].url, next);
  assert.deepEqual(order, ['start:1', 'durable:1:0', 'start:2', 'durable:2:1', 'commit']);
  assert.equal(result.messages, 1);
});

test('uses stored opaque cursor verbatim', async () => {
  const { reader, calls } = fixture([json({ value: [], '@odata.deltaLink': finalCursor })]);
  const cursor = `${base}?$deltatoken=original%2Bcase%3D`;
  await reader.readDelta(MAILBOX, 'Inbox', { ...callbacks(), cursor });
  assert.equal(calls[0].url, cursor);
});

test('accepts documented same-folder OData pagination form and keeps folder ID case', async () => {
  const odata = `https://graph.microsoft.com/v1.0/users/${MAILBOX}/mailfolders('FolderAbC%3D')/messages/delta?$deltatoken=end`;
  const { reader } = fixture([json({ value: [], '@odata.deltaLink': odata })]);
  assert.equal((await reader.readDelta(MAILBOX, 'FolderAbC=', callbacks())).deltaLink, odata);
});

test('unsafe stored cursors fail before any token or HTTP request', async t => {
  const cases = [
    base.replace('graph.microsoft.com', 'graph.microsoft.com.attacker.test'),
    base.replace('https://', 'http://'),
    base.replace('graph.microsoft.com', 'attacker@graph.microsoft.com'),
    base.replace('graph.microsoft.com', 'graph.microsoft.com:8443'),
    base.replace(MAILBOX, OTHER),
    base.replace('/Inbox/', '/SentItems/'),
    base.replace('/Inbox/', '/%49nbox/../SentItems/'),
    base.replace('/Inbox/', '/Inbox/%2e%2e/'),
    base.replace('/v1.0/', '/beta/'),
    base.replace('/messages/delta', '/messages'),
    `${base}#fragment`,
    `${base}?$select=id,body`,
    `${base}?$expand=attachments`,
    `${base}?$select=id&$SELECT=subject`,
    `${base}?$filter=receivedDateTime%20gt%202026-01-01`,
    `${base}\r\nAuthorization:evil`,
    base.replace('/v1.0/', '\\v1.0/'),
  ];
  for (const [index, cursor] of cases.entries()) {
    await t.test(`cursor boundary ${index + 1}`, async () => {
      const { reader, tokens, calls } = fixture([]);
      await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', { ...callbacks(), cursor }), code('UNSAFE_GRAPH_URL'));
      assert.equal(tokens.length, 0);
      assert.equal(calls.length, 0);
    });
  }
});

test('malicious provider nextLink is rejected without following or committing it', async () => {
  const { reader, calls } = fixture([json({ value: [{ id: 'm1' }],
    '@odata.nextLink': `https://attacker.test/?token=please` })]);
  let committed = false;
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', {
    onPage: async () => {}, commitCursor: async () => { committed = true; },
  }), code('UNSAFE_GRAPH_URL'));
  assert.equal(calls.length, 1);
  assert.equal(committed, false);
});

test('folder identity mismatch in final cursor cannot advance checkpoint', async () => {
  const { reader } = fixture([json({ value: [], '@odata.deltaLink': finalCursor.replace('/Inbox/', '/inbox/') })]);
  let committed = false;
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', {
    onPage: async () => {}, commitCursor: async () => { committed = true; },
  }), code('UNSAFE_GRAPH_URL'));
  assert.equal(committed, false);
});

test('redirects are denied even to another valid Graph path', async () => {
  const { reader, calls } = fixture([new Response(null, {
    status: 302, headers: { location: base.replace(MAILBOX, OTHER) },
  })]);
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', callbacks()), code('GRAPH_REDIRECT_DENIED'));
  assert.equal(calls.length, 1);
});

test('honors Retry-After for 429 and 503 within bounded retry count', async () => {
  const { reader, calls, sleeps } = fixture([
    json({}, 429, { 'retry-after': '2' }),
    json({}, 503, { 'retry-after': '1' }),
    json({ value: [], '@odata.deltaLink': finalCursor }),
  ]);
  await reader.readDelta(MAILBOX, 'Inbox', callbacks());
  assert.deepEqual(sleeps, [2000, 1000]);
  assert.equal(calls.length, 3);
});

test('long Retry-After is deferred rather than retried earlier than Microsoft requests', async () => {
  const { reader, sleeps, calls } = fixture([json({}, 429, { 'retry-after': '600' })]);
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', callbacks()), error =>
    error.code === 'GRAPH_RETRY_DEFERRED' && error.retryAfterMs === 600_000);
  assert.deepEqual(sleeps, []);
  assert.equal(calls.length, 1);
});

test('exhausted retry budget preserves checkpoint and does not sleep again', async () => {
  const { reader, sleeps, calls } = fixture([
    json({}, 503, { 'retry-after': '1' }), json({}, 503, { 'retry-after': '1' }),
  ], { maxRetries: 1 });
  let commits = 0;
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', {
    onPage: async () => {}, commitCursor: async () => { commits += 1; },
  }), code('GRAPH_RETRY_DEFERRED'));
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(commits, 0);
});

test('permission failure is not retried or logged with provider error content', async () => {
  const { reader, calls } = fixture([json({ error: { message: 'SECRET-BODY' } }, 403)]);
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', callbacks()), error => {
    assert.equal(error.status, 403);
    assert.ok(!error.message.includes('SECRET-BODY'));
    return error.code === 'GRAPH_HTTP_ERROR';
  });
  assert.equal(calls.length, 1);
});

test('410 demands explicit rebaseline and does not follow Location', async () => {
  const { reader, calls } = fixture([json({}, 410, { location: 'https://attacker.test' })]);
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', callbacks()), code('GRAPH_RESYNC_REQUIRED'));
  assert.equal(calls.length, 1);
});

test('400 syncStateNotFound requires rebaseline without leaking provider error text', async () => {
  const { reader } = fixture([json({ error: { code: 'syncStateNotFound', message: 'SECRET' } }, 400)]);
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', callbacks()), error =>
    error.code === 'GRAPH_RESYNC_REQUIRED' && !error.message.includes('SECRET'));
});

test('failed onPage leaves prior cursor intact; no subsequent request or commit', async () => {
  const { reader, calls } = fixture([json({ value: [{ id: 'm1' }], '@odata.nextLink': `${base}?$skiptoken=2` })]);
  let stored = 'old-checkpoint';
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', {
    onPage: async () => { throw new Error('durability failed'); },
    commitCursor: async cursor => { stored = cursor; },
  }), /durability failed/);
  assert.equal(stored, 'old-checkpoint');
  assert.equal(calls.length, 1);
});

test('failed second page never commits first page as a final checkpoint', async () => {
  const { reader } = fixture([
    json({ value: [{ id: 'm1' }], '@odata.nextLink': `${base}?$skiptoken=2` }),
    json({}, 403),
  ]);
  let stored = 'old-checkpoint';
  let persisted = 0;
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', {
    onPage: async records => { persisted += records.length; },
    commitCursor: async cursor => { stored = cursor; },
  }), code('GRAPH_HTTP_ERROR'));
  assert.equal(persisted, 1);
  assert.equal(stored, 'old-checkpoint');
});

test('commit failures propagate; caller must implement atomic compare-and-swap persistence', async () => {
  const { reader } = fixture([json({ value: [], '@odata.deltaLink': finalCursor })]);
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', {
    onPage: async () => {}, commitCursor: async () => { throw new Error('db conflict'); },
  }), /db conflict/);
});

test('rejects malformed pages and repeated pagination instead of looping forever', async () => {
  for (const body of [
    { value: [] },
    { value: [], '@odata.nextLink': finalCursor, '@odata.deltaLink': finalCursor },
    { value: 'not an array', '@odata.deltaLink': finalCursor },
    { value: [{ subject: 'missing id' }], '@odata.deltaLink': finalCursor },
  ]) {
    const { reader } = fixture([json(body)]);
    await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', callbacks()), code('INVALID_GRAPH_PAGE'));
  }
  const repeated = `${base}?$skiptoken=loop`;
  const { reader, calls } = fixture([
    json({ value: [], '@odata.nextLink': repeated }),
    json({ value: [], '@odata.nextLink': repeated }),
  ]);
  await assert.rejects(reader.readDelta(MAILBOX, 'Inbox', callbacks()), code('GRAPH_PAGE_LIMIT'));
  assert.equal(calls.length, 2);
});

test('preserves removed marker as evidence and strips over-returned content', async () => {
  const { reader } = fixture([json({ value: [
    { id: 'm1', subject: 'Approved metadata', body: { content: 'secret' }, bodyPreview: 'secret', attachments: ['secret'] },
    { id: 'm2', '@removed': { reason: 'deleted', unrelated: 'secret' } },
  ], '@odata.deltaLink': finalCursor })]);
  let observed;
  await reader.readDelta(MAILBOX, 'Inbox', {
    onPage: async records => { observed = records; }, commitCursor: async () => {},
  });
  assert.deepEqual(observed, [
    { id: 'm1', subject: 'Approved metadata' }, { id: 'm2', '@removed': { reason: 'deleted' } },
  ]);
});

test('participant metadata is projected without extra nested content', async () => {
  const { reader } = fixture([json({ value: [{ id: 'm1',
    sender: { emailAddress: { address: 'demo@example.test', name: 'Demo', body: 'secret' }, body: 'secret' },
  }], '@odata.deltaLink': finalCursor })]);
  let observed;
  await reader.readDelta(MAILBOX, 'Inbox', {
    onPage: async records => { observed = records; }, commitCursor: async () => {},
  });
  assert.deepEqual(observed, [{ id: 'm1', sender: { emailAddress: { address: 'demo@example.test', name: 'Demo' } } }]);
});

test('readMessage fetches selected plain-text evidence and headers through scoped Graph path', async () => {
  const message = { id: 'opaque+message=', subject: 'Fictional customer request',
    body: { contentType: 'text', content: 'Please provide the specification. https://untrusted.test' },
    uniqueBody: { contentType: 'text', content: 'Please provide the specification.' },
    internetMessageHeaders: [{ name: 'In-Reply-To', value: '<previous@example.test>' }],
    from: { emailAddress: { address: 'customer@example.test' } }, isDraft: false, hasAttachments: true,
    attachments: [{ contentBytes: 'not-returned' }],
  };
  const { reader, calls } = fixture([json(message)]);
  const result = await reader.readMessage(MAILBOX, 'opaque+message=');
  assert.equal(result.body.content, message.body.content);
  assert.equal(result.attachments, undefined);
  assert.deepEqual(result.internetMessageHeaders, message.internetMessageHeaders);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/messages/opaque%2Bmessage%3D?'));
  assert.match(calls[0].options.headers.Prefer, /outlook.body-content-type="text"/);
  assert.ok(new URL(calls[0].url).searchParams.get('$select').includes('internetMessageHeaders'));
});

test('readMessage cannot change mailbox scope and treats slash-bearing opaque IDs as data', async () => {
  const { reader, calls, tokens } = fixture([json({ id: 'opaque/message+id=', body: { contentType: 'text', content: '' } })]);
  await assert.rejects(reader.readMessage(OTHER, 'm1'), code('MAILBOX_NOT_ALLOWED'));
  await assert.rejects(reader.readMessage(MAILBOX, '../messages/evil'), code('INVALID_FOLDER'));
  await assert.rejects(reader.readMessage(MAILBOX, 'encoded%2Fid'), code('INVALID_FOLDER'));
  assert.equal(tokens.length, 0);
  await reader.readMessage(MAILBOX, 'opaque/message+id=');
  assert.ok(calls[0].url.includes('/messages/opaque%2Fmessage%2Bid%3D?'));
  assert.equal(new URL(calls[0].url).hostname, 'graph.microsoft.com');
});

test('readMessage rejects HTML, redirects and mismatched message identities', async () => {
  const html = fixture([json({ id: 'm1', body: { contentType: 'html', content: '<script>bad</script>' } })]);
  await assert.rejects(html.reader.readMessage(MAILBOX, 'm1'), code('UNSUPPORTED_MESSAGE_BODY'));
  const mismatch = fixture([json({ id: 'm2' })]);
  await assert.rejects(mismatch.reader.readMessage(MAILBOX, 'm1'), code('INVALID_GRAPH_PAGE'));
  const redirect = fixture([new Response(null, { status: 302, headers: { location: 'https://attacker.test' } })]);
  await assert.rejects(redirect.reader.readMessage(MAILBOX, 'm1'), code('GRAPH_REDIRECT_DENIED'));
  assert.equal(redirect.calls.length, 1);
});

test('lists root folders across pages and does not silently crawl children', async () => {
  const next = `https://graph.microsoft.com/v1.0/users/${MAILBOX}/mailFolders?$skiptoken=next`;
  const { reader, calls } = fixture([
    json({ value: [{ id: 'Inbox', displayName: 'Inbox', childFolderCount: 2 }], '@odata.nextLink': next }),
    json({ value: [{ id: 'SentItems', displayName: 'Sent Items' }] }),
  ]);
  assert.deepEqual(await reader.listFolders(MAILBOX), [
    { id: 'Inbox', displayName: 'Inbox', childFolderCount: 2 }, { id: 'SentItems', displayName: 'Sent Items' },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, next);
});

test('listFolderTree traverses nested real folders and identifies virtual search folders', async () => {
  const { reader, calls } = fixture([
    json({ value: [
      { id: 'Inbox', childFolderCount: 1 }, { id: 'SentItems', childFolderCount: 0 },
      { id: 'Search', childFolderCount: 1, '@odata.type': '#microsoft.graph.mailSearchFolder' },
    ] }),
    json({ value: [{ id: 'CustomerA', parentFolderId: 'Inbox', childFolderCount: 1 }] }),
    json({ value: [{ id: 'OldRequests', parentFolderId: 'CustomerA', childFolderCount: 0 }] }),
  ]);
  const result = await reader.listFolderTree(MAILBOX);
  assert.deepEqual(result.map(folder => folder.id), ['Inbox', 'SentItems', 'Search', 'CustomerA', 'OldRequests']);
  assert.ok(calls[1].url.includes('/mailFolders/Inbox/childFolders?'));
  assert.ok(calls[2].url.includes('/mailFolders/CustomerA/childFolders?'));
  assert.equal(calls.length, 3);
});

test('child-folder pagination cannot switch parent folder or mailbox', async () => {
  const link = `https://graph.microsoft.com/v1.0/users/${MAILBOX}/mailFolders/OtherParent/childFolders?$skiptoken=next`;
  const { reader } = fixture([json({ value: [], '@odata.nextLink': link })]);
  await assert.rejects(reader.listFolders(MAILBOX, { parentFolderId: 'Inbox' }), code('UNSAFE_GRAPH_URL'));
});

test('folder traversal fails visibly on cycles and excessive depth', async () => {
  const cycle = fixture([
    json({ value: [{ id: 'Inbox', childFolderCount: 1 }] }),
    json({ value: [{ id: 'Inbox', childFolderCount: 1 }] }),
  ]);
  await assert.rejects(cycle.reader.listFolderTree(MAILBOX), code('GRAPH_FOLDER_LIMIT'));
  const depth = fixture(Array.from({ length: 21 }, (_, index) =>
    json({ value: [{ id: `Folder${index}`, childFolderCount: 1 }] })));
  await assert.rejects(depth.reader.listFolderTree(MAILBOX), code('GRAPH_FOLDER_LIMIT'));
  assert.equal(depth.calls.length, 21);
});

test('oversize, malformed JSON, transport and token failures are safe failures', async () => {
  const oversized = fixture([new Response('x', { headers: { 'content-length': '3000000' } })]);
  await assert.rejects(oversized.reader.readDelta(MAILBOX, 'Inbox', callbacks()), code('RESPONSE_TOO_LARGE'));
  const invalid = fixture([new Response('not json')]);
  await assert.rejects(invalid.reader.readDelta(MAILBOX, 'Inbox', callbacks()), code('INVALID_GRAPH_PAGE'));
  const network = fixture([new Error('secret transport context')]);
  await assert.rejects(network.reader.readDelta(MAILBOX, 'Inbox', callbacks()), code('GRAPH_TRANSPORT_ERROR'));
  const token = fixture([], { getAccessToken: async () => { throw new Error('secret credential'); } });
  await assert.rejects(token.reader.readDelta(MAILBOX, 'Inbox', callbacks()), code('TOKEN_UNAVAILABLE'));
  assert.equal(token.calls.length, 0);
});
