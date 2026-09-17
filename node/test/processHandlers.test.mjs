// The process-level handlers (src/processHandlers.js), each case in a child
// process running test-support/processHandlersFixture.mjs: an exit can only be
// seen from outside the process it ends, and installing the handlers in this
// process would put them around node:test's own. No database and no ledger:
// the fixture imports only express, src/health.js and src/processHandlers.js,
// and fakes both probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const FIXTURE = path.resolve(import.meta.dirname, '..', 'test-support', 'processHandlersFixture.mjs');
const WAIT_MS = 10000;

function runFixture(mode) {
  const child = spawn(process.execPath, mode ? [FIXTURE, mode] : [FIXTURE], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (d) => { out.stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { out.stderr += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const within = (promise) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), WAIT_MS).unref())]);

  return {
    child,
    out,
    // null if the process is still running after WAIT_MS.
    exit: () => within(exited),
    // The port the fixture listens on, once it has printed it.
    port: async () => {
      const found = await within(
        new Promise((resolve) => {
          const look = () => {
            const m = out.stdout.match(/PROCESS_HANDLERS_FIXTURE port=(\d+)/);
            if (m) resolve(Number(m[1]));
          };
          child.stdout.on('data', look);
          exited.then(() => resolve(null));
          look();
        })
      );
      assert.ok(found, `the fixture never reported a port; stdout: ${out.stdout} stderr: ${out.stderr}`);
      return found;
    },
  };
}

async function health(port) {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: res.status, body: await res.json() };
}

test('an uncaught exception is logged and the process exits with a non-zero code', async () => {
  const fixture = runFixture('uncaught');
  try {
    const exit = await fixture.exit();
    assert.ok(exit, `the process was still running ${WAIT_MS}ms after the exception; stderr: ${fixture.out.stderr}`);
    assert.ok(Number.isInteger(exit.code) && exit.code !== 0, `exit code ${exit.code}, signal ${exit.signal}`);
    assert.match(fixture.out.stderr, /\[server\] uncaughtException: Error: fixture uncaught exception/);
  } finally {
    fixture.child.kill();
  }
});

test('an unhandled rejection is logged, the process stays up, and /health says degraded with 200', async () => {
  const started = Date.now();
  const fixture = runFixture('reject');
  try {
    const port = await fixture.port();
    const { status, body } = await health(port);
    assert.equal(fixture.child.exitCode, null, 'the process is still running');
    assert.equal(status, 200);
    const lastAt = body.degraded?.lastUnhandledRejectionAt;
    assert.deepEqual(body, {
      ok: true,
      dependencies: { database: 'up', ledger: 'up' },
      degraded: { unhandledRejections: 2, lastUnhandledRejectionAt: lastAt },
    });
    const at = Date.parse(lastAt);
    assert.ok(at >= started - 1000 && at <= Date.now(), `lastUnhandledRejectionAt: ${lastAt}`);
    assert.match(fixture.out.stderr, /\[server\] unhandledRejection: Error: fixture rejection one/);
    assert.match(fixture.out.stderr, /\[server\] unhandledRejection: Error: fixture rejection two/);
  } finally {
    fixture.child.kill();
  }
});

test('with no rejection, /health does not say degraded', async () => {
  const fixture = runFixture();
  try {
    const port = await fixture.port();
    assert.deepEqual(await health(port), {
      status: 200,
      body: { ok: true, dependencies: { database: 'up', ledger: 'up' } },
    });
  } finally {
    fixture.child.kill();
  }
});
