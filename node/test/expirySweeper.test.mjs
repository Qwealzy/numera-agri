import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from '../src/db.js';
import { runOnce } from '../src/sweepers/expirySweeper.js';

// Pure SQL-query tests -- expirySweeper.js never touches the ledger
// (confirmed by search: it imports nothing from damlClient.js, dispatch/
// dispatcher.js remains the only caller), so unlike dispatcher.test.mjs
// this file needs no live Canton participant or real allocated party --
// it only exercises the sweeper's own "expired and still open" query.

let insurerId;

// policies.document_hash is required, as a SHA-256 in lowercase hex (migration
// 034), and these fixtures write policies directly.
const DOCUMENT_HASH = crypto.createHash('sha256').update('expiry sweeper test policy document').digest('hex');

before(async () => {
  const inserted = await pool.query(`INSERT INTO insurers (legal_name, api_key_hash) VALUES ($1, $2) RETURNING id`, [
    'Test Insurer Ltd (expirySweeper fixture, fake)',
    crypto.randomBytes(16).toString('hex'),
  ]);
  insurerId = inserted.rows[0].id;
});

// Removes every row this file created, in FK dependency order, so a suite run
// leaves the database as it found it.
//
// This exists for one screen: a fixture policy carrying `fake-cid` (or no
// contract id) while still `active` is exactly what /debug/dashboard reports
// as ORPHAN_SQL, so every run used to add noise to the one view that says
// whether the system is healthy. The orphan detection is right -- it was the
// fixtures that were wrong.
//
// Scoped by this file's own insurerId, so the three test files cannot delete
// each other's rows, and nothing outside the fixtures is touched. Deleting by
// insurer also sweeps the role registry whole, which matters: the v13 round
// showed a mortgagee's or beneficiary's `policyholders` row survives a
// policyholder-only sweep as residue.
//
// Two ordering traps, both learned by having them bite: `policy_events`
// references `oracle_readings`, so outbox rows must go BEFORE the readings
// they point at; and `policies` has two self-referential FKs (a renewal links
// two rows together) which must be nulled before any delete.
//
// It does NOT revoke the Canton parties allocated during a run -- those are
// participant state, not rows, and revoking them is the package-migration
// cleanup step.
async function removeFixtureRows() {
  if (!insurerId) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mine = 'SELECT id FROM policies WHERE insurer_id = $1';
    await client.query(
      `UPDATE policies SET renewed_by_policy_id = NULL WHERE renewed_by_policy_id IN (${mine})`,
      [insurerId]
    );
    await client.query(
      `UPDATE policies SET predecessor_policy_id = NULL WHERE predecessor_policy_id IN (${mine})`,
      [insurerId]
    );
    await client.query(`DELETE FROM payout_notifications WHERE payout_event_id IN (SELECT id FROM payout_events WHERE policy_id IN (${mine}))`, [insurerId]);
    await client.query(`DELETE FROM payout_events WHERE policy_id IN (${mine})`, [insurerId]);
    await client.query(`DELETE FROM policy_events WHERE policy_no IN (${mine})`, [insurerId]);
    for (const t of ['policy_documents', 'policy_status_history', 'policy_coverages', 'oracle_readings']) {
      await client.query(`DELETE FROM ${t} WHERE policy_id IN (${mine})`, [insurerId]);
    }
    await client.query('DELETE FROM policies WHERE insurer_id = $1', [insurerId]);
    await client.query('DELETE FROM policyholders WHERE insurer_id = $1', [insurerId]);
    await client.query('DELETE FROM payout_tiers WHERE insurer_id = $1', [insurerId]);
    await client.query('DELETE FROM insurers WHERE id = $1', [insurerId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Loud, never swallowed: leftover debris is the exact thing this exists to
    // prevent, so a cleanup that fails must be visible rather than quiet.
    console.error('[fixture cleanup] FAILED -- rows may be left behind:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// node:test runs after() even when tests fail, so a failing run cleans up too.
after(async () => {
  try {
    await removeFixtureRows();
  } finally {
    await pool.end();
  }
});

async function createPolicyholder() {
  const { rows } = await pool.query(
    `INSERT INTO policyholders (insurer_id, external_ref)
     VALUES ($1, $2) RETURNING *`,
    [insurerId, `test-ref-${crypto.randomUUID()}`]
  );
  return rows[0];
}

// Inserts a policy directly at whatever status/expiry a test needs -- the
// sweeper's query is what's under test here, not activation itself
// (dispatcher.test.mjs already covers how a real token gets minted and
// `expiry` gets set).
async function createPolicyAt(policyholderId, { status, expiry, damlContractId = null }) {
  const { rows } = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date,
        status, expiry, daml_contract_id, current_version, document_hash)
     VALUES ($1,$2,500,'TRY','2020-01-01','2020-06-30',$3,$4,$5,1,$6)
     RETURNING *`,
    [insurerId, policyholderId, status, expiry, damlContractId, DOCUMENT_HASH]
  );
  return rows[0];
}

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

async function expiryEventCount(policyId) {
  const { rows } = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'expiry'`,
    [policyId]
  );
  return rows;
}

test('an expired, still-open policy gets one expiry outbox row', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, { status: 'active', expiry: YESTERDAY, damlContractId: 'fake-cid' });

  await runOnce({ insurerIds: [insurerId] });

  const rows = await expiryEventCount(policy.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
});

test('a policy whose term has not passed is not swept', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, { status: 'active', expiry: TOMORROW, damlContractId: 'fake-cid' });

  await runOnce({ insurerIds: [insurerId] });

  assert.equal((await expiryEventCount(policy.id)).length, 0);
});

test('a second sweeper run produces no second outbox row', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    status: 'partially_paid',
    expiry: YESTERDAY,
    damlContractId: 'fake-cid',
  });

  await runOnce({ insurerIds: [insurerId] });
  await runOnce({ insurerIds: [insurerId] }); // simulates re-running after a missed run, and a normal re-fire alike

  const rows = await expiryEventCount(policy.id);
  assert.equal(rows.length, 1, 'a policy must expire exactly once no matter how many times the sweeper runs');
});

test('a claimed_and_closed policy is never swept', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    status: 'claimed_and_closed',
    expiry: YESTERDAY,
    damlContractId: null, // a closed policy has no live token, same as production's 48f83e94-...
  });

  await runOnce({ insurerIds: [insurerId] });

  assert.equal(
    (await expiryEventCount(policy.id)).length,
    0,
    'a terminal status must never be swept, regardless of its expiry date'
  );
});
