// Fixture for test/guardOrdering.test.mjs, which runs it in a child
// `node --test` against a marked throwaway database. It has the shape of every
// test file that writes -- the guard as the first import, src/db.js after it
// -- and asserts that the pool db.js built is connected to the test database.
//
// Not a test file of its own: it sits outside test/ and has no .test.mjs
// suffix, so neither `npm test` nor the first-import meta-test picks it up.
import './setup-test-db.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';

after(async () => {
  await pool.end();
});

test('the pool src/db.js built is connected to the test database', async () => {
  const { rows } = await pool.query('SELECT current_database() AS db');
  console.log(`ORDERING_FIXTURE current_database=${rows[0].db}`);
  assert.equal(rows[0].db, new URL(process.env.TEST_DATABASE_URL).pathname.slice(1));
});
