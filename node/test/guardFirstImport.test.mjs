// Every test file under node/test/ loads the test-database guard
// (test-support/setup-test-db.mjs) as its FIRST import, except the files named
// in EXEMPT below. A test file added later that forgets it fails here, in
// `npm run test:db`, rather than running against whatever DATABASE_URL names.
//
// "First" means the first statement: only comments and blank lines may come
// before it. The guard has to be evaluated before src/db.js builds its pool,
// and an import placed after another import does not guarantee that.
//
// Exemptions are listed by file name, each with its reason -- never by
// pattern -- so an exemption cannot be widened by naming a file to match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DIR = import.meta.dirname;
const GUARD = path.resolve(TEST_DIR, '..', 'test-support', 'setup-test-db.mjs');

const EXEMPT = new Map([
  ['enumOrdering.test.mjs', 'reads the working database through its own read-only connection, and writes nothing'],
  ['testDbGuard.test.mjs', 'tests the guard itself, against throwaway databases it creates and drops'],
  ['guardFirstImport.test.mjs', 'this file: it reads source files and touches no database'],
  ['guardOrdering.test.mjs', 'runs the guard in a child process against a throwaway database it creates and drops'],
  ['schemaDrift.test.mjs', 'reads the working database read-only against a throwaway built from schema.sql, which it drops'],
  ['errorHandler.test.mjs', 'imports only express and src/errorHandler.js, which imports nothing; touches no database'],
  ['health.test.mjs', 'imports only express and src/health.js, which imports nothing; both probes are faked'],
  ['processHandlers.test.mjs', 'runs test-support/processHandlersFixture.mjs in child processes, which imports only express, src/health.js and src/processHandlers.js, neither of which imports anything; both probes are faked; touches no database'],
  ['dbErrorListeners.test.mjs', 'runs test-support/dbErrorListenersFixture.mjs in child processes, which loads the guard as its first import and so runs against TEST_DATABASE_URL, writing nothing; this file imports only node builtins and touches no database'],
  ['commandId.test.mjs', 'imports only src/damlClient.js and runs against a stub ledger on loopback; touches no database'],
  ['eventWindow.test.mjs', 'imports only src/oracle/eventWindow.js, which is pure; touches no database and no ledger'],
  ['evidenceLock.test.mjs', 'runs against a throwaway database it builds from schema.sql and drops; never connects to the working or test database'],
  ['eventHandlers.test.mjs', 'reads the working database through its own read-only connection; imports dispatcher.js only for EVENT_HANDLERS, whose db.js pool it never queries'],
  ['webhookSignature.test.mjs', 'imports only src/notifications/envelope.js and signature.js, which are pure and import only node:crypto; touches no database'],
  ['notificationsContract.test.mjs', 'reads the working database through its own read-only connection, for enum values only, and writes nothing; imports src/notifications/envelope.js, payoutRecord.js and policyRecord.js, which are pure, and neither config.js nor they build a pool'],
  ['recordProviderResponses.test.mjs', "imports only scripts/recordProviderResponses.mjs's file functions; the script's own imports are node builtins, and config.js, oracleBot.js and axios load lazily only when it records or forecasts; touches no database and no network; the file also runs the script in child processes with placeholder config that the script refuses before any request or write (in the child, config.js loads and db.js builds its pool, which is never queried; no database and no network is touched)"],
  ['oracleParse.test.mjs', 'imports src/oracle/oracleBot.js for readingFromResponse, which is pure; config.js loads and db.js builds its pool, which is never queried; touches no database and no network'],
  ['oracleEndpoint.test.mjs', 'imports config.js, damlClient.js and dispatcher.js and runs against two stub ledgers on loopback; db.js builds its pool, which is never queried, and no database is touched'],
  ['firstPremiumPaidAt.test.mjs', 'imports only scripts/lib/firstPremiumPaidAt.mjs, which is pure and imports nothing; every instant is passed in, so it touches no database, no ledger, no network and no clock'],
  ['tiers.test.mjs', 'imports only src/dispatch/tiers.js, which is pure and imports nothing; touches no database, no ledger, no network and no clock'],
  ['withTransaction.test.mjs', 'imports src/db.js, which loads config.js and builds its pool; pool.connect is replaced by a stub returning a fake client, so the pool is never queried and no database is touched'],
  ['termsContract.test.mjs', 'imports src/routes/policies.js for its exported terms field map, and src/dispatch/tiers.js (imports nothing). policies.js imports express, node:crypto, db.js (pg and config.js, which loads dotenv/config; the pool is built, never queried), notifications/payoutRecord.js and notifications/policyRecord.js (import nothing), oracle/oracleBot.js (node:url, node:crypto, node-cron, axios, db.js, config.js, oracle/eventWindow.js, damlClient.js; its main is guarded), dispatch/ledgerText.js (node:crypto only), dispatch/tiers.js, oracle/eventWindow.js (imports nothing) and dispatch/dispatcher.js (node:url, db.js, config.js, damlClient.js (axios, node:crypto, config.js), notifications/enqueue.js (imports nothing), dispatch/ledgerText.js, dispatch/tiers.js; its main is guarded). It reads docs/api/terms-v1.openapi.json and node/test-support/frostStandardGapSetFixture.json; it touches no database, no ledger and no network'],
]);

// The first line that is not blank and not part of a comment.
function firstStatement(source) {
  let inBlockComment = false;
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      inBlockComment = false;
      line = line.slice(end + 2).trim();
    }
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end === -1) {
        inBlockComment = true;
        continue;
      }
      line = line.slice(end + 2).trim();
    }
    if (line === '' || line.startsWith('//')) continue;
    return line;
  }
  return null;
}

const testFiles = fs
  .readdirSync(TEST_DIR, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.test.mjs'));

test('every exemption names a file that exists', () => {
  for (const name of EXEMPT.keys()) {
    assert.ok(fs.existsSync(path.join(TEST_DIR, name)), `${name} is exempt but does not exist -- remove it from EXEMPT`);
  }
});

test('every other test file loads the guard as its first import', () => {
  const checked = [];
  for (const rel of testFiles) {
    if (EXEMPT.has(rel)) continue;
    const file = path.join(TEST_DIR, rel);
    const first = firstStatement(fs.readFileSync(file, 'utf8'));
    const m = first?.match(/^import\s+(['"])([^'"]+)\1\s*;?\s*(\/\/.*)?$/);
    assert.ok(
      m && path.resolve(path.dirname(file), m[2]) === GUARD,
      `${rel}: its first statement must be the guard import ` +
        `(import '../test-support/setup-test-db.mjs';), but it is: ${first}`
    );
    checked.push(rel);
  }
  // Not vacuous: three of the files that write, as a sample, are among those checked.
  for (const writer of ['dispatcher.test.mjs', 'expirySweeper.test.mjs', 'graceSweeper.test.mjs']) {
    assert.ok(checked.includes(writer), `${writer} was not checked`);
  }
});
