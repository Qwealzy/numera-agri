// The API's error handler (src/errorHandler.js), through a real Express app on
// an ephemeral loopback port, so what is checked is what a client receives.
// No database and no ledger: the handler imports nothing, and nothing here
// touches either.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errorHandler } from '../src/errorHandler.js';

// The text a client received on 2026-09-11, from a POST /policies that failed
// in Postgres.
const PG_TEXT = 'null value in column "full_name" of relation "policyholders" violates not-null constraint';
const withStatus = (message, status) => Object.assign(new Error(message), { status });

let server;
let base;
const logged = [];

before(async () => {
  const app = express();
  app.get('/refused', (_req, _res, next) => next(withStatus('policy is not active', 409)));
  app.get('/no-status', (_req, _res, next) => next(new Error(PG_TEXT)));
  app.get('/server-error', (_req, _res, next) => next(withStatus(PG_TEXT, 500)));
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  mock.method(console, 'error', (...args) => logged.push(args));
});

after(() => {
  mock.restoreAll();
  server.close();
});

async function get(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

const loggedInFull = (seen) => logged.slice(seen).some((args) => args.some((a) => a?.message === PG_TEXT));

test('a 4xx goes out with the message the route wrote', async () => {
  assert.deepEqual(await get('/refused'), { status: 409, body: { error: 'policy is not active' } });
});

test('an error with no status is a 500 with a fixed body, and is logged in full', async () => {
  const seen = logged.length;
  assert.deepEqual(await get('/no-status'), { status: 500, body: { error: 'internal server error' } });
  assert.ok(loggedInFull(seen), 'the full error still reaches the server log');
});

test('a 500 gets the fixed body, not its message, and is logged in full', async () => {
  const seen = logged.length;
  assert.deepEqual(await get('/server-error'), { status: 500, body: { error: 'internal server error' } });
  assert.ok(loggedInFull(seen), 'the full error still reaches the server log');
});
