// The /health handler (src/health.js), through a real Express app on an
// ephemeral loopback port, with both probes faked. No database and no ledger:
// the handler imports nothing, and nothing here touches either.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { healthHandler } from '../src/health.js';

let databaseUp = true;
let ledgerUp = true;
let ledgerHangs = false;
let server;
let base;

before(async () => {
  const app = express();
  app.get('/health', healthHandler({
    probeDatabase: async () => { if (!databaseUp) throw new Error('database probe failed'); },
    probeLedger: async () => {
      if (ledgerHangs) await new Promise(() => {});
      if (!ledgerUp) throw new Error('ledger probe failed');
    },
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function health({ database, ledger, hangs = false }) {
  databaseUp = database;
  ledgerUp = ledger;
  ledgerHangs = hangs;
  const res = await fetch(`${base}/health`);
  return { status: res.status, body: await res.json() };
}

test('both up: 200, and both named up', async () => {
  assert.deepEqual(await health({ database: true, ledger: true }), {
    status: 200,
    body: { ok: true, dependencies: { database: 'up', ledger: 'up' } },
  });
});

test('the ledger down is still 200, and the ledger is the one named down', async () => {
  assert.deepEqual(await health({ database: true, ledger: false }), {
    status: 200,
    body: { ok: true, dependencies: { database: 'up', ledger: 'down' } },
  });
});

test('the database down is still 200, and the database is the one named down', async () => {
  assert.deepEqual(await health({ database: false, ledger: true }), {
    status: 200,
    body: { ok: true, dependencies: { database: 'down', ledger: 'up' } },
  });
});

test('both down is still 200: ok is liveness, not readiness', async () => {
  assert.deepEqual(await health({ database: false, ledger: false }), {
    status: 200,
    body: { ok: true, dependencies: { database: 'down', ledger: 'down' } },
  });
});

test('a probe that hangs is reported down rather than holding the response open', async () => {
  const started = Date.now();
  const { status, body } = await health({ database: true, ledger: true, hangs: true });
  assert.equal(status, 200);
  assert.equal(body.dependencies.ledger, 'down');
  assert.equal(body.dependencies.database, 'up');
  assert.ok(Date.now() - started < 5000, 'the timeout bounds the response');
});
