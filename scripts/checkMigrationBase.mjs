// Can sql/migrations/ be replayed from an empty database?
//
// schema.sql is a mirror of the numbered migrations and is verified to apply
// to an empty database on its own. The migrations are the other half of that
// claim, and nobody had ever tested them from nothing -- migration 001's own
// header says it expects the earlier schema.sql and the migration that
// followed it to have been applied first, so the schema that PREDATES the outbox is the base, and it
// is not in the repository.
//
// This creates a THROWAWAY database, applies both paths, and reports. It
// drops what it creates and never touches the working database -- the
// connection borrowed from DATABASE_URL supplies host/port/user only.
// Since the least-privileged role, DATABASE_MAINT_URL supplies it instead,
// and without it the script refuses.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENV_PATH = fileURLToPath(new URL('../node/.env', import.meta.url));
// 2026-09-17: the process environment wins over node/.env, as in doctor.mjs
// and setupTestDb.mjs, so a URL given on the command line is the one used.
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
}

if (!process.env.DATABASE_MAINT_URL) {
  console.error('DATABASE_MAINT_URL not set: needed for CREATE DATABASE (sql/roles.sql, README Setup)');
  process.exit(1);
}
const url = new URL(process.env.DATABASE_MAINT_URL);
const PG = process.env.PG_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';
const conn = ['-U', decodeURIComponent(url.username), '-h', url.hostname, '-p', url.port || '5432'];
const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
const run = (exe, args, opts = {}) =>
  execFileSync(path.join(PG, exe), args, { env, encoding: 'utf8', ...opts });

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const stamp = Date.now().toString(36);
const DB_SCHEMA = `basecheck_schema_${stamp}`;
const DB_MIGRATE = `basecheck_migrate_${stamp}`;
const psql = (db, args, opts) => run('psql.exe', [...conn, '-d', db, ...args], opts);

const created = [];
process.on('exit', () => {
  for (const db of created) {
    try { run('dropdb.exe', [...conn, db]); console.log(`dropped ${db}`); }
    catch (e) { console.error(`FAILED to drop ${db}: ${e.message.slice(0, 120)}`); }
  }
});

// --- path A: schema.sql, the supported one --------------------------------
run('createdb.exe', [...conn, DB_SCHEMA]); created.push(DB_SCHEMA);
psql(DB_SCHEMA, ['-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(ROOT, 'sql/schema.sql')]);
psql(DB_SCHEMA, ['-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(ROOT, 'sql/seed.sql')]);
console.log('schema.sql + seed.sql applied clean to an empty database');

// --- path B: the migrations in order --------------------------------------
run('createdb.exe', [...conn, DB_MIGRATE]); created.push(DB_MIGRATE);
const files = fs.readdirSync(path.join(ROOT, 'sql/migrations')).filter((f) => f.endsWith('.sql')).sort();
let failedAt = null;
for (const f of files) {
  try {
    // One psql invocation per file: ALTER TYPE ... ADD VALUE cannot be used in
    // the same transaction that later reads the new value, which is why these
    // are separate files to begin with.
    psql(DB_MIGRATE, ['-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(ROOT, 'sql/migrations', f)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`  ok   ${f}`);
  } catch (e) {
    failedAt = { file: f, error: (e.stderr || e.message).toString().trim().split('\n').slice(0, 3).join('\n') };
    console.log(`  FAIL ${f}`);
    console.log(failedAt.error.split('\n').map((l) => `       ${l}`).join('\n'));
    break;
  }
}

if (failedAt) {
  console.log(`\nThe migration sequence CANNOT be replayed from an empty database.`);
  console.log(`It stops at ${failedAt.file}, which assumes objects only the missing base creates.`);
  console.log(`sql/schema.sql is therefore the only install path that works from nothing.`);
  process.exitCode = 2;
} else {
  console.log('\nThe migration sequence CAN be replayed from an empty database.');
}
