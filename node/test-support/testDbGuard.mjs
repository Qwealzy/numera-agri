// The test-database guard. Tests that write run against TEST_DATABASE_URL and
// never against DATABASE_URL, and this is what refuses to let them start
// otherwise. Two checks, both fail-closed:
//
//   1. The target is not the working database. Compared by server identity
//      (pg_control_system().system_identifier) plus database name, never by
//      URL text, so localhost and 127.0.0.1 -- or any other spelling -- of the
//      same database are caught. If the identity cannot be read, or
//      DATABASE_URL cannot be reached, it stops; it does not fall back to a
//      weaker signal and it does not skip the comparison.
//   2. The target carries a positive marker, the database-level setting
//      app.is_test_database = 'on', which only markTestDatabase() puts there
//      (called by scripts/setupTestDb.mjs). Identity alone only recognises
//      this machine's working database; the marker is what rules out every
//      other database that is not a test database.
//
// Every connection this file opens for checking is read-only.
import pg from 'pg';

export const MARKER = 'app.is_test_database';

// A connection that cannot be made within this is refused like any other
// failure. It sits below setup-test-db.mjs's 15 s limit on the whole child, so
// the test path reports this error rather than a bare timeout, and it bounds
// doctor, which calls the guard in-process, outside that limit.
const CONNECT_TIMEOUT_MS = 5000;

function describeUrl(url) {
  const u = new URL(url);
  return `database "${u.pathname.slice(1)}" on ${u.hostname}:${u.port || 5432}`;
}

async function withReadOnlyClient(url, what, fn) {
  const client = new pg.Client({
    connectionString: url,
    options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`test-database guard: cannot connect to ${what} (${describeUrl(url)}): ${err.message}. Refusing.`);
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function identity(url, what) {
  return withReadOnlyClient(url, what, async (client) => {
    let systemIdentifier;
    try {
      ({ rows: [{ s: systemIdentifier }] } = await client.query(
        'SELECT system_identifier::text AS s FROM pg_control_system()'
      ));
    } catch (err) {
      throw new Error(
        `test-database guard: cannot read the server identity (pg_control_system()) through ${what}: ` +
          `${err.message}. Refusing rather than comparing a weaker signal.`
      );
    }
    const { rows: [{ d: database }] } = await client.query('SELECT current_database() AS d');
    return { systemIdentifier, database };
  });
}

// Throws unless testUrl names a database other than the one workingUrl names.
export async function assertNotWorkingDatabase({ testUrl, workingUrl }) {
  if (!workingUrl) {
    throw new Error(
      'test-database guard: DATABASE_URL is not set, so the test database cannot be told apart from the working one. Refusing.'
    );
  }
  const target = await identity(testUrl, 'TEST_DATABASE_URL');
  const working = await identity(workingUrl, 'DATABASE_URL');
  if (target.systemIdentifier === working.systemIdentifier && target.database === working.database) {
    throw new Error(
      `test-database guard: TEST_DATABASE_URL points at the working database (same server, database ` +
        `"${target.database}"), however it is spelled. Refusing.`
    );
  }
  return target;
}

// The check a test process runs before anything else.
export async function assertTestDatabase({ testUrl, workingUrl }) {
  if (!testUrl) {
    throw new Error(
      'test-database guard: TEST_DATABASE_URL is not set. Tests that write never fall back to DATABASE_URL: ' +
        'set TEST_DATABASE_URL in node/.env to a database built by `node scripts/setupTestDb.mjs`.'
    );
  }
  const target = await assertNotWorkingDatabase({ testUrl, workingUrl });
  const marker = await withReadOnlyClient(testUrl, 'TEST_DATABASE_URL', async (client) =>
    (await client.query('SELECT current_setting($1, true) AS m', [MARKER])).rows[0].m
  );
  if (marker !== 'on') {
    throw new Error(
      `test-database guard: ${describeUrl(testUrl)} does not carry the test marker (${MARKER} = on). ` +
        'Only scripts/setupTestDb.mjs sets it. Refusing.'
    );
  }
  return target;
}

// DATABASE_MAINT_URL is the only role that creates, builds, marks and drops
// databases. Without it those steps refuse; they never fall back to
// DATABASE_URL.
export const MAINT_URL_MISSING = 'DATABASE_MAINT_URL not set: needed for CREATE DATABASE (sql/roles.sql, README Setup)';

export function requireMaintUrl(maintUrl) {
  if (!maintUrl) throw new Error(MAINT_URL_MISSING);
  return maintUrl;
}

// Throws unless DATABASE_MAINT_URL reaches the server DATABASE_URL reaches,
// compared by system_identifier as the guard compares.
export async function assertMaintSameServer({ maintUrl, workingUrl }) {
  requireMaintUrl(maintUrl);
  const maint = await identity(maintUrl, 'DATABASE_MAINT_URL');
  const working = await identity(workingUrl, 'DATABASE_URL');
  if (maint.systemIdentifier !== working.systemIdentifier) {
    throw new Error('test-database guard: DATABASE_MAINT_URL and DATABASE_URL reach different servers. Refusing.');
  }
}

// Sets the marker. Refuses first if the target is the working database, so a
// run with the wrong URL cannot mark the working database and disarm the guard.
// The ALTER DATABASE goes through DATABASE_MAINT_URL, the owner, on the
// target's server only.
export async function markTestDatabase({ testUrl, workingUrl, maintUrl }) {
  requireMaintUrl(maintUrl);
  const target = await assertNotWorkingDatabase({ testUrl, workingUrl });
  const maint = await identity(maintUrl, 'DATABASE_MAINT_URL');
  if (maint.systemIdentifier !== target.systemIdentifier) {
    throw new Error('test-database guard: DATABASE_MAINT_URL and TEST_DATABASE_URL reach different servers. Refusing.');
  }
  const client = new pg.Client({ connectionString: maintUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();
  try {
    await client.query(`ALTER DATABASE ${client.escapeIdentifier(target.database)} SET ${MARKER} = 'on'`);
  } finally {
    await client.end();
  }
}
