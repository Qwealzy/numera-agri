// One health report, read-only toward the data: what is running, what the
// configuration says, and whether the pieces agree with each other.
//
// Every line is [OK], [INFO], [WARN], [FAIL] or [UNKNOWN]. UNKNOWN is what a
// check that could not run reports -- a check that did not run is never shown
// as passing. FAIL is kept for configuration that is wrong or contradicts
// itself; a service that is simply not running is a WARN, with what it blocks.
//
// Read-only toward the data: nothing is written to the working database or
// the test database -- every session on them is opened read-only -- and the
// ledger is only asked for its end offset, its package list, the active
// PolicyTokens of insurer parties and the ledger user's rights. The one
// thing it creates is the
// drift check's throwaway: a single driftcheck_* database on the server,
// built from sql/schema.sql and dropped before that check returns.
// node/.env is read here so that nobody else has to print it -- no value from
// it is echoed, only key names, hosts, ports, the (public) package id and the
// ledger user id in DAML_UNSAFE_JWT_SUB.
//
//   node scripts/doctor.mjs          the report; exit 2 if it stopped early
//                                    (the checks after the one that threw did
//                                    not run), else 1 if any line is FAIL
//   node scripts/doctor.mjs --hook   the same report as SessionStart hook JSON,
//                                    always exit 0

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ledgerCommandId } from './outboxCommandId.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = process.argv.includes('--hook');
const lines = [];
const report = (status, area, text) => lines.push(`${`[${status}]`.padEnd(10)}${area}: ${text}`);

// The keys doctor consults. The file's own keys are added to these, so a key
// only the process environment defines is still picked up where doctor reads
// it.
const KEYS_READ = [
  'DATABASE_URL', 'TEST_DATABASE_URL', 'DATABASE_MAINT_URL', 'DAML_JSON_API_URL', 'DAML_JSON_API_URL_ORACLE', 'DAML_PACKAGE_ID',
  'DAML_LEDGER_TOKEN', 'DAML_UNSAFE_JWT_SECRET', 'DAML_UNSAFE_JWT_SUB', 'CLIMATE_API_URL', 'PORT', 'WEBHOOK_SIGNING_MASTER_KEY',
  'WEBHOOK_ALLOW_NON_LOOPBACK', 'WEBHOOK_STALE_PROCESSING_MS', 'DEBUG_ROUTES_ENABLED',
];

// The refusals this system makes on purpose, each one a `failed` outbox row
// that means a rule held. Listed one by one and never by a wildcard, so that
// anything else is counted as `other` rather than absorbed into "expected".
// Matched against policy_events.error because the row carries no column
// saying which kind it is -- adding one would be a migration and a change to
// the dispatcher's failure path, which is a separate decision.
const EXPECTED_REFUSALS = [
  'm. 1434(4) requires two ihtars sent within one insurance period',
  'the sigortali cannot take over before enforcement has been reported fruitless',
  'the contract was taken over by the sigortali under m. 1431(4)',
  'no m. 1456(6) request has been recorded on this policy to respond to',
  'a m. 1456(6) request is already outstanding on this policy',
  'a m. 1456(6) response cannot predate the request it answers',
  'm. 1458 retroactive-cover check REFUSED the mint',
  'is under attachment (m. 1457',
  "is not insurance for another's account",
];

function parseEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
  }
  return out;
}

// Any HTTP response at all means something is listening; only a transport
// error means it is not. Status codes are reported, not judged.
async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    // Read the body to completion: an unread one holds its socket open with
    // data pending, and this process wants to exit as soon as the report is
    // written. It is kept because /health now answers with its dependencies.
    const text = await res.text().catch(() => '');
    return { up: true, status: res.status, text };
  } catch (err) {
    return { up: false, reason: err.cause?.code ?? err.name ?? err.message };
  }
}

function newestMtime(dir, ext) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p, ext));
    else if (entry.name.endsWith(ext)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}

// --- env -------------------------------------------------------------------
let env = {};
const invalidUrls = new Set();
function checkEnv() {
  const envFile = path.join(ROOT, 'node', '.env');
  const exampleFile = path.join(ROOT, 'node', '.env.example');
  if (!fs.existsSync(envFile)) {
    report('FAIL', 'env', 'node/.env is missing (start from node/.env.example)');
    return;
  }
  // The file is the source, but the process environment wins where it defines
  // a key -- the precedence dotenv already gives config.js, and what
  // scripts/setupTestDb.mjs does. Nothing is overridden silently: the keys
  // that came from the environment get their own line below, and the lines
  // about the FILE (its key count, and the comparison with .env.example) keep
  // describing the file.
  const fileEnv = parseEnvFile(envFile);
  env = { ...fileEnv };
  const fromEnvironment = [];
  for (const k of new Set([...Object.keys(fileEnv), ...KEYS_READ])) {
    if (process.env[k] !== undefined && process.env[k] !== fileEnv[k]) {
      env[k] = process.env[k];
      fromEnvironment.push(k);
    }
  }
  // Same default config.js:40 gives the running app, so the gated checks
  // below run against it instead of being silently skipped when the key is
  // absent from both node/.env and the process environment.
  env.DAML_UNSAFE_JWT_SUB = env.DAML_UNSAFE_JWT_SUB ?? 'ledger-api-user';
  const example = fs.existsSync(exampleFile) ? parseEnvFile(exampleFile) : {};
  report('OK', 'env', `node/.env present, ${Object.keys(fileEnv).length} keys`);
  if (fromEnvironment.length) {
    report('INFO', 'env', `read from the process environment, not from node/.env: ${fromEnvironment.sort().join(', ')} (same precedence config.js gets from dotenv; the line above counts the file)`);
  }
  const missing = Object.keys(example).filter((k) => !(k in fileEnv));
  const extra = Object.keys(fileEnv).filter((k) => !(k in example));
  if (missing.length) {
    report('WARN', 'env', `in .env.example but not in .env: ${missing.join(', ')} (config.js falls back to its default where it has one)`);
  }
  if (extra.length) report('WARN', 'env', `in .env but not in .env.example: ${extra.join(', ')}`);
  for (const k of ['DATABASE_URL', 'DAML_JSON_API_URL', 'DAML_PACKAGE_ID']) {
    if (!env[k]) report('FAIL', 'env', `${k} is empty; config.js refuses to start without it`);
  }
  // 2026-09-17: "stopped early: Invalid URL" named no key, and finding the one with an extra character took a separate command
  for (const k of ['DATABASE_URL', 'TEST_DATABASE_URL', 'DATABASE_MAINT_URL']) {
    if (!env[k]) continue;
    try {
      new URL(env[k]);
    } catch {
      invalidUrls.add(k);
      report('FAIL', 'env', `${k} is not a valid URL (length ${env[k].length}; check for a trailing space, a quote, or an unencoded @ # % in the password)`);
    }
  }
  if (!env.DAML_LEDGER_TOKEN && !env.DAML_UNSAFE_JWT_SECRET) {
    report('FAIL', 'env', 'neither DAML_LEDGER_TOKEN nor DAML_UNSAFE_JWT_SECRET is set; every ledger call throws');
  }
  if (!env.CLIMATE_API_URL) {
    report('WARN', 'env', 'CLIMATE_API_URL is empty: oracleBot.js throws "CLIMATE_API_URL not configured" for every cell, so no reading and no trigger is ever raised automatically');
  }
  // Only whether it is set; the value is never printed.
  if (!env.WEBHOOK_SIGNING_MASTER_KEY) {
    report('WARN', 'env', 'WEBHOOK_SIGNING_MASTER_KEY is empty: the notification sender does not start, and no payout notification is delivered');
  }
  if (env.WEBHOOK_ALLOW_NON_LOOPBACK === 'true') {
    report('WARN', 'env', 'WEBHOOK_ALLOW_NON_LOOPBACK is true: the sender posts to addresses that are not loopback. The standing rule: nothing goes to a real insurer address before the lawyer answers');
  }
  if (env.DEBUG_ROUTES_ENABLED === 'true') {
    report('WARN', 'env', 'DEBUG_ROUTES_ENABLED is true: the /debug routes are mounted (party ids and contract payloads, no authentication, loopback only); off in any deployment');
  } else {
    report('OK', 'env', 'DEBUG_ROUTES_ENABLED is not true: the /debug routes are not mounted');
  }
}

// --- git -------------------------------------------------------------------
function checkGit() {
  const git = (...args) => spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  const status = git('status', '--porcelain');
  if (status.status !== 0) {
    report('UNKNOWN', 'git', `git status failed: ${(status.stderr || status.error?.message || '').trim()}`);
    return;
  }
  const entries = status.stdout.split('\n').filter(Boolean);
  const untracked = entries.filter((l) => l.startsWith('??')).length;
  const modified = entries.length - untracked;
  const head = git('log', '-1', '--format=%h %s').stdout.trim();
  report(modified ? 'INFO' : 'OK', 'git', `${modified} modified, ${untracked} untracked; HEAD ${head}`);
}

// --- postgres ----------------------------------------------------------------
let dbUp = false;
async function checkDatabase() {
  if (!env.DATABASE_URL) {
    report('UNKNOWN', 'postgres', 'not checked: DATABASE_URL is empty');
    return;
  }
  if (invalidUrls.has('DATABASE_URL')) {
    report('UNKNOWN', 'postgres', 'not checked: DATABASE_URL is not a valid URL');
    return;
  }
  const url = new URL(env.DATABASE_URL);
  const where = `${url.hostname}:${url.port || 5432}/${url.pathname.slice(1)}`;
  const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');
  const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    report('FAIL', 'postgres', `${where} unreachable (${err.code ?? err.message})`);
    return;
  }
  dbUp = true;
  try {
    await client.query('SET default_transaction_read_only = on');
    const { rows: [server] } = await client.query("SELECT current_setting('server_version') AS v");
    report('OK', 'postgres', `${where} reachable, server ${server.v}, session read-only`);

    // Test files promise to leave the database as they found it; these names
    // are what their fixtures and the probe scripts insert.
    const { rows: debris } = await client.query(
      `SELECT legal_name, count(*)::int AS n FROM insurers
       WHERE legal_name ILIKE '%fixture%' OR legal_name ILIKE '%throwaway%'
       GROUP BY 1 ORDER BY 2 DESC, 1`
    );
    if (debris.length) {
      report('WARN', 'db', `leftover fixture/throwaway insurers: ${debris.map((r) => `"${r.legal_name}" x${r.n}`).join(', ')}`);
    } else {
      report('OK', 'db', 'no leftover fixture/throwaway insurers');
    }

    // A drift check drops its throwaway before it returns, and throws if it
    // cannot, so a driftcheck_* database found here -- before this run's own
    // drift check has made one -- was left by a drop that failed, or belongs
    // to a drift check running elsewhere at this moment. Named, never dropped.
    const { rows: throwaways } = await client.query(
      "SELECT datname FROM pg_database WHERE starts_with(datname, 'driftcheck_') ORDER BY 1"
    );
    if (throwaways.length) {
      report('WARN', 'db', `leftover drift-check databases on the server: ${throwaways.map((r) => r.datname).join(', ')} (doctor does not drop them)`);
    } else {
      report('OK', 'db', 'no leftover driftcheck_* databases on the server');
    }

    // The other throwaways, by the prefixes the code that creates them uses:
    // checkMigrationBase.mjs, testDbGuard.test.mjs, guardOrdering.test.mjs,
    // evidenceLock.test.mjs and checkSchemaApplies.mjs. Each drops its own on
    // the way out, so one found here was left by a run that stopped before
    // its drop, or belongs to a run in progress. Named, never dropped.
    const otherPrefixes = [
      'basecheck_schema_', 'basecheck_migrate_', 'guardtest_unmarked_', 'guardtest_marked_', 'guardorder_',
      'evidencelock_', 'schemaapplies_',
    ];
    const { rows: otherThrowaways } = await client.query(
      `SELECT datname FROM pg_database d
       WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS p WHERE starts_with(d.datname, p)) ORDER BY 1`,
      [otherPrefixes]
    );
    if (otherThrowaways.length) {
      report('WARN', 'db', `leftover throwaway databases on the server: ${otherThrowaways.map((r) => r.datname).join(', ')} (doctor does not drop them)`);
    } else {
      report('OK', 'db', `no leftover ${otherPrefixes.map((p) => `${p}*`).join(', ')} databases on the server`);
    }

    // attested_evidence lets DELETE and TRUNCATE through only in a database
    // whose own catalog carries the test marker (migration 032), so the
    // working database must not carry it. Read from the catalog the way the
    // gate reads it, not from the session, which could say anything.
    const { rows: [{ marked }] } = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
          WHERE d.datname = current_database() AND s.setrole = 0
            AND 'app.is_test_database=on' = ANY (s.setconfig)
       ) AS marked`
    );
    if (marked) {
      report('FAIL', 'db', `"${url.pathname.slice(1)}" is marked as a test database (app.is_test_database=on in its catalog): attested_evidence lets DELETE and TRUNCATE through on it`);
    } else {
      report('OK', 'db', `"${url.pathname.slice(1)}" is not marked as a test database`);
    }

    // The application is meant to connect as the least-privileged role
    // sql/roles.sql creates: a superuser can drop migration 032's triggers or
    // mark the database, and createdb is the maintenance role's.
    const { rows: [role] } = await client.query(
      'SELECT current_user AS name, rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user'
    );
    report(role.rolsuper || role.rolcreatedb ? 'WARN' : 'OK', 'db',
      `connected as ${role.name}; superuser ${role.rolsuper}, createdb ${role.rolcreatedb}`);

    // The grants sql/roles.sql gives, table by table: SELECT on every public
    // table, INSERT and UPDATE on every one but policy_documents. A table
    // added without a grant shows up here.
    const WRITTEN_TABLES = [
      'insurers', 'policyholders', 'payout_tiers', 'policies', 'policy_coverages', 'oracle_raw_responses',
      'attested_evidence', 'oracle_readings', 'trigger_windows', 'policy_events', 'policy_status_history', 'payout_events',
      'payout_notifications',
    ];
    const { rows: lacking } = await client.query(
      `SELECT t.tablename, p.privilege
         FROM pg_tables t CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p(privilege)
        WHERE t.schemaname = 'public'
          AND (p.privilege = 'SELECT' OR t.tablename = ANY ($1))
          AND NOT has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), p.privilege)
        ORDER BY 1, 2`,
      [WRITTEN_TABLES]
    );
    // sql/roles.sql also grants DELETE on policy_coverages (dispatcher.js's
    // coverage replacement) and USAGE on policy_status_history_id_seq; the
    // query above only covers SELECT/INSERT/UPDATE, so check those two here.
    const { rows: [extra] } = await client.query(
      `SELECT NOT has_table_privilege(current_user, 'public.policy_coverages', 'DELETE') AS lacks_delete,
              NOT has_sequence_privilege(current_user, 'public.policy_status_history_id_seq', 'USAGE') AS lacks_seq_usage`
    );
    if (extra.lacks_delete) lacking.push({ tablename: 'policy_coverages', privilege: 'DELETE' });
    if (extra.lacks_seq_usage) lacking.push({ tablename: 'policy_status_history_id_seq', privilege: 'USAGE (sequence)' });
    if (lacking.length) {
      report('WARN', 'db', `app role privileges: ${role.name} lacks ${lacking.map((r) => `${r.privilege} on ${r.tablename}`).join(', ')} (sql/roles.sql)`);
    } else {
      report('OK', 'db', `app role privileges: ${role.name} has SELECT on every public table and INSERT, UPDATE on the ${WRITTEN_TABLES.length} the application writes`);
    }

    const { rows: outbox } = await client.query(
      `SELECT status::text AS status, count(*)::int AS n,
              EXTRACT(EPOCH FROM now() - min(created_at))::int AS oldest_s
       FROM policy_events WHERE status <> 'done' GROUP BY 1 ORDER BY 1`
    );
    if (!outbox.length) report('OK', 'db', 'outbox: nothing pending, processing or failed');
    for (const r of outbox) {
      if (r.status === 'pending') {
        // A pending trigger row claimNext holds on purpose is waiting for an
        // outcome to be recorded, one already due when such a row exists (the
        // oracle queues only a closed window). Counted apart with the
        // dispatcher's own condition (dispatcher.js TRIGGER_HOLD_PREDICATE);
        // the pending line below then counts only the rest.
        try {
          for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
          const { TRIGGER_HOLD_PREDICATE } = await import(pathToFileURL(path.join(ROOT, 'node', 'src', 'dispatch', 'dispatcher.js')).href);
          const { rows: [split] } = await client.query(
            `SELECT count(*) FILTER (WHERE held)::int AS held_n,
                    EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE held))::int AS held_oldest_s,
                    count(*) FILTER (WHERE NOT held)::int AS n,
                    EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE NOT held))::int AS oldest_s
               FROM (SELECT created_at, (${TRIGGER_HOLD_PREDICATE}) AS held
                       FROM policy_events WHERE status = 'pending') e`
          );
          if (split.held_n) {
            report('INFO', 'db', `outbox: ${split.held_n} pending trigger row(s) held on purpose by the dispatcher, oldest ` +
              `${split.held_oldest_s}s -- each one's window ends after its policy's notice deadline while default_state is ` +
              'still grace_period, or after the effective instant of a two_notice_elected policy; it is claimed once ' +
              'the grace or two-notice sweeper records that outcome, which is already due when such a row exists ' +
              '(or once a reported payment reinstates a grace_period policy)');
          }
          r.n = split.n;
          r.oldest_s = split.oldest_s;
        } catch (err) {
          report('UNKNOWN', 'db', `outbox: pending trigger rows the dispatcher holds on purpose are not told apart from ` +
            `stuck ones in the line below: ${err.message.slice(0, 140)}`);
        }
        if (!r.n) continue;
      }
      if (r.status === 'failed') {
        // A `failed` row is usually the system saying no where it should --
        // the verify scripts drive those refusals on purpose -- and a real
        // error would otherwise sit unnoticed among them. Classified by
        // matching the error text against the list above: anything that does
        // not match is counted as `other` and turns this line into a WARN,
        // never hidden. The newest row is named either way, so a fresh
        // failure is visible even when every pattern is a known one.
        const { rows: failures } = await client.query(
          `SELECT event_type::text AS event_type, created_at, error FROM policy_events
           WHERE status = 'failed' ORDER BY created_at DESC`
        );
        const other = failures.filter((f) => !EXPECTED_REFUSALS.some((p) => (f.error ?? '').includes(p)));
        const when = (f) => `${f.created_at.toISOString()} (${f.event_type})`;
        const newest = failures[0] ? `newest ${when(failures[0])}` : 'none';
        if (other.length) {
          report('WARN', 'db', `outbox: ${r.n} failed -- ${r.n - other.length} a deliberate refusal, ` +
            `${other.length} OTHER; ${newest}, newest other ${when(other[0])}. Read policy_events.error for the ${other.length}`);
        } else {
          report('INFO', 'db', `outbox: ${r.n} failed, every one a deliberate refusal by its error text; ${newest}`);
        }
      } else if (r.status === 'processing' && r.oldest_s > 300) {
        // A running dispatcher claims only `pending` rows, so an old
        // `processing` row may be one it is still working on, or one that was
        // in flight when its process exited -- and that one never moves on by
        // itself. Each row is listed with the command id to look for on the
        // ledger. Nothing here writes, retries or asks the ledger anything.
        report('WARN', 'db', `outbox: ${r.n} processing, oldest ${r.oldest_s}s since created_at -- either the dispatcher is ` +
          `not getting through them (is npm start running?), or a row was in flight when its process exited: a running ` +
          `dispatcher never claims a processing row, so such a row stays where it is. Look for its command id on the ledger; ` +
          `marking it failed is a human decision, and nothing retries it, by design`);
        const { rows: inFlight } = await client.query(
          `SELECT id, event_type::text AS event_type, policy_no,
                  EXTRACT(EPOCH FROM now() - created_at)::int AS age_s
           FROM policy_events WHERE status = 'processing' ORDER BY created_at`
        );
        for (const e of inFlight) {
          const commandId = ledgerCommandId(e);
          report('INFO', 'db', `outbox: processing ${e.event_type} ${e.id} on policy ${e.policy_no}, ${e.age_s}s since created_at; ` +
            (commandId ? `ledger command id ${commandId}` : `its event type submits no ledger command`));
        }
      } else if (r.oldest_s > 300) {
        report('WARN', 'db', `outbox: ${r.n} ${r.status}, oldest ${r.oldest_s}s -- the dispatcher is not getting through them (is npm start running?)`);
      } else {
        report('INFO', 'db', `outbox: ${r.n} ${r.status}, oldest ${r.oldest_s}s`);
      }
    }

    // The payout notification queue (migration 035). A pending row is only
    // claimed once its insurer has an address, so those without one are
    // counted apart: they wait by design, not because the sender is stuck.
    const { rows: queue } = await client.query(
      `SELECT status::text AS status, count(*)::int AS n,
              EXTRACT(EPOCH FROM now() - min(created_at))::int AS oldest_s
       FROM payout_notifications WHERE status IN ('pending', 'processing', 'failed') GROUP BY 1`
    );
    const q = Object.fromEntries(queue.map((r) => [r.status, r]));
    const count = (s) => q[s]?.n ?? 0;
    if (!queue.length) {
      report('OK', 'db', 'notifications: nothing pending, processing or failed');
    } else {
      report(count('failed') ? 'WARN' : 'INFO', 'db',
        `notifications: ${count('pending')} pending${q.pending ? ` (oldest ${q.pending.oldest_s}s since created_at)` : ''}, ` +
        `${count('processing')} processing, ${count('failed')} failed` +
        (count('failed') ? ' -- a failed notification is not retried; read payout_notifications.last_error' : ''));
    }
    if (count('pending')) {
      const { rows: [{ n: unaddressed }] } = await client.query(
        `SELECT count(*)::int AS n FROM payout_notifications pn JOIN insurers i ON i.id = pn.insurer_id
          WHERE pn.status = 'pending' AND i.webhook_url IS NULL`
      );
      report('INFO', 'db', `notifications: ${unaddressed} of the pending belong to insurers with no webhook_url; the sender does not claim them until one is set (npm run set-webhook)`);
    }
    // Same threshold the sender releases at (config.js); only counted here.
    if (count('processing')) {
      const staleMs = Number(env.WEBHOOK_STALE_PROCESSING_MS || 120000);
      const { rows: [{ n: stale }] } = await client.query(
        `SELECT count(*)::int AS n FROM payout_notifications
          WHERE status = 'processing' AND updated_at < now() - make_interval(secs => $1 / 1000.0)`,
        [staleMs]
      );
      if (stale) {
        report('WARN', 'db', `notifications: ${stale} stale in processing (updated_at older than ${staleMs}ms) -- a sender exited mid-delivery; the next sender run releases them to pending, or failed if the schedule has run out (is npm start running?)`);
      }
    }

    // The review items a human has to work: payout_events rows in
    // manual_review, a payout MarkFailed moved there or an unrouted amount
    // written there from the start (record_kind unrouted_*). Only counted.
    const { rows: review } = await client.query(
      `SELECT record_kind, status = 'manual_review' AS open, count(*)::int AS n FROM payout_events
        WHERE status = 'manual_review' OR record_kind <> 'payout' GROUP BY 1, 2`
    );
    const sum = (rows) => rows.reduce((s, r) => s + r.n, 0);
    const openOf = (kind) => sum(review.filter((r) => r.open && r.record_kind === kind));
    report('INFO', 'db', `review items: ${sum(review.filter((r) => r.open))} payout_events row(s) in manual_review -- ` +
      `record_kind payout ${openOf('payout')}, unrouted_remainder ${openOf('unrouted_remainder')}, ` +
      `unrouted_competing_claims ${openOf('unrouted_competing_claims')}; ` +
      `${sum(review.filter((r) => !r.open))} unrouted_* row(s) no longer in manual_review`);

    // The same "expired and still open" set the expiry sweeper selects; a
    // policy stays in it while its last window is pending, and the sweeper
    // logs why for each one. Only counted here.
    const { rows: [held] } = await client.query(
      `SELECT count(*)::int AS n, min(expiry) AS oldest FROM policies
        WHERE expiry < now() AND status IN ('active', 'partially_paid')`
    );
    if (!held.n) {
      report('OK', 'db', 'expiry: no policy past its expiry is still active or partially_paid');
    } else {
      report('WARN', 'db', `expiry: ${held.n} polic${held.n === 1 ? 'y' : 'ies'} past expiry still active or partially_paid, ` +
        `oldest expiry ${held.oldest.toISOString()} -- the expirySweeper log says why for each (npm run expiry-sweeper)`);
    }
  } catch (err) {
    report('FAIL', 'db', `query failed: ${err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

// --- maintenance role ------------------------------------------------------
// DATABASE_MAINT_URL: the role that creates, builds, marks and drops databases.
// The application never reads it. Its session is read-only like every other.
async function checkMaint() {
  if (!env.DATABASE_MAINT_URL) {
    report('WARN', 'maint', 'DATABASE_MAINT_URL is not set: the drift check, scripts/setupTestDb.mjs, checkSchemaApplies.mjs, checkMigrationBase.mjs, npm run verify-all and the throwaway-database tests of npm run test:db refuse without it (README, Setup)');
    return;
  }
  if (invalidUrls.has('DATABASE_MAINT_URL')) {
    report('UNKNOWN', 'maint', 'not checked: DATABASE_MAINT_URL is not a valid URL');
    return;
  }
  const url = new URL(env.DATABASE_MAINT_URL);
  const where = `${url.hostname}:${url.port || 5432}/${url.pathname.slice(1)}`;
  const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');
  const client = new Client({ connectionString: env.DATABASE_MAINT_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    report('FAIL', 'maint', `${where} unreachable through DATABASE_MAINT_URL (${err.code ?? err.message})`);
    return;
  }
  try {
    await client.query('SET default_transaction_read_only = on');
    const { rows: [role] } = await client.query(
      'SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user'
    );
    const canCreate = role.rolsuper || role.rolcreatedb;
    const canCreateRole = role.rolsuper || role.rolcreaterole;
    report(canCreate && canCreateRole ? 'OK' : 'WARN', 'maint',
      `connected as ${role.name}; superuser ${role.rolsuper}, createdb ${role.rolcreatedb}, createrole ${role.rolcreaterole}` +
        (canCreate ? '' : ': it cannot create the throwaway databases') +
        (canCreateRole ? '' : ': cannot CREATE ROLE, which node/test/evidenceLock.test.mjs needs'));
  } catch (err) {
    report('FAIL', 'maint', `query failed: ${err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

// --- test database -----------------------------------------------------------
// The database npm test's second half writes to. Whether it is the marked test
// database and not the working one is the guard's own call
// (node/test-support/testDbGuard.mjs), not a copy of its logic here; what
// counts as a leftover is test-support/leftoverRows.mjs, the same definition
// npm test's leak gate uses. Every connection either opens is read-only and
// closed before this returns. Only the database name is shown, never the URL.
async function checkTestDatabase() {
  if (!env.TEST_DATABASE_URL) {
    report('WARN', 'testdb', "TEST_DATABASE_URL is not set, so npm test's second half will not run: the test-database guard stops every file in it");
    return;
  }
  if (invalidUrls.has('TEST_DATABASE_URL')) {
    report('UNKNOWN', 'testdb', 'not checked: TEST_DATABASE_URL is not a valid URL');
    return;
  }
  if (!dbUp) {
    report('UNKNOWN', 'testdb', 'not checked: the test-database guard needs the working database to tell the two apart, and it is unreachable');
    return;
  }
  const support = (file) => pathToFileURL(path.join(ROOT, 'node', 'test-support', file)).href;
  const { assertTestDatabase } = await import(support('testDbGuard.mjs'));
  const { leftoverRows } = await import(support('leftoverRows.mjs'));
  let target;
  try {
    target = await assertTestDatabase({ testUrl: env.TEST_DATABASE_URL, workingUrl: env.DATABASE_URL });
  } catch (err) {
    report('FAIL', 'testdb', `${err.message} npm test's second half will stop at the same guard.`);
    return;
  }
  report('OK', 'testdb', `"${target.database}" is marked as a test database and is not the working one (the test-database guard's own check)`);

  const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');
  const client = new Client({ connectionString: env.TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query('SET default_transaction_read_only = on');
    const { tables, leftovers } = await leftoverRows(client);
    if (leftovers.length) {
      report('WARN', 'testdb', `leftover rows in "${target.database}": ${leftovers.map((r) => `${r.table} x${r.n}`).join(', ')} (a clean run leaves every table empty; npm test's leak gate fails on these)`);
    } else {
      report('OK', 'testdb', `"${target.database}": all ${tables.length} public tables empty`);
    }
  } catch (err) {
    report('FAIL', 'testdb', `"${target.database}": leftover count failed: ${err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

// --- schema drift -------------------------------------------------------------
// The working database against sql/schema.sql, through the comparison
// scripts/checkSchemaDrift.mjs exports: the same code npm test's drift test
// runs, not a copy. It is the one thing doctor creates -- a throwaway database
// built from schema.sql and dropped before this returns, never the working
// one, which is only read. That needs CREATEDB; without it, or without
// Postgres, the line is UNKNOWN, never OK. It applies nothing: the FAIL line
// only says how an existing database is brought forward.
// The throwaway and both catalog reads go through DATABASE_MAINT_URL.
async function checkDrift() {
  if (!dbUp) {
    report('UNKNOWN', 'drift', 'not checked: the working database is unreachable');
    return;
  }
  if (!env.DATABASE_MAINT_URL) {
    report('UNKNOWN', 'drift', 'not checked: DATABASE_MAINT_URL not set: needed for CREATE DATABASE (sql/roles.sql, README Setup)');
    return;
  }
  if (invalidUrls.has('DATABASE_MAINT_URL')) {
    report('UNKNOWN', 'drift', 'not checked: DATABASE_MAINT_URL is not a valid URL');
    return;
  }
  const { schemaDrift } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'checkSchemaDrift.mjs')).href);
  let result;
  try {
    result = await schemaDrift(env.DATABASE_URL, env.DATABASE_MAINT_URL);
  } catch (err) {
    report('UNKNOWN', 'drift', `not checked: ${err.message} (the check builds a throwaway database from sql/schema.sql, which needs DATABASE_MAINT_URL)`);
    return;
  }
  const { working, categories, drift } = result;
  if (!drift) {
    report('OK', 'drift', `"${working}" matches sql/schema.sql (column order and enum order not compared)`);
    return;
  }
  const entries = categories.flatMap((c) => [
    ...c.onlyWorking.map((k) => `only in "${working}": ${k}`),
    ...c.onlySchema.map((k) => `only in schema.sql: ${k}`),
  ]);
  const shown = entries.slice(0, 5).join('; ') + (entries.length > 5 ? `; and ${entries.length - 5} more` : '');
  report('FAIL', 'drift', `${drift} catalog entries differ between "${working}" and sql/schema.sql: ${shown}. An existing database is brought forward by running, in order, the migrations it has not had yet (README, Setup); doctor applies nothing`);
}

// --- daml package -----------------------------------------------------------
function checkPackage() {
  const yaml = fs.readFileSync(path.join(ROOT, 'daml', 'daml.yaml'), 'utf8');
  const name = yaml.match(/^name:\s*(\S+)/m)?.[1];
  const version = yaml.match(/^version:\s*(\S+)/m)?.[1];
  if (!name || !version) {
    report('UNKNOWN', 'daml', 'could not read name/version from daml/daml.yaml');
    return;
  }
  const darName = `${name}-${version}.dar`;
  const darFile = path.join(ROOT, 'daml', '.daml', 'dist', darName);
  if (!fs.existsSync(darFile)) {
    report('FAIL', 'daml', `${darName} is not built (dpm build --all)`);
    return;
  }
  // A DAR is a zip, and zip entry names are stored uncompressed. The main
  // DALF's entry name carries the package id -- the same name MANIFEST.MF's
  // Main-Dalf line gives.
  const escaped = `${name}-${version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const id = fs.readFileSync(darFile).toString('latin1').match(new RegExp(`${escaped}-([0-9a-f]{64})\\.dalf`))?.[1];
  if (!id) {
    report('UNKNOWN', 'daml', `no main DALF entry found inside ${darName}`);
  } else if (!env.DAML_PACKAGE_ID) {
    report('UNKNOWN', 'daml', `${darName} is ${id.slice(0, 12)}...; DAML_PACKAGE_ID is empty`);
  } else if (env.DAML_PACKAGE_ID === id) {
    report('OK', 'daml', `DAML_PACKAGE_ID matches ${darName} (${id.slice(0, 12)}...)`);
  } else {
    // The full id, because the fix is pasting it into node/.env -- which the
    // agent may not edit -- and a package id is a public content hash.
    report('FAIL', 'daml', `DAML_PACKAGE_ID ${env.DAML_PACKAGE_ID.slice(0, 12)}... is not ${darName}'s id; if ${darName} is the one deployed, set DAML_PACKAGE_ID=${id} in node/.env`);
  }
  const newestSource = newestMtime(path.join(ROOT, 'daml', 'daml'), '.daml');
  if (newestSource > fs.statSync(darFile).mtimeMs) {
    report('WARN', 'daml', `a .daml source is newer than ${darName}: rebuild (dpm build --all) and expect a new package id`);
  } else {
    report('OK', 'daml', `${darName} is newer than every .daml source`);
  }
}

// --- services ---------------------------------------------------------------
let ledgerUp = false;
let apiUp = false;
// The active-contract read below, kept per party for checkReadings to reuse.
const activeTokensByParty = new Map();
async function checkServices() {
  if (!env.DAML_JSON_API_URL) {
    report('UNKNOWN', 'localnet', 'not checked: DAML_JSON_API_URL is empty');
  } else {
    const base = env.DAML_JSON_API_URL.replace(/\/+$/, '');
    const { origin } = new URL(base);
    const p = await probe(`${base}/v2/version`);
    if (!p.up) {
      report('WARN', 'localnet', `${origin} unreachable (${p.reason}); npm test, the verify scripts and every ledger call need it`);
      report('UNKNOWN', 'localnet', `whether ${origin} has DAML_PACKAGE_ID is not checked: it is unreachable`);
    } else {
      ledgerUp = true;
      // getLedgerEnd is the lightest call damlClient.js exports, and it needs
      // working auth -- so an offset here means the ledger answers AND this
      // configuration may talk to it.
      let client;
      try {
        for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
        client = await import(pathToFileURL(path.join(ROOT, 'node', 'src', 'damlClient.js')).href);
        report('OK', 'localnet', `${origin} answers; ledger end offset ${await client.getLedgerEnd()}`);
      } catch (err) {
        report('FAIL', 'localnet', `${origin} answers HTTP ${p.status}, but the ledger-end call failed: ${err.message.slice(0, 200)}`);
      }
      // The READ path, separately from the write path above: an active-contract
      // read for one insurer party. It is its own line because it fails on its
      // own -- a party over the participant's list limit (200 elements here)
      // makes every reader fail while everything else still looks healthy, and
      // payoutListener logs that failure and continues, so it goes quiet
      // without anything else saying so. A read, like the rest of this file.
      if (client && dbUp) {
        try {
          const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');
          const pgClient = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
          await pgClient.connect();
          let party;
          try {
            await pgClient.query('SET default_transaction_read_only = on');
            party = (await pgClient.query(
              `SELECT canton_party_id FROM insurers
               WHERE canton_party_id IS NOT NULL AND is_active = true ORDER BY created_at LIMIT 1`
            )).rows[0]?.canton_party_id;
          } finally {
            await pgClient.end().catch(() => {});
          }
          if (!party) {
            report('UNKNOWN', 'localnet', 'the active-contract read is not checked: no insurer has an allocated party');
          } else {
            const entries = await client.queryActiveContracts({
              moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', parties: [party],
            });
            activeTokensByParty.set(party, entries);
            report('OK', 'localnet', `active-contract read works for ${party.split('::')[0]}: ${entries.length} PolicyToken(s) under the current package`);
          }
        } catch (err) {
          report('FAIL', 'localnet', `the active-contract read FAILED (${err.message.slice(0, 140)}). ` +
            'While this fails, payoutListener logs the error and carries on -- it stops tracking payouts without stopping; ' +
            '/debug/contracts answers 500 and the verify scripts fail. If it is the list limit, archive that party\'s contracts (the package-migration cleanup step)');
        }
      }

      // Only the CONFIGURED participant is asked, and the line says which:
      // LocalNet runs two (app provider :3975, app user :2975), each vetting
      // packages for itself, and this configuration talks to one of them. A
      // read, like everything else here.
      if (!client) {
        report('UNKNOWN', 'localnet', `whether ${origin} has DAML_PACKAGE_ID is not checked: damlClient.js could not be loaded`);
      } else if (!env.DAML_PACKAGE_ID) {
        report('UNKNOWN', 'localnet', `whether ${origin} has the package is not checked: DAML_PACKAGE_ID is empty`);
      } else {
        try {
          const ids = await client.listPackageIds();
          if (ids.includes(env.DAML_PACKAGE_ID)) {
            report('OK', 'localnet', `${origin} has DAML_PACKAGE_ID vetted, among ${ids.length} packages`);
          } else {
            report('FAIL', 'localnet', `${origin} does not have DAML_PACKAGE_ID ${env.DAML_PACKAGE_ID.slice(0, 12)}... among its ${ids.length} packages: every mint against it fails on an unknown template until that DAR is uploaded there`);
          }
        } catch (err) {
          report('UNKNOWN', 'localnet', `whether ${origin} has DAML_PACKAGE_ID is not checked: the package listing failed (${err.message.slice(0, 120)})`);
        }
      }

      // The ledger user's rights: how many, and how many CanReadAs. The
      // production path grants no CanReadAs, so any held is a leftover. The
      // cap is quoted from the package-migration document, not a threshold of this
      // file's own. A read, like the rest.
      if (client && env.DAML_UNSAFE_JWT_SUB) {
        try {
          const user = env.DAML_UNSAFE_JWT_SUB;
          const rights = await client.listUserRights(user);
          const readAs = rights.filter((r) => r.kind?.CanReadAs).length;
          let cap = '';
          try {
            const m = fs.readFileSync(path.join(ROOT, 'docs', 'package-migration.md'), 'utf8').match(/caps a user at (\d+) rights/);
            if (m) cap = `; the cap is ${m[1]} (per the package-migration document)`;
          } catch { /* no cap quoted if the document cannot be read */ }
          report(readAs > 0 ? 'WARN' : 'OK', 'localnet',
            `${user} holds ${rights.length} rights, ${readAs} of them CanReadAs${cap}` +
            (readAs > 0 ? '; every CanReadAs is a leftover: a maintenance script kept outside this repository lists them and can revoke them' : ''));
        } catch (err) {
          report('UNKNOWN', 'localnet', `the ledger user's rights are not checked: the listing failed (${err.message.slice(0, 120)})`);
        }
      }

      // --- the SECOND participant, where the oracle operator may live ------
      // One line when there is no second participant, and the whole set of
      // checks the configured one already gets when there is: it answers, it
      // has the package (a participant that does not have DAML_PACKAGE_ID
      // refuses every exercise against it as an unknown template), and how
      // many rights its own ledger user holds. Rights are granted PER
      // participant, which is what the last block per insurer reads.
      const oracleBase = (env.DAML_JSON_API_URL_ORACLE ?? '').replace(/\/+$/, '');
      if (!oracleBase) {
        report('OK', 'oracle-node',
          'DAML_JSON_API_URL_ORACLE is empty: the oracle operator shares the insurer\'s participant, ' +
          `${origin}. Set it to host the oracle elsewhere (node/.env.example says what changes)`);
      } else if (oracleBase === base) {
        report('WARN', 'oracle-node',
          `DAML_JSON_API_URL_ORACLE is set to ${oracleBase}, the same address as DAML_JSON_API_URL: ` +
          'that is the single-participant configuration written twice, not a second node -- leave it empty instead');
      } else {
        const oracleOrigin = new URL(oracleBase).origin;
        const op = await probe(`${oracleBase}/v2/version`);
        if (!op.up) {
          report('FAIL', 'oracle-node',
            `DAML_JSON_API_URL_ORACLE ${oracleOrigin} is set but unreachable (${op.reason}). Nothing falls back ` +
            `to ${origin}: every trigger fails until it answers, and the dispatcher says so at startup`);
        } else if (!client) {
          report('UNKNOWN', 'oracle-node', `${oracleOrigin} answers, but nothing else is checked: damlClient.js could not be loaded`);
        } else {
          try {
            report('OK', 'oracle-node', `${oracleOrigin} answers; ledger end offset ${await client.getLedgerEnd({ endpoint: oracleBase })}`);
          } catch (err) {
            report('FAIL', 'oracle-node', `${oracleOrigin} answers HTTP ${op.status}, but the ledger-end call failed: ${err.message.slice(0, 200)}`);
          }
          if (!env.DAML_PACKAGE_ID) {
            report('UNKNOWN', 'oracle-node', `whether ${oracleOrigin} has the package is not checked: DAML_PACKAGE_ID is empty`);
          } else {
            try {
              const ids = await client.listPackageIds({ endpoint: oracleBase });
              if (ids.includes(env.DAML_PACKAGE_ID)) {
                report('OK', 'oracle-node', `${oracleOrigin} has DAML_PACKAGE_ID vetted, among ${ids.length} packages`);
              } else {
                report('FAIL', 'oracle-node',
                  `${oracleOrigin} does not have DAML_PACKAGE_ID ${env.DAML_PACKAGE_ID.slice(0, 12)}... among its ` +
                  `${ids.length} packages: every trigger submitted there fails on an unknown template until that DAR ` +
                  'is uploaded to it (scripts/uploadDar.mjs uploads to DAML_JSON_API_URL and DAML_JSON_API_URL_ORACLE)');
              }
            } catch (err) {
              report('UNKNOWN', 'oracle-node', `whether ${oracleOrigin} has DAML_PACKAGE_ID is not checked: the package listing failed (${err.message.slice(0, 120)})`);
            }
          }
          if (env.DAML_UNSAFE_JWT_SUB) {
            try {
              const rights = await client.listUserRights(env.DAML_UNSAFE_JWT_SUB, { endpoint: oracleBase });
              const readAs = rights.filter((r) => r.kind?.CanReadAs).length;
              report(readAs > 0 ? 'WARN' : 'OK', 'oracle-node',
                `${env.DAML_UNSAFE_JWT_SUB} holds ${rights.length} rights on ${oracleOrigin}, ${readAs} of them CanReadAs` +
                (readAs > 0 ? '; every CanReadAs is a leftover' : ''));
            } catch (err) {
              report('UNKNOWN', 'oracle-node', `the rights on ${oracleOrigin} are not checked: the listing failed (${err.message.slice(0, 120)})`);
            }
          }
        }
      }

      // WHERE EACH INSURER'S ORACLE PARTY ACTUALLY LIVES, asked of the
      // network rather than derived from configuration or from a column: a
      // CanActAs right is granted per participant, so the participant that
      // holds one for the oracle party is the participant that hosts it
      // (measured, phase 2 of a two-participant wire check kept outside this repository). No
      // party id is printed -- only the insurer's name and which side it is
      // on. An insurer onboarded before DAML_JSON_API_URL_ORACLE was set
      // shows up here as still sharing the insurer's participant.
      if (client && dbUp && env.DAML_UNSAFE_JWT_SUB) {
        try {
          const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');
          const pgClient = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
          await pgClient.connect();
          let insurers;
          try {
            await pgClient.query('SET default_transaction_read_only = on');
            insurers = (await pgClient.query(
              `SELECT legal_name, oracle_operator_party FROM insurers
               WHERE oracle_operator_party IS NOT NULL AND is_active = true ORDER BY created_at`
            )).rows;
          } finally {
            await pgClient.end().catch(() => {});
          }
          if (!insurers.length) {
            report('UNKNOWN', 'oracle-node', 'where the oracle parties are hosted is not checked: no active insurer has one');
          } else {
            const actAsOn = async (endpoint) =>
              new Set((await client.listUserRights(env.DAML_UNSAFE_JWT_SUB, endpoint ? { endpoint } : {}))
                .map((r) => r.kind?.CanActAs?.value?.party).filter(Boolean));
            const separate = Boolean(oracleBase) && oracleBase !== base;
            const onInsurerNode = await actAsOn(undefined);
            const onOracleNode = separate ? await actAsOn(oracleBase) : onInsurerNode;
            for (const i of insurers) {
              const here = onInsurerNode.has(i.oracle_operator_party);
              const there = onOracleNode.has(i.oracle_operator_party);
              // With one participant there is only one set to ask, and holding
              // the right is the whole answer. With two, holding it on BOTH is
              // its own finding: the insurer's node could then submit as the
              // oracle, which is the boundary the split exists to keep.
              const [level, where] = !separate
                ? here
                  ? ['OK', 'same participant as the insurer']
                  : ['FAIL', 'a participant that holds no right for it: no trigger can be submitted as it']
                : here && there
                  ? ['WARN', 'both participants, which means the split is not real: the insurer\'s node can submit as it']
                  : there
                    ? ['OK', 'separate participant']
                    : here
                      ? ['OK', 'same participant as the insurer (onboarded before DAML_JSON_API_URL_ORACLE was set)']
                      : ['FAIL', 'neither participant: no trigger can be submitted as it'];
              report(level, 'oracle-node', `${i.legal_name}: its oracle operator is on the ${where}`);
            }
          }
        } catch (err) {
          report('UNKNOWN', 'oracle-node', `where the oracle parties are hosted is not checked: ${err.message.slice(0, 140)}`);
        }
      }
    }
  }

  const api = `http://localhost:${env.PORT || 8080}`;
  const h = await probe(`${api}/health`);
  if (h.up && h.status === 200) {
    apiUp = true;
    // /health reports its own dependencies and stays 200 even when one is
    // down (node/src/health.js), so the code alone says only that the process
    // is alive. Show what it reported; if the body is not the shape this
    // expects, say that rather than inventing a state.
    let deps;
    let degraded = null;
    try {
      const body = JSON.parse(h.text ?? '');
      deps = body?.dependencies
        ? Object.entries(body.dependencies).map(([k, v]) => `${k} ${v}`).join(', ')
        : null;
      degraded = body?.degraded ?? null;
    } catch {
      deps = null;
    }
    // `degraded` appears once the process has seen an unhandled rejection
    // (node/src/processHandlers.js); the process carried on, so the status
    // code stayed 200.
    if (degraded) {
      report('WARN', 'api', `${api}/health answers 200 but says degraded: ${degraded.unhandledRejections} unhandled rejection(s) ` +
        `since the process started, the last at ${degraded.lastUnhandledRejectionAt} -- the process carried on; its stderr ` +
        `has each one. ` + (deps ? `it reports: ${deps}` : 'it reported no dependencies block'));
    } else {
      report('OK', 'api', `${api}/health answers 200 -- liveness only, it stays 200 with a dependency down; ` +
        (deps ? `it reports: ${deps}` : 'it reported no dependencies block'));
    }
  } else {
    report('WARN', 'api', `${api}/health ${h.up ? `answers HTTP ${h.status}` : `unreachable (${h.reason})`}; the verify scripts need npm start`);
  }
}

// --- oracle readings ---------------------------------------------------------
// The age of the newest oracle_readings row of each coverage cell the oracle's
// filter keeps, read from the database: the CLIMATE_API_URL line says only what
// this process's environment holds, not whether the running oracle records
// anything. The filter is the oracle's own: status active or partially_paid,
// and not known to lack a PolicyToken active for the policy's insurer under
// DAML_PACKAGE_ID (a failed read keeps the cell, marked NOT KNOWN), judged by
// oracleBot.js's tokenNotLive on one active-contract read per insurer (the
// localnet section's read is reused for its party). Without the ledger the
// cells are selected by status alone, and the line says so. INFO only.
async function checkReadings() {
  if (!dbUp) {
    report('UNKNOWN', 'readings', 'not checked: the working database is unreachable');
    return;
  }
  const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');
  const pgClient = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  await pgClient.connect();
  let cells;
  try {
    await pgClient.query('SET default_transaction_read_only = on');
    cells = (await pgClient.query(
      `SELECT p.id, p.insurer_id, p.daml_contract_id, i.canton_party_id, c.coverage_code, u.cell_id,
              (SELECT EXTRACT(EPOCH FROM now() - max(o.created_at))::int FROM oracle_readings o
                WHERE o.policy_id = p.id AND o.coverage_code = c.coverage_code AND o.cell_id = u.cell_id) AS age_s
         FROM policies p
         JOIN insurers i ON i.id = p.insurer_id
         JOIN policy_coverages c ON c.policy_id = p.id
         CROSS JOIN jsonb_array_elements_text(c.cell_ids) AS u(cell_id)
        WHERE p.status IN ('active', 'partially_paid')
        ORDER BY p.created_at, p.id, c.coverage_code, u.cell_id`
    )).rows;
  } finally {
    await pgClient.end().catch(() => {});
  }
  if (!cells.length) {
    report('INFO', 'readings', 'no coverage cell of an active or partially_paid policy: the oracle reads none');
    return;
  }

  let notLive = null;
  let unread = 'the ledger is unreachable';
  if (ledgerUp) {
    try {
      const client = await import(pathToFileURL(path.join(ROOT, 'node', 'src', 'damlClient.js')).href);
      const { tokenNotLive } = await import(pathToFileURL(path.join(ROOT, 'node', 'src', 'oracle', 'oracleBot.js')).href);
      const byInsurer = new Map();
      for (const [insurerId, party] of new Map(cells.filter((c) => c.canton_party_id).map((c) => [c.insurer_id, c.canton_party_id]))) {
        try {
          const entries = activeTokensByParty.get(party) ?? await client.queryActiveContracts({
            moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', parties: [party],
          });
          const byPolicyNo = new Map();
          for (const e of entries) {
            const { contractId, createArgument } = e.contractEntry.JsActiveContract.createdEvent;
            if (!byPolicyNo.has(createArgument.policyNo)) byPolicyNo.set(createArgument.policyNo, new Set());
            byPolicyNo.get(createArgument.policyNo).add(contractId);
          }
          byInsurer.set(insurerId, byPolicyNo);
        } catch (err) {
          byInsurer.set(insurerId, err);
        }
      }
      notLive = (c) => tokenNotLive(c, byInsurer);
    } catch (err) {
      unread = `the ledger read could not be made (${err.message.slice(0, 120)})`;
    }
  }
  const shown = notLive ? cells.filter((c) => !notLive(c)?.known) : cells;
  if (notLive) {
    const leftOut = [...new Set(cells.filter((c) => notLive(c)?.known).map((c) => c.id))];
    const notKnown = shown.filter((c) => notLive(c)).length;
    report('INFO', 'readings', `${shown.length} coverage cell(s) kept by the oracle's filter: active or partially_paid, and ` +
      `not known to lack a PolicyToken active under DAML_PACKAGE_ID` +
      (notKnown ? ` (${shown.length - notKnown} with one active, ${notKnown} NOT KNOWN)` : '') +
      (leftOut.length ? `; left out by that filter: polic${leftOut.length === 1 ? 'y' : 'ies'} ${leftOut.join(', ')}` : ''));
  } else {
    report('INFO', 'readings', `${cells.length} coverage cell(s) selected by status alone (active, partially_paid): ` +
      `whether each has an active PolicyToken is not read (${unread}), so a policy whose token is archived is listed too`);
  }
  for (const c of shown) {
    const unknown = notLive?.(c);
    report('INFO', 'readings', `policy ${c.id} ${c.coverage_code} cell ${c.cell_id}: ` +
      (c.age_s === null ? 'no oracle_readings row' : `newest oracle_readings row ${c.age_s}s since created_at`) +
      (unknown ? `; whether it has an active token is NOT KNOWN (${unknown.why})` : ''));
  }
}

// --- toolchain --------------------------------------------------------------
function checkToolchain() {
  if (/user\.language=en/.test(process.env.JAVA_TOOL_OPTIONS ?? '')) {
    report('OK', 'java', 'JAVA_TOOL_OPTIONS carries -Duser.language=en');
  } else {
    report('WARN', 'java', 'JAVA_TOOL_OPTIONS lacks -Duser.language=en -Duser.country=US in this shell; set it before dpm build / dpm test (Turkish dotted-I bug)');
  }
}

function runnableNow() {
  if (!dbUp) return 'dpm build --all and dpm test only (nothing that touches the database)';
  if (!ledgerUp) return 'npm run test:db (needs DATABASE_MAINT_URL), dpm build --all, dpm test (npm test and npm run verify-all need LocalNet; npm test also DATABASE_MAINT_URL and a TEST_DATABASE_URL marked by scripts/setupTestDb.mjs)';
  if (!apiUp) return 'npm test (needs DATABASE_MAINT_URL and a TEST_DATABASE_URL marked by scripts/setupTestDb.mjs), dpm build --all, dpm test (npm run verify-all also needs npm start)';
  return 'npm test (needs DATABASE_MAINT_URL and a TEST_DATABASE_URL marked by scripts/setupTestDb.mjs), npm run verify-all (also needs DATABASE_MAINT_URL), dpm build --all, dpm test';
}

let stoppedEarly = false;
try {
  checkEnv();
  checkGit();
  await checkDatabase();
  try {
    await checkMaint();
  } catch (err) {
    report('UNKNOWN', 'maint', `maintenance role check failed: ${err.message}`);
  }
  try {
    await checkTestDatabase();
  } catch (err) {
    report('UNKNOWN', 'testdb', `test database check failed: ${err.message}`);
  }
  try {
    await checkDrift();
  } catch (err) {
    report('UNKNOWN', 'drift', `drift check failed: ${err.message}`);
  }
  try {
    checkPackage();
  } catch (err) {
    report('UNKNOWN', 'daml', `package check failed: ${err.message}`);
  }
  await checkServices();
  try {
    await checkReadings();
  } catch (err) {
    report('UNKNOWN', 'readings', `readings check failed: ${err.message}`);
  }
  checkToolchain();
} catch (err) {
  stoppedEarly = true;
  report('UNKNOWN', 'doctor', `stopped early: ${err.message}`);
}

const header = `insurance doctor, ${new Date().toISOString()} (read-only toward its data; the drift check makes and drops one throwaway database)`;
const footer = [
  `Runnable now: ${runnableNow()}`,
  'Drift detail: node scripts/checkSchemaDrift.mjs prints every catalog entry the drift line counts (the same comparison, through a throwaway database).',
];
const text = [header, ...lines, ...footer].join('\n');
const fails = lines.filter((l) => l.startsWith('[FAIL]')).length;
const warns = lines.filter((l) => l.startsWith('[WARN]')).length;

// The report: plain text, or the JSON the SessionStart hook reads.
const out = HOOK
  ? JSON.stringify({
      systemMessage: `insurance doctor: ${fails} FAIL, ${warns} WARN`,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    })
  : `${text}\n`;
// Close what this run opened, so the process can end on its own: the ledger
// call leaves a keep-alive socket on Node's global agent, and fetch keeps its
// own connection pool. The pool is reached through the symbol Node stores its
// dispatcher under; if a future version moves it, the optional chain makes
// this a no-op.
http.globalAgent.destroy();
https.globalAgent.destroy();
await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.().catch(() => {});

// Then set the code and let the write drain, instead of calling process.exit()
// from the write callback. That call is what tripped libuv's
// UV_HANDLE_CLOSING assertion on Windows whenever LocalNet was up:
// measured, not guessed -- with the sockets above closed the report
// still crashed, and the crash went only when the exit stopped being
// explicit. A pending write on the pipe keeps the process alive by itself, so
// a hook still reads the whole report. Exit codes are unchanged by that: --hook
// always 0, otherwise 2 if the run stopped early, else 1 if any line is FAIL.
process.exitCode = HOOK ? 0 : stoppedEarly ? 2 : fails ? 1 : 0;
process.stdout.write(out);
