// Migration 032's rules on attested_evidence, exercised against a real
// database on the local server and never needing LocalNet: a response whose
// hash has been sent to the ledger cannot be deleted, the rows that hold it
// cannot be deleted, changed or truncated away -- CASCADE included -- and a
// response nothing attests to still deletes. The gate that lets DELETE and
// TRUNCATE through in a test database opens on the catalog's marker only,
// never on a session's own SET.
//
// Everything runs in a throwaway database this file builds from
// sql/schema.sql, left unmarked until the last test marks it, and drops. The
// working database and the test database are never connected to. Runs under
// `npm run test:db`, needs CREATEDB, and does not load the test-database
// guard, because it needs DATABASE_URL to reach the server;
// guardFirstImport.test.mjs names it as an exemption.
// Since the least-privileged role it reaches the server through
// DATABASE_MAINT_URL instead, and refuses without it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { requireMaintUrl } from '../test-support/testDbGuard.mjs';

const MAINT = process.env.DATABASE_MAINT_URL;
const THROWAWAY = `evidencelock_${Date.now().toString(36)}`;
const SCHEMA = new URL('../../sql/schema.sql', import.meta.url);
// The application role's cases: a login role made for this run only, given
// its grants by sql/roles.sql through psql (the file uses psql variables),
// and dropped after the throwaway, where its only grants lived.
const ROLES = new URL('../../sql/roles.sql', import.meta.url);
const ROLE = `evidencelock_role_${crypto.randomBytes(4).toString('hex')}`;
const ROLE_PASSWORD = crypto.randomBytes(18).toString('base64url');
const PG = process.env.PG_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';

let client;
let roleClient;
let roleCreated = false;

function onDatabase(database) {
  const u = new URL(requireMaintUrl(MAINT));
  u.pathname = `/${database}`;
  return u.toString();
}

async function onMaintenanceDb(sql) {
  const c = new pg.Client({ connectionString: onDatabase('postgres') });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

before(async () => {
  requireMaintUrl(MAINT);
  await onMaintenanceDb(`CREATE DATABASE ${THROWAWAY}`);
  client = new pg.Client({ connectionString: onDatabase(THROWAWAY) });
  await client.connect();
  await client.query(fs.readFileSync(SCHEMA, 'utf8'));
  await onMaintenanceDb(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}' NOSUPERUSER NOCREATEDB`);
  roleCreated = true;
});

after(async () => {
  await client?.end().catch(() => {});
  await roleClient?.end().catch(() => {});
  await onMaintenanceDb(`DROP DATABASE IF EXISTS ${THROWAWAY} WITH (FORCE)`);
  if (roleCreated) await onMaintenanceDb(`DROP ROLE IF EXISTS ${ROLE}`);
});

// sql/roles.sql applied to the throwaway with psql, as the README applies it,
// through the maintenance user DATABASE_URL names.
// That user is now DATABASE_MAINT_URL's.
function applyRoles(mode) {
  const u = new URL(requireMaintUrl(MAINT));
  const r = spawnSync(path.join(PG, 'psql.exe'), [
    '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', decodeURIComponent(u.username), '-h', u.hostname, '-p', u.port || '5432',
    '-d', THROWAWAY, '-v', `app_role=${ROLE}`, '-v', `app_password=${ROLE_PASSWORD}`, '-v', `mode=${mode}`,
    '-f', fileURLToPath(ROLES),
  ], { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, encoding: 'utf8' });
  assert.equal(r.status, 0, `psql -f sql/roles.sql (mode=${mode}) failed: ${r.error?.message ?? r.stderr}`);
}

async function connectAsRole() {
  const u = new URL(onDatabase(THROWAWAY));
  u.username = ROLE;
  u.password = ROLE_PASSWORD;
  roleClient = new pg.Client({ connectionString: u.toString() });
  await roleClient.connect();
}

async function insertResponse(db = client) {
  const body = Buffer.from(`evidenceLock fixture ${crypto.randomUUID()}`);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO oracle_raw_responses (request_url, request_params, http_status, body, sha256, fetched_at)
     VALUES ('https://fixture.invalid/compact', '{}', 200, $1, $2, now()) RETURNING id`,
    [body, sha256]
  );
  return { id, sha256 };
}

// One attested response, the way the dispatcher records it. Only the response
// id is a foreign key, so no policy, window or outbox row has to exist.
async function insertAttested(db = client) {
  const response = await insertResponse(db);
  const policyEventId = crypto.randomUUID();
  await db.query(
    `INSERT INTO attested_evidence
       (policy_event_id, raw_response_id, sha256, trigger_window_id, policy_id, command_id, attestation_ref)
     VALUES ($1,$2,$3,$4,$5,$6,'{"v":1}')`,
    [policyEventId, response.id, response.sha256, crypto.randomUUID(), crypto.randomUUID(), `exercise-${policyEventId}`]
  );
  return response;
}

// Runs fn inside a transaction that is always rolled back, so each case starts
// from an empty throwaway.
async function rolledBack(fn, db = client) {
  await db.query('BEGIN');
  try {
    return await fn();
  } finally {
    await db.query('ROLLBACK');
  }
}

// A statement that must fail, run under a savepoint so the transaction goes on.
async function refused(sql, params, pattern, db = client) {
  await db.query('SAVEPOINT refused');
  await assert.rejects(db.query(sql, params), pattern);
  await db.query('ROLLBACK TO SAVEPOINT refused');
}

test('an attested response cannot be deleted', () =>
  rolledBack(async () => {
    const response = await insertAttested();
    await refused('DELETE FROM oracle_raw_responses WHERE id = $1', [response.id], /attested_evidence/);
    const { rows } = await client.query('SELECT sha256 FROM oracle_raw_responses WHERE id = $1', [response.id]);
    assert.equal(rows[0].sha256, response.sha256, 'the bytes are still there');
  }));

test('the evidence row cannot be deleted, updated or truncated', () =>
  rolledBack(async () => {
    const response = await insertAttested();
    await refused('DELETE FROM attested_evidence WHERE raw_response_id = $1', [response.id], /attested_evidence is append-only/);
    await refused(`UPDATE attested_evidence SET command_id = 'rewritten' WHERE raw_response_id = $1`, [response.id],
      /attested_evidence is append-only/);
    await refused('TRUNCATE attested_evidence', [], /attested_evidence is append-only/);
    const { rows } = await client.query('SELECT count(*)::int AS n FROM attested_evidence');
    assert.equal(rows[0].n, 1);
  }));

test('TRUNCATE oracle_raw_responses CASCADE is refused as a whole, not applied around the evidence', () =>
  rolledBack(async () => {
    const response = await insertAttested();
    const unattested = await insertResponse();
    await refused('TRUNCATE oracle_raw_responses CASCADE', [], /attested_evidence is append-only/);
    const { rows } = await client.query('SELECT count(*)::int AS n FROM oracle_raw_responses WHERE id = ANY($1)', [
      [response.id, unattested.id],
    ]);
    assert.equal(rows[0].n, 2, 'nothing was truncated, the unattested response included');
  }));

test('a response nothing attests to still deletes', () =>
  rolledBack(async () => {
    const response = await insertResponse();
    const { rowCount } = await client.query('DELETE FROM oracle_raw_responses WHERE id = $1', [response.id]);
    assert.equal(rowCount, 1);
  }));

test("a session's own SET app.is_test_database does not open the gate", () =>
  rolledBack(async () => {
    const response = await insertAttested();
    await client.query(`SET LOCAL app.is_test_database = 'on'`);
    const { rows: [{ m }] } = await client.query(`SELECT current_setting('app.is_test_database') AS m`);
    assert.equal(m, 'on', 'the session does carry the setting');
    await refused('DELETE FROM attested_evidence WHERE raw_response_id = $1', [response.id], /attested_evidence is append-only/);
    await refused('TRUNCATE attested_evidence', [], /attested_evidence is append-only/);
  }));

// The application role, before and after sql/roles.sql. These run in order:
// the first needs the role without grants, the later ones build on them.
test('before sql/roles.sql the application role cannot even read', async () => {
  await connectAsRole();
  await assert.rejects(roleClient.query('SELECT count(*) FROM attested_evidence'),
    { code: '42501', message: /permission denied for table attested_evidence/ });
  await assert.rejects(roleClient.query('SELECT count(*) FROM policies'),
    { code: '42501', message: /permission denied for table policies/ });
});

test('sql/roles.sql mode=working, applied twice: the role writes but cannot delete attested evidence', async () => {
  applyRoles('working');
  applyRoles('working');
  await rolledBack(async () => {
    const response = await insertAttested(roleClient);
    await refused('DELETE FROM attested_evidence WHERE raw_response_id = $1', [response.id],
      /permission denied for table attested_evidence/, roleClient);
    await refused('DELETE FROM oracle_raw_responses WHERE id = $1', [response.id],
      /permission denied for table oracle_raw_responses/, roleClient);
    const { rows } = await roleClient.query('SELECT count(*)::int AS n FROM attested_evidence');
    assert.equal(rows[0].n, 1, 'the role reads what it wrote');
  }, roleClient);
});

test('the application role cannot drop the 032 trigger, mark the database or switch triggers off', async () => {
  await assert.rejects(roleClient.query('DROP TRIGGER trg_attested_evidence_no_delete ON attested_evidence'),
    { code: '42501', message: /must be owner of relation attested_evidence/ });
  await assert.rejects(roleClient.query(`ALTER DATABASE ${THROWAWAY} SET app.is_test_database = 'on'`),
    { code: '42501', message: new RegExp(`must be owner of database ${THROWAWAY}`) });
  await assert.rejects(roleClient.query(`SET session_replication_role = 'replica'`),
    { code: '42501', message: /permission denied to set parameter "session_replication_role"/ });
  const { rows: [{ marked }] } = await roleClient.query('SELECT is_marked_test_database() AS marked');
  assert.equal(marked, false, 'the throwaway is still unmarked');
});

// mode=test grants DELETE, so the refusal that remains is migration 032's own.
test("sql/roles.sql mode=test in an unmarked database: 032 refuses the role's DELETE, and its own SET does not open the gate", async () => {
  applyRoles('test');
  applyRoles('test');
  await rolledBack(async () => {
    const response = await insertAttested(roleClient);
    await refused('DELETE FROM attested_evidence WHERE raw_response_id = $1', [response.id],
      /attested_evidence is append-only/, roleClient);
    await refused('DELETE FROM oracle_raw_responses WHERE id = $1', [response.id], /attested_evidence/, roleClient);
    await roleClient.query(`SET LOCAL app.is_test_database = 'on'`);
    const { rows: [{ m }] } = await roleClient.query(`SELECT current_setting('app.is_test_database') AS m`);
    assert.equal(m, 'on', 'the session does carry the setting');
    await refused('DELETE FROM attested_evidence WHERE raw_response_id = $1', [response.id],
      /attested_evidence is append-only/, roleClient);
  }, roleClient);
});

// Last: it marks the throwaway, which cannot be undone for the tests above.
test('ALTER DATABASE ... SET app.is_test_database opens DELETE and TRUNCATE, and never UPDATE', async () => {
  await client.query(`ALTER DATABASE ${THROWAWAY} SET app.is_test_database = 'on'`);
  await rolledBack(async () => {
    // The gate reads the catalog, so a session setting to the contrary changes nothing.
    await client.query(`SET LOCAL app.is_test_database = 'off'`);
    const response = await insertAttested();
    await refused(`UPDATE attested_evidence SET command_id = 'rewritten' WHERE raw_response_id = $1`, [response.id],
      /attested_evidence is append-only/);
    await refused('DELETE FROM oracle_raw_responses WHERE id = $1', [response.id], /attested_evidence/);
    const evidence = await client.query('DELETE FROM attested_evidence WHERE raw_response_id = $1', [response.id]);
    assert.equal(evidence.rowCount, 1, 'the evidence row deletes in a marked database');
    const bytes = await client.query('DELETE FROM oracle_raw_responses WHERE id = $1', [response.id]);
    assert.equal(bytes.rowCount, 1, 'and then so does the response');
    await insertAttested();
    await client.query('TRUNCATE attested_evidence');
    const { rows } = await client.query('SELECT count(*)::int AS n FROM attested_evidence');
    assert.equal(rows[0].n, 0, 'TRUNCATE goes through too');
  });
});
