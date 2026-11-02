import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRequestStore } from '../src/persistence/postgres-request-store.mjs';

const ACTOR = '00000000-0000-4000-8000-000000000001';
function connectionFixture(failures = {}) {
  const state = { statements: [], releases: [], connects: 0 };
  const pool = { async connect() {
    state.connects++;
    return {
      async query(sql) {
        state.statements.push(sql);
        if (failures[sql]) throw failures[sql];
        return { rows: [], rowCount: 0 };
      },
      release(error) { state.releases.push(error); },
    };
  } };
  return { state, store: new PostgresRequestStore(pool, { actorId: ACTOR }) };
}

test('repository rejects non-UUID identities before opening a connection', async () => {
  const { store, state } = connectionFixture();
  await assert.rejects(store.read('tenant-alias', ACTOR), /UUID/);
  assert.equal(state.connects, 0);
  assert.throws(() => new PostgresRequestStore({ connect() {} }, { actorId: 'worker' }), /UUID/);
});

test('a failed callback rolls back and preserves the original error', async () => {
  const { store, state } = connectionFixture();
  const failure = new Error('event validation failed');
  await assert.rejects(store.transaction(async () => { throw failure; }), error => error === failure);
  assert.equal(state.statements.at(-1), 'ROLLBACK');
  assert.deepEqual(state.releases, [undefined]);
});

test('a failed rollback discards the connection without hiding the command error', async () => {
  const { store, state } = connectionFixture({ ROLLBACK: new Error('connection lost') });
  const failure = new Error('command failed');
  await assert.rejects(store.transaction(async () => { throw failure; }), error => error === failure);
  assert.equal(state.releases.length, 1);
  assert.ok(state.releases[0] instanceof Error);
});

test('unknown commit outcome discards the connection and never reruns the callback', async () => {
  const failure = new Error('connection lost during commit');
  const { store, state } = connectionFixture({ COMMIT: failure });
  let executions = 0;
  await assert.rejects(store.transaction(async () => { executions++; return 'result'; }), error => error === failure);
  assert.equal(executions, 1);
  assert.equal(state.connects, 1);
  assert.equal(state.releases.length, 1);
  assert.ok(state.releases[0] instanceof Error);
});

test('a successful transaction returns only after commit and releases its connection', async () => {
  const { store, state } = connectionFixture();
  assert.deepEqual(await store.transaction(async () => ({ accepted: true })), { accepted: true });
  assert.equal(state.statements.at(-1), 'COMMIT');
  assert.deepEqual(state.releases, [undefined]);
});


test('unknown BEGIN outcome discards the connection before a command can run', async () => {
  const failure = new Error('connection lost during begin');
  const { store, state } = connectionFixture({ BEGIN: failure });
  let executions = 0;
  await assert.rejects(store.transaction(async () => { executions++; }), error => error === failure);
  assert.equal(executions, 0);
  assert.equal(state.releases.length, 1);
  assert.ok(state.releases[0] instanceof Error);
});
