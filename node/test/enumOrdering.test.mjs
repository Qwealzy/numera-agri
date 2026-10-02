// The two install paths declare the same enum VALUES in different ORDERS.
//
// `CREATE TYPE ... AS ENUM (...)` in schema.sql fixes the sort order from the
// literal list. `ALTER TYPE ... ADD VALUE` in a migration appends, so the
// migration path's order is the chronological order in which features were
// built. Both produce the same set; neither is wrong; they simply disagree
// about `enumsortorder`.
//
// That has NO behavioural reach while nothing sorts by or range-compares one
// of these columns -- equality, IN and NOT IN are all order-independent, and
// that is all this codebase does with them. It acquires reach the moment
// something writes ORDER BY on one, or `<`, or BETWEEN, or MIN/MAX: the same
// query would then return different answers on a database built from
// schema.sql than on one grown through the migrations, and nothing would
// fail loudly to say so.
//
// Postgres cannot reorder an existing enum -- ADD VALUE ... BEFORE/AFTER
// positions only the value being added -- so reconciling the two would mean
// recreating the type and rewriting every column that uses it. That is why
// the divergence is recorded rather than fixed, and why this test exists
// instead. See the notes next to the CREATE TYPE lines in sql/schema.sql.
//
// This test does not assert an order. It asserts that nothing DEPENDS on one.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from '../src/config.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

// Read-only by construction, not by promise. This is a test file that
// runs against DATABASE_URL instead of the guarded test database (package.json
// runs it apart from the tests that write), so a write added here later fails
// in the database instead of reaching the working data. It was the first;
// eventHandlers, notificationsContract and schemaDrift now run against it too,
// each read-only.
const pool = new pg.Pool({ connectionString: config.databaseUrl, options: '-c default_transaction_read_only=on' });

after(async () => { await pool.end(); });

test('its connection is read-only, which is what lets it run against the working database', async () => {
  const { rows } = await pool.query('SHOW default_transaction_read_only');
  assert.equal(rows[0].default_transaction_read_only, 'on');
});

// --- what schema.sql declares ---------------------------------------------
// Comments are stripped first, and this is fussier than it looks. Two traps,
// both hit while writing this: the file is CRLF, so `/--.*$/` matches nothing
// (`.` will not cross the `\r`, and `$` sits after it), and if the comments
// survive, the value list is truncated at the first `)` inside one of them --
// `payout(s)` in policy_status, `m. 1434(2)` in event_type.
function enumsDeclaredInSchemaSql() {
  const text = fs.readFileSync(path.join(ROOT, 'sql/schema.sql'), 'utf8')
    .replace(/\r/g, '')
    .split('\n').map((l) => l.replace(/--.*/, '')).join('\n');
  const found = new Map();
  for (const m of text.matchAll(/CREATE\s+TYPE\s+(\w+)\s+AS\s+ENUM\s*\(([^)]*)\)/gi)) {
    found.set(m[1], [...m[2].matchAll(/'([^']*)'/g)].map((v) => v[1]));
  }
  return found;
}

// --- what the live database holds -----------------------------------------
// The working database grew through the migrations, so it IS the migration
// path's answer -- which is the only way to observe that path at all, since
// the migrations cannot be replayed from an empty database (migration 001
// assumes `policies` already exists).
async function enumsInDatabase() {
  const { rows } = await pool.query(
    `SELECT t.typname, e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder`
  );
  const found = new Map();
  for (const r of rows) {
    if (!found.has(r.typname)) found.set(r.typname, []);
    found.get(r.typname).push(r.enumlabel);
  }
  return found;
}

// The invariant that matters TODAY. schema.sql is a mirror of the migrations,
// so the two paths disagreeing about which values EXIST is a live bug, not a
// dormant one -- an insert would simply fail on one path and not the other.
test('the two install paths declare the same enum values', async () => {
  const declared = enumsDeclaredInSchemaSql();
  const live = await enumsInDatabase();

  for (const [type, values] of declared) {
    const inDb = live.get(type);
    assert.ok(inDb, `sql/schema.sql declares enum '${type}' but the database has no such type`);
    assert.deepEqual(
      [...values].sort(), [...inDb].sort(),
      `enum '${type}' has different VALUES in sql/schema.sql than in the database -- ` +
      `the mirror and the migrations have diverged, which is a live bug rather than the ` +
      `dormant ordering one`
    );
  }
});

// The dormant one, reported rather than asserted: this test never fails on the
// ordering itself. Failing on it would only push someone to "fix" it by
// rewriting one of the two paths, which is the thing that must not happen
// silently.
test('the enum ordering divergence is reported, not asserted', async () => {
  const declared = enumsDeclaredInSchemaSql();
  const live = await enumsInDatabase();
  const divergent = [];
  for (const [type, values] of declared) {
    const inDb = live.get(type);
    if (inDb && values.length === inDb.length && values.some((v, i) => v !== inDb[i])) {
      divergent.push(type);
    }
  }
  console.log(`    enum types whose ORDER differs between schema.sql and the database: ` +
    (divergent.length ? divergent.join(', ') : 'none'));
  assert.ok(true);
});

// --- the guard -------------------------------------------------------------

// Which columns actually carry a divergent enum. Read from the catalog rather
// than listed here, so a new column of one of these types is covered the day
// it is added.
async function columnsOfDivergentEnums() {
  const declared = enumsDeclaredInSchemaSql();
  const live = await enumsInDatabase();
  const divergent = new Set();
  for (const [type, values] of declared) {
    const inDb = live.get(type);
    if (inDb && values.length === inDb.length && values.some((v, i) => v !== inDb[i])) divergent.add(type);
  }
  if (divergent.size === 0) return { divergent, columns: new Set() };

  const { rows } = await pool.query(
    `SELECT DISTINCT a.attname
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped
        AND t.typname = ANY($1::text[])`,
    [[...divergent]]
  );
  return { divergent, columns: new Set(rows.map((r) => r.attname)) };
}

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (/\.(js|mjs|sql)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const d of ['node/src', 'sql', 'scripts']) walk(path.join(ROOT, d));
  return out;
}

// An ORDER BY reaches to the end of its own clause, so only the slice AFTER
// the keyword is searched -- otherwise `SELECT status ... ORDER BY created_at`
// would flag on a column it merely selects.
function orderByOffences(text, columns) {
  const hits = [];
  for (const m of text.matchAll(/ORDER\s+BY\b/gi)) {
    const rest = text.slice(m.index + m[0].length);
    const clause = rest.split(/;|`|\bLIMIT\b|\bOFFSET\b|\)\s*$/im)[0].slice(0, 200);
    for (const col of columns) {
      if (new RegExp(`\\b${col}\\b`, 'i').test(clause)) {
        hits.push({ kind: 'ORDER BY', col, snippet: `ORDER BY${clause}`.trim().slice(0, 90) });
      }
    }
  }
  return hits;
}

// Several operators CONTAIN `<` or `>` without ordering anything, and each of
// these produced a false positive before it was neutralised: SQL's `<>` (not
// equal, order-independent, and the reason this exists), Postgres's `->` and
// `->>` JSON accessors, and JavaScript's `=>`. Replaced with sentinels so the
// patterns below can stay simple and read a bare `<` or `>` as meaning it.
function neutraliseNonOrderingOperators(text) {
  return text
    .replace(/->>/g, '→→')
    .replace(/->/g, '→')
    .replace(/=>/g, '⇒')
    .replace(/<>/g, '≠');
}

function comparisonOffences(rawText, columns) {
  const text = neutraliseNonOrderingOperators(rawText);
  const hits = [];
  for (const col of columns) {
    const patterns = [
      [new RegExp(`\\b${col}\\s*(<=|>=|<|>)(?!=)`, 'gi'), 'range comparison'],
      [new RegExp(`(<=|>=|<|>)\\s*\\b${col}\\b`, 'gi'), 'range comparison'],
      [new RegExp(`\\b${col}\\s+(NOT\\s+)?BETWEEN\\b`, 'gi'), 'BETWEEN'],
      [new RegExp(`\\b(MIN|MAX|GREATEST|LEAST)\\s*\\(\\s*${col}\\b`, 'gi'), 'ordered aggregate'],
    ];
    for (const [re, kind] of patterns) {
      for (const m of text.matchAll(re)) {
        hits.push({ kind, col, snippet: text.slice(Math.max(0, m.index - 30), m.index + 60).replace(/\s+/g, ' ').trim() });
      }
    }
  }
  return hits;
}

test('no query orders by or range-compares a divergently-ordered enum', async () => {
  const { divergent, columns } = await columnsOfDivergentEnums();
  if (columns.size === 0) {
    console.log('    no divergent enums -- nothing to guard');
    return;
  }
  console.log(`    guarding columns [${[...columns].join(', ')}] of enum(s) [${[...divergent].join(', ')}]`);

  const offences = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const hit of [...orderByOffences(text, columns), ...comparisonOffences(text, columns)]) {
      offences.push(`${path.relative(ROOT, file)}: ${hit.kind} on '${hit.col}' -- ${hit.snippet}`);
    }
  }

  assert.deepEqual(
    offences, [],
    `A query now depends on the sort order of an enum whose order differs between ` +
    `sql/schema.sql and the migration path, so it would answer differently on a ` +
    `database built each way. Either stop depending on the order, or reconcile the ` +
    `two paths deliberately -- see the notes at the CREATE TYPE lines in ` +
    `sql/schema.sql.\n\n${offences.join('\n')}`
  );
});
