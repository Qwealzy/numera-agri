// The working database against sql/schema.sql, through the comparison
// scripts/checkSchemaDrift.mjs exports -- imported, not copied. A green run of
// the tests that write says nothing about the working database's schema: they
// write to the test database, which is built from schema.sql. This is what
// does. It exists because migration 028 was missing from the working database,
// every POST /policies there answered 500, and npm test stayed green.
//
// It builds a throwaway database from schema.sql, so it needs CREATEDB, and
// schemaDrift() drops it before returning, a failing run included. The
// working database is only read, in a read-only session.
// The throwaway and both catalog reads go through DATABASE_MAINT_URL.
//
// It does not load the test-database guard, because what it has to read is
// DATABASE_URL itself; guardFirstImport.test.mjs names it as an exemption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { schemaDrift } from '../../scripts/checkSchemaDrift.mjs';

test('the working database matches sql/schema.sql', async () => {
  const { working, categories, drift } = await schemaDrift(config.databaseUrl, config.databaseMaintUrl);
  const entries = categories.flatMap((c) => [
    ...c.onlyWorking.map((k) => `${c.name}: only in ${working}: ${k}`),
    ...c.onlySchema.map((k) => `${c.name}: only in sql/schema.sql: ${k}`),
  ]);
  assert.equal(
    drift,
    0,
    `"${working}" has drifted from sql/schema.sql; ${drift} catalog entries differ:\n  ${entries.join('\n  ')}\n` +
      'An existing database is brought forward by running, in order, the migrations it has not had yet ' +
      '(README, Setup). Nothing here applies them.'
  );
});
