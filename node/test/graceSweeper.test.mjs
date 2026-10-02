import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from '../src/db.js';
import { runOnce } from '../src/sweepers/graceSweeper.js';

// Pure SQL-query tests -- graceSweeper.js never touches the ledger (it
// imports nothing from damlClient.js), so like expirySweeper.test.mjs this
// needs no live Canton participant. It exercises the sweeper's two state
// tests: "notice period elapsed and still in grace_period" (phase one,
// termination) and "terminated with a live token and no unresolved payout"
// (phase two, the archive).

let insurerId;

// policies.document_hash is required, as a SHA-256 in lowercase hex (migration
// 034), and these fixtures write policies directly.
const DOCUMENT_HASH = crypto.createHash('sha256').update('grace sweeper test policy document').digest('hex');

before(async () => {
  const inserted = await pool.query(`INSERT INTO insurers (legal_name, api_key_hash) VALUES ($1, $2) RETURNING id`, [
    'Test Insurer Ltd (graceSweeper fixture, fake)',
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

// Inserts a policy directly at whatever state a test needs -- the sweeper's
// query is what's under test here, not how a policy reaches the
// grace_period default state (dispatcher.test.mjs covers that end of it).
//
// Stage 3 Part 3: takes BOTH axes now. `status` defaults to 'active'
// because most of these tests only care about the default axis -- but the
// combination that matters most (partially_paid + grace_period) is exactly
// what the old single-field design could not express, and is tested
// explicitly below.
async function createPolicyAt(
  policyholderId,
  { status = 'active', defaultState, noticeServiceDate, gracePeriodDays }
) {
  const { rows } = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date,
        status, default_state, notice_service_date, grace_period_days, daml_contract_id, current_version, document_hash)
     VALUES ($1,$2,500,'TRY','2026-01-01','2027-01-01',$3,$4,$5,$6,'fake-cid',1,$7)
     RETURNING *`,
    [insurerId, policyholderId, status, defaultState, noticeServiceDate, gracePeriodDays, DOCUMENT_HASH]
  );
  return rows[0];
}

const DAYS_AGO_30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const DAYS_AGO_2 = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

async function terminationRows(policyId) {
  const { rows } = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'termination'`,
    [policyId]
  );
  return rows;
}

async function archiveRows(policyId) {
  const { rows } = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'termination_archive'`,
    [policyId]
  );
  return rows;
}

// An unresolved PayoutApproved on a policy -- the thing that must keep the
// token alive after the contract has been terminated.
async function createOpenPayout(policyId) {
  const { rows } = await pool.query(
    `INSERT INTO payout_events
       (policy_id, coverage_code, payout_percentage, payout_amount, currency, daml_contract_id)
     VALUES ($1, 'FROST', 25, 25000, 'TRY', $2) RETURNING *`,
    [policyId, `fake-payout-cid-${crypto.randomUUID()}`]
  );
  return rows[0];
}

test('a policy whose notice period has elapsed gets one termination outbox row', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'grace_period',
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: 14,
  });

  await runOnce({ insurerIds: [insurerId] });

  const rows = await terminationRows(policy.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
});

// THE FREEZE (m. 1431(4)). A substituted policy is excluded from phase one,
// and what that rests on is the incompatibility of two phrases: "sozlesme bu
// kisilerle devam eder" against "sozlesme feshedilmis olur". The clock is not
// reset -- default_state stays grace_period and the notice date stays put --
// only the one outcome the two phrases cannot share is refused.
test('a substituted policy whose notice period has elapsed is NOT swept', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'grace_period',
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: 10,
  });
  // A control first: identical policy, not substituted, IS swept. Otherwise
  // the absence below would prove nothing.
  const control = await createPolicyAt(ph.id, {
    defaultState: 'grace_period',
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: 10,
  });

  await pool.query(
    `UPDATE policies SET insured_policyholder_id = policyholder_id,
        enforcement_fruitless_at = $2, enforcement_route = 'ER_Takip',
        substitution_notified_at = $2, substituted_at = $2,
        superseded_policyholder_id = $3
      WHERE id = $1`,
    [policy.id, DAYS_AGO_2, ph.id]
  );

  await runOnce({ insurerIds: [insurerId] });

  assert.equal((await terminationRows(policy.id)).length, 0, 'frozen: never queued');
  assert.equal((await terminationRows(control.id)).length, 1, 'and the control still is');

  // Frozen, not cleared: the sweeper changed nothing about the default axis.
  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'grace_period');
  assert.equal(new Date(rows[0].notice_service_date).toISOString(), DAYS_AGO_30);
});

test('a policy still inside its notice period is not swept', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'grace_period',
    noticeServiceDate: DAYS_AGO_2, // 2 days in, 14-day period -- not elapsed
    gracePeriodDays: 14,
  });

  await runOnce({ insurerIds: [insurerId] });

  assert.equal(
    (await terminationRows(policy.id)).length,
    0,
    'termination must not be queued before the notice period has actually elapsed'
  );
});

test('a second sweeper run produces no second termination row', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'grace_period',
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: 7,
  });

  await runOnce({ insurerIds: [insurerId] });
  await runOnce({ insurerIds: [insurerId] }); // simulates both a normal re-fire and a catch-up after a missed run

  assert.equal(
    (await terminationRows(policy.id)).length,
    1,
    'while its termination row is pending or processing, a policy must get no second one however many times the sweeper runs'
  );
});

// Stage 3 Part 3, the regression this whole split exists for. Before the
// axes were separated, a payout during the grace period overwrote the single
// status column with 'partially_paid', the sweeper's query stopped matching,
// and the policy was never acted on however long the premium went unpaid.
// Now the two are independent and this combination is still swept.
test('a PARTIALLY PAID policy in its grace period is still swept', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    status: 'partially_paid',   // a loss was paid during the grace period
    defaultState: 'grace_period', // ...and the premium is still unpaid
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: 14,
  });

  await runOnce({ insurerIds: [insurerId] });

  const rows = await terminationRows(policy.id);
  assert.equal(rows.length, 1, 'a claim payout must not make a defaulting policy invisible to the sweeper');
  assert.equal(rows[0].status, 'pending');
});

test('an already-terminated policy is not swept for termination again', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'terminated',
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: 7,
  });

  await runOnce({ insurerIds: [insurerId] });

  assert.equal((await terminationRows(policy.id)).length, 0);
});

test('an active policy with no notice served is never swept', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'none',
    noticeServiceDate: null,
    gracePeriodDays: 14,
  });

  await runOnce({ insurerIds: [insurerId] });

  assert.equal((await terminationRows(policy.id)).length, 0);
});

// The sweeper deliberately does not fall back to the insurer default --
// dispatcher.js froze the resolved value onto the row at activation, so a
// NULL here means something bypassed that. Such a policy must be left
// visibly unswept rather than terminated on a guessed deadline.
test('a grace-period policy with no grace_period_days is left unswept, not guessed at', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'grace_period',
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: null,
  });

  await runOnce({ insurerIds: [insurerId] });

  assert.equal((await terminationRows(policy.id)).length, 0);
});

// --- Phase two: the archive sweep -------------------------------------
//
// Termination ends the CONTRACT. The token is burned separately, and only
// once every payout raised on it has reached a terminal state -- otherwise
// termination would orphan an obligation that, per m. 1434(3)'s own
// arrangement, survives it: cover ran in full through the notice period, so
// a loss during it is payable and the payout outlives the contract.

test('a terminated policy with no open payout is queued for archive', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'terminated',
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: 10,
  });

  await runOnce({ insurerIds: [insurerId] });

  const rows = await archiveRows(policy.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
});

test('a terminated policy with an UNRESOLVED payout is NOT queued for archive', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'terminated',
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: 10,
  });
  await createOpenPayout(policy.id);

  await runOnce({ insurerIds: [insurerId] });

  assert.equal(
    (await archiveRows(policy.id)).length,
    0,
    'the token must stay live while an obligation raised on it is still open'
  );
});

test('the same policy IS queued for archive once its payout resolves', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'terminated',
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: 10,
  });
  const payout = await createOpenPayout(policy.id);

  await runOnce({ insurerIds: [insurerId] });
  assert.equal((await archiveRows(policy.id)).length, 0);

  // The insurer reports settlement; the payout reaches a terminal state.
  await pool.query(
    `UPDATE payout_events SET status = 'settled', resolved_at = now(), settled_at = now(),
       bank_reference = 'FIXTURE-REF', paid_role = 'PDR_Insured' WHERE id = $1`,
    [payout.id]
  );

  // A state test, so simply running again picks it up -- nothing had to
  // remember that this policy was skipped last time.
  await runOnce({ insurerIds: [insurerId] });
  assert.equal((await archiveRows(policy.id)).length, 1);
});

test('a policy whose token is already burned is not queued for archive', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'terminated',
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: 10,
  });
  await pool.query(`UPDATE policies SET daml_contract_id = NULL, status = 'cancelled' WHERE id = $1`, [policy.id]);

  await runOnce({ insurerIds: [insurerId] });

  assert.equal((await archiveRows(policy.id)).length, 0);
});

test('a policy still in its notice period is never queued for archive', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, {
    defaultState: 'grace_period',
    noticeServiceDate: DAYS_AGO_30,
    gracePeriodDays: 10,
  });

  await runOnce({ insurerIds: [insurerId] });

  assert.equal((await terminationRows(policy.id)).length, 1, 'phase one still fires');
  assert.equal(
    (await archiveRows(policy.id)).length,
    0,
    'phase two must wait for the termination to actually be recorded, not run ahead of it'
  );
});

// v22. Since v22 the ledger evaluates a terminated contract's windows
// by the event's time, so the last window before the termination instant is
// still payable once the termination is recorded, and the oracle queues it
// only then. The archive waits for it -- the expiry sweeper's own test, with
// terminated_at as the end. The policy carries a window rule, a cover start,
// and one in-cover reading just before the termination instant, in a
// closed window with no trigger_windows row yet.
test('a terminated policy is not queued for archive while its last window before termination is unevaluated', async () => {
  const ph = await createPolicyholder();
  const terminatedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const { rows: [policy] } = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date,
        status, default_state, notice_service_date, grace_period_days, terminated_at, daml_contract_id, current_version,
        document_hash, coverage_began_at, coverage_start_basis, event_window_timezone, event_window_start_hour,
        event_aggregation)
     VALUES ($1,$2,500,'TRY','2026-01-01','2027-01-01','active','terminated',$3,10,$4,'fake-cid',1,$5,$6,
             'CSB_AgreedWithoutPayment','UTC',0,'min')
     RETURNING *`,
    [insurerId, ph.id, DAYS_AGO_30, terminatedAt.toISOString(), DOCUMENT_HASH, DAYS_AGO_30]
  );
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL','["grace-cell"]',10000,10000,'[]','["PDR_Insured"]',
             'TEMPERATURE_C','PB_RemainingLimit')`,
    [policy.id]
  );
  await pool.query(
    `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source)
     VALUES ($1,'TEST-COVERAGE','grace-cell','TEMPERATURE_C',-1.0,$2,'graceSweeper-fixture')`,
    [policy.id, new Date(terminatedAt.getTime() - 1).toISOString()]
  );

  await runOnce({ insurerIds: [insurerId] });
  assert.equal(
    (await archiveRows(policy.id)).length,
    0,
    'the last window before the termination instant holds an in-cover reading it has not been evaluated on'
  );

  // Once no in-cover reading is left unevaluated there, the archive is queued.
  await pool.query('DELETE FROM oracle_readings WHERE policy_id = $1', [policy.id]);
  await runOnce({ insurerIds: [insurerId] });
  assert.equal((await archiveRows(policy.id)).length, 1);
});
