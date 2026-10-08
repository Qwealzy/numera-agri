import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

// The payout notification sender against a receiver on a
// loopback port. It needs no LocalNet. What is under test is what goes onto
// the wire -- the envelope's bytes, the signature over exactly those bytes,
// the delivery id -- and what the queue row records afterwards, including
// what it must never record: anything the receiver said.
//
// The loopback gate makes a rule mechanical: nothing is delivered to a
// real insurer address until a legal review is complete.

const MASTER_KEY = 'test-master-key-not-a-secret';

// The receiver. Each path is one behaviour; every request is recorded with
// its raw body bytes, so the test compares bytes, not a re-serialization.
const received = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ path: req.url, headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') });
    if (req.url === '/ok') {
      res.writeHead(200).end();
    } else if (req.url === '/fail') {
      res.writeHead(500).end();
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: '/ok' }).end();
    } else if (req.url === '/leaky') {
      res.writeHead(500, { 'x-leak': 'SECRET-HEADER', 'content-type': 'text/plain' }).end('SECRET-BODY');
    } else {
      res.writeHead(404).end();
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Set before src/config.js is loaded: dotenv does not override a variable
// that is already present, so the dynamic imports below pick these up. A
// two-step schedule keeps the exhaustion test short.
process.env.WEBHOOK_SIGNING_MASTER_KEY = MASTER_KEY;
process.env.WEBHOOK_RETRY_SCHEDULE_MS = '60000,300000';
process.env.WEBHOOK_TIMEOUT_MS = '2000';
process.env.WEBHOOK_ALLOW_NON_LOOPBACK = 'false';
const { pool } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { runOnce } = await import('../src/notifications/sender.js');
const { deriveSecret, sign } = await import('../src/notifications/signature.js');
const { buildEnvelope } = await import('../src/notifications/envelope.js');

const DOCUMENT_HASH = crypto.createHash('sha256').update('notification sender test policy document').digest('hex');
const insurerIds = [];

// One insurer, policy and queued notification per test. The claim takes the
// oldest due row among insurers with an address, so after each test -- passed
// or failed -- every fixture insurer's address is cleared (afterEach below),
// and a row a test left pending can never be claimed by a later one.
async function aNotification(webhookUrl, kind = 'payout_approved') {
  const insurer = await pool.query(
    `INSERT INTO insurers (legal_name, api_key_hash, webhook_url) VALUES ($1, $2, $3) RETURNING id`,
    ['Test Insurer Ltd (notificationSender fixture, fake)', crypto.randomBytes(16).toString('hex'), webhookUrl]
  );
  const insurerId = insurer.rows[0].id;
  insurerIds.push(insurerId);
  const person = await pool.query(
    `INSERT INTO policyholders (insurer_id, external_ref) VALUES ($1, $2) RETURNING id`,
    [insurerId, `notificationSender-${crypto.randomUUID()}`]
  );
  const policy = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, start_date, end_date, document_hash)
     VALUES ($1, $2, 1000.00, '2026-01-01', '2026-12-31', $3) RETURNING id`,
    [insurerId, person.rows[0].id, DOCUMENT_HASH]
  );
  const payout = await pool.query(
    `INSERT INTO payout_events
       (policy_id, coverage_code, payout_percentage, payout_amount, currency,
        status, daml_contract_id, recipient, record_kind, approved_at)
     VALUES ($1, 'TEST-COVERAGE', 25.00, 100.00, 'TRY', 'approved', $2, 'PDR_Insured', 'payout', now())
     RETURNING id`,
    [policy.rows[0].id, `fake-cid-${crypto.randomUUID()}`]
  );
  const n = await pool.query(
    `INSERT INTO payout_notifications (payout_event_id, insurer_id, kind) VALUES ($1, $2, $3) RETURNING id`,
    [payout.rows[0].id, insurerId, kind]
  );
  return { insurerId, notificationId: n.rows[0].id };
}

async function row(notificationId) {
  const { rows } = await pool.query(
    `SELECT id, payout_event_id, insurer_id, kind::text AS kind, status::text AS status, attempt_count,
            next_attempt_at, last_status_code, last_error, delivered_at, created_at
       FROM payout_notifications WHERE id = $1`,
    [notificationId]
  );
  return rows[0];
}

afterEach(async () => {
  await pool.query('UPDATE insurers SET webhook_url = NULL WHERE id = ANY($1)', [insurerIds]);
});

// A second ahead of the wall clock. next_attempt_at defaults to Postgres's
// now(), which keeps microseconds; a JS Date truncates to milliseconds and can
// land just before it, leaving a row the test has just queued not yet due.
const due = () => Date.now() + 1000;

const requestsTo = (path) => received.filter((r) => r.path === path);

test('200: delivered, and the receiver verifies the signature over the exact bytes it got', async () => {
  const { insurerId, notificationId } = await aNotification(`${BASE}/ok`);
  const before = requestsTo('/ok').length;
  const now = new Date(due());
  await runOnce({ now });

  const r = await row(notificationId);
  assert.equal(r.status, 'delivered');
  assert.equal(r.last_status_code, 200);
  assert.equal(r.last_error, null);
  assert.equal(r.delivered_at.getTime(), now.getTime());

  const got = requestsTo('/ok').slice(before);
  assert.equal(got.length, 1);
  const { headers, raw } = got[0];
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-webhook-id'], notificationId);
  assert.match(headers['x-webhook-timestamp'], /^\d+$/);
  // The receiver's side: derive the insurer's secret, sign what arrived,
  // compare in constant time.
  const expected = `v1=${sign(deriveSecret(MASTER_KEY, insurerId, 1), headers['x-webhook-timestamp'], raw)}`;
  assert.ok(
    crypto.timingSafeEqual(Buffer.from(headers['x-webhook-signature']), Buffer.from(expected)),
    'the signature must verify over the received bytes'
  );
  // The bytes that arrived are the envelope, byte for byte, and nothing else.
  assert.equal(raw, buildEnvelope(r));
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['apiVersion', 'createdAt', 'id', 'payoutId', 'type']);
  assert.ok(!Object.keys(headers).some((h) => /numera|insurance/i.test(h)), 'no header names the product');
});

test('500: back to pending with one attempt spent and the next one in the future', async () => {
  const { notificationId } = await aNotification(`${BASE}/fail`);
  const now = new Date(due());
  await runOnce({ now });

  const r = await row(notificationId);
  assert.equal(r.status, 'pending');
  assert.equal(r.attempt_count, 1);
  assert.equal(r.last_status_code, 500);
  assert.equal(r.last_error, 'http 500');
  assert.equal(r.next_attempt_at.getTime(), now.getTime() + 60000);
  assert.equal(r.delivered_at, null);
});

test('the schedule runs out: failed after the last retry', async () => {
  const { notificationId } = await aNotification(`${BASE}/fail`);
  const t0 = due();
  await runOnce({ now: new Date(t0) });
  // Not yet due: nothing is claimed before next_attempt_at.
  await runOnce({ now: new Date(t0 + 30000) });
  assert.equal((await row(notificationId)).attempt_count, 1);
  await runOnce({ now: new Date(t0 + 61000) });
  assert.equal((await row(notificationId)).status, 'pending');
  await runOnce({ now: new Date(t0 + 61000 + 301000) });

  const r = await row(notificationId);
  assert.equal(r.status, 'failed');
  assert.equal(r.attempt_count, 3);
  assert.equal(r.last_error, 'http 500');
});

test('two attempts at one notification carry the same X-Webhook-Id', async () => {
  const { notificationId } = await aNotification(`${BASE}/fail`);
  const before = requestsTo('/fail').length;
  const t0 = due();
  await runOnce({ now: new Date(t0) });
  await runOnce({ now: new Date(t0 + 61000) });

  const got = requestsTo('/fail').slice(before);
  assert.equal(got.length, 2);
  assert.equal(got[0].headers['x-webhook-id'], notificationId);
  assert.equal(got[1].headers['x-webhook-id'], notificationId);
  assert.equal(got[0].raw, got[1].raw, 'a retry sends the same envelope');
});

test('an insurer with no webhook_url: the row is not claimed', async () => {
  const { notificationId } = await aNotification(null);
  const before = received.length;
  await runOnce({ now: new Date(Date.now() + 86400000) });

  const r = await row(notificationId);
  assert.equal(r.status, 'pending');
  assert.equal(r.attempt_count, 0);
  assert.equal(received.length, before);
});

test('a non-loopback address: failed without a request, and the error names the non-loopback rule', async () => {
  // .invalid never resolves: if a request were attempted the row would come
  // back pending with a DNS error, not failed with the non-loopback text.
  const { notificationId } = await aNotification('https://insurer.invalid/hook');
  const before = received.length;
  await runOnce({ now: new Date(due()) });

  const r = await row(notificationId);
  assert.equal(r.status, 'failed');
  assert.equal(r.attempt_count, 0);
  assert.equal(r.last_status_code, null);
  assert.equal(r.last_error, 'destination is not loopback and WEBHOOK_ALLOW_NON_LOOPBACK is not set');
  assert.equal(received.length, before);
});

test('302: the redirect is not followed and counts as a failure', async () => {
  const { notificationId } = await aNotification(`${BASE}/redirect`);
  const okBefore = requestsTo('/ok').length;
  await runOnce({ now: new Date(due()) });

  const r = await row(notificationId);
  assert.equal(r.status, 'pending');
  assert.equal(r.attempt_count, 1);
  assert.equal(r.last_status_code, 302);
  assert.equal(r.last_error, 'http 302');
  assert.equal(requestsTo('/ok').length, okBefore, 'the Location must not be requested');
});

test("last_error carries none of the receiver's body, headers or address", async () => {
  const { notificationId } = await aNotification(`${BASE}/leaky`);
  await runOnce({ now: new Date(due()) });

  const r = await row(notificationId);
  assert.equal(r.last_error, 'http 500');
  for (const s of ['SECRET-BODY', 'SECRET-HEADER', '127.0.0.1', String(server.address().port), '/leaky']) {
    assert.ok(!r.last_error.includes(s), `last_error must not contain ${s}`);
  }
});

test('without a signing master key runOnce sends nothing and claims nothing', async () => {
  const { notificationId } = await aNotification(`${BASE}/ok`);
  const before = received.length;
  const saved = config.notificationSender.signingMasterKey;
  config.notificationSender.signingMasterKey = undefined;
  try {
    await runOnce({ now: new Date(due()) });
  } finally {
    config.notificationSender.signingMasterKey = saved;
  }

  const r = await row(notificationId);
  assert.equal(r.status, 'pending');
  assert.equal(r.attempt_count, 0);
  assert.equal(received.length, before, 'there is no unsigned delivery path');
});

// A row left in processing by a sender that exited mid-delivery. Inserted as
// processing, with its updated_at: the status trigger and set_updated_at guard
// updates, not inserts.
async function strandProcessing(notificationId, attemptCount, updatedAt) {
  const n = await row(notificationId);
  await pool.query('DELETE FROM payout_notifications WHERE id = $1', [notificationId]);
  await pool.query(
    `INSERT INTO payout_notifications (id, payout_event_id, insurer_id, kind, status, attempt_count, updated_at)
     VALUES ($1, $2, $3, $4, 'processing', $5, $6)`,
    [n.id, n.payout_event_id, n.insurer_id, n.kind, attemptCount, updatedAt]
  );
}

const longAgo = () => new Date(Date.now() - config.notificationSender.staleProcessingMs - 1000);

test('a stale processing row is released to pending with the attempt counted; a fresh one is left alone', async () => {
  // No address on either insurer, so the released row is not claimed again in
  // the same run and what the release wrote can be read.
  const stale = await aNotification(null);
  const fresh = await aNotification(null);
  await strandProcessing(stale.notificationId, 0, longAgo());
  await strandProcessing(fresh.notificationId, 0, new Date());
  const now = new Date(due());
  await runOnce({ now });

  const r = await row(stale.notificationId);
  assert.equal(r.status, 'pending');
  assert.equal(r.attempt_count, 1);
  assert.equal(r.next_attempt_at.getTime(), now.getTime());
  assert.equal(r.last_error, 'released: stale processing');
  const f = await row(fresh.notificationId);
  assert.equal(f.status, 'processing');
  assert.equal(f.attempt_count, 0);
});

test('a stale processing row whose schedule has run out is failed, not released', async () => {
  const { notificationId } = await aNotification(`${BASE}/ok`);
  const before = received.length;
  // Two retries in this file's schedule: a third spent attempt has no delay left.
  await strandProcessing(notificationId, 2, longAgo());
  await runOnce({ now: new Date(due()) });

  const r = await row(notificationId);
  assert.equal(r.status, 'failed');
  assert.equal(r.attempt_count, 3);
  assert.equal(r.last_error, 'released: stale processing');
  assert.equal(received.length, before, 'a failed row is not sent');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mine = 'SELECT id FROM policies WHERE insurer_id = ANY($1)';
    // FK order: notifications reference payout_events and insurers; payout
    // events reference policies; policies reference policyholders.
    await client.query('DELETE FROM payout_notifications WHERE insurer_id = ANY($1)', [insurerIds]);
    await client.query(`DELETE FROM payout_events WHERE policy_id IN (${mine})`, [insurerIds]);
    await client.query('DELETE FROM policies WHERE insurer_id = ANY($1)', [insurerIds]);
    await client.query('DELETE FROM policyholders WHERE insurer_id = ANY($1)', [insurerIds]);
    await client.query('DELETE FROM insurers WHERE id = ANY($1)', [insurerIds]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Loud, never swallowed: leftover debris is what the leak gate exists to catch.
    console.error('[notificationSender.test] teardown FAILED, rows may be left behind:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
});
