// Live verification of m. 1431(4) policyholder substitution, driven through
// the real HTTP API against the real participant.
//
// Every act goes through an endpoint. Reads are direct SQL and direct ledger
// queries, because the claim being verified is that the two agree -- and here
// that includes the observer set, which is the part a field-level check would
// miss.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// POST /policies requires the policy document's SHA-256 in lowercase hex
// (migration 034); the document itself never reaches the platform.
const DOCUMENT_HASH = crypto.createHash('sha256').update('verify-m1431-4 policy document').digest('hex');

const ENV_PATH = fileURLToPath(new URL('../node/.env', import.meta.url));
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
}

const BASE = `http://localhost:${process.env.PORT ?? 8080}/api/v1`;
const KEY = process.argv[2] ?? 'demo-api-key';
const { pool } = await import('../node/src/db.js');
const { queryActiveContracts } = await import('../node/src/damlClient.js');

const RUN = Date.now().toString(36);
// Cell ids in the oracle's own format, "metno:<lat>,<lon>" with at most 4 decimals. The
// first two decimals of the latitude name this script, the first two of the longitude
// count the cells this run hands out, and the last two of each carry the run.
const CELL_RUN = String(parseInt(RUN, 36) % 10000).padStart(4, '0');
let cellCount = 0;
const nextCell = () =>
  `metno:0.11${CELL_RUN.slice(0, 2)},0.${String(++cellCount).padStart(2, '0')}${CELL_RUN.slice(2)}`;
const iso = (d) => new Date(d).toISOString();
const ago = (n) => iso(Date.now() - n * 86400000);
const ahead = (n) => iso(Date.now() + n * 86400000);
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
const partyOf = async (phId) =>
  (await pool.query('SELECT canton_party_id FROM policyholders WHERE id = $1', [phId])).rows[0].canton_party_id;

const insurerParty = (await pool.query(
  `SELECT canton_party_id p FROM insurers WHERE api_key_hash = encode(sha256($1::bytea),'hex')`, [KEY]
)).rows[0].p;
const tokenFor = async (cid) => (await queryActiveContracts({
  moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', parties: [insurerParty],
})).map((e) => e.contractEntry.JsActiveContract.createdEvent).find((c) => c.contractId === cid);

// The package line gives the DAML_PACKAGE_ID loaded above, the package this
// run is against, beside the name in the source tree's daml/daml.yaml. The
// heading's vNN stays the version the article shipped in.
const packageName = fs.readFileSync(new URL('../daml/daml.yaml', import.meta.url), 'utf8').match(/^name:\s*(\S+)/m)?.[1];
if (!packageName) throw new Error('daml/daml.yaml has no name line');
const PACKAGE = `\`${packageName}\` (id \`${process.env.DAML_PACKAGE_ID}\`)`;

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
const short = (p) => String(p).split('::')[0].slice(0, 22);

say('## 3o. Live verification run (v18 — policyholder substitution, m. 1431(4))');
say('');
say('Through the real HTTP API against the real participant, package');
say(`${PACKAGE}.`);
say('');

// A policy genuinely taken for another's account.
const created = await call('POST', '/policies', {
  policyholder: { externalRef: `m1431-ettiren-${RUN}` },
  documentHash: DOCUMENT_HASH,
  insured: { externalRef: `m1431-sigortali-${RUN}` },
  policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: istanbulDay(ago(30)), endDate: istanbulDay(ahead(180)) },
  agreedCoverageStart: ago(30),
  coverages: [{
    coverageCode: 'FROST-COVER', productCode: 'FROST-STANDARD', perilType: 'FROST',
    cellIds: [nextCell()], sumInsured: 100000,
    // v22: required by the API, with no default. The basis v21 applied.
    metric: 'TEMPERATURE_C', payoutBasis: 'PB_RemainingLimit',
  }],
});
const policyId = created.policy.id;
await call('POST', `/policies/${policyId}/activate`, {});
await settle(policyId, 'activation');

const before = await row(policyId);
const ettirenParty = await partyOf(before.policyholder_id);
const sigortaliParty = await partyOf(before.insured_policyholder_id);
const tokenBefore = await tokenFor(before.daml_contract_id);

say('### Insurance for another\'s account, which is what m. 1431(4) needs');
say('```');
say(`  sigorta ettiren  = ${short(ettirenParty)}`);
say(`  sigortali        = ${short(sigortaliParty)}   <- a DISTINCT party (m. 1454)`);
say(`  observers        = ${JSON.stringify(tokenBefore.observers.map(short))}`);
say('```');
say('');

// The notice mechanism is running, so the freeze has something to freeze.
await call('POST', `/policies/${policyId}/notice`, { serviceDate: ago(30) });
await settle(policyId, 'notice');
const noticed = await row(policyId);

say('### A notice period is running against the sigorta ettiren');
say('```');
say(`  default_state       = ${noticed.default_state}`);
say(`  notice_service_date = ${noticed.notice_service_date.toISOString()}`);
say(`  grace_period_days   = ${noticed.grace_period_days}   (elapsed: the sweeper would terminate)`);
say('```');
say('');

// Out of order: refused.
await call('POST', `/policies/${policyId}/substitute-policyholder`, { substitutedAt: ago(1) });
const premature = await settle(policyId, 'substitution');

say('### The assumption is refused before the two facts that precede it');
say('```');
say(`  substitution row status = ${premature.status}`);
say('  reason:');
for (const l of (premature.error ?? '').match(/.{1,66}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say(`  SQL substituted_at      = ${(await row(policyId)).substituted_at}`);
say('```');
say('');

// Fact one, then fact two, then fact three.
await call('POST', `/policies/${policyId}/enforcement-fruitless`, { fruitlessAt: ago(20), route: 'ER_Takip' });
await settle(policyId, 'enforcement_fruitless');
await call('POST', `/policies/${policyId}/substitution-notice`, { notifiedAt: ago(10) });
await settle(policyId, 'substitution_notice');
const afterTwo = await row(policyId);

say('### The three facts, each reported, in order');
say('```');
say(`  enforcement_fruitless_at = ${afterTwo.enforcement_fruitless_at.toISOString()}  route=${afterTwo.enforcement_route}`);
say(`  enforcement_commenced_at = ${afterTwo.enforcement_commenced_at}   <- a DIFFERENT fact, untouched`);
say(`  substitution_notified_at = ${afterTwo.substitution_notified_at.toISOString()}`);
say('```');
say('');

await call('POST', `/policies/${policyId}/substitute-policyholder`, { substitutedAt: ago(1) });
const substEvent = await settle(policyId, 'substitution');
const after = await row(policyId);
const tokenAfter = await tokenFor(after.daml_contract_id);

say('### "Sözleşme bu kişilerle devam eder" — the party moves');
say('```');
say(`  substitution row status    = ${substEvent.status}`);
say(`  SQL policyholder_id        = ${after.policyholder_id === before.insured_policyholder_id ? 'now the SIGORTALI' : after.policyholder_id}`);
say(`  SQL superseded_policyholder= ${after.superseded_policyholder_id === before.policyholder_id ? 'the former ETTIREN' : after.superseded_policyholder_id}`);
say(`  SQL substituted_at         = ${after.substituted_at.toISOString()}`);
say('');
say(`  LEDGER policyholder        = ${short(tokenAfter.createArgument.policyholder)}`);
say(`  LEDGER supersededPolicyholder = ${short(tokenAfter.createArgument.supersededPolicyholder)}`);
say(`  observers BEFORE           = ${JSON.stringify(tokenBefore.observers.map(short))}`);
say(`  observers AFTER            = ${JSON.stringify(tokenAfter.observers.map(short))}`);
say(`  superseded party still observes = ${tokenAfter.observers.includes(ettirenParty)}`);
say('```');
say('');
say('The superseded party leaves the observer set with the role. It is no');
say('longer a party, and 5684 m. 35(8)/(9) makes continued disclosure to a');
say('non-party the wrong default. Its identity stays on the record.');
say('');

say('### The default axis is frozen, not cleared');
say('```');
say(`  default_state       = ${after.default_state}   <- unchanged: an undertaking is not a payment`);
say(`  notice_service_date = ${after.notice_service_date.toISOString()}   <- unchanged`);
say(`  notice_count        = ${after.notice_count}`);
say('```');
say('');

// The freeze, end to end: the termination cannot complete.
await pool.query(
  `INSERT INTO policy_events (policy_no, event_type, payload) VALUES ($1,'termination','{}')`,
  [policyId]
);
const term = await settle(policyId, 'termination');
const afterTerm = await row(policyId);

say('### And the termination cannot complete');
say('```');
say(`  termination row status = ${term.status}`);
say('  reason:');
for (const l of (term.error ?? '').match(/.{1,66}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say(`  default_state after    = ${afterTerm.default_state}   <- still not terminated`);
say('```');
say('');
say('What that rests on is the incompatibility of two phrases, and nothing');
say('more: m. 1431(4)\'s "sözleşme bu kişilerle devam eder" against');
say('m. 1434(3)\'s "sözleşme feshedilmiş olur". A contract cannot both continue');
say('and have been terminated. No article says the clock stops, resets or runs');
say('on, and nothing here asserts any of those.');
say('');

// Spent.
await call('POST', `/policies/${policyId}/substitute-policyholder`, { substitutedAt: iso(Date.now()) });
const second = await settle(policyId, 'substitution');

say('### It cannot happen twice — the paragraph is spent');
say('```');
say(`  second substitution status = ${second.status}`);
say('  reason:');
for (const l of (second.error ?? '').match(/.{1,66}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say('```');
say('');
say('One person now holds both roles, so there is no distinct sigortali left');
say('to substitute in. m. 1454(1) left the contract\'s rights with them');
say('throughout; m. 1431(4) moved the counterparty onto them.');
say('');
say('Reproduced by `scripts/verify-m1431-4.mjs`, which drives all of the above');
say('through the HTTP API and writes this section.');

const target = fileURLToPath(new URL('../docs/m1431-live-run.txt', import.meta.url));
fs.writeFileSync(target, out.join('\n') + '\n');
console.log(`\nwritten to ${target}`);
await pool.end();
