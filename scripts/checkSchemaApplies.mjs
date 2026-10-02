// Does sql/schema.sql apply to an EMPTY database, and sql/seed.sql after it?
//
// The project requires it after every schema.sql edit, and schema.sql was
// unrunnable from the initial commit until someone ran it. This is that run:
// it creates a throwaway database, applies schema.sql and then seed.sql with
// psql -v ON_ERROR_STOP=1, and fails if either step exits non-zero or writes
// anything to stderr -- a NOTICE included. The throwaway is dropped on the way
// out, success or not, and a drop that fails is a failure too.
//
// psql rather than the pg client's multi-statement query: what is being
// checked is the install path the README gives, which is psql reading the
// file, and the two parse a file differently. psql and createdb are taken from
// PG_BIN, or from the PostgreSQL 17 default install directory when PG_BIN is
// unset, the same as checkSchemaDrift.mjs and checkMigrationBase.mjs.
//
// The connection borrowed from DATABASE_URL supplies host, port, user and
// password only; the working database is never connected to.
// Since the least-privileged role, DATABASE_MAINT_URL supplies them instead,
// and without it the script refuses.
//
//   node scripts/checkSchemaApplies.mjs [schema.sql] [seed.sql]
//
// The two paths default to the repository's own files; passing others is how
// a broken copy is checked without touching the real one.
// Exit 0 = both applied clean, 1 = they did not, or the throwaway could not be
// created or dropped.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENV_PATH = fileURLToPath(new URL('../node/.env', import.meta.url));
// 2026-09-17: the process environment wins over node/.env, as in doctor.mjs
// and setupTestDb.mjs, so a URL given on the command line is the one used.
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
}

const SCHEMA = path.resolve(process.argv[2] ?? path.join(ROOT, 'sql', 'schema.sql'));
const SEED = path.resolve(process.argv[3] ?? path.join(ROOT, 'sql', 'seed.sql'));
const PG = process.env.PG_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';
for (const exe of ['psql.exe', 'createdb.exe', 'dropdb.exe']) {
  if (!fs.existsSync(path.join(PG, exe))) {
    console.error(`${exe} not found in ${PG}; set PG_BIN to the directory that holds it`);
    process.exit(1);
  }
}

if (!process.env.DATABASE_MAINT_URL) {
  console.error('DATABASE_MAINT_URL not set: needed for CREATE DATABASE (sql/roles.sql, README Setup)');
  process.exit(1);
}
const url = new URL(process.env.DATABASE_MAINT_URL);
const conn = ['-U', decodeURIComponent(url.username), '-h', url.hostname, '-p', url.port || '5432'];
const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
const THROWAWAY = `schemaapplies_${Date.now().toString(36)}`;

// One step, reported whole: the command without the password, its exit code
// and its stderr as psql wrote it. Returns whether it was clean.
function step(label, exe, args) {
  const r = spawnSync(path.join(PG, exe), [...conn, ...args], { env, encoding: 'utf8' });
  const status = r.error ? `could not start (${r.error.message})` : `exit ${r.status}`;
  const stderr = (r.stderr ?? '').replace(/\r/g, '');
  const clean = !r.error && r.status === 0 && stderr === '';
  console.log(`${clean ? 'ok  ' : 'FAIL'} ${label}: ${exe} ${args.join(' ')} -> ${status}, stderr ${stderr.length} bytes`);
  if (stderr) console.log(stderr.trimEnd().split('\n').map((l) => `       ${l}`).join('\n'));
  return clean;
}

let ok = false;
let created = false;
try {
  created = step('create', 'createdb.exe', [THROWAWAY]);
  ok = created &&
    step('schema', 'psql.exe', ['-X', '-d', THROWAWAY, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]) &&
    step('seed', 'psql.exe', ['-X', '-d', THROWAWAY, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SEED]);
} finally {
  if (created && !step('drop', 'dropdb.exe', [THROWAWAY])) {
    console.log(`the throwaway ${THROWAWAY} was NOT dropped; drop it by hand`);
    ok = false;
  }
}

console.log(ok
  ? `${path.relative(ROOT, SCHEMA)} and ${path.relative(ROOT, SEED)} applied clean to an empty database`
  : `${path.relative(ROOT, SCHEMA)} and ${path.relative(ROOT, SEED)} did NOT apply clean to an empty database`);
process.exitCode = ok ? 0 : 1;
