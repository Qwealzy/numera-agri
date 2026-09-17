// The test-database guard (test-support/testDbGuard.mjs), exercised against
// real databases on the local server and never needing LocalNet. It must stop
// in every unsafe case and pass in the safe one. The databases it uses besides
// the working one are throwaways this file creates and drops; the working
// database is only ever connected to read-only, by the guard itself, and is
// never passed to markTestDatabase -- where a case needs "the working
// database" to be marked or markable, a throwaway stands in for it, so a bug
// in the guard cannot mark the real one.
//
// Runs under `npm run test:db` and does not load the guard itself, because it
// needs DATABASE_URL to still name the working database.
// The throwaways are created, marked and dropped through DATABASE_MAINT_URL,
// which must reach the same server; the cases themselves connect as DATABASE_URL's role.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import pg from 'pg';
import {
  assertTestDatabase, markTestDatabase, MARKER, requireMaintUrl, assertMaintSameServer,
} from '../test-support/testDbGuard.mjs';

const WORKING = process.env.DATABASE_URL;
const MAINT = process.env.DATABASE_MAINT_URL;
const suffix = Date.now().toString(36);
const UNMARKED = `guardtest_unmarked_${suffix}`;
const MARKED = `guardtest_marked_${suffix}`;

function onDatabase(database) {
  const u = new URL(WORKING);
  u.pathname = `/${database}`;
  return u.toString();
}

// The same database under another spelling of the same host.
function respelled(url) {
  const u = new URL(url);
  if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
  else if (u.hostname === '127.0.0.1') u.hostname = 'localhost';
  else throw new Error(`cannot respell host "${u.hostname}": these cases need localhost or 127.0.0.1`);
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

before(async () => {
  assert.ok(WORKING, 'DATABASE_URL must be set');
  await assertMaintSameServer({ maintUrl: MAINT, workingUrl: WORKING });
  await onMaintenanceDb(`CREATE DATABASE ${UNMARKED}`);
  await onMaintenanceDb(`CREATE DATABASE ${MARKED}`);
  await markTestDatabase({ testUrl: onDatabase(MARKED), workingUrl: WORKING, maintUrl: MAINT });
});

after(async () => {
  await onMaintenanceDb(`DROP DATABASE IF EXISTS ${UNMARKED} WITH (FORCE)`);
  await onMaintenanceDb(`DROP DATABASE IF EXISTS ${MARKED} WITH (FORCE)`);
});

test('(a) stops when TEST_DATABASE_URL is not set', async () => {
  await assert.rejects(
    assertTestDatabase({ testUrl: undefined, workingUrl: WORKING }),
    /TEST_DATABASE_URL is not set/
  );
});

test('(b) stops on a separate database that carries no marker', async () => {
  await assert.rejects(
    assertTestDatabase({ testUrl: onDatabase(UNMARKED), workingUrl: WORKING }),
    /does not carry the test marker/
  );
});

test('(c) stops on the working database spelled differently (localhost / 127.0.0.1)', async () => {
  const alias = respelled(WORKING);
  assert.notEqual(alias, WORKING);
  await assert.rejects(
    assertTestDatabase({ testUrl: alias, workingUrl: WORKING }),
    /points at the working database/
  );
});

test('(c) the identity check stops it even when the database IS marked', async () => {
  // A marked throwaway stands in for the working database, reached under two spellings.
  await assert.rejects(
    assertTestDatabase({ testUrl: respelled(onDatabase(MARKED)), workingUrl: onDatabase(MARKED) }),
    /points at the working database/
  );
});

test('stops when DATABASE_URL cannot be reached, rather than skipping the comparison', async () => {
  const unreachable = new URL(WORKING);
  unreachable.port = '1';
  await assert.rejects(
    assertTestDatabase({ testUrl: onDatabase(MARKED), workingUrl: unreachable.toString() }),
    /cannot connect to DATABASE_URL/
  );
});

test('marking refuses a target that is the working one, and leaves it unmarked', async () => {
  // An unmarked throwaway stands in for the working database.
  await assert.rejects(
    markTestDatabase({ testUrl: respelled(onDatabase(UNMARKED)), workingUrl: onDatabase(UNMARKED), maintUrl: MAINT }),
    /points at the working database/
  );
  const client = new pg.Client({ connectionString: onDatabase(UNMARKED) });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT current_setting($1, true) AS m', [MARKER]);
    assert.equal(rows[0].m, null);
  } finally {
    await client.end();
  }
});

test('passes on a separate, marked database', async () => {
  await assertTestDatabase({ testUrl: onDatabase(MARKED), workingUrl: WORKING });
});
