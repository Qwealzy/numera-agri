// Does the WORKING database still match sql/schema.sql?
//
// checkMigrationBase.mjs proves schema.sql applies to an empty database. This
// is the other question: whether the database everything actually runs
// against has drifted from it -- a migration applied by hand and never
// mirrored, a mirror edit never applied, a function body changed in one place.
//
// It builds a THROWAWAY database from schema.sql, reads the catalog of both,
// and prints what differs. The working database is only ever read, in a
// read-only session. The throwaway is dropped on the way out, success or not.
//
// Ignored on purpose, because both are known and documented divergences
// between the two install paths rather than drift: column order, and the
// order of enum values (see node/test/enumOrdering.test.mjs). Function bodies
// are compared with comments and blank lines removed, since the migrations
// and schema.sql carry the same code under different commentary.
//
// Exit 0 = no drift, 1 = drift, 2 = could not run.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireMaintUrl, assertMaintSameServer } from '../node/test-support/testDbGuard.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');

const CATALOG = {
  tables: `SELECT table_name AS k FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  columns: `SELECT table_name || '.' || column_name || ' ' || udt_name || ' null=' || is_nullable
                   || ' default=' || coalesce(column_default, '') AS k
            FROM information_schema.columns WHERE table_schema = 'public'`,
  constraints: `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS k
                FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
  indexes: `SELECT indexdef AS k FROM pg_indexes WHERE schemaname = 'public'`,
  triggers: `SELECT tgrelid::regclass::text || ' ' || pg_get_triggerdef(oid) AS k
             FROM pg_trigger WHERE NOT tgisinternal`,
  enums: `SELECT t.typname || ' {' || string_agg(e.enumlabel, ',' ORDER BY e.enumlabel) || '}' AS k
          FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`,
  views: `SELECT table_name || ' ' || md5(view_definition) AS k
          FROM information_schema.views WHERE table_schema = 'public'`,
};

const normalizeBody = (src) =>
  src.split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean).join('\n');

async function catalog(url, database) {
  const client = new Client({
    host: url.hostname, port: url.port || 5432, database,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const out = {};
    for (const [name, sql] of Object.entries(CATALOG)) {
      out[name] = new Set((await client.query(sql)).rows.map((r) => r.k));
    }
    const { rows } = await client.query(
      `SELECT proname || '(' || pg_get_function_identity_arguments(oid) || ')' AS sig, prosrc
       FROM pg_proc WHERE pronamespace = 'public'::regnamespace`
    );
    out.functions = new Set(rows.map((r) =>
      `${r.sig} body=${crypto.createHash('md5').update(normalizeBody(r.prosrc)).digest('hex')}`));
    return out;
  } finally {
    await client.end();
  }
}

// The comparison, exported so that npm test's drift test and doctor run this
// code rather than a copy of it. It builds the throwaway, reads both catalogs
// and drops the throwaway before it returns -- on drift and on failure alike.
// It throws if it could not run, and also if the throwaway could not be
// dropped, so a leftover database is never silent.
// DATABASE_URL names the working database; DATABASE_MAINT_URL, on the same
// server, builds and drops the throwaway and reads both catalogs. Both catalogs
// are read by one role because information_schema hides column defaults, view
// definitions and unprivileged tables from a role that does not own them.
export async function schemaDrift(databaseUrl, maintUrl) {
  requireMaintUrl(maintUrl);
  await assertMaintSameServer({ maintUrl, workingUrl: databaseUrl });
  const url = new URL(maintUrl);
  const PG = process.env.PG_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';
  const conn = ['-U', decodeURIComponent(url.username), '-h', url.hostname, '-p', url.port || '5432'];
  const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
  const run = (exe, args) =>
    execFileSync(path.join(PG, exe), args, { env: pgEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const WORKING = new URL(databaseUrl).pathname.slice(1);
  const THROWAWAY = `driftcheck_${Date.now().toString(36)}`;

  let created = false;
  let categories = null;
  let failure = null;
  try {
    run('createdb.exe', [...conn, THROWAWAY]);
    created = true;
    run('psql.exe', [...conn, '-d', THROWAWAY, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(ROOT, 'sql', 'schema.sql')]);
    const fresh = await catalog(url, THROWAWAY);
    const working = await catalog(url, WORKING);
    categories = Object.keys(fresh).map((name) => ({
      name,
      working: working[name].size,
      schema: fresh[name].size,
      onlyWorking: [...working[name]].filter((k) => !fresh[name].has(k)).sort(),
      onlySchema: [...fresh[name]].filter((k) => !working[name].has(k)).sort(),
    }));
  } catch (err) {
    failure = `could not run: ${(err.stderr || err.message).toString().trim().split('\n').slice(0, 3).join(' | ')}`;
  }
  if (created) {
    try {
      run('dropdb.exe', [...conn, THROWAWAY]);
    } catch (e) {
      throw new Error(`${failure ? `${failure}; ` : ''}FAILED to drop ${THROWAWAY}: ${e.message.slice(0, 160)}`);
    }
  }
  if (failure) throw new Error(created ? `${failure} (dropped ${THROWAWAY})` : failure);
  const drift = categories.reduce((n, c) => n + c.onlyWorking.length + c.onlySchema.length, 0);
  return { working: WORKING, throwaway: THROWAWAY, categories, drift };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 2026-09-17: the process environment wins over node/.env, as in doctor.mjs
  // and setupTestDb.mjs, so a URL given on the command line is the one used.
  for (const line of fs.readFileSync(path.join(ROOT, 'node', '.env'), 'utf8').split('\n')) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
  }
  let exitCode = 2;
  try {
    const { working: WORKING, throwaway, categories, drift } = await schemaDrift(process.env.DATABASE_URL, process.env.DATABASE_MAINT_URL);
    for (const c of categories) {
      console.log(`${c.name.padEnd(12)} working=${c.working} schema.sql=${c.schema}` +
        `${c.onlyWorking.length + c.onlySchema.length ? `  DIFFERS (${c.onlyWorking.length} + ${c.onlySchema.length})` : ''}`);
      for (const k of c.onlyWorking) console.log(`   only in ${WORKING}:   ${k.slice(0, 240)}`);
      for (const k of c.onlySchema) console.log(`   only in schema.sql: ${k.slice(0, 240)}`);
    }
    console.log(drift
      ? `\nDRIFT: ${drift} catalog entries differ between ${WORKING} and sql/schema.sql.`
      : `\nNo drift: ${WORKING} matches sql/schema.sql (column order and enum order not compared).`);
    console.log(`dropped ${throwaway}`);
    exitCode = drift ? 1 : 0;
  } catch (err) {
    console.error(err.message);
  }
  process.exitCode = exitCode;
}
