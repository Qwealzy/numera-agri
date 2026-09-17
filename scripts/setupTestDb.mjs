// Builds, or confirms, the persistent database that `npm test` writes to, and
// marks it as a test database (node/test-support/testDbGuard.mjs). Run from
// the repo root:
//
//   node scripts/setupTestDb.mjs
//
// Reads TEST_DATABASE_URL and DATABASE_URL from the environment, then from
// node/.env for anything not already set. Refuses, and marks nothing, when:
//   - TEST_DATABASE_URL is not set;
//   - it names the working database, however spelled, or DATABASE_URL cannot
//     be reached to tell (the guard's identity check);
//   - it names a database that already has tables but no marker -- this
//     script only marks a database it built itself.
// Otherwise: creates the database if it does not exist, applies sql/schema.sql
// if it has no tables, and sets the marker. Running it again on a database it
// already set up changes nothing.
// Creating the database, counting its tables, applying schema.sql and the
// marker go through DATABASE_MAINT_URL, which owns what it creates; without
// it the script refuses. The guard's identity check stays on the two URLs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
for (const line of fs.readFileSync(path.join(ROOT, 'node', '.env'), 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
  }
}

const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');
const { assertNotWorkingDatabase, markTestDatabase, MARKER, requireMaintUrl, assertMaintSameServer } = await import(
  pathToFileURL(path.join(ROOT, 'node', 'test-support', 'testDbGuard.mjs')).href
);

const testUrl = process.env.TEST_DATABASE_URL;
const workingUrl = process.env.DATABASE_URL;
const maintUrl = process.env.DATABASE_MAINT_URL;
if (!testUrl) {
  console.error('TEST_DATABASE_URL is not set (environment or node/.env). Nothing done.');
  process.exit(1);
}
try {
  requireMaintUrl(maintUrl);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const name = new URL(testUrl).pathname.slice(1);
const url = new URL(maintUrl);
const maintOnTest = new URL(maintUrl);
maintOnTest.pathname = `/${name}`;
const PG = process.env.PG_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';
const conn = ['-U', decodeURIComponent(url.username), '-h', url.hostname, '-p', url.port || '5432'];
const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
const run = (exe, args) =>
  execFileSync(path.join(PG, exe), args, { env: pgEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  await assertMaintSameServer({ maintUrl, workingUrl });
  // A database that does not exist cannot be the working one, so creating it
  // before the identity check is safe; everything after the check is not.
  const probe = new Client({ connectionString: testUrl });
  try {
    await probe.connect();
    await probe.end();
  } catch (err) {
    if (err.code !== '3D000') throw err; // 3D000: database does not exist
    run('createdb.exe', [...conn, name]);
    console.log(`created database "${name}"`);
  }

  await assertNotWorkingDatabase({ testUrl, workingUrl });

  const client = new Client({ connectionString: maintOnTest.toString() });
  await client.connect();
  const { rows: [{ n: tables }] } = await client.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'"
  );
  const { rows: [{ m: marker }] } = await client.query('SELECT current_setting($1, true) AS m', [MARKER]);
  await client.end();

  if (tables > 0 && marker !== 'on') {
    console.error(
      `refusing: "${name}" already has ${tables} tables and no ${MARKER} marker. ` +
        'This script only marks a database it built; nothing done.'
    );
    process.exit(1);
  }
  if (tables === 0) {
    run('psql.exe', [...conn, '-d', name, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(ROOT, 'sql', 'schema.sql')]);
    console.log(`applied sql/schema.sql to "${name}"`);
  }
  if (marker !== 'on') {
    await markTestDatabase({ testUrl, workingUrl, maintUrl });
    console.log(`marked "${name}" (${MARKER} = on)`);
  } else {
    console.log(`"${name}" was already set up and marked; nothing changed`);
  }
} catch (err) {
  console.error(`setupTestDb failed: ${(err.stderr || err.message).toString().trim().split('\n').slice(0, 3).join(' | ')}`);
  process.exit(1);
}
