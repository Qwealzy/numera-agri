// Every value of the event_type enum has an entry in the dispatcher's
// EVENT_HANDLERS map, and the map has no entry the enum does not have.
//
// A policy_events row whose type has no entry is not refused by the
// dispatcher: `EVENT_HANDLERS[event.event_type]` is undefined, and the row
// fails with "handler is not a function", which says nothing about why. A
// type that is deliberately unsupported has an entry that rejects it
// explicitly (notImplemented). An entry with no enum value behind it can
// never be reached, because Postgres refuses to store the row.
//
// The enum is read from the database rather than from sql/schema.sql:
// enumOrdering.test.mjs already holds the two install paths to the same set
// of values, and the database is what a row is actually checked against.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { config } from '../src/config.js';
import { EVENT_HANDLERS } from '../src/dispatch/dispatcher.js';

// Read-only by construction, as in enumOrdering.test.mjs: this file runs
// against DATABASE_URL, not the guarded test database. Importing
// dispatcher.js builds src/db.js's pool as well; nothing here queries it, so
// it never opens a connection.
const pool = new pg.Pool({ connectionString: config.databaseUrl, options: '-c default_transaction_read_only=on' });

after(async () => { await pool.end(); });

test('its connection is read-only, which is what lets it run against the working database', async () => {
  const { rows } = await pool.query('SHOW default_transaction_read_only');
  assert.equal(rows[0].default_transaction_read_only, 'on');
});

async function eventTypesInDatabase() {
  const { rows } = await pool.query('SELECT unnest(enum_range(NULL::event_type)) AS value');
  return rows.map((r) => r.value);
}

test('every event_type value has a handler', async () => {
  const values = await eventTypesInDatabase();
  assert.ok(values.length > 0, 'the event_type enum has no values -- the query read nothing');
  const missing = values.filter((v) => !Object.hasOwn(EVENT_HANDLERS, v));
  assert.deepEqual(
    missing, [],
    `${missing.map((v) => `'${v}'`).join(', ')} has no handler in EVENT_HANDLERS: a row of that ` +
    `type would fail with "handler is not a function". Give it a handler, or ` +
    `notImplemented if it is deliberately unsupported.`
  );
});

test('every handler has an event_type value', async () => {
  const values = new Set(await eventTypesInDatabase());
  const extra = Object.keys(EVENT_HANDLERS).filter((k) => !values.has(k));
  assert.deepEqual(
    extra, [],
    `${extra.map((k) => `'${k}'`).join(', ')} is in EVENT_HANDLERS but not in the event_type ` +
    `enum, so no row can ever reach it.`
  );
});
