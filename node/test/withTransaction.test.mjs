// src/db.js's withTransaction when its ROLLBACK fails: the error thrown by the
// transaction body still propagates, and the client goes back to pg-pool with
// that failure, so the pool destroys it instead of reusing a connection whose
// transaction state is unknown. pool.connect is replaced by a stub returning a
// fake client, so the pool db.js builds is never queried and no database is
// touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTransaction } from '../src/db.js';

function fakeClient({ rollbackFails }) {
  const released = [];
  const client = {
    released,
    on() {},
    removeListener() {},
    async query(sql) {
      if (sql === 'ROLLBACK' && rollbackFails) throw new Error('Client was closed');
    },
    release(...args) {
      released.push(args);
    },
  };
  return client;
}

test('a failing ROLLBACK keeps the original error and destroys the client', async (t) => {
  const client = fakeClient({ rollbackFails: true });
  t.mock.method(pool, 'connect', async () => client);
  t.mock.method(console, 'error', () => {});
  await assert.rejects(
    withTransaction(() => {
      throw new Error('business');
    }),
    { message: 'business' }
  );
  assert.equal(client.released.length, 1);
  assert.ok(client.released[0][0], 'release was not given the ROLLBACK error, so the client would be reused');
});

test('a successful ROLLBACK releases the client for reuse', async (t) => {
  const client = fakeClient({ rollbackFails: false });
  t.mock.method(pool, 'connect', async () => client);
  await assert.rejects(
    withTransaction(() => {
      throw new Error('business');
    }),
    { message: 'business' }
  );
  assert.equal(client.released.length, 1);
  assert.equal(client.released[0][0], undefined);
});
