// A connection that Postgres ends (a restart, pg_terminate_backend) must be
// logged, not crash the process. Each case runs
// test-support/dbErrorListenersFixture.mjs in a child process, which installs
// src/processHandlers.js -- whose uncaughtException handler exits 1 -- and
// ends the backend of one connection: idle in src/db.js's pool, held by
// dispatcher.js withPolicyLock, or held by db.js withTransaction.
//
// This file imports only node builtins and touches no database; the fixture
// loads the test-database guard as its first import and runs against
// TEST_DATABASE_URL, writing nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const NODE_DIR = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(NODE_DIR, 'test-support', 'dbErrorListenersFixture.mjs');
// The guard's own check runs first, in a child of the fixture.
const WAIT_MS = 30000;

function runFixture(mode) {
  const child = spawn(process.execPath, [FIXTURE, mode], { cwd: NODE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (d) => { out.stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { out.stderr += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), WAIT_MS).unref());
  return Promise.race([exited, timer]).then((exit) => {
    child.kill();
    return { exit, ...out };
  });
}

async function assertSurvives(mode, logged) {
  const { exit, stdout, stderr } = await runFixture(mode);
  const seen = `stdout: ${stdout}\nstderr: ${stderr}`;
  assert.ok(exit, `the fixture was still running after ${WAIT_MS}ms; ${seen}`);
  assert.doesNotMatch(stderr, /uncaughtException/, seen);
  assert.equal(exit.code, 0, `exit code ${exit.code}, signal ${exit.signal}; ${seen}`);
  assert.match(stdout, /DB_ERROR_FIXTURE survived/, seen);
  assert.match(stderr, logged, seen);
}

test('an idle pool client whose backend is terminated is logged and the process stays up', async () => {
  await assertSurvives('idle', /\[db\] idle client error: terminating connection due to administrator command/);
});

test("withPolicyLock's client, terminated while it holds the lock, is logged and the process stays up", async () => {
  await assertSurvives('lock', /\[dispatcher\] policy lock client error: terminating connection due to administrator command/);
});

test("withTransaction's client, terminated while a query runs, is logged and the process stays up", async () => {
  await assertSurvives('transaction', /\[db\] transaction client error: /);
});
