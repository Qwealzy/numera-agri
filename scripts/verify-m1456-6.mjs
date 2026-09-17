// Live verification of the m. 1456(6) information duty, driven through the
// real HTTP API against the real participant.
//
// The point of this run is narrow and worth stating: the platform is proving
// that it recorded an ACT. The information itself was already readable by the
// mortgagee from the ledger before any of this ran, and the run shows that
// too -- side by side, so the difference between the two is visible.

import fs from 'node:fs';
import crypto from 'node:crypto';

// POST /policies requires the policy document's SHA-256 in lowercase hex
// (migration 034); the document itself never reaches the platform.
const DOCUMENT_HASH = crypto.createHash('sha256').update('verify-m1456-6 policy document').digest('hex');

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
const BASE_T = Date.now();
const iso = (d) => new Date(d).toISOString();
const ago = (n) => iso(BASE_T - n * 86400000);
const ahead = (n) => iso(BASE_T + n * 86400000);
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

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
const short = (p) => String(p).split('::')[0].slice(0, 22);

say('## 3p. Live verification run (v19 — the m. 1456(6) information duty)');
say('');
say('Through the real HTTP API against the real participant, package');
say('`insurance-tokenization-v19`.');
say('');

const created = await call('POST', '/policies', {
  policyholder: { externalRef: `m1456-6-ph-${RUN}` },
  documentHash: DOCUMENT_HASH,
  mortgagee: { externalRef: `m1456-6-bank-${RUN}` },
  policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: istanbulDay(ago(30)), endDate: istanbulDay(ahead(180)) },
  agreedCoverageStart: ago(30),
  coverages: [{
    coverageCode: 'FROST-COVER', productCode: 'FROST-STANDARD', perilType: 'FROST',
    cellIds: [`cell-1456-6-${RUN}`], sumInsured: 100000,
  }],
});
const policyId = created.policy.id;
await call('POST', `/policies/${policyId}/activate`, {});
await settle(policyId, 'activation');

const minted = await row(policyId);
const bankParty = (await pool.query(
  'SELECT canton_party_id p FROM policyholders WHERE id = $1', [minted.mortgagee_policyholder_id]
)).rows[0].p;
const token0 = await tokenFor(minted.daml_contract_id);
const cov0 = token0.createArgument.coverages[0];

say('### What the mortgagee could already read, before asking anything');
say('```');
say(`  bank observes the token = ${token0.observers.includes(bankParty)}   (${short(bankParty)})`);
say(`  LEDGER sumInsured       = ${cov0.sumInsured}`);
say(`  LEDGER remainingLimit   = ${cov0.remainingLimit}`);
say(`  LEDGER coverageValidThrough = ${token0.createArgument.coverageValidThrough}`);
say('```');
say('');
say('That is "sigorta koruması ile sigorta bedelinin miktarı", continuously,');
say('without asking anyone. The information was never missing.');
say('');

// A response with nothing to respond to.
await call('POST', `/policies/${policyId}/mortgagee-info-provided`, { providedAt: ago(1) });
const premature = await settle(policyId, 'mortgagee_info_provided');

say('### What was missing is the ACT — and a response needs a request');
say('```');
say(`  response-first row status = ${premature.status}`);
say('  reason:');
for (const l of (premature.error ?? '').match(/.{1,66}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say(`  SQL mortgagee_info_provided_at = ${(await row(policyId)).mortgagee_info_provided_at}`);
say('```');
say('');

await call('POST', `/policies/${policyId}/mortgagee-info-request`, { requestedAt: ago(5) });
await settle(policyId, 'mortgagee_info_request');
const outstanding = await row(policyId);
const tokenReq = await tokenFor(outstanding.daml_contract_id);

say('### The request is recorded, and the duty is now outstanding');
say('```');
say(`  SQL requested_at = ${outstanding.mortgagee_info_requested_at.toISOString()}`);
say(`  SQL provided_at  = ${outstanding.mortgagee_info_provided_at}   <- the insurer owes an answer`);
say(`  LEDGER mortgageeInfoRequestedAt = ${tokenReq.createArgument.mortgageeInfoRequestedAt}`);
say(`  bank still observes             = ${tokenReq.observers.includes(bankParty)}`);
say('```');
say('');

// A second request while one is outstanding.
await call('POST', `/policies/${policyId}/mortgagee-info-request`, { requestedAt: ago(3) });
const second = await settle(policyId, 'mortgagee_info_request');

say('### A second request while one is outstanding is refused');
say('```');
say(`  second request status = ${second.status}`);
say('  reason:');
for (const l of (second.error ?? '').match(/.{1,66}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say(`  SQL requested_at = ${(await row(policyId)).mortgagee_info_requested_at.toISOString()}   <- not overwritten`);
say('```');
say('');
say('The date the duty runs from is the one thing a second request would');
say('destroy, and the unanswered request is the whole point of recording it.');
say('');

// A response that predates its request.
await call('POST', `/policies/${policyId}/mortgagee-info-provided`, { providedAt: ago(6) });
const backdated = await settle(policyId, 'mortgagee_info_provided');

say('### A response cannot predate the request it answers');
say('```');
say(`  backdated response status = ${backdated.status}`);
say('  reason:');
for (const l of (backdated.error ?? '').match(/.{1,66}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say('```');
say('');

await call('POST', `/policies/${policyId}/mortgagee-info-provided`, { providedAt: ago(4) });
await settle(policyId, 'mortgagee_info_provided');
const answered = await row(policyId);
const tokenAns = await tokenFor(answered.daml_contract_id);

say('### Answered');
say('```');
say(`  SQL requested_at = ${answered.mortgagee_info_requested_at.toISOString()}`);
say(`  SQL provided_at  = ${answered.mortgagee_info_provided_at.toISOString()}`);
say(`  LEDGER mortgageeInfoProvidedAt = ${tokenAns.createArgument.mortgageeInfoProvidedAt}`);
say('');
say(`  default_state = ${answered.default_state}   <- neither axis moved`);
say(`  status        = ${answered.status}`);
say(`  mortgagee_notified_at = ${answered.mortgagee_notified_at}   <- m. 1456(4), a different fact`);
say('```');
say('');
say('Nothing records WHAT was disclosed. The token already carries the cover');
say('and the sum insured; a second copy could only drift from the first.');
say('');

// Ask again.
await call('POST', `/policies/${policyId}/mortgagee-info-request`, { requestedAt: ago(2) });
await settle(policyId, 'mortgagee_info_request');
const again = await row(policyId);

say('### And the bank may ask again — there is no limit in the text');
say('```');
say(`  SQL requested_at = ${again.mortgagee_info_requested_at.toISOString()}`);
say(`  SQL provided_at  = ${again.mortgagee_info_provided_at.toISOString()}   <- the older answer, left behind it`);
say(`  outstanding      = ${new Date(again.mortgagee_info_provided_at) < new Date(again.mortgagee_info_requested_at)}`);
say('```');
say('');
say('A later request sitting in front of an older response IS the outstanding');
say('state. That is why these are two dates rather than a log.');
say('');
say('Reproduced by `scripts/verify-m1456-6.mjs`, which drives all of the above');
say('through the HTTP API and writes this section.');

const target = new URL('../docs/m1456-6-live-run.txt', import.meta.url).pathname.replace(/^\//, '');
fs.writeFileSync(target, out.join('\n') + '\n');
console.log(`\nwritten to ${target}`);
await pool.end();
