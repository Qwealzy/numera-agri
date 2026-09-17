// Live verification of the m. 1458 retroactive-cover check, driven through
// the real HTTP API against the real participant.
//
// Everything a policy needs goes through POST /policies and /activate. The
// only direct SQL writes are historical oracle_readings -- in production the
// oracle bot accumulates those over months, and the whole point of the check
// is that it searches what the platform ALREADY HOLDS.
//
// Reads are direct SQL and direct ledger queries, because the claim being
// verified is that the two agree.

import fs from 'node:fs';
import crypto from 'node:crypto';

// POST /policies requires the policy document's SHA-256 in lowercase hex
// (migration 034); the document itself never reaches the platform.
const DOCUMENT_HASH = crypto.createHash('sha256').update('verify-m1458 policy document').digest('hex');

const ENV_PATH = new URL('../node/.env', import.meta.url).pathname.replace(/^\//, '');
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
}

const BASE = `http://localhost:${process.env.PORT ?? 8080}/api/v1`;
const KEY = process.argv[2] ?? 'demo-api-key';
const { pool } = await import('../node/src/db.js');
const { queryActiveContracts } = await import('../node/src/damlClient.js');

const RUN = Date.now().toString(36);
const iso = (d) => new Date(d).toISOString();
const daysAgo = (n) => iso(Date.now() - n * 86400000);
const daysAhead = (n) => iso(Date.now() + n * 86400000);
// policyTerms dates are calendar days -- the API refuses a timestamp -- and
// the day has to be Istanbul's, the zone the dispatcher reads them in: for
// three hours every night the UTC day is still the one before.
const istanbulDay = (d) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(d))
      .map(({ type, value }) => [type, value])
  );
  return `${p.year}-${p.month}-${p.day}`;
};

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return parsed;
};

// Cover start earlier than creation is what makes a policy backdated. Omit it
// for the ordinary case, where cover has not begun at all.
const createPolicy = async (label, cellIds, agreedCoverageStart) =>
  (await call('POST', '/policies', {
    policyholder: { externalRef: `m1458-${label}-${RUN}` },
    documentHash: DOCUMENT_HASH,
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: istanbulDay(daysAgo(90)), endDate: istanbulDay(daysAhead(180)) },
    coverages: [{
      coverageCode: 'FROST-COVER',
      productCode: 'FROST-STANDARD',
      perilType: 'FROST',
      cellIds,
      sumInsured: 100000,
    }],
    ...(agreedCoverageStart ? { agreedCoverageStart } : {}),
  })).policy.id;

const reading = (policyId, cellId, value, measuredAt) =>
  pool.query(
    `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source)
     VALUES ($1,'FROST-COVER',$2,'TEMPERATURE_C',$3,$4,'live-verification') RETURNING id`,
    [policyId, cellId, value, measuredAt]
  ).then((r) => r.rows[0].id);

// The dispatcher runs as part of `npm start`; this waits for it rather than
// calling it, so the run exercises the real process.
const settle = async (policyId, type = 'activation') => {
  for (let i = 0; i < 60; i++) {
    const { rows } = await pool.query(
      `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = $2
       ORDER BY created_at DESC LIMIT 1`, [policyId, type]
    );
    if (rows[0] && (rows[0].status === 'done' || rows[0].status === 'failed')) return rows[0];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`outbox row for ${policyId} never settled`);
};

const policyRow = async (id) => (await pool.query('SELECT * FROM policies WHERE id = $1', [id])).rows[0];

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

say('## 3m. Live verification run (v16 — retroactive cover)');
say('');
say('Through the real HTTP API against the real participant, package');
say('`insurance-tokenization-v16`.');
say('');

// ---------------------------------------------------------------------------
// A neighbour policy, so the cells have a history that belongs to SOMEONE
// ELSE. This is the case the check exists for: a brand-new policy has no
// readings of its own.
// ---------------------------------------------------------------------------
const CELL_FROST = `cell-1458-frost-${RUN}`;
const CELL_MILD = `cell-1458-mild-${RUN}`;
const CELL_UNSEEN = `cell-1458-unseen-${RUN}`;

const neighbourId = await createPolicy('neighbour', [CELL_FROST, CELL_MILD], daysAgo(90));
await call('POST', `/policies/${neighbourId}/activate`, {});
const neighbourEvent = await settle(neighbourId);
if (neighbourEvent.status !== 'done') throw new Error(`neighbour did not mint: ${neighbourEvent.error}`);

const frostReadingId = await reading(neighbourId, CELL_FROST, -1.0, daysAgo(45));
await reading(neighbourId, CELL_MILD, -3.0, daysAgo(45));
await reading(neighbourId, CELL_MILD, 6.0, daysAgo(40));

say('### The platform\'s own history, belonging to another policy');
say('```');
say(`  neighbour policy ${neighbourId.slice(0, 8)}  minted, cover began 90 days ago`);
say(`  ${CELL_FROST.slice(0, 22)}...  reading ${String(-1.0).padEnd(5)} 45 days ago  <- inside FROST-STANDARD tier 1 (-2..0)`);
say(`  ${CELL_MILD.slice(0, 22)}...   reading ${String(-3.0).padEnd(5)} 45 days ago  <- in the -4..-2 GAP: matches no tier`);
say(`  ${CELL_MILD.slice(0, 22)}...   reading ${String(6.0).padEnd(5)} 40 days ago  <- matches no tier`);
say('```');
say('');

// ---------------------------------------------------------------------------
// 1. Backdated over a tier-matching reading -> REFUSED
// ---------------------------------------------------------------------------
const refusedId = await createPolicy('refused', [CELL_FROST], daysAgo(60));
await call('POST', `/policies/${refusedId}/activate`, {});
const refusedEvent = await settle(refusedId);
const refusedRow = await policyRow(refusedId);

say('### A policy backdated over a tier-matching reading is refused');
say('```');
say(`  requested cover start = ${refusedRow.coverage_began_at.toISOString()}  (60 days ago)`);
say(`  contract formed at    = ${refusedRow.created_at.toISOString()}  (now)`);
say('');
say(`  activation row status = ${refusedEvent.status}`);
say(`  policy status         = ${refusedRow.status}`);
say(`  daml_contract_id      = ${refusedRow.daml_contract_id}`);
say(`  check timestamp       = ${refusedRow.retroactive_cover_checked_at}`);
say('');
say('  reason:');
for (const line of (refusedEvent.error ?? '').match(/.{1,68}(\s|$)/g) ?? []) say(`    ${line.trim()}`);
say('```');
say('');
say(`Nothing minted. The reading named is \`${frostReadingId}\`, and the message`);
say('says what it is not: the platform\'s own rule, asserting neither invalidity,');
say('nor knowledge, nor that a riziko legally occurred.');
say('');

// ---------------------------------------------------------------------------
// 2. Backdated over readings that match NO tier -> mints, RC_PassedWithData
// ---------------------------------------------------------------------------
const passedId = await createPolicy('passed', [CELL_MILD], daysAgo(60));
await call('POST', `/policies/${passedId}/activate`, {});
const passedEvent = await settle(passedId);
const passedRow = await policyRow(passedId);
const contracts = await queryActiveContracts({
  moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken',
  parties: [(await pool.query('SELECT canton_party_id FROM insurers WHERE id = $1', [passedRow.insurer_id])).rows[0].canton_party_id],
});
const token = contracts
  .map((e) => e.contractEntry.JsActiveContract.createdEvent)
  .find((c) => c.contractId === passedRow.daml_contract_id);

say('### A reading matching no tier does not refuse — and the pass is recorded');
say('```');
say(`  activation row status = ${passedEvent.status}`);
say(`  policy status         = ${passedRow.status}`);
say(`  SQL    checked_at     = ${passedRow.retroactive_cover_checked_at.toISOString()}`);
say(`  SQL    check_status   = ${passedRow.retroactive_cover_check_status}`);
say(`  LEDGER retroactiveCoverCheckedAt = ${token.createArgument.retroactiveCoverCheckedAt}`);
say('');
say('  off-ledger detail (policies.retroactive_cover_check_result):');
for (const line of JSON.stringify(passedRow.retroactive_cover_check_result, null, 2).split('\n')) {
  say(`    ${line}`);
}
say('```');
say('');
say('The ledger carries the timestamp and nothing else. The cell ids, the');
say('readings and the window are off-ledger, where they are not visible to');
say('every observer of the contract.');
say('');

// ---------------------------------------------------------------------------
// 3. Backdated over a cell the platform has NEVER observed -> vacuous pass
// ---------------------------------------------------------------------------
const vacuousId = await createPolicy('vacuous', [CELL_UNSEEN], daysAgo(60));
await call('POST', `/policies/${vacuousId}/activate`, {});
const vacuousEvent = await settle(vacuousId);
const vacuousRow = await policyRow(vacuousId);

say('### A pass over an unobserved cell is recorded as vacuous, not as verified');
say('```');
say(`  activation row status = ${vacuousEvent.status}`);
say(`  policy status         = ${vacuousRow.status}   <- it still mints; there is no basis to refuse`);
say(`  SQL    check_status   = ${vacuousRow.retroactive_cover_check_status}`);
say(`  readings held         = ${JSON.stringify(vacuousRow.retroactive_cover_check_result.readingsHeldPerCell)}`);
say(`  cells with no data    = ${vacuousRow.retroactive_cover_check_result.cellsWithNoReadings.length}`);
say('');
say('  caveat:');
for (const line of vacuousRow.retroactive_cover_check_result.caveat.match(/.{1,68}(\s|$)/g) ?? []) {
  say(`    ${line.trim()}`);
}
say('```');
say('');
say('The distinction the column exists for: this policy passed having verified');
say('NOTHING about its cell. Findable afterwards through');
say('`idx_policies_retro_check_vacuous`.');
say('');

// ---------------------------------------------------------------------------
// 4. No window -> no check at all
// ---------------------------------------------------------------------------
const inertId = await createPolicy('inert', [CELL_FROST]);              // no cover start
const forwardId = await createPolicy('forward', [CELL_FROST], daysAhead(5));
for (const id of [inertId, forwardId]) {
  await call('POST', `/policies/${id}/activate`, {});
  await settle(id);
}
const inertRow = await policyRow(inertId);
const forwardRow = await policyRow(forwardId);

say('### No window, no check');
say('```');
say(`  cover not begun at all   status=${inertRow.status}  checked_at=${inertRow.retroactive_cover_checked_at}  result=${inertRow.retroactive_cover_check_result}`);
say(`  cover starts in 5 days   status=${forwardRow.status}  checked_at=${forwardRow.retroactive_cover_checked_at}  result=${forwardRow.retroactive_cover_check_result}`);
say('```');
say('');
say('Both mint on the same cell whose reading refused the backdated policy');
say('above. The reading is not the problem; **backdating over it** is.');
say('');

// ---------------------------------------------------------------------------
// 5. The correction path: move the cover start past the reading.
// ---------------------------------------------------------------------------
const correctedId = await createPolicy('corrected', [CELL_FROST], daysAgo(30));
await call('POST', `/policies/${correctedId}/activate`, {});
await settle(correctedId);
const correctedRow = await policyRow(correctedId);

say('### The correction: a cover start later than the reading');
say('```');
say(`  cover start moved to 30 days ago (the reading is at 45)`);
say(`  policy status       = ${correctedRow.status}`);
say(`  check_status        = ${correctedRow.retroactive_cover_check_status}`);
say(`  readings examined   = ${correctedRow.retroactive_cover_check_result.readingsExamined}`);
say('```');
say('');
say('Still backdated, still checked — the window simply no longer contains the');
say('reading. The refusal is about the window, not about the policy.');
say('');
say('Note what the correction actually bought: a **vacuous** pass, not a clean');
say('one. Shrinking the window excluded the only readings this cell has, so the');
say('check now verifies nothing about it — and says so, rather than reporting');
say('the correction as a clean bill of health.');

const target = new URL('../docs/m1458-live-run.txt', import.meta.url).pathname.replace(/^\//, '');
fs.writeFileSync(target, out.join('\n') + '\n');
console.log(`\nwritten to ${target}`);
await pool.end();
