// The leak gate: the last step of `npm test`'s second half. It is not one of
// the files of the run that writes. test-support/runWritersThenGate.mjs starts
// it in a process of its own, only after that run's process has exited --
// whether it passed, failed or could not be started -- because a failing test
// is the likeliest to have skipped its cleanup.
//
// It requires every table in the public schema of the test database to be
// empty, payout_tiers included (test-support/leftoverRows.mjs says why that is
// the clean state). A row still here is one a test left behind.
//
// It deletes nothing: it reads through a read-only connection, and on failure
// it names each table with its row count and says how to get back to an empty
// test database. Doing that is left to a person.
import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before this file connects to it
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { leftoverRows } from '../test-support/leftoverRows.mjs';

test('the tests that write left no row in the test database', async () => {
  // The guard has checked TEST_DATABASE_URL and pointed DATABASE_URL at exactly that value.
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    options: '-c default_transaction_read_only=on',
  });
  await client.connect();
  try {
    const { database, tables, leftovers } = await leftoverRows(client);
    // Not vacuous: a database with no tables would have nothing left in it either.
    for (const table of ['insurers', 'payout_tiers']) {
      assert.ok(tables.includes(table), `${table} is not among the tables of "${database}"; nothing was checked`);
    }
    assert.equal(
      leftovers.length,
      0,
      `test database "${database}" is not empty after the tests that write: ` +
        `${leftovers.map((r) => `${r.table} x${r.n}`).join(', ')}.\n` +
        'These rows are evidence of a leak: a test that writes did not remove what it inserted. Look at them first.\n' +
        `The way back to an empty test database is to drop "${database}" -- the database current_database() ` +
        'returned here, which the guard has already confirmed is the marked test database -- and run ' +
        '`node scripts/setupTestDb.mjs` again from the repo root: it creates the database when it does not ' +
        'exist, applies sql/schema.sql when it has no tables, and marks it. Then, per the README Setup section, run ' +
        '`psql ... -v mode=test -d <test db> -f sql/roles.sql` -- setupTestDb.mjs does not apply it, and ' +
        'without it insurance_app has no table grants. This test deletes nothing.'
    );
  } finally {
    await client.end();
  }
});
