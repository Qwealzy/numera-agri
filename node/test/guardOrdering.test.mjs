// The ordering the guard exists for, as a regression test. It runs
// test-support/guardOrderingFixture.mjs -- the guard as the first import,
// src/db.js after it -- in a child `node --test` against a marked throwaway
// database, and requires the pool db.js built to be connected to that
// database. Should the guard module ever await at top level, ESM would
// evaluate db.js while the guard was suspended, the pool would be built on
// the working database, and this test would fail.
//
// Needs no LocalNet. Creates and drops its own throwaway database; the
// working database is only read, by the guard's identity check.
// The throwaway is created, marked and dropped through DATABASE_MAINT_URL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import 'dotenv/config';
import pg from 'pg';
import { markTestDatabase, requireMaintUrl, assertMaintSameServer } from '../test-support/testDbGuard.mjs';

const WORKING = process.env.DATABASE_URL;
const MAINT = process.env.DATABASE_MAINT_URL;
const DB = `guardorder_${Date.now().toString(36)}`;
const NODE_DIR = path.resolve(import.meta.dirname, '..');

function onDatabase(database) {
  const u = new URL(WORKING);
  u.pathname = `/${database}`;
  return u.toString();
}

async function onMaintenanceDb(sql) {
  const client = new pg.Client({ connectionString: requireMaintUrl(MAINT) });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function runFixture(testUrl) {
  // node:test marks the processes it runs with NODE_TEST_CONTEXT, and a nested
  // `node --test` that inherits it declines to run any file. The fixture is a
  // run of its own, so it must not inherit it.
  const env = { ...process.env, TEST_DATABASE_URL: testUrl };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', path.join('test-support', 'guardOrderingFixture.mjs')], {
    cwd: NODE_DIR,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

before(async () => {
  assert.ok(WORKING, 'DATABASE_URL must be set');
  await assertMaintSameServer({ maintUrl: MAINT, workingUrl: WORKING });
  await onMaintenanceDb(`CREATE DATABASE ${DB}`);
  await markTestDatabase({ testUrl: onDatabase(DB), workingUrl: WORKING, maintUrl: MAINT });
});

after(async () => {
  await onMaintenanceDb(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
});

test('a file that loads the guard first gets a src/db.js pool on the test database', () => {
  const { status, out } = runFixture(onDatabase(DB));
  assert.equal(status, 0, out);
  assert.match(out, new RegExp(`ORDERING_FIXTURE current_database=${DB}\\b`), out);
});

test('with TEST_DATABASE_URL empty, the file stops at the guard and its test never runs', () => {
  const { status, out } = runFixture('');
  assert.notEqual(status, 0, out);
  assert.match(out, /TEST_DATABASE_URL is not set/, out);
  assert.doesNotMatch(out, /ORDERING_FIXTURE/, out);
});
