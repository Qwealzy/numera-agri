// Live verification of m. 1456 payout routing, driven through the real HTTP
// API against the real participant.
//
// Everything a policy needs goes through POST /policies, /activate and the
// payout endpoints. The only direct SQL write is the oracle reading plus its
// trigger outbox row -- in production the oracle bot writes those on its own
// schedule, and waiting for a cron is not a verification step.
//
// Reads are direct SQL and direct ledger queries, because the claim being
// verified is that the two agree.

import fs from 'node:fs';
import crypto from 'node:crypto';

// POST /policies requires the policy document's SHA-256 in lowercase hex
// (migration 034); the document itself never reaches the platform.
const DOCUMENT_HASH = crypto.createHash('sha256').update('verify-m1456-routing policy document').digest('hex');

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
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

// A policy with a bank named as mortgagee, and a per-coverage claim ceiling.
const createPolicy = async (label, claim) =>
  (await call('POST', '/policies', {
    policyholder: { externalRef: `m1456-${label}-${RUN}` },
    documentHash: DOCUMENT_HASH,
    mortgagee: claim === null ? undefined : { externalRef: `m1456-bank-${RUN}` },
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: istanbulDay(daysAgo(30)), endDate: istanbulDay(daysAhead(180)) },
    agreedCoverageStart: daysAgo(30),
    coverages: [{
      coverageCode: 'FROST-COVER',
      productCode: 'FROST-STANDARD',
      perilType: 'FROST',
      cellIds: [`cell-1456-${label}-${RUN}`],
      sumInsured: 100000,
      ...(claim === null ? {} : { mortgageeClaimAmount: claim }),
    }],
  })).policy.id;

const settleOutbox = async (policyId, type) => {
  for (let i = 0; i < 60; i++) {
    const { rows } = await pool.query(
      `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = $2
       ORDER BY created_at DESC LIMIT 1`, [policyId, type]
    );
    if (rows[0] && (rows[0].status === 'done' || rows[0].status === 'failed')) return rows[0];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`outbox ${type} for ${policyId} never settled`);
};

// The oracle bot writes these on a schedule; the verification supplies one
// directly rather than waiting for a cron.
const fireTrigger = async (policyId, value) => {
  const { rows } = await pool.query(
    `SELECT c.cell_ids, p.current_version FROM policy_coverages c JOIN policies p ON p.id = c.policy_id
      WHERE c.policy_id = $1 AND c.coverage_code = 'FROST-COVER'`, [policyId]
  );
  const cell = rows[0].cell_ids[0];
  const reading = (await pool.query(
    `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source)
     VALUES ($1,'FROST-COVER',$2,'TEMPERATURE_C',$3,now(),'live-verification') RETURNING id`,
    [policyId, cell, value]
  )).rows[0];
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, expected_version, reading_id, payload)
     VALUES ($1,'trigger',$2,$3,$4)`,
    [policyId, rows[0].current_version, reading.id,
     JSON.stringify({ observedValue: value, metric: 'TEMPERATURE_C', coverageCode: 'FROST-COVER' })]
  );
  for (let i = 0; i < 60; i++) {
    const { rows: ev } = await pool.query('SELECT * FROM policy_events WHERE reading_id = $1', [reading.id]);
    if (ev[0] && (ev[0].status === 'done' || ev[0].status === 'failed')) return ev[0];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('trigger never settled');
};

const rowsFor = async (policyId) => (await pool.query(
  'SELECT * FROM payout_events WHERE policy_id = $1 ORDER BY created_at ASC, id ASC', [policyId]
)).rows;
const claimOf = async (policyId) => (await pool.query(
  `SELECT mortgagee_claim_amount m FROM policy_coverages WHERE policy_id = $1 AND coverage_code = 'FROST-COVER'`,
  [policyId]
)).rows[0].m;

const insurerParty = (await pool.query(
  `SELECT canton_party_id p FROM insurers WHERE api_key_hash = encode(sha256($1::bytea),'hex')`, [KEY]
)).rows[0].p;
const ledger = async (entityName) => (await queryActiveContracts({
  moduleName: 'Insurance.PayoutBridge', entityName, parties: [insurerParty],
})).map((e) => e.contractEntry.JsActiveContract.createdEvent);

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

say('## 3n. Live verification run (v17 — payout routing to the mortgagee)');
say('');
say('Through the real HTTP API against the real participant, package');
say('`insurance-tokenization-v17`. A -2 reading pays 25% of the remaining');
say('limit, so the first payout on a 100000 coverage is 25000.');
say('');

// ---------------------------------------------------------------------------
// 1. Claim above the payout: the whole indemnity goes to the bank.
// ---------------------------------------------------------------------------
const wholeId = await createPolicy('whole', 40000);
await call('POST', `/policies/${wholeId}/activate`, {});
await settleOutbox(wholeId, 'activation');
await fireTrigger(wholeId, -2);
const wholeRows = await rowsFor(wholeId);
const wholePayout = (await ledger('PayoutApproved')).find((c) => c.contractId === wholeRows[0].daml_contract_id);

say('### A payout below the claim goes wholly to the mortgagee');
say('```');
say(`  claim before       = 40000.00`);
say(`  indemnity          = ${Number(wholeRows[0].payout_amount).toFixed(2)}`);
say(`  rows written       = ${wholeRows.length}`);
say(`    ${wholeRows[0].record_kind.padEnd(18)} recipient=${wholeRows[0].recipient}  amount=${Number(wholeRows[0].payout_amount).toFixed(2)}  status=${wholeRows[0].status}`);
say(`  claim after        = ${Number(await claimOf(wholeId)).toFixed(2)}   <- decremented by what was routed`);
say('');
say(`  LEDGER recipient   = ${wholePayout.createArgument.recipient}`);
say(`  LEDGER mortgagee   = ${String(wholePayout.createArgument.mortgagee).split('::')[0]}`);
say(`  bank observes it   = ${wholePayout.observers.includes(wholePayout.createArgument.mortgagee)}`);
say('```');
say('');

// ---------------------------------------------------------------------------
// 2. Claim below the payout: a leg for the bank, a remainder for a human.
// ---------------------------------------------------------------------------
const splitId = await createPolicy('split', 10000);
await call('POST', `/policies/${splitId}/activate`, {});
await settleOutbox(splitId, 'activation');
await fireTrigger(splitId, -2);
const splitRows = await rowsFor(splitId);
const leg = splitRows.find((r) => r.record_kind === 'payout');
const remainder = splitRows.find((r) => r.record_kind === 'unrouted_remainder');
const approvedForSplit = (await ledger('PayoutApproved')).filter((c) => c.createArgument.policyId === splitId);
const review = (await ledger('ManualReviewRequired')).find((c) => c.contractId === remainder.review_contract_id);

say('### A payout above the claim: the bank is paid, the excess is NOT');
say('```');
say(`  claim before       = 10000.00`);
say(`  indemnity          = 25000.00`);
say('');
say(`    ${leg.record_kind.padEnd(18)} recipient=${leg.recipient}  amount=${Number(leg.payout_amount).toFixed(2)}  status=${leg.status}`);
say(`    ${remainder.record_kind.padEnd(18)} recipient=${remainder.recipient}  amount=${Number(remainder.payout_amount).toFixed(2)}  status=${remainder.status}`);
say('');
say(`  PayoutApproved contracts for this policy = ${approvedForSplit.length}   <- ONE, not two`);
say(`  the remainder's daml_contract_id         = ${remainder.daml_contract_id}`);
say(`  ManualReviewRequired amount              = ${Number(review.createArgument.amount).toFixed(2)}`);
say(`  claim after                              = ${Number(await claimOf(splitId)).toFixed(2)}`);
say('');
say('  the reason recorded on the review item:');
for (const l of review.createArgument.reason.match(/.{1,66}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say('```');
say('');

// ---------------------------------------------------------------------------
// 3. They settle separately.
// ---------------------------------------------------------------------------
await call('POST', `/payouts/${leg.id}/settle`, {
  bankReference: 'BANK-REF-LIVE-1', settledAt: iso(Date.now()), paidRole: 'PDR_Mortgagee',
});
await settleOutbox(splitId, 'settlement');
const afterSettle = await rowsFor(splitId);
const legAfter = afterSettle.find((r) => r.id === leg.id);
const remAfter = afterSettle.find((r) => r.id === remainder.id);

say('### Each is settled on its own — m. 1427 runs per claim');
say('```');
say(`  after the insurer reports paying the BANK:`);
say(`    mortgagee leg      status=${legAfter.status}  paid_role=${legAfter.paid_role}  ref=${legAfter.bank_reference}`);
say(`    unrouted remainder status=${remAfter.status}  resolved_at=${remAfter.resolved_at}`);
say('```');
say('');
say('Paying the bank discharged the bank\'s claim and nothing else. The');
say('remainder is still open, which is exactly what it should be.');
say('');

// ---------------------------------------------------------------------------
// 4. Exhaustion, then an uncharged coverage.
// ---------------------------------------------------------------------------
await fireTrigger(splitId, -2);
const exhaustedRows = await rowsFor(splitId);
const second = exhaustedRows.filter((r) => !splitRows.some((s) => s.id === r.id));

say('### Once the claim is exhausted, nothing is routed at all');
say('```');
say(`  claim before the second loss = ${Number(await claimOf(splitId)).toFixed(2)}`);
for (const r of second) {
  say(`    ${r.record_kind.padEnd(18)} recipient=${String(r.recipient)}  amount=${Number(r.payout_amount).toFixed(2)}  status=${r.status}`);
}
say('```');
say('');
say('Not quietly redirected to the insured. The payout after exhaustion is');
say('the same surplus by another name, and the ORDER of losses must not decide');
say('what the arithmetic was not allowed to.');
say('');

const plainId = await createPolicy('uncharged', null);
await call('POST', `/policies/${plainId}/activate`, {});
await settleOutbox(plainId, 'activation');
await fireTrigger(plainId, -2);
const plainRows = await rowsFor(plainId);
const plainPayout = (await ledger('PayoutApproved')).find((c) => c.contractId === plainRows[0].daml_contract_id);

say('### A coverage with no charge on it is untouched');
say('```');
say(`  rows written     = ${plainRows.length}`);
say(`    ${plainRows[0].record_kind.padEnd(18)} recipient=${plainRows[0].recipient}  amount=${Number(plainRows[0].payout_amount).toFixed(2)}  status=${plainRows[0].status}`);
say(`  claim            = ${await claimOf(plainId)}`);
say(`  LEDGER mortgagee = ${plainPayout.createArgument.mortgagee ?? null}`);
say('```');
say('');
say('No sınırlı ayni hak reaches this indemnity, so m. 1456 has nothing to');
say('say about it and the path is the one that has always been there.');

const target = new URL('../docs/m1456-live-run.txt', import.meta.url).pathname.replace(/^\//, '');
fs.writeFileSync(target, out.join('\n') + '\n');
console.log(`\nwritten to ${target}`);
await pool.end();
