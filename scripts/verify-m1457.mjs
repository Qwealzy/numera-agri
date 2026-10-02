// Live verification of m. 1457 attachment routing, driven through the real
// HTTP API against the real participant.
//
// Shows all three routing cases side by side, and the refused settlement --
// the one place the system declines to record something as a discharge that
// the text says is not one.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// POST /policies requires the policy document's SHA-256 in lowercase hex
// (migration 034); the document itself never reaches the platform.
const DOCUMENT_HASH = crypto.createHash('sha256').update('verify-m1457 policy document').digest('hex');

const ENV_PATH = fileURLToPath(new URL('../node/.env', import.meta.url));
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
}

const BASE = `http://localhost:${process.env.PORT ?? 8080}/api/v1`;
const KEY = process.argv[2] ?? 'demo-api-key';
const { pool } = await import('../node/src/db.js');
const { queryActiveContracts } = await import('../node/src/damlClient.js');
const { insertWindowedTrigger } = await import('../node/test-support/windowedTrigger.mjs');

const RUN = Date.now().toString(36);
// Cell ids in the oracle's own format, "metno:<lat>,<lon>" with at most 4 decimals. The
// first two decimals of the latitude name this script, the first two of the longitude
// count the cells this run hands out, and the last two of each carry the run.
const CELL_RUN = String(parseInt(RUN, 36) % 10000).padStart(4, '0');
let cellCount = 0;
const nextCell = () =>
  `metno:0.15${CELL_RUN.slice(0, 2)},0.${String(++cellCount).padStart(2, '0')}${CELL_RUN.slice(2)}`;
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

const payouts = async (id) => (await pool.query(
  'SELECT * FROM payout_events WHERE policy_id = $1 ORDER BY created_at ASC, id ASC', [id]
)).rows;

const insurerParty = (await pool.query(
  `SELECT canton_party_id p FROM insurers WHERE api_key_hash = encode(sha256($1::bytea),'hex')`, [KEY]
)).rows[0].p;
const ledger = async (ent) => (await queryActiveContracts({
  moduleName: 'Insurance.PayoutBridge', entityName: ent, parties: [insurerParty],
})).map((e) => e.contractEntry.JsActiveContract.createdEvent);

const makePolicy = async (label, claim) => {
  const created = await call('POST', '/policies', {
    policyholder: { externalRef: `m1457-${label}-${RUN}` },
    documentHash: DOCUMENT_HASH,
    ...(claim === null ? {} : { mortgagee: { externalRef: `m1457-bank-${RUN}` } }),
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: istanbulDay(at(-30)), endDate: istanbulDay(at(180)) },
    agreedCoverageStart: at(-30),
    coverages: [{
      coverageCode: 'FROST-COVER', productCode: 'FROST-STANDARD', perilType: 'FROST',
      cellIds: [nextCell()], sumInsured: 100000,
      // v22: required by the API, with no default. The basis v21 applied.
      metric: 'TEMPERATURE_C', payoutBasis: 'PB_RemainingLimit',
      ...(claim === null ? {} : { mortgageeClaimAmount: claim }),
    }],
  });
  const id = created.policy.id;
  await call('POST', `/policies/${id}/activate`, {});
  await settle(id, 'activation');
  return id;
};

// v22: a trigger is a window -- the stored response, the reading, the
// trigger_windows row with the event interval, and the outbox row naming it --
// as the oracle writes one (node/test-support/windowedTrigger.mjs); the
// dispatcher sends no trigger without it. The interval is an hour that ended a
// minute ago, inside the policy's cover; each further trigger on a policy an
// hour earlier, since a policy has one window per start.
const windowsWritten = new Map();
const fire = async (policyId, value) => {
  const { rows } = await pool.query(
    `SELECT c.cell_ids, p.current_version FROM policy_coverages c JOIN policies p ON p.id = c.policy_id
      WHERE c.policy_id = $1 AND c.coverage_code = 'FROST-COVER'`, [policyId]
  );
  const earlier = windowsWritten.get(policyId) ?? 0;
  windowsWritten.set(policyId, earlier + 1);
  const eventEnd = new Date(Date.now() - 60 * 1000 - earlier * 60 * 60 * 1000);
  const { eventId } = await insertWindowedTrigger(pool, {
    policyId, coverageCode: 'FROST-COVER', cellId: rows[0].cell_ids[0], value,
    eventStart: new Date(eventEnd.getTime() - 60 * 60 * 1000), eventEnd,
    expectedVersion: rows[0].current_version,
  });
  for (let i = 0; i < 60; i++) {
    const { rows: ev } = await pool.query('SELECT * FROM policy_events WHERE id = $1', [eventId]);
    if (ev[0] && (ev[0].status === 'done' || ev[0].status === 'failed')) return ev[0];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('trigger never settled');
};

// The package line gives the DAML_PACKAGE_ID loaded above, the package this
// run is against, beside the name in the source tree's daml/daml.yaml. The
// heading's vNN stays the version the article shipped in.
const packageName = fs.readFileSync(new URL('../daml/daml.yaml', import.meta.url), 'utf8').match(/^name:\s*(\S+)/m)?.[1];
if (!packageName) throw new Error('daml/daml.yaml has no name line');
const PACKAGE = `\`${packageName}\` (id \`${process.env.DAML_PACKAGE_ID}\`)`;

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
const line = (r) => `    ${r.record_kind.padEnd(26)} recipient=${String(r.recipient).padEnd(22)} amount=${Number(r.payout_amount).toFixed(2).padStart(9)}  status=${r.status}`;

say('## 3r. Live verification run (v21 — attachment of the insured property, m. 1457)');
say('');
say('Through the real HTTP API against the real participant, package');
say(`${PACKAGE}. All three routing cases, side by side.`);
say('');

// CASE 1 -------------------------------------------------------------------
const plain = await makePolicy('unattached', null);
await fire(plain, -2);
say('### Case 1 — no attachment, no charge: unchanged since v17');
say('```');
for (const r of await payouts(plain)) say(line(r));
say('```');
say('');

// CASE 2 -------------------------------------------------------------------
const attached = await makePolicy('attached', null);
await fire(attached, -2);
const beforeRows = await payouts(attached);
await call('POST', `/policies/${attached}/attachment`, {
  coverageCode: 'FROST-COVER', attachedAt: at(-5),
});
await settle(attached, 'attachment');
await fire(attached, -2);
const afterRows = await payouts(attached);
const icraRow = afterRows[afterRows.length - 1];
const icraPayout = (await ledger('PayoutApproved')).find((c) => c.contractId === icraRow.daml_contract_id);

say('### Case 2 — attached, no charge: the icra müdürlüğü');
say('```');
say('  before the attachment:');
for (const r of beforeRows) say(line(r));
say('  after it:');
say(line(icraRow));
say('');
say(`  LEDGER recipient        = ${icraPayout.createArgument.recipient}`);
say(`  LEDGER payoutDestination = ${JSON.stringify(icraPayout.createArgument.payoutDestination)}`);
say('```');
say('');
say('The leg exists though the policy never designated that role, and could');
say('not have: nobody designates an icra müdürlüğü when the policy is');
say('written. That is what the exemption in the ensure clause is for.');
say('');

// CASE 3 -------------------------------------------------------------------
const both = await makePolicy('competing', 5000);
await call('POST', `/policies/${both}/attachment`, {
  coverageCode: 'FROST-COVER', attachedAt: at(-5),
});
await settle(both, 'attachment');
await fire(both, -2);
const bothRows = await payouts(both);
const review = (await ledger('ManualReviewRequired'))
  .find((c) => c.contractId === bothRows[0].review_contract_id);
const claimAfter = (await pool.query(
  `SELECT mortgagee_claim_amount m FROM policy_coverages WHERE policy_id = $1`, [both]
)).rows[0].m;
const approvedForBoth = (await ledger('PayoutApproved')).filter((c) => c.createArgument.policyId === both);

say('### Case 3 — charged AND attached: nothing routes');
say('```');
for (const r of bothRows) say(line(r));
say('');
say(`  PayoutApproved contracts for this policy = ${approvedForBoth.length}`);
say(`  mortgagee claim after                    = ${Number(claimAfter).toFixed(2)}   <- NOT decremented`);
say('');
say('  the reason recorded on the review item:');
for (const l of review.createArgument.reason.match(/.{1,64}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say('```');
say('');

// The refused settlement ---------------------------------------------------
const late = await makePolicy('late-attachment', null);
await fire(late, -2);
const [approved] = await payouts(late);
await call('POST', `/policies/${late}/attachment`, {
  coverageCode: 'FROST-COVER', attachedAt: at(-1),
});
await settle(late, 'attachment');
await call('POST', `/payouts/${approved.id}/settle`, {
  bankReference: 'REF-TO-INSURED', settledAt: iso(Date.now()), paidRole: 'PDR_Insured',
});
const refused = await settle(late, 'settlement');
const stillOpen = (await payouts(late))[0];

say('### A payout approved BEFORE the attachment: refused, not redirected');
say('```');
say(`  the payout was approved to      = ${approved.recipient}`);
say(`  then the coverage was attached  = ${at(-1)}`);
say(`  settlement report status        = ${refused.status}`);
say('  reason:');
for (const l of (refused.error ?? '').match(/.{1,64}(\s|$)/g) ?? []) say(`    ${l.trim()}`);
say('');
say(`  the obligation is untouched: status=${stillOpen.status} recipient=${stillOpen.recipient}`);
say('```');
say('');
say('Refusing asserts nothing. It declines to record as a discharge something');
say('the text says is not one -- the officer\'s ihtar binds "diğer bir');
say('bildirime kadar" and the insurer is freed ANCAK by paying the icra');
say('müdürlüğü. Rewriting an approved obligation would be the system deciding.');
say('');

// Lifting ------------------------------------------------------------------
await call('POST', `/policies/${late}/attachment-lifted`, {
  coverageCode: 'FROST-COVER', liftedAt: at(0),
});
await settle(late, 'attachment_lifted');
await call('POST', `/payouts/${approved.id}/settle`, {
  bankReference: 'REF-TO-INSURED', settledAt: iso(Date.now()), paidRole: 'PDR_Insured',
});
const accepted = await settle(late, 'settlement');
const settledRow = (await payouts(late))[0];

say('### And once lifted, the same report is accepted');
say('```');
say(`  settlement report status = ${accepted.status}`);
say(`  payout                   = ${settledRow.status}  paid_role=${settledRow.paid_role}`);
say('```');
say('');
say('Lifting is a fact the Code itself anticipates -- "diğer bir bildirime');
say('kadar" -- not one this system invented.');
say('');
say('Reproduced by `scripts/verify-m1457.mjs`, which drives all of the above');
say('through the HTTP API and writes this section.');

const target = fileURLToPath(new URL('../docs/m1457-live-run.txt', import.meta.url));
fs.writeFileSync(target, out.join('\n') + '\n');
console.log(`\nwritten to ${target}`);
await pool.end();
