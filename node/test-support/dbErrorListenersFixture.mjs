// Fixture for test/dbErrorListeners.test.mjs, which runs it as a child process:
// an exit can only be observed from outside the process it ends. It installs
// src/processHandlers.js the way server.js does, holds a connection from
// src/db.js's pool the way one of three paths does, and ends that
// connection's backend with pg_terminate_backend -- what a Postgres restart
// does to every connection at once.
//
// The guard is its first import, so the pool is built on TEST_DATABASE_URL.
// Nothing is written: the only statements are pg_backend_pid, an advisory
// lock and unlock on a random key, BEGIN, pg_sleep, and pg_terminate_backend
// on the fixture's own backends.
//
// Not a test file of its own: it sits outside test/ and has no .test.mjs
// suffix, so neither `npm test` nor the first-import meta-test picks it up.
//
// argv[2] is the mode:
//   idle        -- a client pool.query has returned to the pool, idle
//   lock        -- dispatcher.js withPolicyLock's client, while it holds the
//                  lock and runs no query
//   transaction -- db.js withTransaction's client, while a query runs
// Once the ended connection has been handled and SETTLE_MS more have passed,
// it prints DB_ERROR_FIXTURE survived and ends the pool.
import './setup-test-db.mjs';
import crypto from 'node:crypto';
import pg from 'pg';
import { installProcessHandlers } from '../src/processHandlers.js';
import { pool, withTransaction } from '../src/db.js';
import { withPolicyLock } from '../src/dispatch/dispatcher.js';

// A second 'error' for the same connection can come after the first.
const SETTLE_MS = 1000;

const mode = process.argv[2];
installProcessHandlers();

// Ends a backend through a connection of its own, outside the pool.
async function terminate(pid) {
  const killer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await killer.connect();
  try {
    const { rows } = await killer.query('SELECT pg_terminate_backend($1) AS ok', [pid]);
    if (!rows[0].ok) throw new Error(`pg_terminate_backend(${pid}) returned false`);
  } finally {
    await killer.end();
  }
}

async function backendPid(client) {
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
  return rows[0].pid;
}

// Not events.once: it listens for 'error' itself, which would hide the very
// crash this fixture looks for.
const next = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

if (mode === 'idle') {
  const pid = await backendPid(pool);
  const removed = next(pool, 'remove');
  await terminate(pid);
  await removed;
} else if (mode === 'lock') {
  await withPolicyLock(`dbErrorListenersFixture-${crypto.randomUUID()}`, async (client) => {
    const pid = await backendPid(client);
    const ended = next(client, 'end');
    await terminate(pid);
    await ended;
  });
} else if (mode === 'transaction') {
  await withTransaction(async (client) => {
    const pid = await backendPid(client);
    const ended = next(client, 'end');
    // Handled from the start: it rejects while terminate() is still awaited.
    const sleeping = client
      .query('SELECT pg_sleep(60)')
      .catch((err) => console.log(`DB_ERROR_FIXTURE query rejected: ${err.message}`));
    await terminate(pid);
    await sleeping;
    await ended;
  }).catch((err) => console.log(`DB_ERROR_FIXTURE withTransaction rejected: ${err.message}`));
} else {
  throw new Error(`unknown mode: ${mode}`);
}

await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
console.log('DB_ERROR_FIXTURE survived');
await pool.end();
