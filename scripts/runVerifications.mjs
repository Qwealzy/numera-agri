// Runs every scripts/verify-*.mjs against the live stack, one after another,
// and prints one PASS/FAIL line per script.
//
// Each verify script was written to prove one article's behaviour on the day
// it shipped, and was run once. Run together they are the regression check
// for the HTTP API, which node/test does not call at all.
//
// Refuses to start unless both the ledger JSON API and the API server answer,
// so a stack that is down reads as "not run" -- never as a failure of the code.
// Afterwards it compares the number of fixture/throwaway insurers with the
// count before the run: a run that leaves new ones behind fails, because the
// test fixtures' own cleanup has already been seen not to hold (see
// `npm run doctor`).
//
// The verify scripts write real rows (policies, events, readings) to the
// working database, and each rewrites its own docs/m*-live-run.txt evidence
// file -- untracked and not ignored, so a run leaves them in `git status`.
// That is how they have always worked; this does not change it, it only lists
// the files at the end.
//
//   node scripts/runVerifications.mjs [api-key]   the key is passed to every
//                                                 script (their default is
//                                                 demo-api-key)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertMaintSameServer } from '../node/test-support/testDbGuard.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, 'node', '.env'), 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
}

async function answers(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { up: true, status: res.status };
  } catch (err) {
    return { up: false, reason: err.cause?.code ?? err.name };
  }
}

// The ledger side of the same promise, added after a run left 201 active
// contracts on one party and every reader broke at the participant's
// 200-element list cap: what a run creates on the ledger, the run takes back.
//
// ONE teardown here rather than six in the scripts. Each verify script is an
// evidence document -- it prints a narrative and writes its own
// docs/m*-live-run.txt -- so six copies of the same teardown would be six
// places to drift, and a script that fails half way through cannot clean up
// after itself at all. The runner still can, and it already owns the
// before/after comparison for fixture insurers.
//
// Scoped to what the run made: contracts whose ids were not there before it
// started, and rows created at or after it started. Anything older is left
// exactly as it was.
async function insurerParties() {
  const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');
  const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const { rows } = await client.query(
      `SELECT id, canton_party_id FROM insurers WHERE canton_party_id IS NOT NULL AND is_active = true`
    );
    return rows;
  } finally {
    await client.end();
  }
}

// A run takes minutes, and the keep-alive socket from the read at the start
// is often dead by the time the teardown reads again -- the first call then
// fails with ECONNRESET on a socket the agent reused. One retry, and only for
// that class of error: anything the participant actually answered, 413
// included, is returned as-is.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    const transport = err.response === undefined &&
      (/ECONNRESET|EPIPE|socket hang up/i.test(err.message ?? '') ||
        err.code === 'ECONNABORTED' || /timeout of \d+ms exceeded/i.test(err.message ?? ''));
    if (!transport) throw err;
    return fn();
  }
}

// Reads through damlClient.js, so the endpoint shapes stay in the one file
// that owns them. A failure here is returned, not thrown: the caller decides
// whether it means "do not start" or "the gate fails".
async function activeContracts(parties) {
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
  const { queryActiveContracts } = await import(
    pathToFileURL(path.join(ROOT, 'node', 'src', 'damlClient.js')).href
  );
  const found = new Map();
  for (const party of parties) {
    for (const [moduleName, entityName] of [
      ['Insurance.PolicyToken', 'PolicyToken'],
      ['Insurance.PayoutBridge', 'PayoutApproved'],
      ['Insurance.PayoutBridge', 'ManualReviewRequired'],
    ]) {
      let entries;
      try {
        entries = await withRetry(() => queryActiveContracts({ moduleName, entityName, parties: [party] }));
      } catch (err) {
        return { ok: false, error: `${entityName} for ${party.split('::')[0]}: ${err.message.slice(0, 200)}` };
      }
      for (const e of entries) {
        const c = e.contractEntry?.JsActiveContract?.createdEvent;
        if (c) found.set(c.contractId, { templateId: c.templateId, signatories: c.signatories, entity: entityName });
      }
    }
  }
  return { ok: true, contracts: found };
}

async function fixtureInsurers() {
  const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');
  const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const { rows: [r] } = await client.query(
      `SELECT count(*)::int AS n FROM insurers
       WHERE legal_name ILIKE '%fixture%' OR legal_name ILIKE '%throwaway%'`
    );
    return r.n;
  } finally {
    await client.end();
  }
}

const ledger = await answers(`${env.DAML_JSON_API_URL.replace(/\/+$/, '')}/v2/version`);
const api = await answers(`http://localhost:${env.PORT || 8080}/health`);
if (!ledger.up || !api.up || api.status !== 200) {
  console.log('Not run: the live stack is not up.');
  console.log(`  ledger JSON API ${new URL(env.DAML_JSON_API_URL).origin}: ${ledger.up ? `HTTP ${ledger.status}` : ledger.reason}`);
  console.log(`  API server localhost:${env.PORT || 8080}/health: ${api.up ? `HTTP ${api.status}` : api.reason}`);
  console.log('Start LocalNet and `npm start` (from node/), then run this again.');
  process.exit(2);
}

// The teardown's row cleanup deletes, and the application role deliberately
// cannot (2026-09-17), so it runs as DATABASE_MAINT_URL. Checked here,
// before the first script, rather than after six of them have run: the run
// would otherwise write rows it has no way to take back.
const maintUrl = process.env.DATABASE_MAINT_URL ?? env.DATABASE_MAINT_URL;
try {
  if (!maintUrl) throw new Error('DATABASE_MAINT_URL not set: needed for the verify-all row cleanup');
  await assertMaintSameServer({ maintUrl, workingUrl: env.DATABASE_URL });
  const maintDatabase = new URL(maintUrl).pathname.slice(1);
  const workingDatabase = new URL(env.DATABASE_URL).pathname.slice(1);
  if (maintDatabase !== workingDatabase) {
    throw new Error(
      `DATABASE_MAINT_URL names database "${maintDatabase}", DATABASE_URL names "${workingDatabase}": ` +
        'the row cleanup would delete somewhere else'
    );
  }
} catch (err) {
  console.log(`Not run: ${err.message}`);
  process.exit(2);
}

// Evidence files with their modification times, so the summary names only the
// files this run actually wrote -- a script that fails before writing leaves
// its file, and its mtime, as they were.
const evidenceMtimes = () =>
  new Map(
    fs.readdirSync(path.join(ROOT, 'docs'))
      .filter((f) => /^m.*-live-run\.txt$/.test(f))
      .map((f) => [f, fs.statSync(path.join(ROOT, 'docs', f)).mtimeMs])
  );

const scripts = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^verify-.*\.mjs$/.test(f)).sort();
const passthrough = process.argv.slice(2);
const before = await fixtureInsurers();
const evidenceBefore = evidenceMtimes();
const parties = (await insurerParties()).map((r) => r.canton_party_id);
const contractsBefore = await activeContracts(parties);
if (!contractsBefore.ok) {
  // Refusing to start, not failing the run: if the ledger cannot be read
  // before a single script has run, nothing here is about to be proved, and
  // the reason is almost certainly the 200-element cap on one party -- for
  // which the fix is the cleanup step in the package-migration notes.
  console.log('Not run: the active-contract read failed before any script started.');
  console.log(`  ${contractsBefore.error}`);
  console.log('If this is the participant\'s list limit, archive that party\'s contracts first (the package-migration cleanup step).');
  process.exit(2);
}
const runStart = new Date();
const results = [];

for (const file of scripts) {
  console.log(`\n=== ${file} ${'='.repeat(Math.max(0, 60 - file.length))}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', file), ...passthrough], {
    stdio: 'inherit',
    // A verify script that never exits (an open pool, a poll that never
    // settles) must not hang the whole run.
    timeout: 10 * 60 * 1000,
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const outcome = r.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : r.status === 0 ? 'PASS' : 'FAIL';
  results.push({ file, outcome, detail: outcome === 'FAIL' ? `exit ${r.status ?? r.signal}` : '', seconds });
}

// --- teardown: take back what this run made --------------------------------
const teardown = { archived: 0, failed: 0, rows: null, error: null };
const contractsAfterRun = await activeContracts(parties);
if (!contractsAfterRun.ok) {
  teardown.error = contractsAfterRun.error;
} else {
  for (const [contractId, c] of contractsAfterRun.contracts) {
    if (contractsBefore.contracts.has(contractId)) continue; // older than this run
    try {
      const { exerciseChoice } = await import(pathToFileURL(path.join(ROOT, 'node', 'src', 'damlClient.js')).href);
      const [, moduleName, entityName] = c.templateId.split(':');
      await withRetry(() => exerciseChoice({
        moduleName, entityName, contractId, choice: 'Archive', argument: {},
        // PayoutApproved has two signatories; Archive needs both.
        actAs: c.signatories?.length ? c.signatories : [parties[0]],
      }));
      teardown.archived += 1;
    } catch (err) {
      // An archive that timed out and was retried can come back "not active":
      // the first attempt did land. The state this asks for is the state it
      // is in, so it counts as archived -- and the gate below re-reads the
      // ledger anyway, so a wrong call here cannot pass the run.
      if (/NOT_ACTIVE|CONTRACT_NOT_FOUND|NOT_FOUND/i.test(err.message ?? '')) {
        teardown.archived += 1;
        continue;
      }
      teardown.failed += 1;
      console.log(`  could not archive ${contractId.slice(0, 16)}... (${c.entity}): ${err.message.slice(0, 140)}`);
    }
  }
  // Then the rows, in FK order, and only those this run created.
  const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');
  const client = new Client({ connectionString: maintUrl, connectionTimeoutMillis: 3000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    const mine = 'SELECT id FROM policies WHERE created_at >= $1';
    await client.query('UPDATE policies SET renewed_by_policy_id = NULL, predecessor_policy_id = NULL WHERE created_at >= $1', [runStart]);
    await client.query(`DELETE FROM payout_notifications WHERE payout_event_id IN (SELECT id FROM payout_events WHERE policy_id IN (${mine}))`, [runStart]);
    await client.query(`DELETE FROM payout_events WHERE policy_id IN (${mine})`, [runStart]);
    await client.query(`DELETE FROM policy_events WHERE policy_no IN (${mine})`, [runStart]);
    for (const t of ['policy_documents', 'policy_status_history', 'policy_coverages', 'oracle_readings']) {
      await client.query(`DELETE FROM ${t} WHERE policy_id IN (${mine})`, [runStart]);
    }
    const policies = await client.query('DELETE FROM policies WHERE created_at >= $1', [runStart]);
    const people = await client.query('DELETE FROM policyholders WHERE created_at >= $1', [runStart]);
    await client.query('COMMIT');
    teardown.rows = `${policies.rowCount} policies, ${people.rowCount} policyholders`;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    teardown.error = `row cleanup failed: ${err.message.slice(0, 160)}`;
  } finally {
    await client.end();
  }
}

const after = await fixtureInsurers();
const contractsAfter = await activeContracts(parties);
console.log('\n=== summary ' + '='.repeat(52));
for (const r of results) console.log(`${r.outcome.padEnd(8)} ${r.file.padEnd(28)} ${r.seconds.padStart(6)}s ${r.detail}`);
const debrisGrew = after > before;
console.log(`${debrisGrew ? 'FAIL' : 'PASS'}     fixture/throwaway insurers: ${before} before, ${after} after`);
// The ledger gate. A run that leaves contracts behind is how a party reaches
// the participant's list limit, after which every reader -- the verify
// scripts, /debug/contracts and payoutListener -- stops working.
const contractsGrew = !contractsAfter.ok || contractsAfter.contracts.size > contractsBefore.contracts.size;
console.log(
  contractsAfter.ok
    ? `${contractsGrew ? 'FAIL' : 'PASS'}     active contracts: ${contractsBefore.contracts.size} before, ${contractsAfter.contracts.size} after` +
      ` (teardown archived ${teardown.archived}${teardown.failed ? `, ${teardown.failed} FAILED` : ''}` +
      `${teardown.rows ? `; deleted ${teardown.rows}` : ''})`
    : `FAIL     active contracts: ${contractsBefore.contracts.size} before, unreadable after -- ${contractsAfter.error}`
);
if (teardown.error) console.log(`FAIL     teardown: ${teardown.error}`);
const evidence = [...evidenceMtimes()].filter(([f, t]) => evidenceBefore.get(f) !== t).map(([f]) => f);
console.log(evidence.length
  ? `evidence files written or rewritten under docs/ by this run: ${evidence.join(', ')}`
  : 'no evidence file under docs/ was written by this run');
const failed = results.filter((r) => r.outcome !== 'PASS').length;
console.log(`\n${results.length - failed}/${results.length} verify scripts passed${debrisGrew ? '; the run left fixture insurers behind' : ''}` +
  `${contractsGrew ? '; the run left active contracts behind' : ''}.`);
process.exitCode = failed || debrisGrew || contractsGrew || teardown.error || teardown.failed ? 1 : 0;
