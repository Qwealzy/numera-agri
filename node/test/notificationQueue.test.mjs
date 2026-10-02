import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from '../src/db.js';
import { enqueuePayoutNotification } from '../src/notifications/enqueue.js';

// The payout notification queue (migration 035), in SQL only. It needs no
// LocalNet: what is under test is the table's own discipline -- the UNIQUE
// that makes enqueueing idempotent, and the status-transition trigger that
// refuses in the table what application code might otherwise get wrong.
//
// Nothing here sends anything. The sender (src/notifications/sender.js) has
// its own test, notificationSender.test.mjs, against a loopback receiver. It
// is loopback-only unless WEBHOOK_ALLOW_NON_LOOPBACK is 'true', as
// (the project's standing rule).

let insurerId;
let policyholderId;
let policyId;

// policies.document_hash is required, as a SHA-256 in lowercase hex
// (migration 034), and this fixture writes policies directly.
const DOCUMENT_HASH = crypto.createHash('sha256').update('notification queue test policy document').digest('hex');

// Inserts a payout_events row and returns its id. record_kind 'payout'
// requires a daml_contract_id, so each row gets a unique fake one.
async function aPayout() {
  const { rows } = await pool.query(
    `INSERT INTO payout_events
       (policy_id, coverage_code, payout_percentage, payout_amount, currency,
        status, daml_contract_id, recipient, record_kind, approved_at)
     VALUES ($1, 'TEST-COVERAGE', 25.00, 100.00, 'TRY', 'approved', $2, 'PDR_Insured', 'payout', now())
     RETURNING id`,
    [policyId, `fake-cid-${crypto.randomUUID()}`]
  );
  return rows[0].id;
}

// Queues one notification and returns its id.
async function queued(payoutEventId, kind = 'payout_approved') {
  await enqueuePayoutNotification(pool, { payoutEventId, insurerId, kind });
  const { rows } = await pool.query(
    `SELECT id FROM payout_notifications WHERE payout_event_id = $1 AND kind = $2`,
    [payoutEventId, kind]
  );
  return rows[0].id;
}

// Puts a queued row into 'processing', the only state the interesting
// transitions leave from.
async function claim(notificationId) {
  await pool.query(
    `UPDATE payout_notifications SET status = 'processing' WHERE id = $1`,
    [notificationId]
  );
}

before(async () => {
  const insurer = await pool.query(
    `INSERT INTO insurers (legal_name, api_key_hash) VALUES ($1, $2) RETURNING id`,
    ['Test Insurer Ltd (notificationQueue fixture, fake)', crypto.randomBytes(16).toString('hex')]
  );
  insurerId = insurer.rows[0].id;
  const person = await pool.query(
    `INSERT INTO policyholders (insurer_id, external_ref) VALUES ($1, $2) RETURNING id`,
    [insurerId, `notificationQueue-${crypto.randomUUID()}`]
  );
  policyholderId = person.rows[0].id;
  const policy = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, start_date, end_date, document_hash)
     VALUES ($1, $2, 1000.00, '2026-01-01', '2026-12-31', $3) RETURNING id`,
    [insurerId, policyholderId, DOCUMENT_HASH]
  );
  policyId = policy.rows[0].id;
});

test('enqueueing the same payout and kind twice leaves one row', async () => {
  const payoutEventId = await aPayout();
  await enqueuePayoutNotification(pool, { payoutEventId, insurerId, kind: 'payout_approved' });
  await enqueuePayoutNotification(pool, { payoutEventId, insurerId, kind: 'payout_approved' });

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM payout_notifications WHERE payout_event_id = $1`,
    [payoutEventId]
  );
  assert.equal(rows[0].n, 1, 'the second enqueue must be a no-op, not a second notification');
});

test('two kinds for one payout are two rows', async () => {
  const payoutEventId = await aPayout();
  await enqueuePayoutNotification(pool, { payoutEventId, insurerId, kind: 'payout_approved' });
  await enqueuePayoutNotification(pool, { payoutEventId, insurerId, kind: 'review_required' });

  const { rows } = await pool.query(
    `SELECT kind::text AS kind FROM payout_notifications WHERE payout_event_id = $1 ORDER BY kind::text`,
    [payoutEventId]
  );
  assert.deepEqual(rows.map((r) => r.kind), ['payout_approved', 'review_required']);
});

test('a queued row starts pending, unattempted, due and carries no payload', async () => {
  const payoutEventId = await aPayout();
  await enqueuePayoutNotification(pool, { payoutEventId, insurerId, kind: 'payout_approved' });

  const { rows } = await pool.query(
    `SELECT status::text AS status, attempt_count, next_attempt_at IS NOT NULL AS due,
            delivered_at, last_status_code, last_error
       FROM payout_notifications WHERE payout_event_id = $1`,
    [payoutEventId]
  );
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].attempt_count, 0);
  assert.equal(rows[0].due, true);
  assert.equal(rows[0].delivered_at, null);
  // No payload is stored: the row points at the payout and carries nothing
  // about it (a standing rule -- the envelope is built at delivery).
  assert.equal(rows[0].last_status_code, null);
  assert.equal(rows[0].last_error, null);
});

test('the trigger refuses delivered -> pending', async () => {
  const id = await queued(await aPayout());
  await claim(id);
  await pool.query(
    `UPDATE payout_notifications SET status = 'delivered', delivered_at = now() WHERE id = $1`,
    [id]
  );

  await assert.rejects(
    () => pool.query(`UPDATE payout_notifications SET status = 'pending' WHERE id = $1`, [id]),
    /invalid payout_notifications status transition: delivered -> pending/,
    'delivered is terminal'
  );
});

test('the trigger refuses failed -> processing', async () => {
  const id = await queued(await aPayout());
  await claim(id);
  await pool.query(`UPDATE payout_notifications SET status = 'failed' WHERE id = $1`, [id]);

  await assert.rejects(
    () => pool.query(`UPDATE payout_notifications SET status = 'processing' WHERE id = $1`, [id]),
    /invalid payout_notifications status transition: failed -> processing/,
    'failed is terminal'
  );
});

test('the trigger refuses processing -> pending without a spent attempt', async () => {
  const id = await queued(await aPayout());
  await claim(id);

  await assert.rejects(
    () => pool.query(`UPDATE payout_notifications SET status = 'pending' WHERE id = $1`, [id]),
    /payout_notifications retry without a spent attempt: attempt_count 0 -> 0/,
    'a row cannot be handed back to the queue without recording the attempt'
  );
});

test('processing -> pending is allowed when the attempt was counted', async () => {
  const id = await queued(await aPayout());
  await claim(id);

  await pool.query(
    `UPDATE payout_notifications
        SET status = 'pending', attempt_count = attempt_count + 1,
            next_attempt_at = now() + interval '1 minute', last_status_code = 503
      WHERE id = $1`,
    [id]
  );
  const after = await pool.query(
    `SELECT status::text AS status, attempt_count, last_status_code
       FROM payout_notifications WHERE id = $1`,
    [id]
  );
  assert.equal(after.rows[0].status, 'pending');
  assert.equal(after.rows[0].attempt_count, 1);
  assert.equal(after.rows[0].last_status_code, 503);
});

test('delivered without a delivered_at is refused by the CHECK', async () => {
  const id = await queued(await aPayout());
  await claim(id);

  await assert.rejects(
    () => pool.query(`UPDATE payout_notifications SET status = 'delivered' WHERE id = $1`, [id]),
    /payout_notifications_delivered_has_time/,
    "'delivered' is a claim about a time and does not get to be made without one"
  );
});

after(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mine = 'SELECT id FROM policies WHERE insurer_id = $1';
    // FK order: notifications reference payout_events, which reference policies.
    await client.query(
      `DELETE FROM payout_notifications
        WHERE payout_event_id IN (SELECT id FROM payout_events WHERE policy_id IN (${mine}))`,
      [insurerId]
    );
    await client.query(`DELETE FROM payout_events WHERE policy_id IN (${mine})`, [insurerId]);
    await client.query('DELETE FROM policies WHERE insurer_id = $1', [insurerId]);
    await client.query('DELETE FROM policyholders WHERE insurer_id = $1', [insurerId]);
    await client.query('DELETE FROM insurers WHERE id = $1', [insurerId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Loud, never swallowed: leftover debris is what the leak gate exists to catch.
    console.error('[notificationQueue.test] teardown FAILED, rows may be left behind:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
});
