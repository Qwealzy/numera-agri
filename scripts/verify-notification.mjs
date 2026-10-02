// Live verification of the payout notification loop (Stage 2), driven through
// the real HTTP API against the real participant: approval -> signed webhook
// -> the insurer's receiver reads the payout with its API key -> /settle ->
// settled, with no human input. Then the receiver's half of idempotency: the
// same envelope delivered again does nothing, and a tampered one is refused.
//
// The receiver is opened by this script, on 127.0.0.1, with the same checks
// scripts/mock-insurer.mjs runs (scripts/lib/webhookVerify.mjs).
// The standing rule: nothing goes to a real
// insurer address. The demo insurer's webhook_url is pointed at the receiver
// for the run and written back exactly as it was, in a finally, whatever
// happens in between.
//
// The only direct SQL writes are the oracle reading and its trigger outbox row
// (as verify-m1456-routing.mjs does), and the webhook address and its restore.
// Reads are direct SQL and direct ledger queries, because the claim being
// verified is that they agree.
//
// Needs `npm start` running with WEBHOOK_SIGNING_MASTER_KEY set: the sender is
// part of it. Without the key this script refuses rather than skipping.
// No secret, key or address is written to the evidence file or the console.

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { handleWebhook } from './lib/webhookVerify.mjs';
import { fileURLToPath } from 'node:url';

// POST /policies requires the policy document's SHA-256 in lowercase hex
// (migration 034); the document itself never reaches the platform.
const DOCUMENT_HASH = crypto.createHash('sha256').update('verify-notification policy document').digest('hex');

const ENV_PATH = fileURLToPath(new URL('../node/.env', import.meta.url));
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
}

if (!process.env.WEBHOOK_SIGNING_MASTER_KEY) {
  console.error('verify-notification: WEBHOOK_SIGNING_MASTER_KEY is empty in node/.env. The sender does not start without it, so there is nothing to verify. Refusing (fail closed), not skipping.');
  process.exit(1);
}

const BASE = `http://localhost:${process.env.PORT ?? 8080}/api/v1`;
const KEY = process.argv[2] ?? 'demo-api-key';
const { pool } = await import('../node/src/db.js');
const { queryActiveContracts } = await import('../node/src/damlClient.js');
const { deriveSecret } = await import('../node/src/notifications/signature.js');
const { insertWindowedTrigger } = await import('../node/test-support/windowedTrigger.mjs');

const CONTRACT = JSON.parse(fs.readFileSync(new URL('../docs/api/notifications-v1.openapi.json', import.meta.url), 'utf8'));
const ENVELOPE_KEYS = [...CONTRACT.components.schemas.Envelope.required].sort();
const RECORD_KEYS = [...CONTRACT.components.schemas.PayoutRecord.required].sort();

const RUN = Date.now().toString(36);
// Cell ids in the oracle's own format, "metno:<lat>,<lon>" with at most 4 decimals. The
// first two decimals of the latitude name this script, the first two of the longitude
// count the cells this run hands out, and the last two of each carry the run.
const CELL_RUN = String(parseInt(RUN, 36) % 10000).padStart(4, '0');
let cellCount = 0;
const nextCell = () =>
  `metno:0.17${CELL_RUN.slice(0, 2)},0.${String(++cellCount).padStart(2, '0')}${CELL_RUN.slice(2)}`;
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

const check = (cond, what) => {
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
};

const poll = async (what, fn, seconds = 90) => {
  for (let i = 0; i < seconds; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} did not happen within ${seconds}s`);
};

const settleOutbox = (policyId, type) => poll(`outbox ${type} for ${policyId}`, async () => {
  const { rows } = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = $2
     ORDER BY created_at DESC LIMIT 1`, [policyId, type]
  );
  return rows[0] && (rows[0].status === 'done' || rows[0].status === 'failed') ? rows[0] : null;
});

// The oracle bot writes these on a schedule; the verification supplies one
// directly rather than waiting for a cron (verify-m1456-routing.mjs).
// v22: as a window -- the stored response, the reading, the trigger_windows
// row with the event interval, and the outbox row naming it
// (node/test-support/windowedTrigger.mjs); the dispatcher sends no trigger
// without one. The interval is an hour that ended a minute ago, inside cover.
const fireTrigger = async (policyId, value) => {
  const { rows } = await pool.query(
    `SELECT c.cell_ids, p.current_version FROM policy_coverages c JOIN policies p ON p.id = c.policy_id
      WHERE c.policy_id = $1 AND c.coverage_code = 'FROST-COVER'`, [policyId]
  );
  const eventEnd = new Date(Date.now() - 60 * 1000);
  const { eventId } = await insertWindowedTrigger(pool, {
    policyId, coverageCode: 'FROST-COVER', cellId: rows[0].cell_ids[0], value,
    eventStart: new Date(eventEnd.getTime() - 60 * 60 * 1000), eventEnd,
    expectedVersion: rows[0].current_version,
  });
  return poll('trigger', async () => {
    const { rows: ev } = await pool.query('SELECT * FROM policy_events WHERE id = $1', [eventId]);
    return ev[0] && (ev[0].status === 'done' || ev[0].status === 'failed') ? ev[0] : null;
  });
};

// Instants to the microsecond, as text: a JS Date keeps milliseconds, and the
// claim is that the two are the SAME instant, not the same millisecond.
const MICROS_SQL = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const ledgerMicros = (t) => {
  const m = String(t).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/);
  if (!m) throw new Error(`unexpected ledger time format: ${t}`);
  return `${m[1]}.${(m[2] ?? '').padEnd(6, '0')}Z`;
};
// Decimals compared as decimals, never as floats: "25000.00" and
// "25000.0000000000" are one amount.
const decimal = (s) => {
  const [i, f = ''] = String(s).split('.');
  const frac = f.replace(/0+$/, '');
  return frac ? `${i}.${frac}` : i;
};

const payoutSnapshot = async (payoutId) => JSON.stringify((await pool.query(
  'SELECT * FROM payout_events WHERE id = $1', [payoutId]
)).rows[0]);

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

// ---------------------------------------------------------------------------
// The receiver: the insurer's side of the contract.
// ---------------------------------------------------------------------------
const insurer = (await pool.query(
  `SELECT id, canton_party_id, webhook_url, webhook_secret_version
     FROM insurers WHERE api_key_hash = encode(sha256($1::bytea),'hex')`, [KEY]
)).rows[0];
if (!insurer) throw new Error('no insurer for the API key given');
const original = { webhookUrl: insurer.webhook_url, version: insurer.webhook_secret_version };
const secret = deriveSecret(process.env.WEBHOOK_SIGNING_MASTER_KEY, insurer.id, insurer.webhook_secret_version);

const received = [];        // every request, with its raw body and headers, for the replay
const decisions = [];       // what handleWebhook decided about each
const records = new Map();  // payoutId -> the PayoutRecord the receiver fetched
const settleCalls = [];     // every /settle the receiver made
const gets = [];            // every GET the receiver made
const seen = new Set();
let ourPolicyId = null;
const ourPayoutIds = new Set();

async function onNew(envelope) {
  // Other payouts of this insurer that were waiting for an address arrive too
  // once one is set (in verify-all, the earlier scripts' payouts). They are
  // acknowledged and nothing is done with them. Decided by the payout's
  // policy, which is known before the trigger fires: the sender may deliver
  // before this script has read the payout row.
  const owner = (await pool.query('SELECT policy_id FROM payout_events WHERE id = $1', [envelope.payoutId])).rows[0];
  if (!owner || owner.policy_id !== ourPolicyId) return;
  ourPayoutIds.add(envelope.payoutId);
  gets.push(envelope.payoutId);
  const record = await call('GET', `/payouts/${envelope.payoutId}`);
  records.set(envelope.payoutId, record);
  if (envelope.type === 'payout.approved') {
    settleCalls.push(envelope.payoutId);
    await call('POST', `/payouts/${envelope.payoutId}/settle`, {
      bankReference: `MOCK-${envelope.payoutId.slice(0, 8)}`,
      settledAt: iso(Date.now()),
      paidRole: record.recipientRole,
    });
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => received.push({ headers: { ...req.headers }, raw: Buffer.concat(chunks).toString('utf8') }));
  handleWebhook(req, res, { secret, seen, onNew, record: (e) => decisions.push({ ...e }) }).catch((err) => {
    decisions.push({ error: err.message });
    if (!res.headersSent) res.writeHead(500).end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const receiverUrl = `http://127.0.0.1:${server.address().port}/webhook`;

// A POST of exact bytes and headers, as the sender would make it.
const postToReceiver = async (headers, raw) => {
  const res = await fetch(receiverUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-id': headers['x-webhook-id'],
      'x-webhook-timestamp': headers['x-webhook-timestamp'],
      'x-webhook-signature': headers['x-webhook-signature'],
    },
    body: raw,
  });
  await res.text();
  return res.status;
};

let failure = null;
try {
  await pool.query('UPDATE insurers SET webhook_url = $1 WHERE id = $2', [receiverUrl, insurer.id]);

  say('## Live verification run (Stage 2 — the payout notification loop)');
  say('');
  say('Through the real HTTP API against the real participant, with the sender');
  say('running inside `npm start`. The receiver is this script\'s own, on');
  say('127.0.0.1, running the checks of scripts/lib/webhookVerify.mjs: the same');
  say('code scripts/mock-insurer.mjs runs. Invented data throughout; no real');
  say('insurer address (the standing rule).');
  say('');
  say('```');
  say(`  demo insurer                = ${insurer.id}`);
  say(`  its webhook_url before      = ${original.webhookUrl === null ? 'NULL' : 'set (value not shown)'}`);
  say(`  its webhook_secret_version  = ${original.version}`);
  say(`  during the run              = the receiver on 127.0.0.1 (ephemeral port)`);
  say(`  signing secret              = derived from the master key in node/.env (not shown)`);
  say('```');
  say('');

  // -------------------------------------------------------------------------
  // (c) A policy, activated, first premium reported, then a trigger.
  // -------------------------------------------------------------------------
  const policyId = (await call('POST', '/policies', {
    policyholder: { externalRef: `notification-${RUN}` },
    documentHash: DOCUMENT_HASH,
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: istanbulDay(daysAgo(30)), endDate: istanbulDay(daysAhead(180)) },
    agreedCoverageStart: daysAgo(30),
    coverages: [{
      coverageCode: 'FROST-COVER',
      productCode: 'FROST-STANDARD',
      perilType: 'FROST',
      cellIds: [nextCell()],
      sumInsured: 100000,
      // v22: required by the API, with no default. The basis v21 applied.
      metric: 'TEMPERATURE_C',
      payoutBasis: 'PB_RemainingLimit',
    }],
  })).policy.id;
  ourPolicyId = policyId;
  await call('POST', `/policies/${policyId}/activate`, {});
  const activation = await settleOutbox(policyId, 'activation');
  check(activation.status === 'done', `activation done (was ${activation.status}: ${activation.error})`);
  await call('POST', `/policies/${policyId}/first-premium-paid`, { paidAt: iso(Date.now()) });
  const premium = await settleOutbox(policyId, 'first_premium_paid');
  check(premium.status === 'done', `first premium recorded (was ${premium.status}: ${premium.error})`);
  const trigger = await fireTrigger(policyId, -2);
  check(trigger.status === 'done', `trigger done (was ${trigger.status}: ${trigger.error})`);

  say('### (c) Policy, activation, first premium, trigger');
  say('```');
  say(`  policy                     = ${policyId}`);
  say(`  activation outbox row      = ${activation.status}`);
  say(`  first_premium_paid row     = ${premium.status}`);
  say(`  trigger (reading -2 C)     = ${trigger.status}`);
  say('```');
  say('');

  // -------------------------------------------------------------------------
  // (d) The approved row, and its approval instant against the ledger's.
  // -------------------------------------------------------------------------
  const payout = (await pool.query(
    `SELECT id, status::text AS status, record_kind, recipient, payout_amount::text AS amount, currency,
            daml_contract_id, ${MICROS_SQL.replace('%s', 'approved_at')} AS approved_at_us
       FROM payout_events WHERE policy_id = $1 ORDER BY created_at ASC`, [policyId]
  )).rows;
  check(payout.length === 1, `one payout row (got ${payout.length})`);
  const p = payout[0];
  check(p.status === 'approved' && p.record_kind === 'payout', 'the row is an approved payout');
  const ledgerPayout = (await queryActiveContracts({
    moduleName: 'Insurance.PayoutBridge', entityName: 'PayoutApproved', parties: [insurer.canton_party_id],
  })).map((e) => e.contractEntry.JsActiveContract.createdEvent).find((c) => c.contractId === p.daml_contract_id);
  check(ledgerPayout, 'the PayoutApproved contract is active on the ledger');
  const ledgerApprovedAt = ledgerMicros(ledgerPayout.createArgument.approvedAt);
  check(p.approved_at_us === ledgerApprovedAt, 'approved_at is the ledger\'s approvedAt to the microsecond');
  check(decimal(p.amount) === decimal(ledgerPayout.createArgument.amount), 'SQL amount = ledger amount');

  say('### (d) payout_events against the ledger');
  say('```');
  say(`  payout_events.id            = ${p.id}`);
  say(`  status / record_kind        = ${p.status} / ${p.record_kind}`);
  say(`  recipient                   = ${p.recipient}`);
  say(`  SQL    amount               = ${p.amount} ${p.currency}`);
  say(`  LEDGER amount               = ${ledgerPayout.createArgument.amount}`);
  say(`  SQL    approved_at          = ${p.approved_at_us}`);
  say(`  LEDGER PayoutApproved.approvedAt = ${ledgerPayout.createArgument.approvedAt}`);
  say(`  same instant (microseconds) = ${p.approved_at_us === ledgerApprovedAt}`);
  say('```');
  say('');

  // -------------------------------------------------------------------------
  // (e) Delivered, and what the receiver got.
  // -------------------------------------------------------------------------
  const notification = await poll('delivery', async () => {
    const { rows } = await pool.query(
      `SELECT id, kind::text AS kind, status::text AS status, attempt_count, last_status_code, last_error,
              delivered_at FROM payout_notifications WHERE payout_event_id = $1`, [p.id]
    );
    return rows[0]?.status === 'delivered' ? rows[0] : null;
  });
  const delivery = received.find((r) => r.headers['x-webhook-id'] === notification.id);
  const decided = decisions.find((d) => d.webhookId === notification.id && !d.duplicate);
  check(delivery && decided, 'the receiver got this notification');
  const envelope = JSON.parse(delivery.raw);
  check(decided.signatureValid && decided.answer === 200, 'signature valid, answered 200');
  check(JSON.stringify(Object.keys(envelope).sort()) === JSON.stringify(ENVELOPE_KEYS), 'the body has exactly the five envelope keys');
  check(delivery.headers['x-webhook-id'] === notification.id && envelope.id === notification.id, 'X-Webhook-Id = body id = notification id');
  check(envelope.payoutId === p.id && envelope.type === 'payout.approved', 'the envelope names this payout, as payout.approved');

  say('### (e) Delivered, and verified at the receiver');
  say('```');
  say(`  payout_notifications.id     = ${notification.id}`);
  say(`  kind / status               = ${notification.kind} / ${notification.status}`);
  say(`  attempt_count               = ${notification.attempt_count}`);
  say(`  last_status_code            = ${notification.last_status_code}`);
  say(`  delivered_at                = ${notification.delivered_at.toISOString()}`);
  say('');
  say(`  X-Webhook-Id                = ${delivery.headers['x-webhook-id']}`);
  say(`  X-Webhook-Timestamp         = ${delivery.headers['x-webhook-timestamp']}`);
  say(`  X-Webhook-Signature         = v1=<64 hex, not shown>`);
  say(`  signature valid             = ${decided.signatureValid}`);
  say(`  receiver answered           = ${decided.answer}`);
  say(`  body, byte for byte         = ${delivery.raw}`);
  say(`  body keys                   = ${Object.keys(envelope).sort().join(', ')}`);
  say(`  contract Envelope.required  = ${ENVELOPE_KEYS.join(', ')}`);
  say('```');
  say('');

  // -------------------------------------------------------------------------
  // (f) The record the receiver fetched with the API key.
  // -------------------------------------------------------------------------
  const record = records.get(p.id);
  check(record, 'the receiver fetched the record');
  check(JSON.stringify(Object.keys(record).sort()) === JSON.stringify(RECORD_KEYS), 'the record has exactly PayoutRecord\'s keys');
  check(decimal(record.amount) === decimal(ledgerPayout.createArgument.amount), 'record amount = ledger amount');

  say('### (f) GET /api/v1/payouts/:payoutId, as the receiver made it');
  say('```');
  say(`  keys = contract PayoutRecord.required: ${JSON.stringify(Object.keys(record).sort()) === JSON.stringify(RECORD_KEYS)} (${RECORD_KEYS.length} keys)`);
  for (const line of JSON.stringify(record, null, 2).split('\n')) say(`  ${line}`);
  say('');
  say(`  record amount ${record.amount} = ledger amount ${ledgerPayout.createArgument.amount}: ${decimal(record.amount) === decimal(ledgerPayout.createArgument.amount)}`);
  say('```');
  say('');

  // -------------------------------------------------------------------------
  // (g) The receiver reported the settlement; wait for the ledger round trip.
  // -------------------------------------------------------------------------
  const settlement = await settleOutbox(policyId, 'settlement');
  check(settlement.status === 'done', `settlement done (was ${settlement.status}: ${settlement.error})`);
  const settled = (await pool.query(
    `SELECT status::text AS status, bank_reference, paid_role, settled_at, resolved_at FROM payout_events WHERE id = $1`, [p.id]
  )).rows[0];
  check(settled.status === 'settled', 'payout_events.status = settled');
  check(settleCalls.length === 1, `the receiver called /settle once (${settleCalls.length})`);

  say('### (g) Settled, from the receiver\'s own /settle call');
  say('```');
  say(`  /settle calls by receiver   = ${settleCalls.length}`);
  say(`  settlement outbox row       = ${settlement.status}`);
  say(`  payout_events.status        = ${settled.status}`);
  say(`  bank_reference              = ${settled.bank_reference}   <- the mock's, obviously fake`);
  say(`  paid_role                   = ${settled.paid_role}`);
  say(`  settled_at (reported)       = ${settled.settled_at.toISOString()}`);
  say(`  resolved_at                 = ${settled.resolved_at?.toISOString?.() ?? settled.resolved_at}`);
  say('```');
  say('');

  // -------------------------------------------------------------------------
  // (h) The same envelope again, same headers: 200 and nothing else.
  // -------------------------------------------------------------------------
  const beforeReplay = await payoutSnapshot(p.id);
  const settlementsBefore = (await pool.query(
    `SELECT count(*)::int n FROM policy_events WHERE policy_no = $1 AND event_type = 'settlement'`, [policyId]
  )).rows[0].n;
  const replayFrom = decisions.length;
  const replayStatus = await postToReceiver(delivery.headers, delivery.raw);
  const replayDecision = decisions.slice(replayFrom).find((d) => d.webhookId === notification.id);
  const afterReplay = await payoutSnapshot(p.id);
  const settlementsAfter = (await pool.query(
    `SELECT count(*)::int n FROM policy_events WHERE policy_no = $1 AND event_type = 'settlement'`, [policyId]
  )).rows[0].n;
  check(replayStatus === 200 && replayDecision?.duplicate, 'the repeat is answered 200 and recognised as a repeat');
  check(settleCalls.length === 1 && gets.length === 1, 'no second GET and no second /settle');
  check(beforeReplay === afterReplay, 'payout_events unchanged');
  check(settlementsBefore === settlementsAfter, 'no second settlement outbox row');

  say('### (h) The same envelope delivered again');
  say('```');
  say(`  seconds since the original  = ${Math.floor(Date.now() / 1000) - Number(delivery.headers['x-webhook-timestamp'])} (inside the receiver's 300s)`);
  say(`  receiver answered           = ${replayStatus}`);
  say(`  recognised as a repeat      = ${replayDecision.duplicate}`);
  say(`  GETs by receiver            = ${gets.length}`);
  say(`  /settle calls by receiver   = ${settleCalls.length}`);
  say(`  settlement outbox rows      = ${settlementsBefore} before, ${settlementsAfter} after`);
  say(`  payout_events row identical = ${beforeReplay === afterReplay}`);
  say('```');
  say('');

  // -------------------------------------------------------------------------
  // (i) A broken signature: 401 and nothing.
  // -------------------------------------------------------------------------
  const sig = delivery.headers['x-webhook-signature'];
  const broken = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
  const tamperedHeaders = { ...delivery.headers, 'x-webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'x-webhook-signature': broken };
  const tamperedFrom = decisions.length;
  const tamperedStatus = await postToReceiver(tamperedHeaders, delivery.raw);
  const tamperedDecision = decisions.slice(tamperedFrom).find((d) => d.webhookId === notification.id);
  check(tamperedDecision, 'the receiver recorded the tampered request');
  check(tamperedStatus === 401 && !tamperedDecision.signatureValid, 'a broken signature is 401');
  check(settleCalls.length === 1 && gets.length === 1, 'still no second GET or /settle');
  check((await payoutSnapshot(p.id)) === afterReplay, 'payout_events still unchanged');

  say('### (i) A broken signature');
  say('```');
  say(`  signature                   = the delivered one with its last hex digit changed (not shown)`);
  say(`  receiver answered           = ${tamperedStatus}`);
  say(`  reason                      = ${tamperedDecision.reason}`);
  say(`  GETs / /settle by receiver  = ${gets.length} / ${settleCalls.length}`);
  say(`  payout_events row identical = true`);
  say('```');
  say('');

  const foreign = decisions.filter((d) => d.payoutId && !ourPayoutIds.has(d.payoutId) && !d.duplicate).length;
  say('### What else the receiver saw');
  say('```');
  say(`  requests in total           = ${decisions.length}`);
  say(`  other payouts of this insurer, waiting for an address and delivered once one was set,`);
  say(`  acknowledged and not acted on = ${foreign}`);
  say('```');
} catch (err) {
  failure = err;
} finally {
  // Written back exactly as it was, whatever happened above.
  await pool.query(
    'UPDATE insurers SET webhook_url = $1, webhook_secret_version = $2 WHERE id = $3',
    [original.webhookUrl, original.version, insurer.id]
  );
  const restored = (await pool.query('SELECT webhook_url, webhook_secret_version FROM insurers WHERE id = $1', [insurer.id])).rows[0];
  const same = restored.webhook_url === original.webhookUrl && restored.webhook_secret_version === original.version;
  say('');
  say('### Restored');
  say('```');
  say(`  webhook_url                 = ${restored.webhook_url === null ? 'NULL' : 'set (value not shown)'}; same as before the run: ${restored.webhook_url === original.webhookUrl}`);
  say(`  webhook_secret_version      = ${restored.webhook_secret_version}; same as before the run: ${restored.webhook_secret_version === original.version}`);
  say('```');
  await new Promise((resolve) => server.close(resolve));
  if (!same) failure ??= new Error('the demo insurer\'s webhook settings were not restored');
}

if (failure) {
  say('');
  say(`RUN FAILED: ${failure.message}`);
}
const target = fileURLToPath(new URL('../docs/mvp-notification-live-run.txt', import.meta.url));
fs.writeFileSync(target, out.join('\n') + '\n');
console.log(`\nwritten to ${target}`);
await pool.end();
if (failure) process.exit(1);
