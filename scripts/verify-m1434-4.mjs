// Live verification of the m. 1434(4) two-notice termination right, driven
// through the real HTTP API against the real participant.
//
// The shape of the run follows the shape of the paragraph: the right is only
// reachable where (3) did NOT fire, so every notice here is served and then
// paid off. That is the chronically late payer the provision is about.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// POST /policies requires the policy document's SHA-256 in lowercase hex
// (migration 034); the document itself never reaches the platform.
const DOCUMENT_HASH = crypto.createHash('sha256').update('verify-m1434-4 policy document').digest('hex');

const ENV_PATH = fileURLToPath(new URL('../node/.env', import.meta.url));
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
}

const BASE = `http://localhost:${process.env.PORT ?? 8080}/api/v1`;
const KEY = process.argv[2] ?? 'demo-api-key';
const { pool } = await import('../node/src/db.js');
const { queryActiveContracts } = await import('../node/src/damlClient.js');
const { runOnce: sweepTwoNotice } = await import('../node/src/sweepers/twoNoticeSweeper.js');

const RUN = Date.now().toString(36);
// Cell ids in the oracle's own format, "metno:<lat>,<lon>" with at most 4 decimals. The
// first two decimals of the latitude name this script, the first two of the longitude
// count the cells this run hands out, and the last two of each carry the run.
const CELL_RUN = String(parseInt(RUN, 36) % 10000).padStart(4, '0');
let cellCount = 0;
const nextCell = () =>
  `metno:0.12${CELL_RUN.slice(0, 2)},0.${String(++cellCount).padStart(2, '0')}${CELL_RUN.slice(2)}`;
const T0 = Date.now();
const iso = (d) => new Date(d).toISOString();
const at = (n) => iso(T0 + n * 86400000);
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

const settle = async (policyId, type) => {
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

const row = async (id) => (await pool.query('SELECT * FROM policies WHERE id = $1', [id])).rows[0];
const insurerParty = (await pool.query(
  `SELECT canton_party_id p FROM insurers WHERE api_key_hash = encode(sha256($1::bytea),'hex')`, [KEY]
)).rows[0].p;
const tokenFor = async (cid) => (await queryActiveContracts({
  moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', parties: [insurerParty],
})).map((e) => e.contractEntry.JsActiveContract.createdEvent).find((c) => c.contractId === cid);

const makePolicy = async (label) => {
  const created = await call('POST', '/policies', {
    policyholder: { externalRef: `m1434-4-${label}-${RUN}` },
    documentHash: DOCUMENT_HASH,
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: istanbulDay(at(-200)), endDate: istanbulDay(at(160)) },
    agreedCoverageStart: at(-200),
    coverages: [{
      coverageCode: 'FROST-COVER', productCode: 'FROST-STANDARD', perilType: 'FROST',
      cellIds: [nextCell()], sumInsured: 100000,
      // v22: required by the API, with no default. The basis v21 applied.
      metric: 'TEMPERATURE_C', payoutBasis: 'PB_RemainingLimit',
    }],
  });
  const id = created.policy.id;
  await call('POST', `/policies/${id}/activate`, {});
  await settle(id, 'activation');
  return id;
};

// A notice served and then paid off: the count goes up, the contract survives.
const noticeThenPay = async (id, serviceDate) => {
  await call('POST', `/policies/${id}/notice`, { serviceDate });
  await settle(id, 'notice');
  await call('POST', `/policies/${id}/reinstate`, {});
  await settle(id, 'reinstatement');
};

// The package line gives the DAML_PACKAGE_ID loaded above, the package this
// run is against, beside the name in the source tree's daml/daml.yaml. The
// heading's vNN stays the version the article shipped in.
const packageName = fs.readFileSync(new URL('../daml/daml.yaml', import.meta.url), 'utf8').match(/^name:\s*(\S+)/m)?.[1];
if (!packageName) throw new Error('daml/daml.yaml has no name line');
const PACKAGE = `\`${packageName}\` (id \`${process.env.DAML_PACKAGE_ID}\`)`;

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

say('## 3q. Live verification run (v20 — the two-notice termination right, m. 1434(4))');
say('');
say('Through the real HTTP API against the real participant, package');
say(`${PACKAGE}. Every notice below is served and then PAID`);
say('OFF, because that is the only way the right is ever reachable: where the');
say('ten days elapse unpaid, m. 1434(3) has already ended the contract.');
say('');

const pending = await makePolicy('pending');
await noticeThenPay(pending, at(-50));
let r = await row(pending);

say('### One notice, paid off. The right is not available');
say('```');
say(`  notice_count         = ${r.notice_count}`);
say(`  notice_service_dates = ${r.notice_service_dates.length} recorded`);
say(`  default_state        = ${r.default_state}   <- the debt was cleared`);
say('```');
say('');

await call('POST', `/policies/${pending}/two-notice-election`, {
  electedAt: at(0), insurancePeriodStart: at(-60), insurancePeriodEnd: at(30),
});
const tooSoon = await settle(pending, 'two_notice_election');
say('```');
say(`  election status = ${tooSoon.status}`);
say('  reason:');
for (const l of (tooSoon.error ?? '').match(/.{1,66}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say('```');
say('');

await noticeThenPay(pending, at(-20));
r = await row(pending);
say('### A second notice in the same period, also paid off');
say('```');
say(`  notice_count         = ${r.notice_count}`);
say(`  notice_service_dates = ${r.notice_service_dates.map((d) => new Date(d).toISOString().slice(0, 10)).join(', ')}`);
say(`  default_state        = ${r.default_state}`);
say('```');
say('');

// The period check reads the dates, not the count.
await call('POST', `/policies/${pending}/two-notice-election`, {
  electedAt: at(0), insurancePeriodStart: at(-5), insurancePeriodEnd: at(30),
});
const wrongPeriod = await settle(pending, 'two_notice_election');
say('### The period check reads the DATES, not the count');
say('```');
say(`  a period containing neither notice -> ${wrongPeriod.status}`);
say('  reason:');
for (const l of (wrongPeriod.error ?? '').match(/.{1,66}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say('```');
say('');
say('The count says two. The dates say not in THAT period. m. 1411 ties the');
say('period to how the premium is CALCULATED, which this platform does not');
say('hold -- so the insurer supplies it, and the ledger checks it.');
say('');

await call('POST', `/policies/${pending}/two-notice-election`, {
  electedAt: at(0), insurancePeriodStart: at(-60), insurancePeriodEnd: at(30),
});
await settle(pending, 'two_notice_election');
const elected = await row(pending);
const electedToken = await tokenFor(elected.daml_contract_id);

say('### The election lands, and the effect is DEFERRED');
say('```');
say(`  SQL default_state           = ${elected.default_state}`);
say(`  SQL two_notice_election_at  = ${elected.two_notice_election_at.toISOString()}`);
say(`  SQL two_notice_effective_at = ${elected.two_notice_effective_at.toISOString()}   <- the supplied period end`);
say(`  LEDGER defaultState         = ${electedToken.createArgument.defaultState}`);
say(`  LEDGER coverageValidThrough = ${electedToken.createArgument.coverageValidThrough}   <- UNCHANGED`);
say('```');
say('');
say('The contract runs on. Nothing about the election shortens it -- the');
say('premium for this period was paid, which is why (3) never fired.');
say('');

await sweepTwoNotice();
const stillPending = await row(pending);
say('### The sweeper is a state test, and the period has not ended');
say('```');
say(`  default_state after a sweep = ${stillPending.default_state}   <- nothing queued`);
say('```');
say('');

// A second policy, elected for a period that has already ended.
const landed = await makePolicy('landed');
await noticeThenPay(landed, at(-50));
await noticeThenPay(landed, at(-20));
await call('POST', `/policies/${landed}/two-notice-election`, {
  electedAt: at(-10), insurancePeriodStart: at(-60), insurancePeriodEnd: at(-1),
});
await settle(landed, 'two_notice_election');
await sweepTwoNotice();
const term = await settle(landed, 'two_notice_termination');
const done = await row(landed);
const doneToken = await tokenFor(done.daml_contract_id);

say('### At the period end it lands — and the instant is the frozen one');
say('```');
say(`  termination row status      = ${term.status}`);
say(`  SQL default_state           = ${done.default_state}`);
say(`  SQL two_notice_effective_at = ${done.two_notice_effective_at.toISOString()}`);
say(`  LEDGER coverageValidThrough = ${doneToken.createArgument.coverageValidThrough}   <- the period end, not "now"`);
say('```');
say('');
say('A sweep that runs late records the instant it would have recorded on');
say('time. The sweeper observes; it does not decide.');
say('');

const history = (await pool.query(
  `SELECT old_default_state, new_default_state, reason FROM policy_status_history
    WHERE policy_id = $1 AND event_type = 'two_notice_termination'`, [landed]
)).rows[0];
say('### The audit chain');
say('```');
say(`  ${history.old_default_state} -> ${history.new_default_state}`);
say('  reason:');
for (const l of history.reason.match(/.{1,66}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say('```');
say('');
say('Its own vocabulary throughout: neither `terminated` nor');
say('`withdrawn_for_first_premium`. Three ways a contract ends for');
say('non-payment, three states, never conflated.');
say('');
say('Reproduced by `scripts/verify-m1434-4.mjs`, which drives all of the above');
say('through the HTTP API and writes this section.');

const target = fileURLToPath(new URL('../docs/m1434-4-live-run.txt', import.meta.url));
fs.writeFileSync(target, out.join('\n') + '\n');
console.log(`\nwritten to ${target}`);
await pool.end();
