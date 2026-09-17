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
  ['commandId.test.mjs', 'imports only src/damlClient.js and runs against a stub ledger on loopback; touches no database'],
  ['eventWindow.test.mjs', 'imports only src/oracle/eventWindow.js, which is pure; touches no database and no ledger'],
  ['evidenceLock.test.mjs', 'runs against a throwaway database it builds from schema.sql and drops; never connects to the working or test database'],
  ['eventHandlers.test.mjs', 'reads the working database through its own read-only connection; imports dispatcher.js only for EVENT_HANDLERS, whose db.js pool it never queries'],
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
  // Not vacuous: the files that write today are among those checked.
  for (const writer of ['dispatcher.test.mjs', 'expirySweeper.test.mjs', 'graceSweeper.test.mjs']) {
    assert.ok(checked.includes(writer), `${writer} was not checked`);
  }
});
