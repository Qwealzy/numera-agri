import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { allocateParty, queryActiveContracts, exerciseChoice, listUserRights, getLedgerEnd, revokeUserRights } from '../src/damlClient.js';
import { runOnce, pgDateToDateString, policyTermInstant, EVENT_HANDLERS } from '../src/dispatch/dispatcher.js';
import { newTextSalt, saltedDigest, matchesSaltedDigest } from '../src/dispatch/ledgerText.js';
import { createApp } from '../src/app.js';
import { readPolicyAsRoles } from '../src/routes/debug.js';
import { buildPolicyRecord } from '../src/notifications/policyRecord.js';
import { runOnce as sweepFirstPremium } from '../src/sweepers/firstPremiumSweeper.js';
import { runOnce as sweepTwoNotice } from '../src/sweepers/twoNoticeSweeper.js';
import { insertWindowedTrigger, deleteWindowedTriggerRows } from '../test-support/windowedTrigger.mjs';
import { windowFor } from '../src/oracle/eventWindow.js';

// Runs against the real, already-running Postgres + Canton LocalNet (no
// mocks) -- consistent with how the rest of this project is verified.

let insurerId;
let insurerParty;

// Every party this file allocates with a CanActAs, so after() can take each
// grant back: left behind, they count toward the ledger user's rights cap.
const grantedActAs = [];

// policies.document_hash is required, as a SHA-256 in lowercase hex (migration
// 034), and these fixtures write policies directly.
const DOCUMENT_HASH = crypto.createHash('sha256').update('dispatcher test policy document').digest('hex');

before(async () => {
  const insurerPartyId = await allocateParty(
    'Test Insurer (dispatcher.test.mjs)',
    `test-insurer-${crypto.randomUUID()}`,
    { grantActAs: true }
  );
  grantedActAs.push(insurerPartyId);
  // Stage 3 Part 1: this fixture never allocated an oracle_operator_party
  // before -- harmless while every test here only ever exercised
  // handleActivation, but handleTrigger's actAs comes from this column, so
  // the expiry-after-partial-payout test below (the first test in this
  // file to exercise a trigger) needs a real, distinct party here, same as
  // onboardInsurer.js allocates in production.
  const oracleOperatorPartyId = await allocateParty(
    'Test Oracle Operator (dispatcher.test.mjs)',
    `test-oracle-operator-${crypto.randomUUID()}`,
    { grantActAs: true }
  );
  grantedActAs.push(oracleOperatorPartyId);
  // Stage 3 Part 2: default_grace_period_days is required for activation to
  // succeed at all now (handleActivation refuses to mint a policy whose
  // grace period is configured nowhere -- see resolveGracePeriodDays). 14 is
  // a fixture value chosen for this test file only, NOT a statutory figure
  // and not a default anything in production reads.
  const inserted = await pool.query(
    `INSERT INTO insurers
       (legal_name, api_key_hash, canton_party_id, canton_party_status, oracle_operator_party,
        default_grace_period_days)
     VALUES ($1, $2, $3, 'ALLOCATED', $4, 14) RETURNING id`,
    ['Test Insurer Ltd (fixture, fake)', crypto.randomBytes(16).toString('hex'), insurerPartyId, oracleOperatorPartyId]
  );
  insurerId = inserted.rows[0].id;
  insurerParty = insurerPartyId;
  await pool.query(
    `INSERT INTO payout_tiers
       (insurer_id, product_code, peril_type, tier_order, label, threshold_min, threshold_max, payout_percentage, shape)
     VALUES ($1, 'TEST-PRODUCT', 'TEST-PERIL', 1, 'test tier', -2.0, 0.0, 25.00, 'TS_Step'),
            ($1, 'TEST-PRODUCT', 'TEST-PERIL', 2, 'test total loss', NULL, -4.0, 100.00, 'TS_Step')`,
    [insurerId]
  );
});

// Removes every row this file created, in FK dependency order, so a suite run
// leaves the database as it found it.
//
// The tests that write run against their own marked test database,
// and the leak gate (leakGate.test.mjs) fails the run on any row left in it,
// so each writing test file removes its own. When this was written
// the tests still wrote to the working database, where a fixture policy
// carrying `fake-cid` (or no contract id) while still `active` read as
// ORPHAN_SQL on /debug/dashboard; that page reads the working database, so
// these rows no longer reach it.
//
// Scoped by this file's own insurerId, so each writing test file can delete
// only its own rows, and nothing outside the fixtures is touched. Deleting by
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
// participant state, not rows, and they stay. The CanActAs rights this file
// granted them are revoked by revokeFixtureRights below, after the archive and
// this delete; the package-migration cleanup still covers the rights
// that earlier runs left behind.
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
    // v22: the triggers here are windows with stored evidence
    // (test-support/windowedTrigger.mjs), so their windows, readings, evidence
    // rows and responses go too, after the payout and outbox rows naming them.
    await deleteWindowedTriggerRows(client, (await client.query(mine, [insurerId])).rows.map((r) => r.id));
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

// Unlike the two sweeper files, this one mints REAL tokens. Deleting its SQL
// rows without archiving those contracts would leave them live in the ledger's
// active contract set, which is shared -- the test database is the tests' own,
// the participant is not -- and a live contract with no SQL row is a
// reconciliation failure. So the ledger is cleared first, then SQL.
async function archiveFixtureContracts() {
  if (!insurerParty) return;
  for (const [moduleName, entityName] of [
    ['Insurance.PolicyToken', 'PolicyToken'],
    ['Insurance.PayoutBridge', 'PayoutApproved'],
    ['Insurance.PayoutBridge', 'ManualReviewRequired'],
    // v22: the records a settlement or a close-unpaid leaves.
    ['Insurance.PayoutBridge', 'PayoutSettled'],
    ['Insurance.PayoutBridge', 'PayoutClosedUnpaid'],
  ]) {
    let entries = [];
    try {
      entries = await queryActiveContracts({ moduleName, entityName, parties: [insurerParty] });
    } catch (err) {
      console.error(`[fixture cleanup] could not list ${entityName}:`, err.message);
      continue;
    }
    for (const e of entries) {
      const created = e.contractEntry.JsActiveContract.createdEvent;
      try {
        await exerciseChoice({
          moduleName,
          entityName,
          contractId: created.contractId,
          choice: 'Archive',
          argument: {},
          // PayoutApproved has TWO signatories (insurer, oracleOperator), so
          // Archive on it must actAs both or it fails for no obvious reason.
          actAs: created.signatories?.length ? created.signatories : [insurerParty],
        });
      } catch (err) {
        console.error(`[fixture cleanup] could not archive ${entityName}:`, err.message);
      }
    }
  }
}

// The same archive also runs at the start of each section's first ledger test,
// not only in after(): every contract this file mints is seen by one fixture
// insurer party, and a party past the participant's 200-element list cap fails
// every active-contract read made for it (413, the read-limit
// incident: the read path has no paging). No test reads a contract another
// test minted, and the two sweepers that read every policy of the insurer run
// inside their own section, so a section's contracts are not needed once the
// next section starts. The distinct-oracle-party pair, inside a loop, is left to the section
// after it. The SQL rows stay until after().

// After the archive, which acts as these parties. Loud if the ledger takes back
// fewer than it was asked to.
async function revokeFixtureRights() {
  if (grantedActAs.length === 0) return;
  const rights = grantedActAs.map((party) => ({ kind: { CanActAs: { value: { party } } } }));
  const revoked = await revokeUserRights(config.daml.unsafeJwtSub, rights);
  if (revoked.length !== rights.length) {
    throw new Error(`[fixture cleanup] asked to revoke ${rights.length} CanActAs, the ledger revoked ${revoked.length}`);
  }
}

// node:test runs after() even when tests fail, so a failing run cleans up too.
after(async () => {
  try {
    await archiveFixtureContracts();
    await removeFixtureRows();
    await revokeFixtureRights();
  } finally {
    await pool.end();
  }
});

// queryActiveContracts takes { moduleName, entityName, parties } and returns
// the raw ACS entries; unwrap to the createdEvent so a test can read a
// contract straight off the LEDGER rather than trusting the SQL mirror.
async function ledgerContracts(moduleName, entityName) {
  const entries = await queryActiveContracts({ moduleName, entityName, parties: [insurerParty] });
  return entries.map((e) => e.contractEntry.JsActiveContract.createdEvent);
}

async function createPolicyholder() {
  const { rows } = await pool.query(
    `INSERT INTO policyholders (insurer_id, external_ref)
     VALUES ($1, $2) RETURNING *`,
    [insurerId, `test-ref-${crypto.randomUUID()}`]
  );
  return rows[0];
}

// Stage 2 Part 2: sum_insured/product_code/peril_type/cell_ids/
// payout_tiers_snapshot moved from `policies` to `policy_coverages` --
// this fixture now inserts one coverage row too, same values as before,
// just relocated.
// v22: the ledger refuses an expiry archive before the token's expiry,
// so a test that expires a policy mints it with a term that has already
// ended: `endDate` (YYYY-MM-DD), PAST_END_DATE below.
async function createPolicy(policyholderId, { endDate = '2027-03-31' } = {}) {
  // created_at is pinned rather than left to now(): the m. 1458 check reads
  // "backdated" as cover starting before the CONTRACT WAS MADE, so a fixture
  // whose cover start is a fixed date and whose formation is the wall clock
  // silently becomes backdated the day the clock passes it.
  const { rows } = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date, status,
        coverage_began_at, coverage_start_basis, created_at, document_hash)
     VALUES ($1,$2,500,'TRY','2026-09-01',$4,'pending_mint','2026-09-01','CSB_AgreedWithoutPayment','2026-08-01',$3)
     RETURNING *`,
    [insurerId, policyholderId, DOCUMENT_HASH, endDate]
  );
  const policy = rows[0];
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL','["cell-test"]',10000,10000,
       '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null},{"tierOrder":2,"label":"test total loss","minValue":null,"maxValue":"-4.0","payoutPct":"100.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null}]',
       '["PDR_Insured"]','TEMPERATURE_C','PB_RemainingLimit')`,
    [policy.id]
  );
  return policy;
}

async function activate(policyId, expectedVersion = 0) {
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, expected_version) VALUES ($1, 'activation', $2)
     ON CONFLICT (policy_no, expected_version) WHERE event_type = 'activation' DO NOTHING`,
    [policyId, expectedVersion]
  );
}

// Stage 3 Part 1: adds a second coverage to a policy createPolicy() already
// set up with one -- for the multi-coverage expiry test, which needs to
// prove expiry archives the whole policy regardless of how many coverages
// it has, not just the one-coverage case every other fixture here uses.
async function addSecondCoverage(policyId) {
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE-2','TEST-PRODUCT','TEST-PERIL','["cell-test-2"]',5000,5000,
       '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null},{"tierOrder":2,"label":"test total loss","minValue":null,"maxValue":"-4.0","payoutPct":"100.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null}]',
       '["PDR_Insured"]','TEMPERATURE_C','PB_RemainingLimit')`,
    [policyId]
  );
}

// Simulates what expirySweeper.js would have inserted for a policy it
// found past its term and still open -- this file tests handleExpiry
// itself, not the sweeper's own query (see expirySweeper.test.mjs for
// that), same separation dispatcher.test.mjs already keeps from
// oracleBot.js's trigger-row-writing logic.
async function insertExpiryEvent(policyId) {
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type) VALUES ($1, 'expiry')
     ON CONFLICT (policy_no) WHERE event_type = 'expiry' DO NOTHING`,
    [policyId]
  );
}

// Stage 3 Part 2: the same rows routes/policies.js's /notice and
// /reinstate endpoints write, and the one graceSweeper.js writes. Inserted
// directly here so these tests exercise the dispatcher's handlers rather
// than the HTTP layer or the sweeper's query (both covered elsewhere --
// graceSweeper.test.mjs for the query, the live run for the endpoints).
// Plain INSERT, no ON CONFLICT: these tests sequence their own events and
// each queues a given type at most once while it is in flight, so the
// partial unique indexes (re-scoped to pending/processing in migration 010)
// are never contended here. routes/policies.js owns the real conflict
// handling, and graceSweeper.test.mjs owns the "no second row" guarantee.
async function insertLifecycleEvent(policyId, eventType, payload = null) {
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, payload) VALUES ($1, $2, $3)`,
    [policyId, eventType, payload ? JSON.stringify(payload) : null]
  );
}

// Drives a policy through activation -> notice, the common prefix of every
// premium-default test below. Returns the contract id it is left holding.
async function activateAndServeNotice(policyId, serviceDate) {
  await activate(policyId);
  await runOnce();
  await insertLifecycleEvent(policyId, 'notice', { serviceDate });
  await runOnce();
  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policyId]);
  return rows[0];
}

// v22: a trigger reaches the ledger only through a window with its event
// interval and stored evidence (test-support/windowedTrigger.mjs), so this
// writes one on TEST-COVERAGE's own cell. The interval is an hour that ended
// a minute ago; each further call on the same policy an hour earlier, since a
// policy has one window per start. `eventEnd` fixes the end where a test
// needs a particular instant (before a notice deadline, or an expiry).
// Returns the trigger's outbox row id.
const triggerWindowsWritten = new Map();
async function insertTriggerReading(policyId, observedValue, { eventEnd } = {}) {
  const { rows: [coverage] } = await pool.query(
    `SELECT cell_ids FROM policy_coverages WHERE policy_id = $1 AND coverage_code = 'TEST-COVERAGE'`,
    [policyId]
  );
  const earlier = triggerWindowsWritten.get(policyId) ?? 0;
  triggerWindowsWritten.set(policyId, earlier + 1);
  const end = eventEnd ? new Date(eventEnd) : new Date(Date.now() - 60 * 1000 - earlier * 60 * 60 * 1000);
  const { eventId } = await insertWindowedTrigger(pool, {
    policyId, coverageCode: 'TEST-COVERAGE', cellId: coverage.cell_ids[0], value: observedValue,
    eventStart: new Date(end.getTime() - 60 * 60 * 1000), eventEnd: end,
  });
  return eventId;
}

// A term that has ended: two days ago, as a DATE, so the token's expiry (noon
// Istanbul on it) is in the past whatever the hour this runs at.
const PAST_END_DATE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

test('activation mints exactly one token', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);

  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].current_version, 1);
  assert.ok(rows[0].daml_contract_id, 'expected a daml_contract_id to be recorded');

  const event = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'activation'`,
    [policy.id]
  );
  assert.equal(event.rows[0].status, 'done');
  assert.equal(event.rows[0].resulting_contract_id, rows[0].daml_contract_id);
  assert.ok(event.rows[0].processed_at, 'expected processed_at to be set');
});

test('a duplicate policy_events row is a no-op', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  const firstContractId = (
    await pool.query('SELECT daml_contract_id FROM policies WHERE id = $1', [policy.id])
  ).rows[0].daml_contract_id;

  // Same write routes/policies.js's activate endpoint does on a retry --
  // ON CONFLICT on (policy_no, expected_version) WHERE event_type = 'activation'.
  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT daml_contract_id, current_version FROM policies WHERE id = $1', [
    policy.id,
  ]);
  assert.equal(rows[0].daml_contract_id, firstContractId, 'contract id must not change on reprocessing');
  assert.equal(rows[0].current_version, 1, 'version must not advance on reprocessing');

  const eventCount = await pool.query(
    `SELECT count(*) FROM policy_events WHERE policy_no = $1 AND event_type = 'activation'`,
    [policy.id]
  );
  assert.equal(eventCount.rows[0].count, '1', 'must never be more than one activation row for a given policy');
});

test('a second policy for an existing policyholder reuses the Party', async () => {
  const ph = await createPolicyholder();
  const policyA = await createPolicy(ph.id);
  const policyB = await createPolicy(ph.id);

  await activate(policyA.id);
  await runOnce();
  await activate(policyB.id);
  await runOnce();

  const contractA = (
    await pool.query('SELECT daml_contract_id FROM policies WHERE id = $1', [policyA.id])
  ).rows[0].daml_contract_id;
  const contractB = (
    await pool.query('SELECT daml_contract_id FROM policies WHERE id = $1', [policyB.id])
  ).rows[0].daml_contract_id;
  assert.notEqual(contractA, contractB, 'each policy must still get its own distinct token');

  const { rows: phRows } = await pool.query('SELECT canton_party_id FROM policyholders WHERE id = $1', [ph.id]);
  assert.ok(phRows[0].canton_party_id, 'policyholder should have exactly one allocated party');
});

test('a mismatched expected_version fails the row instead of rebasing', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  // Policy is fresh (current_version=0) -- expected_version=5 can never be
  // correct for a first activation, so this must fail, not silently apply.
  await activate(policy.id, 5);

  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].current_version, 0, 'a version-conflicted event must not change the policy');
  assert.equal(rows[0].daml_contract_id, null);

  const event = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'activation' AND expected_version = 5`,
    [policy.id]
  );
  assert.equal(event.rows[0].status, 'failed');
  assert.match(event.rows[0].error, /conflict/i);
});

test('unimplemented event types are rejected explicitly, not silently skipped', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);

  // 'notice' left this list in Stage 3 Part 2, 'endorsement' in Part 3, and
  // 'renewal' in Part 4 -- all three have real handlers now. 'release'
  // (evidence only, no ledger action) is the last one still unimplemented.
  for (const eventType of ['release']) {
    await pool.query(
      `INSERT INTO policy_events (policy_no, event_type, expected_version) VALUES ($1, $2, 0)`,
      [policy.id, eventType]
    );
  }

  await runOnce();

  const { rows } = await pool.query(
    `SELECT event_type, status, error FROM policy_events WHERE policy_no = $1 AND event_type != 'activation'`,
    [policy.id]
  );
  assert.equal(rows.length, 1);
  for (const row of rows) {
    assert.equal(row.status, 'failed');
    assert.match(row.error, /not implemented in stage 1/);
  }

  // None of these should have touched the policy at all.
  const policyRow = await pool.query('SELECT current_version, daml_contract_id FROM policies WHERE id = $1', [
    policy.id,
  ]);
  assert.equal(policyRow.rows[0].current_version, 0);
  assert.equal(policyRow.rows[0].daml_contract_id, null);
});

test('an expired multi-coverage policy is archived and marked expired', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id, { endDate: PAST_END_DATE });
  await addSecondCoverage(policy.id);
  await activate(policy.id);
  await runOnce();

  const beforeExpiry = (await pool.query('SELECT daml_contract_id FROM policies WHERE id = $1', [policy.id]))
    .rows[0];
  assert.ok(beforeExpiry.daml_contract_id, 'policy must have a live token before expiry');

  await insertExpiryEvent(policy.id);
  await runOnce();

  const { rows } = await pool.query(
    'SELECT status, daml_contract_id, expiry, contract_ended_at, record_closed_at FROM policies WHERE id = $1',
    [policy.id]
  );
  assert.equal(rows[0].status, 'expired');
  assert.equal(rows[0].daml_contract_id, null);
  // v22: the two instants the archive returned, kept apart. The
  // contract ended at its expiry; the record closed at the ledger time of the
  // archive, which comes later.
  assert.equal(new Date(rows[0].contract_ended_at).getTime(), new Date(rows[0].expiry).getTime());
  assert.ok(new Date(rows[0].record_closed_at) > new Date(rows[0].contract_ended_at), 'archived after the term ended');

  const event = await pool.query(`SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'expiry'`, [
    policy.id,
  ]);
  assert.equal(event.rows[0].status, 'done');
  assert.equal(event.rows[0].resulting_contract_id, beforeExpiry.daml_contract_id);
});

// v22: the ledger refuses an expiry archive while its own time is before
// the token's expiry, with no allowance -- the row fails, nothing is archived.
test('an expiry archive before the term has ended is refused by the ledger', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  await insertExpiryEvent(policy.id);
  await runOnce();

  const event = (await pool.query(`SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'expiry'`, [
    policy.id,
  ])).rows[0];
  assert.equal(event.status, 'failed');
  assert.match(event.error, /the term has not ended yet on the ledger clock/);
  const { rows } = await pool.query('SELECT status, daml_contract_id, contract_ended_at FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'active');
  assert.ok(rows[0].daml_contract_id, 'the token is still live');
  assert.equal(rows[0].contract_ended_at, null);
});

test('a partially-paid policy that expires still becomes expired and its remaining limit lapses', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id, { endDate: PAST_END_DATE });
  await activate(policy.id);
  await runOnce();

  // Mild-frost reading on TEST-COVERAGE: 25% payout, re-mints the token
  // with a reduced remainingLimit -- the "still has limit left" state this
  // test needs before expiring it. Since v22 the trigger is a window with its
  // event interval and stored evidence, and the interval has to lie inside
  // cover, so it ends an hour before the (past) expiry.
  const { expiry } = (await pool.query('SELECT expiry FROM policies WHERE id = $1', [policy.id])).rows[0];
  await insertTriggerReading(policy.id, -1, { eventEnd: new Date(new Date(expiry).getTime() - 60 * 60 * 1000) });
  await runOnce();

  const partiallyPaid = (
    await pool.query('SELECT status, daml_contract_id FROM policies WHERE id = $1', [policy.id])
  ).rows[0];
  assert.equal(partiallyPaid.status, 'partially_paid');
  const remainingBefore = (
    await pool.query('SELECT remaining_limit FROM policy_coverages WHERE policy_id = $1', [policy.id])
  ).rows[0].remaining_limit;
  assert.equal(Number(remainingBefore), 7500, 'expected 25% of 10000 to have been paid out, 7500 left');

  await insertExpiryEvent(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT status, daml_contract_id FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'expired', 'a partially-paid policy must still expire at its term end');
  assert.equal(rows[0].daml_contract_id, null);
});

test('serving notice moves the DEFAULT axis only and leaves status untouched', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  const serviceDate = '2026-08-01T09:00:00.000Z';

  const afterNotice = await activateAndServeNotice(policy.id, serviceDate);

  assert.equal(afterNotice.default_state, 'grace_period');
  assert.equal(afterNotice.status, 'active', 'serving notice must never touch the claim axis');
  assert.equal(afterNotice.current_version, 2, 'notice re-mints the token, so the version advances');
  assert.ok(afterNotice.daml_contract_id, 'policy must still hold a live token during its grace period');
  assert.equal(new Date(afterNotice.notice_service_date).toISOString(), serviceDate);
  assert.ok(afterNotice.notice_recorded_at, 'when the platform was told is recorded separately');
  assert.notEqual(
    new Date(afterNotice.notice_service_date).getTime(),
    new Date(afterNotice.notice_recorded_at).getTime(),
    'service date and recorded-at are different facts and must not collapse into one value'
  );

  const event = await pool.query(`SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'notice'`, [
    policy.id,
  ]);
  assert.equal(event.rows[0].status, 'done');
});

test('a notice event with no serviceDate fails loudly instead of defaulting one', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  await insertLifecycleEvent(policy.id, 'notice', null);
  await runOnce();

  const event = await pool.query(`SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'notice'`, [
    policy.id,
  ]);
  assert.equal(event.rows[0].status, 'failed');
  assert.match(event.rows[0].error, /serviceDate/);

  const { rows } = await pool.query(
    'SELECT status, default_state, notice_service_date FROM policies WHERE id = $1', [policy.id]
  );
  assert.equal(rows[0].status, 'active', 'a rejected notice must not move the policy');
  assert.equal(rows[0].default_state, 'none');
  assert.equal(rows[0].notice_service_date, null);
});

test('a trigger during the grace period pays normally', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  // Served two days ago against the fixture's 14-day period: still running.
  // v22 holds a window that ends after a passed deadline while no outcome
  // is recorded (oracleBot.js coverBoundFor, dispatcher.js claimNext), so the
  // notice here is one whose period has not elapsed.
  await activateAndServeNotice(policy.id, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());

  await insertTriggerReading(policy.id, -1);
  await runOnce();

  const { rows } = await pool.query('SELECT status, default_state FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'partially_paid', 'a loss during the grace period is payable');
  // Stage 3 Part 3, the defect this round fixes: the payout must move the
  // claim axis WITHOUT clearing the default axis. Before the split, this
  // overwrote 'grace_period' and dropped the policy out of the default flow
  // entirely -- never suspended, and unable to receive a second notice.
  assert.equal(
    rows[0].default_state,
    'grace_period',
    'a payout must never clear the premium default -- only the insurer, via Reinstate, can'
  );

  const remaining = (
    await pool.query('SELECT remaining_limit FROM policy_coverages WHERE policy_id = $1', [policy.id])
  ).rows[0].remaining_limit;
  assert.equal(Number(remaining), 7500, '25% of 10000 paid out during the grace period');

  const payout = await pool.query('SELECT * FROM payout_events WHERE policy_id = $1', [policy.id]);
  assert.equal(payout.rows.length, 1, 'a payout during the grace period is recorded exactly as any other');

  // Migration 035. approved_at is the LEDGER's instant -- since v22 the
  // ledger time the choice stamped, read back off the created contract -- not
  // the moment the SQL row was written. Compared as instants.
  const onLedger = (await ledgerContracts('Insurance.PayoutBridge', 'PayoutApproved'))
    .find((c) => c.contractId === payout.rows[0].daml_contract_id);
  assert.ok(onLedger, 'the payout row must name a PayoutApproved that is really on the ledger');
  assert.equal(
    new Date(payout.rows[0].approved_at).getTime(),
    new Date(onLedger.createArgument.approvedAt).getTime(),
    'payout_events.approved_at must equal PayoutApproved.approvedAt exactly'
  );

  // The notification is queued in the same transaction as the payout. It is
  // queued only -- nothing sends it, and it carries no payload.
  const queued = await pool.query(
    `SELECT kind::text AS kind, status::text AS status, attempt_count
       FROM payout_notifications WHERE payout_event_id = $1`,
    [payout.rows[0].id]
  );
  assert.deepEqual(
    queued.rows,
    [{ kind: 'payout_approved', status: 'pending', attempt_count: 0 }],
    'an approved payout queues exactly one payout_approved notification'
  );
});

// The ledger refuses a trigger whose eventEnd is after the transaction's
// ledger time, and the dispatcher re-sends that refusal alone on
// ORACLE_TRIGGER_UNENDED_RETRY_SCHEDULE_MS under the same command id. The
// window here ends 3 seconds after this process's clock reads it, so the
// participant refuses the first attempt unless its clock runs more than 3
// seconds ahead of this one -- which the assertion below would report, not
// hide.
test('a trigger the ledger refuses only because its event has not ended yet is re-sent, and pays once it has', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  const eventEnd = new Date(Date.now() + 3000);
  const eventId = await insertTriggerReading(policy.id, -1, { eventEnd });
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => {
    warned.push(args.join(' '));
    warn(...args);
  };
  try {
    await runOnce();
  } finally {
    console.warn = warn;
  }

  const row = (await pool.query('SELECT status, error FROM policy_events WHERE id = $1', [eventId])).rows[0];
  assert.equal(row.status, 'done', row.error ?? '');
  assert.ok(
    warned.some((w) => w.includes('the event has not ended yet on its clock')),
    'the participant refused at least the first attempt, and the dispatcher said so'
  );

  const evidence = (
    await pool.query('SELECT command_id FROM attested_evidence WHERE policy_event_id = $1', [eventId])
  ).rows;
  assert.deepEqual(
    evidence.map((e) => e.command_id),
    [`exercise-${eventId}`],
    'one evidence row, written once before the first attempt, under the one command id'
  );

  const payouts = (await pool.query('SELECT * FROM payout_events WHERE policy_id = $1', [policy.id])).rows;
  assert.equal(payouts.length, 1, 'one payout, from the one attempt the ledger accepted');
  const onLedger = (await ledgerContracts('Insurance.PayoutBridge', 'PayoutApproved'))
    .find((c) => c.contractId === payouts[0].daml_contract_id);
  assert.ok(onLedger, 'the payout row names a PayoutApproved that is really on the ledger');
  assert.ok(
    new Date(onLedger.createArgument.approvedAt).getTime() >= eventEnd.getTime(),
    'approved on the ledger at or after the event ended'
  );
});

// Stage 4 replaced the suspension tests that used to sit here. There is no
// suspension state any more: TTK 6102 m. 1434(3) TERMINATES the contract at
// the end of the notice period (`feshedilmiş olur`), and m. 1452(3) makes
// that non-derogable against the insured. What follows tests the two-phase
// shape that replaced it.

test('termination records the consequence of the notice period elapsing', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  // Notice served 30 days ago against the fixture's 14-day notice period --
  // already elapsed, which is what makes this policy terminable.
  const serviceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await activateAndServeNotice(policy.id, serviceDate);

  await insertLifecycleEvent(policy.id, 'termination');
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'terminated');
  assert.equal(rows[0].status, 'active', 'termination moves the default axis only');
  assert.equal(rows[0].current_version, 3);

  // The instant is DERIVED FROM THE NOTICE, not read off a clock: service
  // date + this policy's own period. A sweeper running days late must
  // record the same instant it would have recorded on time, so this is
  // asserted exactly, not as a range.
  const expected = new Date(new Date(serviceDate).getTime() + 14 * 24 * 60 * 60 * 1000);
  assert.equal(
    new Date(rows[0].terminated_at).getTime(),
    expected.getTime(),
    'the termination instant must come from the notice, never from when the sweeper happened to run'
  );

  const event = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'termination'`,
    [policy.id]
  );
  assert.equal(event.rows[0].status, 'done');
});

test('termination sets coverage end at the termination instant and records the unrun days', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  const serviceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await activateAndServeNotice(policy.id, serviceDate);

  await insertLifecycleEvent(policy.id, 'termination');
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  const terminatedAt = new Date(rows[0].terminated_at);
  const expiry = new Date(rows[0].expiry);

  // m. 1419: the facts a refund is computed from, and only the facts. No
  // premium figure and no refund amount is stored anywhere.
  const expectedUnrun = Math.max(0, Math.floor((expiry.getTime() - terminatedAt.getTime()) / 86400000));
  assert.equal(rows[0].unrun_days, expectedUnrun);
  assert.ok(rows[0].unrun_days > 0, 'this fixture terminates well before expiry');
  assert.ok(rows[0].term_start, 'the term start is on the record, so unrun days can be checked against it');

  const token = await ledgerContracts('Insurance.PolicyToken', 'PolicyToken');
  const mine = token.find((c) => c.contractId === rows[0].daml_contract_id);
  assert.ok(mine, 'the token is still live -- termination ends the contract, not the token');
  assert.equal(
    new Date(mine.createArgument.coverageValidThrough).getTime(),
    terminatedAt.getTime(),
    'coverage ends AT the termination instant, on the ledger as well as in SQL'
  );
  assert.equal(new Date(mine.createArgument.terminationInstant).getTime(), terminatedAt.getTime());
  assert.equal(Number(mine.createArgument.unrunDays), expectedUnrun);
  assert.equal(
    new Date(mine.createArgument.expiry).getTime(),
    expiry.getTime(),
    'expiry itself never moves -- the gap between it and coverage end IS the unrun part'
  );
});

test('a trigger after termination is rejected and leaves a failed row recording the attempt', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  const serviceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await activateAndServeNotice(policy.id, serviceDate);
  await insertLifecycleEvent(policy.id, 'termination');
  await runOnce();

  const readingId = await insertTriggerReading(policy.id, -1);
  await runOnce();

  const event = await pool.query(`SELECT * FROM policy_events WHERE id = $1`, [readingId]);
  assert.equal(event.rows[0].status, 'failed', 'the attempt must never be silently skipped');
  assert.equal(
    event.rows[0].payload.observedValue,
    -1,
    'the observed value stays on the row, so what was seen is recoverable'
  );
  // v22: a terminated contract is judged by the event's time, so
  // the refusal names the interval against coverageValidThrough, which
  // termination moved to the termination instant.
  assert.match(
    event.rows[0].error,
    /the event ends after coverageValidThrough/i,
    'the reason the ledger refused must be readable on the failed row'
  );

  const { rows } = await pool.query('SELECT status, default_state FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'terminated', 'a rejected trigger must not change the policy');
  const payout = await pool.query('SELECT * FROM payout_events WHERE policy_id = $1', [policy.id]);
  assert.equal(payout.rows.length, 0, 'a loss AFTER the contract ended is not covered');
});

// The point of the whole two-phase design. Cover during the notice period is
// real (m. 1434(3) ends the contract at the END of the period, not at its
// start), so a payout raised in that window is an obligation that survives
// the termination -- and the token cannot be burned while it is open,
// because burning it would orphan the payout and break the chain back to
// the policy it came from.
test('a payout raised during the notice period survives termination and gates the archive', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  const serviceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await activateAndServeNotice(policy.id, serviceDate);

  // A loss DURING the notice period: payable, exactly as on any other policy.
  // Its window ends an hour before the deadline (service date + 14 days),
  // which has passed: v22 holds only a window that ends AFTER it.
  const deadline = new Date(new Date(serviceDate).getTime() + 14 * 24 * 60 * 60 * 1000);
  await insertTriggerReading(policy.id, -1, { eventEnd: new Date(deadline.getTime() - 60 * 60 * 1000) });
  await runOnce();
  const payout = (await pool.query('SELECT * FROM payout_events WHERE policy_id = $1', [policy.id])).rows[0];
  assert.ok(payout, 'a loss during the notice period must pay');
  assert.equal(payout.resolved_at, null);

  await insertLifecycleEvent(policy.id, 'termination');
  await runOnce();

  // The PayoutApproved is untouched by termination -- still live on the
  // ledger, still unresolved in SQL.
  const approved = await ledgerContracts('Insurance.PayoutBridge', 'PayoutApproved');
  assert.ok(
    approved.some((c) => c.contractId === payout.daml_contract_id),
    'termination must leave a payout raised during the notice period alone'
  );
  const afterTerm = (await pool.query('SELECT * FROM payout_events WHERE id = $1', [payout.id])).rows[0];
  assert.equal(afterTerm.resolved_at, null, "the insurer's obligation survives the contract");

  // Phase two refuses while the payout is open...
  await insertLifecycleEvent(policy.id, 'termination_archive');
  await runOnce();
  const ev = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'termination_archive'`,
    [policy.id]
  );
  assert.equal(ev.rows[0].status, 'failed');
  assert.match(ev.rows[0].error, /unresolved payout/i);
  assert.ok(
    (await pool.query('SELECT daml_contract_id FROM policies WHERE id = $1', [policy.id])).rows[0].daml_contract_id,
    'the token must still be live'
  );

  // ...and succeeds once it closes. Settlement events key on
  // source_contract_id, not policy_no, so they go through the payout helper
  // rather than insertLifecycleEvent.
  const settled = await reportOnPayout(payout, {
    action: 'settle',
    bankReference: 'TEST-REF-TERMINATION',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Insured',
  });
  assert.equal(settled.status, 'done', settled.error ?? '');
  assert.ok(
    (await pool.query('SELECT resolved_at FROM payout_events WHERE id = $1', [payout.id])).rows[0].resolved_at,
    'the obligation raised during the notice period is now closed'
  );

  await insertLifecycleEvent(policy.id, 'termination_archive');
  await runOnce();
  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'cancelled');
  assert.equal(rows[0].daml_contract_id, null, 'the token is burned only once every payout has closed');
  assert.equal(rows[0].default_state, 'terminated', 'the termination itself stays on the record');
  // v22: the contract ended at the frozen termination instant; the
  // record closed at the archive's ledger time, later. Neither stands in for
  // the other.
  assert.equal(new Date(rows[0].contract_ended_at).getTime(), new Date(rows[0].terminated_at).getTime());
  assert.ok(new Date(rows[0].record_closed_at) > new Date(rows[0].contract_ended_at));
});

// The ten-day period is configuration, never a literal -- but a value BELOW
// ten is a variation to the detriment of the insured, which m. 1452(3) does
// not permit. It is refused, with the reason on the failed row.
test('a grace period configured below ten days is refused as a detrimental variation', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await pool.query('UPDATE policies SET grace_period_days = 5 WHERE id = $1', [policy.id]);

  await activate(policy.id);
  await runOnce();

  const event = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'activation'`,
    [policy.id]
  );
  assert.equal(event.rows[0].status, 'failed');
  assert.match(event.rows[0].error, /1434\(3\)/, 'the article must be named in the error');
  assert.match(event.rows[0].error, /1452\(3\)/, 'and the reason it cannot be varied away');

  const { rows } = await pool.query('SELECT status, daml_contract_id FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'pending_mint', 'nothing may mint on a period the Code would override');
  assert.equal(rows[0].daml_contract_id, null);
});

test('reinstatement from the grace period restores coverage without changing dates', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const beforeNotice = (await pool.query('SELECT expiry, end_date FROM policies WHERE id = $1', [policy.id])).rows[0];

  await insertLifecycleEvent(policy.id, 'notice', { serviceDate: '2026-08-01T09:00:00.000Z' });
  await runOnce();
  await insertLifecycleEvent(policy.id, 'reinstatement');
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'none');
  assert.equal(rows[0].status, 'active');
  assert.equal(
    new Date(rows[0].expiry).getTime(),
    new Date(beforeNotice.expiry).getTime(),
    'expiry must not move -- the term is never extended to compensate for the interruption'
  );
  assert.equal(new Date(rows[0].end_date).getTime(), new Date(beforeNotice.end_date).getTime());
  assert.ok(rows[0].notice_service_date, 'the notice history stays on the record after reinstatement');
});

// Stage 4: the branch where payment arrives INSIDE the notice period. No
// termination happens at all -- the sweeper never sees the policy, because
// reinstatement took it out of grace_period before the period elapsed.
test('payment within the notice period reinstates and no termination is ever recorded', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  // Pay out first, so the policy is partially_paid before it ever defaults --
  // reinstatement must return it to that, not wipe it back to plain active.
  await insertTriggerReading(policy.id, -1);
  await runOnce();

  // Served 2 days ago against a 14-day period -- still running.
  const serviceDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await insertLifecycleEvent(policy.id, 'notice', { serviceDate });
  await runOnce();
  assert.equal(
    (await pool.query('SELECT default_state FROM policies WHERE id = $1', [policy.id])).rows[0].default_state,
    'grace_period'
  );

  await insertLifecycleEvent(policy.id, 'reinstatement');
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'none');
  assert.equal(rows[0].status, 'partially_paid', 'reinstatement must not erase a real payout history');
  assert.equal(rows[0].terminated_at, null, 'a policy paid inside the period is never terminated');
  assert.equal(rows[0].unrun_days, null, 'and no refund facts are recorded for it');
  assert.equal(
    rows[0].notice_count,
    1,
    'm. 1434(4): the notice still counts against this insurance period after payment'
  );
  const remaining = (
    await pool.query('SELECT remaining_limit FROM policy_coverages WHERE policy_id = $1', [policy.id])
  ).rows[0].remaining_limit;
  assert.equal(Number(remaining), 7500, 'the earlier payout is not undone by reinstatement');
});

// m. 1456(4) and (5). Both are RECORDED facts: this system generates and
// sends no notification, and does not implement the mortgagee taking the
// contract over.
//
// This tests only the no-mortgagee path: the refusals, and a termination
// that opens no window. There the m. 1456 path must refuse rather than
// record a notification to nobody. The
// positive path is proven in this file, by 'the m. 1456 flows run end to end
// on a policy that has a mortgagee',
// and at the ledger layer:
// test_mortgageeNoticeWindowAndElectionAreRecorded in InsuranceTests.daml
// walks notice -> mortgagee notice -> termination -> election and asserts
// the window and the election are recorded and that ME_Continue revives
// nothing.
test('the mortgagee path refuses on a policy with no mortgagee, and termination records no window', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await pool.query('UPDATE insurers SET mortgagee_continuation_days = 15 WHERE id = $1', [insurerId]);

  const serviceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await activateAndServeNotice(policy.id, serviceDate);

  await insertLifecycleEvent(policy.id, 'mortgagee_notice', {
    notifiedAt: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString(),
  });
  await runOnce();
  const noticeEvent = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'mortgagee_notice'`,
    [policy.id]
  );
  assert.equal(noticeEvent.rows[0].status, 'failed');
  assert.match(noticeEvent.rows[0].error, /no mortgagee on this policy/i);
  assert.equal(
    (await pool.query('SELECT mortgagee_notified_at FROM policies WHERE id = $1', [policy.id]))
      .rows[0].mortgagee_notified_at,
    null,
    'a refused report records nothing'
  );

  // Termination still succeeds -- the mortgagee window is only computed when
  // there is a mortgagee, and its absence is not an error.
  await insertLifecycleEvent(policy.id, 'termination');
  await runOnce();
  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'terminated');
  assert.equal(
    rows[0].mortgagee_continuation_ends_at,
    null,
    'no mortgagee means no continuation window, not a window opened for nobody'
  );

  // And an election reported against a policy that has no mortgagee is
  // refused too, rather than being written down as a fact about no one.
  await insertLifecycleEvent(policy.id, 'mortgagee_election', { election: 'ME_Continue' });
  await runOnce();
  const electionEvent = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'mortgagee_election'`,
    [policy.id]
  );
  assert.equal(electionEvent.rows[0].status, 'failed');
  assert.equal(
    (await pool.query('SELECT mortgagee_election FROM policies WHERE id = $1', [policy.id]))
      .rows[0].mortgagee_election,
    null
  );
});

// ---------------------------------------------------------------------------
// Stage 3 Part 3, Part A -- the two status axes move independently
// ---------------------------------------------------------------------------

// Before the split, the notice index keyed on "this policy has never had a
// notice row", so a policy that defaulted, was reinstated, and defaulted
// again could never be noticed a second time. Migration 010 re-scoped that
// index to in-flight rows only.
test('a reinstated policy can receive a second notice', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activateAndServeNotice(policy.id, '2026-08-01T09:00:00.000Z');

  await insertLifecycleEvent(policy.id, 'reinstatement');
  await runOnce();
  assert.equal(
    (await pool.query('SELECT default_state FROM policies WHERE id = $1', [policy.id])).rows[0].default_state,
    'none'
  );

  // Second default cycle, months later.
  await insertLifecycleEvent(policy.id, 'notice', { serviceDate: '2026-11-01T09:00:00.000Z' });
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'grace_period', 'a second default cycle must be possible');
  assert.equal(
    new Date(rows[0].notice_service_date).toISOString(),
    '2026-11-01T09:00:00.000Z',
    'the later notice replaces the earlier service date'
  );

  const notices = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'notice' ORDER BY created_at`,
    [policy.id]
  );
  assert.equal(notices.rows.length, 2, 'both notices are real rows, not one collapsed by the index');
  assert.ok(notices.rows.every((r) => r.status === 'done'));
});

// ---------------------------------------------------------------------------
// Stage 3 Part 3, Part B -- endorsements
// ---------------------------------------------------------------------------

async function endorse(policyId, payload) {
  await insertLifecycleEvent(policyId, 'endorsement', payload);
  await runOnce();
  const { rows } = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'endorsement'
     ORDER BY created_at DESC LIMIT 1`,
    [policyId]
  );
  return rows[0];
}

async function coveragesOf(policyId) {
  const { rows } = await pool.query(
    'SELECT * FROM policy_coverages WHERE policy_id = $1 ORDER BY coverage_code',
    [policyId]
  );
  return rows;
}

test('raising a sum insured raises the remaining limit by the same delta', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  // Pay out 25% of 10000 first, so remaining (7500) is genuinely below sum
  // insured -- an endorsement must move it by the delta, not reset it.
  await insertTriggerReading(policy.id, -1);
  await runOnce();

  const event = await endorse(policy.id, {
    reason: 'ER_SumInsuredIncrease',
    sumInsuredChanges: [{ coverageCode: 'TEST-COVERAGE', sumInsured: 15000 }],
  });
  assert.equal(event.status, 'done', event.error ?? '');

  const [cov] = await coveragesOf(policy.id);
  assert.equal(Number(cov.sum_insured), 15000);
  assert.equal(
    Number(cov.remaining_limit),
    12500,
    'remaining moves by the +5000 delta (7500 -> 12500), it does not reset to the new sum insured'
  );

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].current_version, 3, 'an endorsement re-mints, so the version advances');
  assert.equal(rows[0].last_amendment_reason, 'sum_insured_increase', 'the reason is recorded');
});

const ADDED_SALT = newTextSalt();
test('an endorsement can add and remove coverages', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await addSecondCoverage(policy.id);
  await activate(policy.id);
  await runOnce();
  assert.equal((await coveragesOf(policy.id)).length, 2);

  const event = await endorse(policy.id, {
    reason: 'ER_InsuredObjectChange',
    coverageCodesToRemove: ['TEST-COVERAGE-2'],
    coveragesToAdd: [
      {
        coverageCode: 'TEST-COVERAGE-3',
        productCode: 'TEST-PRODUCT',
        perilType: 'TEST-PERIL',
        cellIds: ['cell-test-3'],
        sumInsured: 8000,
        payoutTiers: [
          { tierOrder: 1, label: 'test tier', minValue: '-2.0', maxValue: '0.0', payoutPct: '25.0', shape: 'TS_Step', pctAtMin: null, pctAtMax: null },
        ],
        // v22: the coverage's terms, and the salt the route draws when it
        // queues the row (routes/policies.js); this payload is written
        // directly, so it carries its own.
        metric: 'TEMPERATURE_C',
        payoutBasis: 'PB_SumInsured',
        cellCommitmentSalt: ADDED_SALT,
      },
    ],
  });
  assert.equal(event.status, 'done', event.error ?? '');

  const codes = (await coveragesOf(policy.id)).map((c) => c.coverage_code);
  assert.deepEqual(codes, ['TEST-COVERAGE', 'TEST-COVERAGE-3'], 'removed one, added one');

  const added = (await coveragesOf(policy.id)).find((c) => c.coverage_code === 'TEST-COVERAGE-3');
  assert.equal(Number(added.sum_insured), 8000);
  assert.equal(Number(added.remaining_limit), 8000, 'a new coverage starts with its full limit');
  assert.equal(added.product_code, 'TEST-PRODUCT', 'SQL-side metadata comes from the endorsement input');
  assert.deepEqual(added.cell_ids, ['cell-test-3']);
  // v22: the terms and the salt are on the row, and the token commits to the
  // added coverage's cell with that salt.
  assert.equal(added.metric, 'TEMPERATURE_C');
  assert.equal(added.payout_basis, 'PB_SumInsured');
  assert.equal(added.cell_commitment_salt, ADDED_SALT);
  const { rows: [row] } = await pool.query('SELECT daml_contract_id FROM policies WHERE id = $1', [policy.id]);
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken')).find((c) => c.contractId === row.daml_contract_id);
  const onToken = token.createArgument.coverages.find((c) => c.coverageCode === 'TEST-COVERAGE-3');
  assert.equal(onToken.cellCommitment, saltedDigest(ADDED_SALT, 'cell-test-3'));
  assert.equal(onToken.payoutBasis, 'PB_SumInsured');
});

// Add-and-remove rules: a code both removed and added, and the removal of a
// coverage attached now (m. 1457), fail before the ledger; the added coverage
// would carry no attachment. A removal under a new code with no attachment
// still runs, and a trigger on the added coverage passes its commitment check.
const replacementCoverage = (coverageCode, cellCommitmentSalt) => ({
  coverageCode,
  productCode: 'TEST-PRODUCT',
  perilType: 'TEST-PERIL',
  cellIds: ['cell-test-3'],
  sumInsured: 8000,
  payoutTiers: [
    { tierOrder: 1, label: 'test tier', minValue: '-2.0', maxValue: '0.0', payoutPct: '25.0', shape: 'TS_Step', pctAtMin: null, pctAtMax: null },
  ],
  metric: 'TEMPERATURE_C',
  payoutBasis: 'PB_SumInsured',
  cellCommitmentSalt,
});

async function assertReplacementRefused(addedCode, message, arrange = async () => {}) {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  await arrange(policy.id);
  const { rows: [before] } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);

  const event = await endorse(policy.id, {
    reason: 'ER_TierChange',
    coverageCodesToRemove: ['TEST-COVERAGE'],
    coveragesToAdd: [replacementCoverage(addedCode, newTextSalt())],
  });
  assert.equal(event.status, 'failed', 'the row is refused');
  assert.match(event.error, message);
  assert.ok(event.error.includes('TEST-COVERAGE'), `names the coverage: ${event.error}`);

  const { rows: [after] } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(after.daml_contract_id, before.daml_contract_id, 'nothing reached the ledger');
  assert.equal(after.current_version, before.current_version);
}

test('an endorsement row removing and adding the same coverage code fails before the ledger', async () => {
  await assertReplacementRefused('TEST-COVERAGE', /different code/);
});

test('an endorsement row removing a coverage that is attached now fails before the ledger, even with a new code added', async () => {
  await assertReplacementRefused('TEST-COVERAGE-3', /attach/, async (policyId) => {
    await pool.query(
      `UPDATE policy_coverages SET attached_at = now() - interval '1 day'
        WHERE policy_id = $1 AND coverage_code = 'TEST-COVERAGE'`,
      [policyId]
    );
  });
});

test('an endorsement row removing a coverage with no attachment and adding one under a new code runs, and a trigger on the added coverage pays', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  const salt = newTextSalt();
  const event = await endorse(policy.id, {
    reason: 'ER_TierChange',
    coverageCodesToRemove: ['TEST-COVERAGE'],
    coveragesToAdd: [replacementCoverage('TEST-COVERAGE-3', salt)],
  });
  assert.equal(event.status, 'done', event.error ?? '');

  const covs = await coveragesOf(policy.id);
  assert.deepEqual(covs.map((c) => c.coverage_code), ['TEST-COVERAGE-3'], 'removed one, added one');
  assert.equal(covs[0].cell_commitment_salt, salt);
  const { rows: [row] } = await pool.query('SELECT current_version FROM policies WHERE id = $1', [policy.id]);
  assert.equal(row.current_version, 2, 'activation, then the endorsement');

  const end = new Date(Date.now() - 60 * 1000);
  const { eventId } = await insertWindowedTrigger(pool, {
    policyId: policy.id, coverageCode: 'TEST-COVERAGE-3', cellId: 'cell-test-3', value: -1,
    eventStart: new Date(end.getTime() - 60 * 60 * 1000), eventEnd: end, expectedVersion: row.current_version,
  });
  await runOnce();
  const { rows: [trigger] } = await pool.query('SELECT status, error FROM policy_events WHERE id = $1', [eventId]);
  assert.equal(trigger.status, 'done', trigger.error ?? '');
});

test('removing a coverage that has already paid out is rejected', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  await insertTriggerReading(policy.id, -1);   // TEST-COVERAGE now has claim history
  await runOnce();

  const event = await endorse(policy.id, {
    reason: 'ER_InsuredObjectChange',
    coverageCodesToRemove: ['TEST-COVERAGE'],
  });

  assert.equal(event.status, 'failed', 'claim history cannot be erased by dropping the coverage');
  assert.match(event.error, /already paid out/i);
  const [cov] = await coveragesOf(policy.id);
  assert.equal(cov.coverage_code, 'TEST-COVERAGE', 'the coverage is still there');
  assert.equal(Number(cov.remaining_limit), 7500, 'and its history is intact');
});

test('amending a terminated policy is rejected', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  const serviceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await activateAndServeNotice(policy.id, serviceDate);
  await insertLifecycleEvent(policy.id, 'termination');
  await runOnce();

  const event = await endorse(policy.id, {
    reason: 'ER_SumInsuredIncrease',
    sumInsuredChanges: [{ coverageCode: 'TEST-COVERAGE', sumInsured: 15000 }],
  });

  assert.equal(event.status, 'failed', 'there is no contract left to amend');
  assert.match(event.error, /terminated/i);
  const [cov] = await coveragesOf(policy.id);
  assert.equal(Number(cov.sum_insured), 10000, 'nothing changed');
});

test('an endorsement during the grace period is allowed and leaves the default axis alone', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activateAndServeNotice(policy.id, '2026-08-01T09:00:00.000Z');

  const event = await endorse(policy.id, {
    reason: 'ER_Correction',
    sumInsuredChanges: [{ coverageCode: 'TEST-COVERAGE', sumInsured: 12000 }],
  });
  assert.equal(event.status, 'done', event.error ?? '');

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'grace_period', 'an endorsement moves neither status axis');
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].last_amendment_reason, 'correction');
});

test('an endorsement carrying a newDocumentHash moves policies.document_hash along with the token', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  const newDocumentHash = crypto.createHash('sha256').update('dispatcher test endorsement document').digest('hex');
  const event = await endorse(policy.id, { reason: 'ER_Correction', newDocumentHash });
  assert.equal(event.status, 'done', event.error ?? '');

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(token.createArgument.documentHash, newDocumentHash, 'the re-minted token carries the new hash');
  assert.equal(rows[0].document_hash, token.createArgument.documentHash, 'and the SQL mirror agrees with it');
});

test('an endorsement without a newDocumentHash keeps the document hash, in SQL and on the token', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  const event = await endorse(policy.id, {
    reason: 'ER_Correction',
    sumInsuredChanges: [{ coverageCode: 'TEST-COVERAGE', sumInsured: 12000 }],
  });
  assert.equal(event.status, 'done', event.error ?? '');

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(rows[0].document_hash, DOCUMENT_HASH, 'the creation hash stays');
  assert.equal(token.createArgument.documentHash, DOCUMENT_HASH, 'on the token too');
});

// The route refuses a sumInsured outside
// policy_coverages.sum_insured's NUMERIC(14,2); a row queued past it fails
// here, before the ledger. The ledger alone would take 1000.005.
test('an endorsement row whose sumInsured has more than 2 decimals fails before the ledger', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const { rows: [before] } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  const tokenBefore = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === before.daml_contract_id);
  const sumInsuredBefore = tokenBefore.createArgument.coverages
    .find((c) => c.coverageCode === 'TEST-COVERAGE').sumInsured;

  const event = await endorse(policy.id, {
    reason: 'ER_SumInsuredIncrease',
    sumInsuredChanges: [{ coverageCode: 'TEST-COVERAGE', sumInsured: 1000.005 }],
  });
  assert.equal(event.status, 'failed', 'the row is refused');
  assert.match(event.error, /NUMERIC\(14,2\)/);
  assert.match(event.error, /2 decimals/);

  const { rows: [after] } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(after.daml_contract_id, before.daml_contract_id, 'nothing reached the ledger');
  assert.equal(after.current_version, before.current_version);
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === after.daml_contract_id);
  assert.ok(token, 'the token the policy row names is still active');
  assert.equal(
    token.createArgument.coverages.find((c) => c.coverageCode === 'TEST-COVERAGE').sumInsured,
    sumInsuredBefore,
    'the coverage\'s sumInsured on the token is unchanged'
  );
});

// An added coverage's payoutDestination and
// remainingLimit are derived here, under the lock, so a row carrying either
// key fails before the ledger, and the re-minted token holds the derived ones.
const addedCoverageRow = (coverageCode, extra = {}) => ({
  coverageCode,
  productCode: 'TEST-PRODUCT',
  perilType: 'TEST-PERIL',
  cellIds: ['cell-test-3'],
  sumInsured: 8000,
  payoutTiers: [
    { tierOrder: 1, label: 'test tier', minValue: '-2.0', maxValue: '0.0', payoutPct: '25.0', shape: 'TS_Step', pctAtMin: null, pctAtMax: null },
  ],
  metric: 'TEMPERATURE_C',
  payoutBasis: 'PB_SumInsured',
  cellCommitmentSalt: newTextSalt(),
  ...extra,
});

test('an endorsement row carrying remainingLimit fails before the ledger; on a mortgaged policy an added coverage with a claim routes to the mortgagee too, one without to the insured, each at its sum insured', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank-added-claim');
  const policy = await createPolicyWithRoles(ph.id, { mortgageeId: bank.id });
  await activate(policy.id);
  await runOnce();
  const { rows: [before] } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);

  const refused = await endorse(policy.id, {
    reason: 'ER_InsuredObjectChange',
    coveragesToAdd: [addedCoverageRow('TEST-COVERAGE-3', { remainingLimit: 1 })],
  });
  assert.equal(refused.status, 'failed', 'the row is refused');
  assert.match(refused.error, /remainingLimit/);
  assert.match(refused.error, /derived/);
  const { rows: [after] } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(after.daml_contract_id, before.daml_contract_id, 'nothing reached the ledger');
  assert.equal(after.current_version, before.current_version);

  const event = await endorse(policy.id, {
    reason: 'ER_InsuredObjectChange',
    coveragesToAdd: [
      addedCoverageRow('TEST-COVERAGE-CLAIM', { mortgageeClaimAmount: 100 }),
      addedCoverageRow('TEST-COVERAGE-NOCLAIM', { cellIds: ['cell-test-4'] }),
    ],
  });
  assert.equal(event.status, 'done', event.error ?? '');

  const { row, token } = await policyAndToken(policy.id);
  assert.equal(row.current_version, before.current_version + 1, 'the endorsement re-minted');
  const claim = token.createArgument.coverages.find((c) => c.coverageCode === 'TEST-COVERAGE-CLAIM');
  const noClaim = token.createArgument.coverages.find((c) => c.coverageCode === 'TEST-COVERAGE-NOCLAIM');
  assert.deepEqual(claim.payoutDestination, ['PDR_Insured', 'PDR_Mortgagee']);
  assert.deepEqual(noClaim.payoutDestination, ['PDR_Insured']);
  for (const c of [claim, noClaim]) {
    assert.equal(Number(c.remainingLimit), Number(c.sumInsured), `${c.coverageCode}: remainingLimit == sumInsured`);
    assert.equal(Number(c.sumInsured), 8000);
  }
});

// ---------------------------------------------------------------------------
// Stage 3 Part 4 -- renewal
// ---------------------------------------------------------------------------

// Builds the successor policy row + coverages the way routes/policies.js's
// /renew endpoint does, then queues the renewal event keyed on the
// PREDECESSOR. Returns the successor's id.
async function queueRenewal(predecessorId, { sumInsured = 10000 } = {}) {
  const ph = (
    await pool.query('SELECT policyholder_id FROM policies WHERE id = $1', [predecessorId])
  ).rows[0].policyholder_id;
  const successor = (
    await pool.query(
      `INSERT INTO policies
         (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date, status, document_hash)
       VALUES ($1,$2,500,'TRY','2027-04-01','2028-03-31','pending_mint',$3)
       RETURNING *`,
      [insurerId, ph, DOCUMENT_HASH]
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL','["cell-test"]',$2,$2,
       '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null},{"tierOrder":2,"label":"test total loss","minValue":null,"maxValue":"-4.0","payoutPct":"100.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null}]',
       '["PDR_Insured"]','TEMPERATURE_C','PB_RemainingLimit')`,
    [successor.id, sumInsured]
  );
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, payload) VALUES ($1, 'renewal', $2)`,
    [predecessorId, JSON.stringify({ newPolicyId: successor.id })]
  );
  return successor.id;
}

async function lastRenewalEvent(predecessorId) {
  const { rows } = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'renewal'
     ORDER BY created_at DESC LIMIT 1`,
    [predecessorId]
  );
  return rows[0];
}

test('renewal resets limits to the new sums insured regardless of what the predecessor consumed', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const predecessor = await createPolicy(ph.id);
  await activate(predecessor.id);
  await runOnce();

  // Draw the predecessor down: 25% of 10000 paid, 7500 left.
  await insertTriggerReading(predecessor.id, -1);
  await runOnce();
  const before = (
    await pool.query('SELECT remaining_limit FROM policy_coverages WHERE policy_id = $1', [predecessor.id])
  ).rows[0];
  assert.equal(Number(before.remaining_limit), 7500);

  const successorId = await queueRenewal(predecessor.id, { sumInsured: 12000 });
  await runOnce();

  const event = await lastRenewalEvent(predecessor.id);
  assert.equal(event.status, 'done', event.error ?? '');

  const succCov = (
    await pool.query('SELECT * FROM policy_coverages WHERE policy_id = $1', [successorId])
  ).rows[0];
  assert.equal(Number(succCov.sum_insured), 12000);
  assert.equal(
    Number(succCov.remaining_limit),
    12000,
    'the new period starts at its FULL limit -- the inverse of an endorsement, which moves by a delta'
  );

  // The predecessor is completely untouched and still live.
  const pred = (await pool.query('SELECT * FROM policies WHERE id = $1', [predecessor.id])).rows[0];
  assert.equal(pred.status, 'partially_paid', 'renewal must not change the predecessor');
  assert.ok(pred.daml_contract_id, 'the predecessor keeps its live token and runs to its own term end');
  assert.equal(pred.current_version, 2, 'the predecessor is not re-minted by a renewal');
  const predCovAfter = (
    await pool.query('SELECT remaining_limit FROM policy_coverages WHERE policy_id = $1', [predecessor.id])
  ).rows[0];
  assert.equal(Number(predCovAfter.remaining_limit), 7500, "the predecessor's drawn-down limit is not restored");

  // The chain is navigable both ways.
  assert.equal(pred.renewed_by_policy_id, successorId);
  const succ = (await pool.query('SELECT * FROM policies WHERE id = $1', [successorId])).rows[0];
  assert.equal(succ.predecessor_policy_id, predecessor.id);
  assert.equal(succ.status, 'active');
  assert.equal(succ.current_version, 1, 'a new period starts at version 1');
  assert.ok(succ.daml_contract_id);
  assert.notEqual(succ.daml_contract_id, pred.daml_contract_id, 'two distinct live tokens');
});

test('renewal reuses the policyholder party rather than allocating a new one', async () => {
  const ph = await createPolicyholder();
  const predecessor = await createPolicy(ph.id);
  await activate(predecessor.id);
  await runOnce();
  const partyAfterActivation = (
    await pool.query('SELECT canton_party_id FROM policyholders WHERE id = $1', [ph.id])
  ).rows[0].canton_party_id;
  assert.ok(partyAfterActivation);

  await queueRenewal(predecessor.id);
  await runOnce();

  const partyAfterRenewal = (
    await pool.query('SELECT canton_party_id FROM policyholders WHERE id = $1', [ph.id])
  ).rows[0].canton_party_id;
  assert.equal(
    partyAfterRenewal,
    partyAfterActivation,
    'a renewal must never allocate a second party for a policyholder that already has one'
  );
});

test('renewal from an expired predecessor works -- the normal renewal case', async () => {
  const ph = await createPolicyholder();
  const predecessor = await createPolicy(ph.id, { endDate: PAST_END_DATE });
  await activate(predecessor.id);
  await runOnce();
  await insertExpiryEvent(predecessor.id);
  await runOnce();

  const expired = (await pool.query('SELECT * FROM policies WHERE id = $1', [predecessor.id])).rows[0];
  assert.equal(expired.status, 'expired');
  assert.equal(expired.daml_contract_id, null, 'an expired policy has no live token at all');

  const successorId = await queueRenewal(predecessor.id);
  await runOnce();

  const event = await lastRenewalEvent(predecessor.id);
  assert.equal(event.status, 'done', event.error ?? '');
  const succ = (await pool.query('SELECT * FROM policies WHERE id = $1', [successorId])).rows[0];
  assert.equal(succ.status, 'active');
  assert.ok(succ.daml_contract_id, 'the successor mints even though the predecessor has no token to exercise on');
  assert.equal(succ.predecessor_policy_id, predecessor.id);
});

test('renewal is rejected while the predecessor is in its grace period', async () => {
  const ph = await createPolicyholder();
  const predecessor = await createPolicy(ph.id);
  await activateAndServeNotice(predecessor.id, '2026-08-01T09:00:00.000Z');

  const successorId = await queueRenewal(predecessor.id);
  await runOnce();

  const event = await lastRenewalEvent(predecessor.id);
  assert.equal(event.status, 'failed');
  assert.match(event.error, /premium default/i);
  assert.match(event.error, /grace_period/, 'the message must name the state it is in');
  assert.match(event.error, new RegExp(predecessor.id), 'the message must name which policy is in default');

  const succ = (await pool.query('SELECT * FROM policies WHERE id = $1', [successorId])).rows[0];
  assert.equal(succ.daml_contract_id, null, 'nothing is minted for a rejected renewal');
});

test('renewal is rejected while the predecessor is terminated for non-payment', async () => {
  const ph = await createPolicyholder();
  const predecessor = await createPolicy(ph.id);
  const serviceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await activateAndServeNotice(predecessor.id, serviceDate);
  await insertLifecycleEvent(predecessor.id, 'termination');
  await runOnce();

  await queueRenewal(predecessor.id);
  await runOnce();

  const event = await lastRenewalEvent(predecessor.id);
  assert.equal(event.status, 'failed');
  assert.match(event.error, /premium default/i);
  assert.match(event.error, /terminated/);
});

test('renewing twice is rejected -- a period is succeeded exactly once', async () => {
  const ph = await createPolicyholder();
  const predecessor = await createPolicy(ph.id);
  await activate(predecessor.id);
  await runOnce();

  const firstSuccessor = await queueRenewal(predecessor.id);
  await runOnce();
  assert.equal((await lastRenewalEvent(predecessor.id)).status, 'done');

  // A second renewal of the same period.
  await queueRenewal(predecessor.id);
  await runOnce();

  const second = await lastRenewalEvent(predecessor.id);
  assert.equal(second.status, 'failed');
  assert.match(second.error, /already been renewed/i);
  const pred = (await pool.query('SELECT renewed_by_policy_id FROM policies WHERE id = $1', [predecessor.id]))
    .rows[0];
  assert.equal(pred.renewed_by_policy_id, firstSuccessor, 'the first renewal still stands');
});

// A renewal whose successor reached the ledger while its row
// ended 'failed' -- a create that timed out after the participant took it, or
// a write-back that failed -- leaves renewed_by_policy_id NULL, so /renew
// accepts a second one. Produced here by running the handler without its
// write-back, then moving the row pending -> processing -> failed (the
// transition trigger allows no done -> failed). Returns the first successor's
// contract id and the first renewal row's id.
async function renewOnLedgerOnly(predecessorId, { resultingContractId }) {
  await queueRenewal(predecessorId);
  const r1 = await lastRenewalEvent(predecessorId);
  const pred = (await pool.query('SELECT * FROM policies WHERE id = $1', [predecessorId])).rows[0];
  const { contractId } = await EVENT_HANDLERS.renewal(r1, pred);
  await pool.query(`UPDATE policy_events SET status = 'processing' WHERE id = $1`, [r1.id]);
  await pool.query(
    `UPDATE policy_events SET status = 'failed', error = 'test: no write-back', processed_at = now(),
       resulting_contract_id = $2 WHERE id = $1`,
    [r1.id, resultingContractId ? contractId : null]
  );
  const after = (await pool.query('SELECT renewed_by_policy_id FROM policies WHERE id = $1', [predecessorId])).rows[0];
  assert.equal(after.renewed_by_policy_id, null, 'the first renewal is not recorded in SQL');
  return { contractId, r1Id: r1.id };
}

async function successorTokensOf(predecessorId) {
  return (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken')).filter(
    (c) => c.createArgument.predecessorRef === predecessorId
  );
}

test('a renewal after one that reached the ledger unrecorded is refused, and no second successor is minted', async () => {
  const ph = await createPolicyholder();
  const predecessor = await createPolicy(ph.id);
  await activate(predecessor.id);
  await runOnce();
  const { contractId } = await renewOnLedgerOnly(predecessor.id, { resultingContractId: false });

  const secondSuccessor = await queueRenewal(predecessor.id);
  await runOnce();

  const second = await lastRenewalEvent(predecessor.id);
  assert.equal(second.payload.newPolicyId, secondSuccessor);
  assert.equal(second.status, 'failed', 'the second renewal must not mint');
  assert.match(second.error, /already on the ledger/);
  assert.ok(second.error.includes(contractId), 'the message names the live successor token');
  assert.equal((await successorTokensOf(predecessor.id)).length, 1, 'exactly one live successor on the ledger');
});

test('a renewal after one whose write-back failed is refused from SQL, and no second successor is minted', async () => {
  const ph = await createPolicyholder();
  const predecessor = await createPolicy(ph.id);
  await activate(predecessor.id);
  await runOnce();
  const { contractId, r1Id } = await renewOnLedgerOnly(predecessor.id, { resultingContractId: true });

  await queueRenewal(predecessor.id);
  await runOnce();

  const second = await lastRenewalEvent(predecessor.id);
  assert.equal(second.status, 'failed', 'the second renewal must not mint');
  assert.match(second.error, /write-back failed/);
  assert.ok(second.error.includes(r1Id), 'the message names the earlier renewal row');
  assert.ok(second.error.includes(contractId), 'the message names the contract that row put on the ledger');
  assert.equal((await successorTokensOf(predecessor.id)).length, 1, 'exactly one live successor on the ledger');
});

test('renewing a claimed_and_closed policy is rejected', async () => {
  const ph = await createPolicyholder();
  const predecessor = await createPolicy(ph.id);
  await activate(predecessor.id);
  await runOnce();
  // -5 matches the 100% tier on this fixture's matrix, exhausting the limit
  // and closing the policy.
  await insertTriggerReading(predecessor.id, -5);
  await runOnce();
  const closed = (await pool.query('SELECT * FROM policies WHERE id = $1', [predecessor.id])).rows[0];
  assert.equal(closed.status, 'claimed_and_closed');

  await queueRenewal(predecessor.id);
  await runOnce();

  const event = await lastRenewalEvent(predecessor.id);
  assert.equal(event.status, 'failed');
  assert.match(event.error, /claimed_and_closed/);
});

test('the expiry sweeper closes a renewed predecessor without touching its successor', async () => {
  const ph = await createPolicyholder();
  const predecessor = await createPolicy(ph.id, { endDate: PAST_END_DATE });
  await activate(predecessor.id);
  await runOnce();
  const successorId = await queueRenewal(predecessor.id);
  await runOnce();
  assert.equal((await lastRenewalEvent(predecessor.id)).status, 'done');

  // Both live at once -- the overlap, which is correct.
  const bothLive = await pool.query(
    `SELECT id FROM policies WHERE id IN ($1,$2) AND daml_contract_id IS NOT NULL`,
    [predecessor.id, successorId]
  );
  assert.equal(bothLive.rows.length, 2, 'predecessor and successor are legitimately live simultaneously');

  await insertExpiryEvent(predecessor.id);
  await runOnce();

  const pred = (await pool.query('SELECT * FROM policies WHERE id = $1', [predecessor.id])).rows[0];
  assert.equal(pred.status, 'expired');
  assert.equal(pred.daml_contract_id, null);
  assert.equal(pred.renewed_by_policy_id, successorId, 'the chain link survives the predecessor expiring');

  const succ = (await pool.query('SELECT * FROM policies WHERE id = $1', [successorId])).rows[0];
  assert.equal(succ.status, 'active', 'the successor is entirely unaffected by its predecessor expiring');
  assert.ok(succ.daml_contract_id);
});

// Migration 037: the mortgagee continuation days and
// the first-premium withdrawal days are frozen onto the policy at activation.
// The tests that move the fixture insurer's two values run inside this, which
// puts them back, so the tests after them read only what they set themselves.
// The day counts these tests use are fixture values, not statutory figures.
async function restoringInsurerWindows(fn) {
  const { rows: [row] } = await pool.query(
    'SELECT mortgagee_continuation_days, first_premium_withdrawal_days FROM insurers WHERE id = $1',
    [insurerId]
  );
  try {
    await fn();
  } finally {
    await pool.query(
      'UPDATE insurers SET mortgagee_continuation_days = $1, first_premium_withdrawal_days = $2 WHERE id = $3',
      [row.mortgagee_continuation_days, row.first_premium_withdrawal_days, insurerId]
    );
  }
}

test('activation freezes the insurer windows onto the policy, and a renewal freezes the values of its own moment', async () => {
  await restoringInsurerWindows(async () => {
    await pool.query(
      'UPDATE insurers SET mortgagee_continuation_days = 15, first_premium_withdrawal_days = 60 WHERE id = $1',
      [insurerId]
    );
    const ph = await createPolicyholder();
    const predecessor = await createPolicy(ph.id);
    await activate(predecessor.id);
    await runOnce();
    let pred = (await pool.query('SELECT * FROM policies WHERE id = $1', [predecessor.id])).rows[0];
    assert.equal(pred.status, 'active');
    assert.equal(pred.mortgagee_continuation_days, 15);
    assert.equal(pred.first_premium_withdrawal_days, 60);

    await pool.query(
      'UPDATE insurers SET mortgagee_continuation_days = 20, first_premium_withdrawal_days = 45 WHERE id = $1',
      [insurerId]
    );
    const successorId = await queueRenewal(predecessor.id);
    await runOnce();
    const event = await lastRenewalEvent(predecessor.id);
    assert.equal(event.status, 'done', event.error ?? '');
    const succ = (await pool.query('SELECT * FROM policies WHERE id = $1', [successorId])).rows[0];
    assert.equal(succ.mortgagee_continuation_days, 20, "the successor takes the insurer's value at its activation");
    assert.equal(succ.first_premium_withdrawal_days, 45);
    pred = (await pool.query('SELECT * FROM policies WHERE id = $1', [predecessor.id])).rows[0];
    assert.equal(pred.mortgagee_continuation_days, 15, 'the predecessor keeps what it froze');
    assert.equal(pred.first_premium_withdrawal_days, 60);
  });
});

// ---------------------------------------------------------------------------
// No mint without a distinct oracle party
// ---------------------------------------------------------------------------

// Runs fn with this file's own insurer row carrying the given
// oracle_operator_party, then puts the real one back, so the tests after
// these keep minting. The two misconfigurations are the ones a mint must
// refuse: no oracle party at all, and the insurer named as its own oracle.
async function withOracleParty(value, fn) {
  const { rows: [row] } = await pool.query('SELECT oracle_operator_party FROM insurers WHERE id = $1', [insurerId]);
  await pool.query('UPDATE insurers SET oracle_operator_party = $1 WHERE id = $2', [value, insurerId]);
  try {
    await fn();
  } finally {
    await pool.query('UPDATE insurers SET oracle_operator_party = $1 WHERE id = $2', [row.oracle_operator_party, insurerId]);
  }
}

async function tokensFor(policyId) {
  return (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken')).filter(
    (c) => c.createArgument.policyNo === policyId
  );
}

for (const [label, oracleValue] of [
  ['no oracle party', () => null],
  ["the insurer's own party as oracle", () => insurerParty],
]) {
  test(`activation with ${label} fails the row and mints nothing`, async () => {
    const ph = await createPolicyholder();
    const policy = await createPolicy(ph.id);
    await withOracleParty(oracleValue(), async () => {
      await activate(policy.id);
      await runOnce();
    });

    const event = (
      await pool.query(`SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'activation'`, [policy.id])
    ).rows[0];
    assert.equal(event.status, 'failed', event.error ?? '');
    assert.match(event.error, /oracle_operator_party/, 'the message must name the missing column');
    assert.match(event.error, new RegExp(insurerId), 'the message must name which insurer row');
    assert.match(event.error, /onboardInsurer/, 'the message must say how it is normally set');

    const row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
    assert.equal(row.daml_contract_id, null, 'nothing is minted');
    assert.equal(row.status, 'pending_mint');
    assert.equal((await tokensFor(policy.id)).length, 0, 'no PolicyToken for this policy on the ledger');
  });

  test(`renewal with ${label} fails the row and mints no successor`, async () => {
    const ph = await createPolicyholder();
    const predecessor = await createPolicy(ph.id);
    await activate(predecessor.id);
    await runOnce();
    assert.ok((await pool.query('SELECT daml_contract_id FROM policies WHERE id = $1', [predecessor.id])).rows[0].daml_contract_id);

    let successorId;
    await withOracleParty(oracleValue(), async () => {
      successorId = await queueRenewal(predecessor.id);
      await runOnce();
    });

    const event = await lastRenewalEvent(predecessor.id);
    assert.equal(event.status, 'failed', event.error ?? '');
    assert.match(event.error, /oracle_operator_party/, 'the message must name the missing column');
    assert.match(event.error, new RegExp(insurerId), 'the message must name which insurer row');
    assert.match(event.error, /onboardInsurer/, 'the message must say how it is normally set');

    const succ = (await pool.query('SELECT * FROM policies WHERE id = $1', [successorId])).rows[0];
    assert.equal(succ.daml_contract_id, null, 'nothing is minted for a rejected renewal');
    assert.equal((await tokensFor(successorId)).length, 0, 'no PolicyToken for the successor on the ledger');
  });
}

// ---------------------------------------------------------------------------
// Stage 4 -- closing the payout loop
// ---------------------------------------------------------------------------

// Drives a policy to a real PayoutApproved and returns its payout_events row.
// -1 matches the fixture's 25% tier, leaving the policy partially paid and
// exactly one payout outstanding.
async function payoutFor(policyId) {
  await insertTriggerReading(policyId, -1);
  await runOnce();
  const { rows } = await pool.query(
    'SELECT * FROM payout_events WHERE policy_id = $1 ORDER BY created_at DESC LIMIT 1',
    [policyId]
  );
  return rows[0];
}

// Queues a settlement report the way routes/policies.js does, keyed on
// whichever contract is currently live for this payout.
async function reportOnPayout(payout, payload) {
  const target = payout.review_contract_id ?? payout.daml_contract_id;
  payload = { ...payload, textSalt: newTextSalt() };
  // Same ON CONFLICT the route uses. Migration 012 re-scoped the settlement
  // index to IN-FLIGHT rows, so this must carry the status predicate too --
  // an inference predicate that does not imply the index predicate does not
  // match the index at all, and Postgres refuses the statement outright.
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, source_contract_id, payload)
     VALUES ($1, 'settlement', $2, $3)
     ON CONFLICT (source_contract_id)
       WHERE event_type = 'settlement' AND status IN ('pending', 'processing')
     DO NOTHING`,
    [payout.policy_id, target, JSON.stringify(payload)]
  );
  await runOnce();
  const { rows } = await pool.query(
    `SELECT * FROM policy_events WHERE event_type = 'settlement' AND source_contract_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [target]
  );
  return rows[0];
}

async function reloadPayout(id) {
  const { rows } = await pool.query('SELECT * FROM payout_events WHERE id = $1', [id]);
  return rows[0];
}

test('a trigger no longer routes its payout to manual_review automatically', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  const payout = await payoutFor(policy.id);
  assert.ok(payout, 'a trigger must still create a payout row');
  assert.equal(
    payout.status,
    'approved',
    'a payout now waits for the insurer to report -- nothing routes it to manual_review on its own'
  );
  assert.equal(payout.resolved_at, null);

  // ...and no settlement event was queued by anything.
  const queued = await pool.query(
    `SELECT count(*)::int AS n FROM policy_events
     WHERE policy_no = $1 AND event_type = 'settlement'`,
    [policy.id]
  );
  assert.equal(queued.rows[0].n, 0, 'nothing may queue a settlement on the platform\'s own initiative');
});

test('a reported settlement closes the payout and it cannot be settled twice', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const payout = await payoutFor(policy.id);

  // After the approval and not in the future: the only instants a report may carry.
  const settledAt = new Date().toISOString();
  const event = await reportOnPayout(payout, {
    action: 'settle',
    bankReference: 'BANK-REF-NODE-1',
    settledAt,
    paidRole: 'PDR_Insured',
  });
  assert.equal(event.status, 'done', event.error ?? '');

  const after = await reloadPayout(payout.id);
  assert.equal(after.status, 'settled');
  assert.equal(after.bank_reference, 'BANK-REF-NODE-1');
  assert.equal(after.paid_role, 'PDR_Insured');
  // v22: the PayoutSettled the settlement left, by the id stored.
  const record = (await ledgerContracts('Insurance.PayoutBridge', 'PayoutSettled'))
    .find((c) => c.contractId === after.resolution_record_contract_id);
  assert.ok(record, 'the stored id names a PayoutSettled on the ledger');
  assert.equal(record.createArgument.recipient, 'PDR_Insured');
  assert.equal(new Date(record.createArgument.settledAt).toISOString(), settledAt);
  assert.equal(
    new Date(after.settled_at).toISOString(),
    settledAt,
    'the settlement date is the insurer\'s reported fact, not a clock reading'
  );
  assert.ok(after.resolved_at, 'resolved_at stamps when the payout reached a terminal state');

  // A second report on the same payout is refused by handleSettlement's own
  // resolved_at guard. Since Stage 4 the settlement index is scoped to
  // in-flight rows (so a REJECTED report never permanently bricks a payout
  // -- see migration 012), which means a second report can be queued; what
  // stops it is the guard, and the ledger behind it, where the settled
  // PayoutApproved is archived and cannot be exercised again
  // (test_settlementClosesPayoutAndCannotRepeat in InsuranceTests.daml).
  const second = await reportOnPayout(payout, {
    action: 'settle',
    bankReference: 'BANK-REF-NODE-2',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Insured',
  });
  assert.equal(second.status, 'failed');
  assert.match(second.error, /already resolved/i);
  const unchanged = await reloadPayout(payout.id);
  assert.equal(unchanged.bank_reference, 'BANK-REF-NODE-1', 'the first settlement stands');
});

test('a settlement naming a role the coverage does not allow is rejected', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const payout = await payoutFor(policy.id);

  // The fixture's coverage has payout_destination ["PDR_Insured"].
  const event = await reportOnPayout(payout, {
    action: 'settle',
    bankReference: 'BANK-REF-WRONG',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Mortgagee',
  });
  assert.equal(event.status, 'failed');
  assert.match(event.error, /payoutDestination/i);

  const after = await reloadPayout(payout.id);
  assert.equal(after.status, 'approved', 'a rejected report must not change the payout');
  assert.equal(after.resolved_at, null);
});

test('a reported failure creates a review item carrying the source contract id and coverage', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const payout = await payoutFor(policy.id);
  const originalContractId = payout.daml_contract_id;

  const event = await reportOnPayout(payout, {
    action: 'fail',
    failureReason: 'payee account closed',
  });
  assert.equal(event.status, 'done', event.error ?? '');

  const after = await reloadPayout(payout.id);
  assert.equal(after.status, 'manual_review');
  assert.ok(after.review_contract_id, 'the review item\'s contract id is recorded');
  assert.notEqual(after.review_contract_id, originalContractId);
  assert.equal(
    after.daml_contract_id,
    originalContractId,
    'the original PayoutApproved id is never overwritten -- that is the supersession link'
  );
  assert.equal(after.coverage_code, 'TEST-COVERAGE', 'the coverage travels the whole chain');
  assert.equal(after.resolved_at, null, 'a failed payout is superseded, not resolved -- it still has to end');
});

test('a review item can be closed as settled after all', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  let payout = await payoutFor(policy.id);
  await reportOnPayout(payout, { action: 'fail', failureReason: 'payee not found' });
  payout = await reloadPayout(payout.id);

  const event = await reportOnPayout(payout, {
    action: 'resolve_settled',
    bankReference: 'BANK-REF-LATE',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Insured',
  });
  assert.equal(event.status, 'done', event.error ?? '');

  const after = await reloadPayout(payout.id);
  assert.equal(after.status, 'settled');
  assert.equal(after.bank_reference, 'BANK-REF-LATE');
  assert.ok(after.resolved_at);
  // v22: the review exit leaves the same kind of record.
  const record = (await ledgerContracts('Insurance.PayoutBridge', 'PayoutSettled'))
    .find((c) => c.contractId === after.resolution_record_contract_id);
  assert.ok(record, 'the stored id names a PayoutSettled on the ledger');
});

test('a review item can be closed unpaid with an enumerated reason and a note', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  let payout = await payoutFor(policy.id);
  await reportOnPayout(payout, { action: 'fail', failureReason: 'claimant contests the amount' });
  payout = await reloadPayout(payout.id);

  // The note is mandatory -- the enum alone cannot carry the circumstances.
  // Checked on its own payout, because one contract can only ever carry one
  // settlement event and a rejected report consumes that slot.
  const ph2 = await createPolicyholder();
  const policy2 = await createPolicy(ph2.id);
  await activate(policy2.id);
  await runOnce();
  let payout2 = await payoutFor(policy2.id);
  await reportOnPayout(payout2, { action: 'fail', failureReason: 'contested' });
  payout2 = await reloadPayout(payout2.id);
  const noNote = await reportOnPayout(payout2, {
    action: 'resolve_unpaid',
    unpaidReason: 'UR_Disputed',
    note: '',
  });
  assert.equal(noNote.status, 'failed');
  assert.match(noNote.error, /note is required/i);

  const closedAt = new Date().toISOString();
  const event = await reportOnPayout(payout, {
    action: 'resolve_unpaid',
    unpaidReason: 'UR_Litigation',
    note: 'referred to arbitration, file 2026/114',
    closedAt,
  });
  assert.equal(event.status, 'done', event.error ?? '');

  const after = await reloadPayout(payout.id);
  assert.equal(after.status, 'closed_unpaid');
  assert.equal(after.unpaid_reason, 'UR_Litigation');
  assert.equal(after.resolution_note, 'referred to arbitration, file 2026/114');
  assert.ok(after.resolved_at);
  assert.equal(after.bank_reference, null, 'nothing was paid, so no bank reference is recorded');
  // v22: the insurer's declared closing instant, and the record the
  // closure left on the ledger, carrying that same instant.
  assert.equal(new Date(after.closed_at).toISOString(), closedAt);
  const record = (await ledgerContracts('Insurance.PayoutBridge', 'PayoutClosedUnpaid'))
    .find((c) => c.contractId === after.resolution_record_contract_id);
  assert.ok(record, 'the stored id names a PayoutClosedUnpaid on the ledger');
  assert.equal(new Date(record.createArgument.closedAt).getTime(), new Date(after.closed_at).getTime());
  assert.equal(record.createArgument.unpaidReason, 'UR_Litigation');
});

test('a close-unpaid report with no closedAt fails loudly instead of taking a clock reading', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  let payout = await payoutFor(policy.id);
  await reportOnPayout(payout, { action: 'fail', failureReason: 'contested' });
  payout = await reloadPayout(payout.id);
  const event = await reportOnPayout(payout, { action: 'resolve_unpaid', unpaidReason: 'UR_Other', note: 'no date given' });
  assert.equal(event.status, 'failed');
  assert.match(event.error, /closedAt is required/);
  assert.equal((await reloadPayout(payout.id)).status, 'manual_review', 'nothing changed');
});

// The route refuses these first; a row queued by any other path meets the
// same refusal here, before the ledger.
test('a settlement row whose settledAt is in the future or before approved_at fails loudly, and the payout stays open', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const payout = await payoutFor(policy.id);
  assert.ok(payout.approved_at, 'fixture: the trigger wrote the ledger\'s approval instant');

  for (const [settledAt, message] of [
    [new Date(Date.now() + 60000).toISOString(), /settledAt \S+ is in the future/],
    [new Date(new Date(payout.approved_at).getTime() - 1000).toISOString(), /settledAt \S+ is before .*approved_at/],
  ]) {
    const event = await reportOnPayout(payout, {
      action: 'settle', bankReference: 'BANK-REF-BOUNDS', settledAt, paidRole: 'PDR_Insured',
    });
    assert.equal(event.status, 'failed', settledAt);
    assert.match(event.error, message);
    const after = await reloadPayout(payout.id);
    assert.equal(after.status, 'approved');
    assert.equal(after.resolved_at, null);
  }
  const live = await ledgerContracts('Insurance.PayoutBridge', 'PayoutApproved');
  assert.ok(live.some((c) => c.contractId === payout.daml_contract_id), 'the PayoutApproved was not exercised');
});

test('a close-unpaid row whose closedAt is in the future or before approved_at fails loudly, and the item stays open', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  let payout = await payoutFor(policy.id);
  await reportOnPayout(payout, { action: 'fail', failureReason: 'contested' });
  payout = await reloadPayout(payout.id);

  for (const [closedAt, message] of [
    [new Date(Date.now() + 60000).toISOString(), /closedAt \S+ is in the future/],
    [new Date(new Date(payout.approved_at).getTime() - 1000).toISOString(), /closedAt \S+ is before .*approved_at/],
  ]) {
    const event = await reportOnPayout(payout, {
      action: 'resolve_unpaid', unpaidReason: 'UR_Other', note: 'bounds', closedAt,
    });
    assert.equal(event.status, 'failed', closedAt);
    assert.match(event.error, message);
    assert.equal((await reloadPayout(payout.id)).status, 'manual_review');
  }
  const live = await ledgerContracts('Insurance.PayoutBridge', 'ManualReviewRequired');
  assert.ok(live.some((c) => c.contractId === payout.review_contract_id), 'the review item was not exercised');
});

test('a settlement row on a payout with no approved_at fails closed', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const payout = await payoutFor(policy.id);
  // A row written before the column existed has no approved_at; this stands in for one.
  await pool.query('UPDATE payout_events SET approved_at = NULL WHERE id = $1', [payout.id]);
  const event = await reportOnPayout(payout, {
    action: 'settle', bankReference: 'BANK-REF-NULL', settledAt: new Date().toISOString(), paidRole: 'PDR_Insured',
  });
  assert.equal(event.status, 'failed');
  assert.match(event.error, /has no approved_at/);
  assert.equal((await reloadPayout(payout.id)).status, 'approved');
});

// ---------------------------------------------------------------------------
// The insurer's free text stays in SQL
// ---------------------------------------------------------------------------
//
// A bank reference, a failure reason and a closure note go through the API,
// are dispatched, and are read back from the ledger. The ledger must carry
// only "sha256:" over the row's salt and the text, never the text itself.

test('saltedDigest matches a vector computed outside node:crypto, and rejects a malformed salt', () => {
  // Computed with .NET's SHA256 over bytes 0x00..0x1f followed by the UTF-8
  // text, so it checks the formula rather than restating the implementation.
  const salt = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  const expected = 'sha256:ce26bc65b7633c0eab6acc81d333238850d2dcba0a251264ff18c18aad23d85f';
  assert.equal(saltedDigest(salt, 'İade: TR00 ödeme'), expected);
  assert.ok(matchesSaltedDigest(salt, 'İade: TR00 ödeme', expected));
  assert.ok(!matchesSaltedDigest(salt, 'İade: TR00 ödeme.', expected), 'one character more is another value');
  assert.notEqual(saltedDigest(newTextSalt(), 'x'), saltedDigest(newTextSalt(), 'x'), 'the salt is per row');
  assert.throws(() => saltedDigest('00', 'x'), /64 lowercase hex/);
  assert.throws(() => saltedDigest(undefined, 'x'), /64 lowercase hex/);
  assert.throws(() => saltedDigest(salt, ''), /non-empty/);
});

// A recognisable free text: an IBAN-shaped fake and a name. Neither is real.
const FREE_TEXT = (label) => `${label}: TR33 0006 1005 1978 6457 8413 26, Ayse Yilmaz`;

let freeTextServer;
let freeTextBase;
let freeTextKey;

async function freeTextApi(method, path, body) {
  if (!freeTextServer) {
    // The fixture insurer's key hash is random; this block needs a key it
    // knows, so it sets one. No other test here goes through /api/v1; the
    // roles block further down goes through /debug, which takes no key.
    freeTextKey = crypto.randomBytes(16).toString('hex');
    await pool.query('UPDATE insurers SET api_key_hash = $1 WHERE id = $2', [
      crypto.createHash('sha256').update(freeTextKey).digest('hex'),
      insurerId,
    ]);
    const app = createApp({
      probeDatabase: async () => true,
      probeLedger: async () => true,
      processDegraded: () => null,
    });
    freeTextServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => freeTextServer.once('listening', resolve));
    freeTextBase = `http://127.0.0.1:${freeTextServer.address().port}/api/v1`;
  }
  const res = await fetch(`${freeTextBase}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': freeTextKey },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

after(() => freeTextServer?.close());

// The choice argument the LEDGER recorded for `choice` on `contractId`, read
// back from /v2/updates as the insurer sees it. Same request as
// oracleWindow.test.mjs makes, for the same reason: damlClient.js has no
// updates reader and does not export its HTTP client.
async function ledgerChoiceArgument(afterOffset, choice, contractId) {
  let token = config.daml.ledgerToken;
  if (!token) {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({
      sub: config.daml.unsafeJwtSub,
      aud: 'https://canton.network.global',
      exp: Math.floor(Date.now() / 1000) + 600,
    })}`;
    token = `${unsigned}.${crypto.createHmac('sha256', config.daml.unsafeJwtSecret).update(unsigned).digest('base64url')}`;
  }
  const res = await fetch(`${config.daml.jsonApiUrl}/v2/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      beginExclusive: afterOffset,
      endInclusive: await getLedgerEnd(),
      updateFormat: {
        includeTransactions: {
          eventFormat: { filtersByParty: { [insurerParty]: { cumulative: [] } }, verbose: false },
          transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
        },
      },
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const exercised = (await res.json())
    .map((u) => u.update?.Transaction?.value)
    .filter(Boolean)
    .flatMap((t) => t.events)
    .map((e) => e.ExercisedEvent)
    .filter((e) => e?.choice === choice && e.contractId === contractId);
  assert.equal(exercised.length, 1, `exactly one ${choice} on ${contractId} in the range`);
  return exercised[0].choiceArgument;
}

// Reports through the API, dispatches, and returns the outbox row.
async function reportThroughApi(payout, route, body) {
  const { status, body: res } = await freeTextApi('POST', `/payouts/${payout.id}/${route}`, body);
  assert.equal(status, 202, JSON.stringify(res));
  await runOnce();
  const { rows } = await pool.query('SELECT * FROM policy_events WHERE id = $1', [res.event.id]);
  assert.equal(rows[0].status, 'done', rows[0].error ?? '');
  return rows[0];
}

// The value on the ledger is not the text, is a salted digest, and is the one
// the SQL row's (salt, text) recomputes to.
function assertOpaque(onLedger, event, text) {
  assert.ok(!String(onLedger).includes('TR33'), `the IBAN-shaped text reached the ledger: ${onLedger}`);
  assert.ok(!String(onLedger).includes('Yilmaz'), `the name reached the ledger: ${onLedger}`);
  assert.match(onLedger, /^sha256:[0-9a-f]{64}$/);
  assert.ok(
    matchesSaltedDigest(event.payload.textSalt, text, onLedger),
    'the ledger value is recomputable from the salt and text kept in SQL'
  );
}

test('settle: the bank reference reaches the ledger only as a salted digest', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const payout = await payoutFor(policy.id);
  const text = FREE_TEXT('settle');

  const offset = await getLedgerEnd();
  const event = await reportThroughApi(payout, 'settle', {
    bankReference: text, settledAt: new Date().toISOString(), paidRole: 'PDR_Insured',
  });
  const arg = await ledgerChoiceArgument(offset, 'PayoutApproved_ConfirmSettlement', payout.daml_contract_id);
  assertOpaque(arg.bankReference, event, text);
  assert.equal((await reloadPayout(payout.id)).bank_reference, text, 'the raw text stays in SQL');
});

test('fail, then close unpaid: the failure reason and the note reach the ledger only as salted digests', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  let payout = await payoutFor(policy.id);
  const reason = FREE_TEXT('fail');
  const note = FREE_TEXT('close');

  let offset = await getLedgerEnd();
  const failed = await reportThroughApi(payout, 'fail', { failureReason: reason });
  const failArg = await ledgerChoiceArgument(offset, 'PayoutApproved_MarkFailed', payout.daml_contract_id);
  assertOpaque(failArg.failureReason, failed, reason);
  payout = await reloadPayout(payout.id);
  const review = (await ledgerContracts('Insurance.PayoutBridge', 'ManualReviewRequired')).find(
    (c) => c.contractId === payout.review_contract_id
  );
  assert.ok(review, 'the review item is on the ledger');
  assertOpaque(review.createArgument.reason, failed, reason);

  offset = await getLedgerEnd();
  const closed = await reportThroughApi(payout, 'close-unpaid', { unpaidReason: 'UR_Other', note, closedAt: new Date().toISOString() });
  const closeArg = await ledgerChoiceArgument(
    offset, 'ManualReviewRequired_ResolveUnpaid', payout.review_contract_id
  );
  assertOpaque(closeArg.note, closed, note);
  assert.equal((await reloadPayout(payout.id)).resolution_note, note, 'the raw note stays in SQL');
});

test('fail, then settle: the late bank reference reaches the ledger only as a salted digest', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  let payout = await payoutFor(policy.id);
  await reportThroughApi(payout, 'fail', { failureReason: 'payee not found' });
  payout = await reloadPayout(payout.id);
  const text = FREE_TEXT('resolve settled');

  const offset = await getLedgerEnd();
  const event = await reportThroughApi(payout, 'settle', {
    bankReference: text, settledAt: new Date().toISOString(), paidRole: 'PDR_Insured',
  });
  const arg = await ledgerChoiceArgument(offset, 'ManualReviewRequired_ResolveSettled', payout.review_contract_id);
  assertOpaque(arg.bankReference, event, text);
});

test('a retried settlement row sends the same digest: the salt is stored when the row is written', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const payout = await payoutFor(policy.id);
  const text = FREE_TEXT('retry');

  const { status, body } = await freeTextApi('POST', `/payouts/${payout.id}/settle`, {
    bankReference: text, settledAt: new Date().toISOString(), paidRole: 'PDR_Insured',
  });
  assert.equal(status, 202, JSON.stringify(body));
  const stored = (await pool.query('SELECT payload FROM policy_events WHERE id = $1', [body.event.id])).rows[0].payload;
  assert.match(stored.textSalt ?? '', /^[0-9a-f]{64}$/, 'the salt is in the outbox row before any dispatch');
  const expected = saltedDigest(stored.textSalt, text);

  const offset = await getLedgerEnd();
  await runOnce();
  const arg = await ledgerChoiceArgument(offset, 'PayoutApproved_ConfirmSettlement', payout.daml_contract_id);
  assert.equal(arg.bankReference, expected, 'dispatch computes from the stored salt, not a fresh one');
});

// ---------------------------------------------------------------------------
// Role intake: mortgagee and beneficiary become reachable
// ---------------------------------------------------------------------------
//
// Both roles have been on the token since the roles round and neither could
// ever be set -- dispatcher.js minted every policy with both null. These
// cover the intake path, the party-reuse rules (one party per person, whatever
// roles and policies it holds), and the m. 1456 flows that had never run
// against a policy that actually has a mortgagee.

// A person in the shared registry. mortgagee and beneficiary are rows in the
// same `policyholders` table as the policyholder -- that is what makes party
// reuse across policies free.
async function createPerson(label) {
  const { rows } = await pool.query(
    `INSERT INTO policyholders (insurer_id, external_ref)
     VALUES ($1, $2) RETURNING *`,
    [insurerId, `${label}-${crypto.randomUUID()}`]
  );
  return rows[0];
}

async function createPolicyWithRoles(policyholderId, opts = {}) {
  const {
    mortgageeId = null,
    beneficiaryId = null,
    beneficiaryDescriptorHash = null,
    claimAmounts = {},        // coverageCode -> amount
    coverageCodes = ['TEST-COVERAGE'],
  } = opts;
  const { rows } = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date, status,
        mortgagee_policyholder_id, beneficiary_policyholder_id, beneficiary_descriptor_hash,
        coverage_began_at, coverage_start_basis, created_at, document_hash)
     VALUES ($1,$2,500,'TRY','2026-09-01','2027-03-31','pending_mint',$3,$4,$5,
             '2026-09-01','CSB_AgreedWithoutPayment','2026-08-01',$6)
     RETURNING *`,
    [insurerId, policyholderId, mortgageeId, beneficiaryId, beneficiaryDescriptorHash, DOCUMENT_HASH]
  );
  const policy = rows[0];
  for (const code of coverageCodes) {
    await pool.query(
      `INSERT INTO policy_coverages
         (policy_id, coverage_code, product_code, peril_type, cell_ids,
          sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, mortgagee_claim_amount, metric, payout_basis)
       VALUES ($1,$2,'TEST-PRODUCT','TEST-PERIL','["cell-test"]',10000,10000,
         '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null},{"tierOrder":2,"label":"test total loss","minValue":null,"maxValue":"-4.0","payoutPct":"100.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null}]',
         $3, $4, 'TEMPERATURE_C', 'PB_RemainingLimit')`,
      [
        policy.id,
        code,
        JSON.stringify(claimAmounts[code] ? ['PDR_Insured', 'PDR_Mortgagee'] : ['PDR_Insured']),
        claimAmounts[code] ?? null,
      ]
    );
  }
  return policy;
}

test('a policy with a mortgagee and per-coverage claim amounts mints with both on the token', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createPolicyWithRoles(ph.id, {
    mortgageeId: bank.id,
    // The bank's charge sits on one coverage and not the other. Absent is
    // the normal case, not a missing value.
    claimAmounts: { 'TEST-COVERAGE': 4000 },
    coverageCodes: ['TEST-COVERAGE', 'TEST-COVERAGE-2'],
  });

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'active');
  const bankRow = (await pool.query('SELECT * FROM policyholders WHERE id = $1', [bank.id])).rows[0];
  assert.ok(bankRow.canton_party_id, 'the mortgagee gets a real allocated party');

  const tokens = await ledgerContracts('Insurance.PolicyToken', 'PolicyToken');
  const mine = tokens.find((c) => c.contractId === rows[0].daml_contract_id);
  assert.ok(mine, 'the token is on the ledger');
  assert.equal(mine.createArgument.mortgagee, bankRow.canton_party_id, 'mortgagee is populated, not null');

  const charged = mine.createArgument.coverages.find((c) => c.coverageCode === 'TEST-COVERAGE');
  const uncharged = mine.createArgument.coverages.find((c) => c.coverageCode === 'TEST-COVERAGE-2');
  assert.equal(Number(charged.mortgageeClaimAmount), 4000);
  // A None Optional inside a nested record comes back with the key ABSENT,
  // not as null -- unlike a None at template level, which is present and
  // null. Found by this round's wire check, so assert the real shape.
  assert.equal(
    uncharged.mortgageeClaimAmount ?? null,
    null,
    'a coverage the charge does not reach carries no claim amount'
  );
  // A destination list, never a split. Nothing divides a payout.
  assert.deepEqual(charged.payoutDestination, ['PDR_Insured', 'PDR_Mortgagee']);
  assert.deepEqual(uncharged.payoutDestination, ['PDR_Insured']);

  // The mortgagee is an observer of the whole token -- including the coverage
  // it has no claim on. That is what a Daml observer is.
  assert.ok(
    mine.observers.includes(bankRow.canton_party_id),
    'a named mortgagee is an observer of the contract'
  );
});

// The invariant spans two tables, so a CHECK constraint cannot express it --
// SQL will happily hold a claim amount on a mortgagee-less policy. It is
// enforced at intake (a 400 naming the coverage) and, unbypassably, by the
// token's own ensure clause. This drives the row straight past the API to
// prove the ledger refuses it, which is the guarantee that actually matters.
test('a claim amount with no policy mortgagee is refused by the ledger, not silently minted', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyWithRoles(ph.id, { claimAmounts: { 'TEST-COVERAGE': 4000 } });

  await activate(policy.id);
  await runOnce();

  const event = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'activation'`,
    [policy.id]
  );
  assert.equal(event.rows[0].status, 'failed');
  const { rows } = await pool.query('SELECT status, daml_contract_id FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'pending_mint', 'nothing mints on an invariant the contract rejects');
  assert.equal(rows[0].daml_contract_id, null);
});

test('a descriptive beneficiary mints with beneficiary None plus the hash', async () => {
  const ph = await createPolicyholder();
  const hash = 'sha256-descriptive-beneficiary-fixture';
  const policy = await createPolicyWithRoles(ph.id, { beneficiaryDescriptorHash: hash });

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  const tokens = await ledgerContracts('Insurance.PolicyToken', 'PolicyToken');
  const mine = tokens.find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(mine.createArgument.beneficiary, null, 'no Party -- no specific person is identified');
  assert.equal(mine.createArgument.beneficiaryDescriptorHash, hash);

  // m. 1494(2): this must be distinguishable on the ledger from a policy that
  // names no beneficiary at all, which is the whole reason the field is on
  // the token rather than only in SQL.
  const plainPolicy = await createPolicyWithRoles(ph.id, {});
  await activate(plainPolicy.id);
  await runOnce();
  const plainRow = (await pool.query('SELECT * FROM policies WHERE id = $1', [plainPolicy.id])).rows[0];
  const plainToken = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === plainRow.daml_contract_id);
  assert.equal(plainToken.createArgument.beneficiary, null);
  assert.equal(plainToken.createArgument.beneficiaryDescriptorHash, null);
});

test('naming and describing a beneficiary at once is refused', async () => {
  const ph = await createPolicyholder();
  const named = await createPerson('beneficiary');
  await assert.rejects(
    () => createPolicyWithRoles(ph.id, {
      beneficiaryId: named.id,
      beneficiaryDescriptorHash: 'sha256-something-else',
    }),
    /named_xor_described|violates check constraint/i
  );
});

// The rights budget. Only the insurer and the oracle operator are granted a
// CanActAs against the 1000 cap; a role party costs none (see the rights test
// below). Every allocation is still a new party on the participant, so reuse
// is not a nicety.
test('a second policy naming the same bank reuses its Party rather than allocating another', async () => {
  const bank = await createPerson('shared-bank');
  const ph1 = await createPolicyholder();
  const ph2 = await createPolicyholder();

  const p1 = await createPolicyWithRoles(ph1.id, { mortgageeId: bank.id });
  await activate(p1.id);
  await runOnce();
  const afterFirst = (await pool.query('SELECT canton_party_id FROM policyholders WHERE id = $1', [bank.id]))
    .rows[0].canton_party_id;
  assert.ok(afterFirst);

  const p2 = await createPolicyWithRoles(ph2.id, { mortgageeId: bank.id });
  await activate(p2.id);
  await runOnce();
  const afterSecond = (await pool.query('SELECT canton_party_id FROM policyholders WHERE id = $1', [bank.id]))
    .rows[0].canton_party_id;

  assert.equal(afterSecond, afterFirst, 'a bank is an institution, not a policyholder -- one party, reused');

  const r1 = (await pool.query('SELECT daml_contract_id FROM policies WHERE id = $1', [p1.id])).rows[0];
  const r2 = (await pool.query('SELECT daml_contract_id FROM policies WHERE id = $1', [p2.id])).rows[0];
  const tokens = await ledgerContracts('Insurance.PolicyToken', 'PolicyToken');
  const t1 = tokens.find((c) => c.contractId === r1.daml_contract_id);
  const t2 = tokens.find((c) => c.contractId === r2.daml_contract_id);
  assert.equal(t1.createArgument.mortgagee, afterFirst);
  assert.equal(t2.createArgument.mortgagee, afterFirst, 'both tokens name the same party');
});

test('a person holding two roles on one policy gets one Party, not two', async () => {
  const person = await createPolicyholder();
  // The same registry row is both the policyholder and the beneficiary.
  const policy = await createPolicyWithRoles(person.id, { beneficiaryId: person.id });

  await activate(policy.id);
  await runOnce();

  const row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  const personRow = (await pool.query('SELECT * FROM policyholders WHERE id = $1', [person.id])).rows[0];
  const tokens = await ledgerContracts('Insurance.PolicyToken', 'PolicyToken');
  const mine = tokens.find((c) => c.contractId === row.daml_contract_id);

  assert.equal(mine.createArgument.policyholder, personRow.canton_party_id);
  assert.equal(mine.createArgument.beneficiary, personRow.canton_party_id);
  assert.equal(
    mine.createArgument.policyholder,
    mine.createArgument.beneficiary,
    'one person, one party -- two roles do not cost two allocations'
  );
});

// Only a party the platform submits commands as holds a CanActAs. Every role
// party is an observer and is allocated without one, so activating a policy
// that names all three registry roles must grant none of them anything.
test('an activation grants no CanActAs to the policyholder, insured, mortgagee or beneficiary party; the insurer and the oracle operator hold one', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('rights-bank');
  const heir = await createPerson('rights-beneficiary');
  const policy = await createPolicyWithRoles(ph.id, { mortgageeId: bank.id, beneficiaryId: heir.id });
  // The fourth role, a sigortalı distinct from the sigorta ettiren, needs a
  // policy taken for another's account.
  const ettiren = await createPolicyholder();
  const insured = await createPerson('rights-insured');
  const forAnother = await createForAnothersAccount(ettiren.id, insured.id);

  await activate(policy.id);
  await runOnce();
  await activate(forAnother.id);
  await runOnce();

  const { rows } = await pool.query('SELECT status FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'active', 'the mint went through with none of its role parties granted');
  assert.equal(
    (await pool.query('SELECT status FROM policies WHERE id = $1', [forAnother.id])).rows[0].status,
    'active',
    'the policy for another\'s account minted with its insured ungranted'
  );

  const roleParties = (
    await pool.query('SELECT canton_party_id FROM policyholders WHERE id = ANY($1)', [[ph.id, bank.id, heir.id, insured.id]])
  ).rows.map((r) => r.canton_party_id);
  assert.equal(roleParties.filter(Boolean).length, 4, 'all four roles were allocated a party');

  const actAs = (await listUserRights(config.daml.unsafeJwtSub))
    .filter((r) => r.kind?.CanActAs)
    .map((r) => r.kind.CanActAs.value.party);
  for (const party of roleParties) {
    assert.ok(!actAs.includes(party), `${party.split('::')[0]} is a role party and must hold no CanActAs`);
  }
  assert.ok(actAs.includes(insurerParty), 'the insurer submits the mint, so it holds a CanActAs');
  const { rows: [insurerRow] } = await pool.query('SELECT oracle_operator_party FROM insurers WHERE id = $1', [insurerId]);
  assert.ok(
    actAs.includes(insurerRow.oracle_operator_party),
    'the oracle operator submits every trigger, so it holds a CanActAs'
  );
});

// Stage 1 of the ledger-outage handling. Through an outage the
// dispatcher claims nothing, so a pending row stays pending instead of being
// burned to `failed`, which the table's own trigger makes terminal.
test('a failed ledger probe claims nothing, and the row runs once the ledger answers', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);

  let probes = 0;
  await runOnce({
    probeLedger: async () => {
      probes += 1;
      throw new Error('ledger unreachable (test probe)');
    },
  });

  assert.equal(probes, 1, 'the probe ran, before anything was claimed');
  const during = await eventRow(policy.id, 'activation');
  assert.equal(during.status, 'pending', 'the row was never claimed');
  assert.equal(during.processed_at, null);
  const untouched = (
    await pool.query('SELECT status, daml_contract_id FROM policies WHERE id = $1', [policy.id])
  ).rows[0];
  assert.equal(untouched.daml_contract_id, null, 'nothing was sent to the ledger');
  assert.equal(untouched.status, 'pending_mint');

  await runOnce();

  const after = await eventRow(policy.id, 'activation');
  assert.equal(after.status, 'done', after.error ?? '');
  const minted = (await pool.query('SELECT daml_contract_id FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.ok(minted.daml_contract_id, 'the same row minted once the ledger answered');
});

// These three choices have existed since the termination round and have never
// run against a policy that actually has a mortgagee -- every previous run
// hit "there is no mortgagee on this policy to notify".
test('the m. 1456 flows run end to end on a policy that has a mortgagee', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank-1456');
  await pool.query('UPDATE insurers SET mortgagee_continuation_days = 15 WHERE id = $1', [insurerId]);
  const policy = await createPolicyWithRoles(ph.id, {
    mortgageeId: bank.id,
    claimAmounts: { 'TEST-COVERAGE': 4000 },
  });

  const serviceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await activateAndServeNotice(policy.id, serviceDate);

  // m. 1456(4) -- the insurer's own reported date, not the moment we were told.
  const notifiedAt = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
  await insertLifecycleEvent(policy.id, 'mortgagee_notice', { notifiedAt });
  await runOnce();
  let ev = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'mortgagee_notice'`,
    [policy.id]
  );
  assert.equal(ev.rows[0].status, 'done', ev.rows[0].error ?? '');
  let row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(new Date(row.mortgagee_notified_at).getTime(), new Date(notifiedAt).getTime());

  // m. 1456(5) -- the window opens AT termination and runs for the CONFIGURED
  // days, never a hardcoded fifteen.
  await insertLifecycleEvent(policy.id, 'termination');
  await runOnce();
  row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(row.default_state, 'terminated');
  assert.equal(
    new Date(row.mortgagee_continuation_ends_at).getTime(),
    new Date(row.terminated_at).getTime() + 15 * 24 * 60 * 60 * 1000
  );

  const tokens = await ledgerContracts('Insurance.PolicyToken', 'PolicyToken');
  const mine = tokens.find((c) => c.contractId === row.daml_contract_id);
  assert.ok(mine.createArgument.mortgageeNotifiedAt, 'the notification survives termination on-ledger');
  assert.ok(mine.createArgument.mortgageeContinuationEndsAt);

  await insertLifecycleEvent(policy.id, 'mortgagee_election', { election: 'ME_Continue' });
  await runOnce();
  ev = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'mortgagee_election'`,
    [policy.id]
  );
  assert.equal(ev.rows[0].status, 'done', ev.rows[0].error ?? '');
  row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(row.mortgagee_election, 'ME_Continue');
  assert.equal(
    row.default_state,
    'terminated',
    'recording ME_Continue does NOT revive the contract -- the takeover is not implemented'
  );
});

// Migration 037: the window termination opens is the one frozen at activation.
// A later change to the insurer's value, or its removal, does not move it.
test('termination opens the continuation window frozen at activation, whatever the insurer has since', async () => {
  await restoringInsurerWindows(async () => {
    for (const later of [30, null]) {
      const ph = await createPolicyholder();
      const bank = await createPerson(`bank-frozen-${later}`);
      await pool.query('UPDATE insurers SET mortgagee_continuation_days = 15 WHERE id = $1', [insurerId]);
      const policy = await createPolicyWithRoles(ph.id, {
        mortgageeId: bank.id,
        claimAmounts: { 'TEST-COVERAGE': 4000 },
      });
      await activateAndServeNotice(policy.id, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
      await pool.query('UPDATE insurers SET mortgagee_continuation_days = $1 WHERE id = $2', [later, insurerId]);

      await insertLifecycleEvent(policy.id, 'termination');
      await runOnce();
      const ev = await eventRow(policy.id, 'termination');
      assert.equal(ev.status, 'done', `insurer value moved to ${later}: ${ev.error ?? ''}`);
      const row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
      assert.equal(row.default_state, 'terminated');
      assert.equal(
        new Date(row.mortgagee_continuation_ends_at).getTime(),
        new Date(row.terminated_at).getTime() + 15 * 24 * 60 * 60 * 1000,
        `the frozen 15 days, not the insurer's ${later}`
      );
    }
  });
});

// An unset value is frozen as unset, and the refusal stays at use time.
// The failed row's own error reaches GET /policies/:id as its reason code.
test('a mortgaged policy activated with no continuation window fails termination, even after the insurer sets one', async () => {
  await restoringInsurerWindows(async () => {
    const ph = await createPolicyholder();
    const bank = await createPerson('bank-unfrozen');
    await pool.query('UPDATE insurers SET mortgagee_continuation_days = NULL WHERE id = $1', [insurerId]);
    const policy = await createPolicyWithRoles(ph.id, {
      mortgageeId: bank.id,
      claimAmounts: { 'TEST-COVERAGE': 4000 },
    });
    let row = await activateAndServeNotice(policy.id, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    assert.equal(row.default_state, 'grace_period');
    assert.equal(row.mortgagee_continuation_days, null, 'NULL is frozen as NULL');
    await pool.query('UPDATE insurers SET mortgagee_continuation_days = 15 WHERE id = $1', [insurerId]);

    await insertLifecycleEvent(policy.id, 'termination');
    await runOnce();
    const ev = await eventRow(policy.id, 'termination');
    assert.equal(ev.status, 'failed');
    row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
    assert.equal(row.default_state, 'grace_period', 'nothing moved');
    const { failure } = buildPolicyRecord(row, [], [ev], false).events[0];
    assert.equal(failure.code, 'mortgagee_continuation_not_configured');
    assert.equal(
      failure.message,
      'The policy names a mortgagee but no mortgagee continuation window was configured for the insurer when the policy was activated.'
    );
  });
});

// An endorsement can name, clear or leave the mortgagee. The token's mortgagee
// is mirrored in policies.mortgagee_policyholder_id, which handleTermination
// reads to open the continuation window and a renewal copies.

// The party ensurePolicyholderParty would allocate for this registry row. The
// row is named by an endorsement here, not by a mint, so nothing else does.
async function allocateRegisteredParty(personId) {
  const partyId = await allocateParty(`policyholder:${personId}`, `ph-${personId}`);
  await pool.query(
    `UPDATE policyholders SET canton_party_id = $1, canton_party_status = 'ALLOCATED' WHERE id = $2`,
    [partyId, personId]
  );
  return partyId;
}

async function policyAndToken(policyId) {
  const row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policyId])).rows[0];
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === row.daml_contract_id);
  return { row, token };
}

test('an endorsement naming a mortgagee writes mortgagee_policyholder_id, and termination then opens the continuation window', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank-endorsed');
  const bankParty = await allocateRegisteredParty(bank.id);
  await pool.query('UPDATE insurers SET mortgagee_continuation_days = 15 WHERE id = $1', [insurerId]);
  const policy = await createPolicy(ph.id);
  const serviceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await activateAndServeNotice(policy.id, serviceDate);

  const event = await endorse(policy.id, { reason: 'ER_Correction', newMortgagee: { value: bankParty } });
  assert.equal(event.status, 'done', event.error ?? '');
  let { row, token } = await policyAndToken(policy.id);
  assert.equal(token.createArgument.mortgagee, bankParty, 'the re-minted token names the mortgagee');
  assert.equal(row.mortgagee_policyholder_id, bank.id, 'and the SQL mirror names the same policyholder');

  await insertLifecycleEvent(policy.id, 'termination');
  await runOnce();
  ({ row, token } = await policyAndToken(policy.id));
  assert.equal(row.default_state, 'terminated');
  assert.equal(
    new Date(row.mortgagee_continuation_ends_at).getTime(),
    new Date(row.terminated_at).getTime() + 15 * 24 * 60 * 60 * 1000,
    'the window opens for the mortgagee the endorsement named'
  );
  assert.ok(token.createArgument.mortgageeContinuationEndsAt, 'on the ledger too');
});

test('an endorsement clearing the mortgagee writes NULL to mortgagee_policyholder_id', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank-cleared');
  const policy = await createPolicyWithRoles(ph.id, { mortgageeId: bank.id });
  await activate(policy.id);
  await runOnce();

  const event = await endorse(policy.id, { reason: 'ER_Correction', newMortgagee: { value: null } });
  assert.equal(event.status, 'done', event.error ?? '');
  const { row, token } = await policyAndToken(policy.id);
  assert.equal(token.createArgument.mortgagee, null, 'the re-minted token names no mortgagee');
  assert.equal(row.mortgagee_policyholder_id, null, 'and neither does the SQL mirror');
});

test('an endorsement that does not name the mortgagee leaves mortgagee_policyholder_id alone', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank-untouched');
  const policy = await createPolicyWithRoles(ph.id, { mortgageeId: bank.id });
  await activate(policy.id);
  await runOnce();
  const bankParty = (await pool.query('SELECT canton_party_id FROM policyholders WHERE id = $1', [bank.id]))
    .rows[0].canton_party_id;

  const event = await endorse(policy.id, {
    reason: 'ER_Correction',
    sumInsuredChanges: [{ coverageCode: 'TEST-COVERAGE', sumInsured: 12000 }],
  });
  assert.equal(event.status, 'done', event.error ?? '');
  const { row, token } = await policyAndToken(policy.id);
  assert.equal(row.current_version, 2, 'not vacuous: the endorsement re-minted');
  assert.equal(token.createArgument.mortgagee, bankParty);
  assert.equal(row.mortgagee_policyholder_id, bank.id);
});

test('an endorsement row naming a mortgagee that is not one of this insurer\'s policyholders fails before the ledger', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const { row: before } = await policyAndToken(policy.id);

  // Both are real parties, so the ledger alone would accept either.
  const unregistered = await allocateParty(
    'Test unregistered mortgagee (dispatcher.test.mjs)',
    `test-unregistered-${crypto.randomUUID()}`
  );
  const { rows: [otherInsurer] } = await pool.query(
    `INSERT INTO insurers (legal_name, api_key_hash, canton_party_status)
     VALUES ('Test Insurer Ltd (fixture, other tenant, fake)', $1, 'PENDING') RETURNING id`,
    [crypto.randomBytes(16).toString('hex')]
  );
  try {
    const { rows: [othersPerson] } = await pool.query(
      `INSERT INTO policyholders (insurer_id, external_ref) VALUES ($1, $2) RETURNING id`,
      [otherInsurer.id, `other-tenant-bank-${crypto.randomUUID()}`]
    );
    const othersParty = await allocateRegisteredParty(othersPerson.id);
    for (const [label, party] of [['unregistered', unregistered], ['another insurer\'s', othersParty]]) {
      const event = await endorse(policy.id, { reason: 'ER_Correction', newMortgagee: { value: party } });
      assert.equal(event.status, 'failed', `${label}: the row is refused`);
      assert.match(event.error, /not the party of one of this insurer's policyholders/);
      const { row, token } = await policyAndToken(policy.id);
      assert.equal(row.daml_contract_id, before.daml_contract_id, `${label}: nothing reached the ledger`);
      assert.equal(row.current_version, before.current_version);
      assert.equal(token.createArgument.mortgagee, null);
      assert.equal(row.mortgagee_policyholder_id, null);
    }
  } finally {
    await pool.query('DELETE FROM policyholders WHERE insurer_id = $1', [otherInsurer.id]);
    await pool.query('DELETE FROM insurers WHERE id = $1', [otherInsurer.id]);
  }
});

// ---------------------------------------------------------------------------
// m. 1434(2) -- first-premium default: cayma, not fesih
// ---------------------------------------------------------------------------
//
// The second premium-default mechanism, and a different one. These cover both
// routes to withdrawal, the exit when payment arrives, the trigger refusal,
// and the two guards that have no analogue in the notice flow: the ceiling on
// the window, and the refusal to act without a reported due date.

// The window is per-insurer config with a CEILING of three months -- the
// inverse of the grace period's floor.
async function setFirstPremiumWindow(days) {
  await pool.query('UPDATE insurers SET first_premium_withdrawal_days = $1 WHERE id = $2', [days, insurerId]);
}

async function eventRow(policyId, type) {
  const { rows } = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = $2 ORDER BY created_at DESC LIMIT 1`,
    [policyId, type]
  );
  return rows[0];
}

// Activate, then report the first premium due and unpaid.
async function inFirstPremiumDefault(policyId, dueDate) {
  await activate(policyId);
  await runOnce();
  await insertLifecycleEvent(policyId, 'premium_due_date', { dueDate });
  await runOnce();
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

test('reporting a first premium due and unpaid moves the policy into its own state', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await setFirstPremiumWindow(60);
  const dueDate = daysAgo(30);

  await inFirstPremiumDefault(policy.id, dueDate);

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'first_premium_unpaid');
  assert.equal(rows[0].status, 'active', 'the claim axis is untouched');
  assert.equal(new Date(rows[0].premium_due_date).toISOString(), dueDate);
  // Not grace_period, not terminated -- its own vocabulary.
  assert.notEqual(rows[0].default_state, 'grace_period');
  assert.equal(rows[0].notice_service_date, null, 'no ihtar is involved in m. 1434(2)');

  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(token.createArgument.defaultState, 'DS_FirstPremiumUnpaid');
  assert.equal(
    new Date(token.createArgument.coverageValidThrough).getTime(),
    new Date(token.createArgument.expiry).getTime(),
    'cover is not moved -- whether it ever began is m. 1421 and this mechanism does not answer it'
  );
});

// Route 1: "sigortacı ... sözleşmeden üç ay içinde cayabilir" -- an act.
test('the insurer withdraws within the window, and the path is recorded', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await setFirstPremiumWindow(60);
  await inFirstPremiumDefault(policy.id, daysAgo(30));

  await insertLifecycleEvent(policy.id, 'first_premium_withdrawal', {
    withdrawnAt: new Date().toISOString(),
  });
  await runOnce();

  const ev = await eventRow(policy.id, 'first_premium_withdrawal');
  assert.equal(ev.status, 'done', ev.error ?? '');
  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'withdrawn_for_first_premium');
  assert.equal(rows[0].withdrawal_path, 'WP_InsurerWithdrew');
  assert.ok(rows[0].withdrawn_at);
  // The token is RE-MINTED, not archived: archiving would encode a holding on
  // whether cayma is retroactive, which the statute text does not support.
  assert.ok(rows[0].daml_contract_id, 'the token survives the withdrawal');
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(token.createArgument.defaultState, 'DS_WithdrawnForFirstPremium');
  assert.equal(token.createArgument.withdrawalPath, 'WP_InsurerWithdrew');
});

// Route 2: withdrawal by operation of law, from inaction. The sweeper
// observes; nobody exercises.
test('the sweeper records the deemed withdrawal once the window elapses unpursued', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await setFirstPremiumWindow(60);
  const dueDate = daysAgo(90);   // 90 days ago, 60-day window -- elapsed
  await inFirstPremiumDefault(policy.id, dueDate);

  await sweepFirstPremium({ insurerIds: [insurerId] });
  await runOnce();

  const ev = await eventRow(policy.id, 'first_premium_deemed_withdrawal');
  assert.equal(ev.status, 'done', ev.error ?? '');
  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'withdrawn_for_first_premium');
  assert.equal(rows[0].withdrawal_path, 'WP_DeemedNoEnforcement');
  // The instant is DERIVED from the reported due date, not read off a clock,
  // so a sweeper running late records what it would have recorded on time.
  const expected = new Date(new Date(dueDate).getTime() + 60 * 24 * 60 * 60 * 1000);
  assert.equal(new Date(rows[0].withdrawn_at).getTime(), expected.getTime());
});

// The deemed route exists BECAUSE the claim was not pursued.
test('reported enforcement forecloses the deemed route but not the insurer act', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await setFirstPremiumWindow(60);
  await inFirstPremiumDefault(policy.id, daysAgo(90));

  await insertLifecycleEvent(policy.id, 'enforcement_commenced', { commencedAt: daysAgo(70) });
  await runOnce();
  let { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.ok(rows[0].enforcement_commenced_at, 'commencement is recorded');
  assert.equal(rows[0].default_state, 'first_premium_unpaid', 'and the policy stays in default');

  // The sweeper's state test excludes it entirely.
  await sweepFirstPremium({ insurerIds: [insurerId] });
  const queued = await pool.query(
    `SELECT count(*)::int n FROM policy_events
     WHERE policy_no = $1 AND event_type = 'first_premium_deemed_withdrawal'`,
    [policy.id]
  );
  assert.equal(queued.rows[0].n, 0, 'a pursued claim is not swept');

  // The insurer's own act is still available.
  await insertLifecycleEvent(policy.id, 'first_premium_withdrawal', {
    withdrawnAt: new Date(new Date(daysAgo(90)).getTime() + 30 * 86400000).toISOString(),
  });
  await runOnce();
  ({ rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]));
  assert.equal(rows[0].default_state, 'withdrawn_for_first_premium');
  assert.equal(rows[0].withdrawal_path, 'WP_InsurerWithdrew');
});

test('payment arriving before either route completes returns the policy to none', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await setFirstPremiumWindow(60);
  const dueDate = daysAgo(10);
  await inFirstPremiumDefault(policy.id, dueDate);

  // m. 1421: paidAt is required now and is the instant cover begins. Dated
  // on or after the fixture's agreed start, since an agreed start LATER
  // than payment is the direction m. 1452(3) forbids.
  await insertLifecycleEvent(policy.id, 'first_premium_paid', {
    paidAt: new Date('2026-09-15T12:00:00.000Z').toISOString(),
  });
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'none');
  assert.equal(rows[0].withdrawn_at, null);
  assert.equal(rows[0].withdrawal_path, null);
  // The due date stays: a fact about what happened, not a flag to clear.
  assert.equal(new Date(rows[0].premium_due_date).toISOString(), dueDate);

  // And the sweeper no longer sees it.
  await sweepFirstPremium({ insurerIds: [insurerId] });
  const queued = await pool.query(
    `SELECT count(*)::int n FROM policy_events
     WHERE policy_no = $1 AND event_type = 'first_premium_deemed_withdrawal'`,
    [policy.id]
  );
  assert.equal(queued.rows[0].n, 0);
});

test('a trigger against a policy in first-premium default is refused with its own reason', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await setFirstPremiumWindow(60);
  await inFirstPremiumDefault(policy.id, daysAgo(30));

  const readingId = await insertTriggerReading(policy.id, -1);
  await runOnce();

  const ev = await pool.query('SELECT * FROM policy_events WHERE id = $1', [readingId]);
  assert.equal(ev.rows[0].status, 'failed', 'never silently skipped');
  assert.equal(ev.rows[0].payload.observedValue, -1, 'the observed value stays on the row');
  assert.match(
    ev.rows[0].error,
    /first premium is reported unpaid/i,
    'and the reason names m. 1434(2), not the termination message'
  );
  const payouts = await pool.query('SELECT * FROM payout_events WHERE policy_id = $1', [policy.id]);
  assert.equal(payouts.rows.length, 0);
});

// The ceiling. This is the INVERSE of the grace period's floor and the error
// says so, precisely so nobody later "fixes" one to match the other.
test('a withdrawal window configured past three months is refused as exceeding the ceiling', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await setFirstPremiumWindow(200);        // well past three months
  await inFirstPremiumDefault(policy.id, daysAgo(10));

  await insertLifecycleEvent(policy.id, 'first_premium_withdrawal', {
    withdrawnAt: new Date().toISOString(),
  });
  await runOnce();

  const ev = await eventRow(policy.id, 'first_premium_withdrawal');
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /1434\(2\)/, 'the article is named');
  assert.match(ev.error, /CEILING, not a floor/, 'and the direction is spelled out');
  assert.match(ev.error, /1452\(3\)/, 'with why it cannot be varied upward');

  const { rows } = await pool.query('SELECT default_state FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'first_premium_unpaid', 'nothing moved');
});

test('a withdrawal on a policy with no reported due date is refused, not defaulted', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await setFirstPremiumWindow(60);
  await activate(policy.id);
  await runOnce();

  // No premium_due_date reported, so the policy is not in the mechanism at all.
  await insertLifecycleEvent(policy.id, 'first_premium_withdrawal', {
    withdrawnAt: new Date().toISOString(),
  });
  await runOnce();

  const ev = await eventRow(policy.id, 'first_premium_withdrawal');
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /not in first-premium default/i);

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'none');
  assert.equal(rows[0].withdrawn_at, null);

  // And the sweeper will not touch it either: no due date, no period to run.
  await sweepFirstPremium({ insurerIds: [insurerId] });
  const queued = await pool.query(
    `SELECT count(*)::int n FROM policy_events
     WHERE policy_no = $1 AND event_type = 'first_premium_deemed_withdrawal'`,
    [policy.id]
  );
  assert.equal(queued.rows[0].n, 0);
});

// Migration 037: the sweeper reads the window frozen onto the policy, so
// unsetting the insurer's value afterwards does not hide an elapsed window.
test('the sweeper selects an elapsed policy on its frozen window after the insurer value is unset', async () => {
  await restoringInsurerWindows(async () => {
    const ph = await createPolicyholder();
    const policy = await createPolicy(ph.id);
    await setFirstPremiumWindow(60);
    const dueDate = daysAgo(90);
    await inFirstPremiumDefault(policy.id, dueDate);
    await setFirstPremiumWindow(null);

    await sweepFirstPremium({ insurerIds: [insurerId] });
    const queued = await pool.query(
      `SELECT count(*)::int n FROM policy_events
       WHERE policy_no = $1 AND event_type = 'first_premium_deemed_withdrawal'`,
      [policy.id]
    );
    assert.equal(queued.rows[0].n, 1, 'the frozen window has elapsed, so the policy is swept');
    await runOnce();
    const ev = await eventRow(policy.id, 'first_premium_deemed_withdrawal');
    assert.equal(ev.status, 'done', ev.error ?? '');
    const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
    assert.equal(rows[0].default_state, 'withdrawn_for_first_premium');
    assert.equal(
      new Date(rows[0].withdrawn_at).getTime(),
      new Date(dueDate).getTime() + 60 * 24 * 60 * 60 * 1000,
      'the deadline is the frozen window'
    );
  });
});

// An unset window is frozen as unset, and the refusal stays at use time.
test('a policy activated with no first-premium window fails its withdrawal, even after the insurer sets one', async () => {
  await restoringInsurerWindows(async () => {
    const ph = await createPolicyholder();
    const policy = await createPolicy(ph.id);
    await setFirstPremiumWindow(null);
    await inFirstPremiumDefault(policy.id, daysAgo(30));
    let row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
    assert.equal(row.default_state, 'first_premium_unpaid');
    assert.equal(row.first_premium_withdrawal_days, null, 'NULL is frozen as NULL');
    await setFirstPremiumWindow(60);

    await insertLifecycleEvent(policy.id, 'first_premium_withdrawal', {
      withdrawnAt: new Date().toISOString(),
    });
    await runOnce();
    const ev = await eventRow(policy.id, 'first_premium_withdrawal');
    assert.equal(ev.status, 'failed');
    row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
    assert.equal(row.default_state, 'first_premium_unpaid', 'nothing moved');
    const { failure } = buildPolicyRecord(row, [], [ev], false).events[0];
    assert.equal(failure.code, 'first_premium_withdrawal_window_not_configured');
    assert.equal(
      failure.message,
      'No first-premium withdrawal window was configured for the insurer when the policy was activated.'
    );
  });
});

// The two mechanisms must not be conflatable, at the SQL layer as well as the
// ledger's.
test('the m. 1434(2) and m. 1434(3) mechanisms cannot both apply to one policy', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await setFirstPremiumWindow(60);
  await inFirstPremiumDefault(policy.id, daysAgo(30));

  // Serving an ihtar on a policy already in the first-premium mechanism is
  // refused by the ledger.
  await insertLifecycleEvent(policy.id, 'notice', { serviceDate: daysAgo(5) });
  await runOnce();
  const ev = await eventRow(policy.id, 'notice');
  assert.equal(ev.status, 'failed');

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].default_state, 'first_premium_unpaid');
  assert.equal(rows[0].notice_service_date, null);
});

// ---------------------------------------------------------------------------
// m. 1421: cover start. Minting no longer means the policy is live.
// ---------------------------------------------------------------------------

// A policy the way the platform now creates one: the contract exists, cover
// has not begun. createPolicy deliberately does NOT produce this -- it makes
// a live policy, because every test that triggers wants one.
async function createPolicyWithoutCover(policyholderId, opts = {}) {
  const { rows } = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date, status,
        insured_policyholder_id, document_hash)
     VALUES ($1,$2,500,'TRY','2026-09-01','2027-03-31','pending_mint',$3,$4)
     RETURNING *`,
    [insurerId, policyholderId, opts.insuredId ?? null, opts.documentHash ?? DOCUMENT_HASH]
  );
  const policy = rows[0];
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL','["cell-test"]',10000,10000,
       '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null},{"tierOrder":2,"label":"test total loss","minValue":null,"maxValue":"-4.0","payoutPct":"100.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null}]',
       '["PDR_Insured"]','TEMPERATURE_C','PB_RemainingLimit')`,
    [policy.id]
  );
  return policy;
}

test('a minted policy has no cover until it is reported', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const policy = await createPolicyWithoutCover(ph.id);

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'active', 'the contract exists...');
  assert.equal(rows[0].coverage_began_at, null, '...but cover has not begun');
  assert.equal(rows[0].coverage_start_basis, null);

  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.ok(token, 'the token exists on the ledger');
  assert.equal(token.createArgument.coverageBeganAt ?? null, null);
  assert.equal(token.createArgument.coverageStartBasis ?? null, null);
});

test('a trigger before cover begins is refused with its own reason', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyWithoutCover(ph.id);
  await activate(policy.id);
  await runOnce();

  const readingId = await insertTriggerReading(policy.id, -1);
  await runOnce();

  const ev = await pool.query('SELECT * FROM policy_events WHERE id = $1', [readingId]);
  assert.equal(ev.rows[0].status, 'failed', 'never silently skipped');
  assert.equal(ev.rows[0].payload.observedValue, -1, 'the observed value stays on the row');
  assert.match(
    ev.rows[0].error,
    /cover has not begun/i,
    'and the reason names m. 1421, distinctly from the terminated and first-premium refusals'
  );
  const payouts = await pool.query('SELECT * FROM payout_events WHERE policy_id = $1', [policy.id]);
  assert.equal(payouts.rows.length, 0, 'nothing is paid on a policy whose cover never started');
});

test('reporting the first premium starts cover at the reported instant, and the term does not shift', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyWithoutCover(ph.id);
  await activate(policy.id);
  await runOnce();
  const before = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];

  const paidAt = '2026-09-20T09:00:00.000Z';
  await insertLifecycleEvent(policy.id, 'first_premium_paid', { paidAt });
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(new Date(rows[0].coverage_began_at).toISOString(), paidAt);
  assert.equal(rows[0].coverage_start_basis, 'CSB_PremiumPaid');
  assert.equal(new Date(rows[0].first_premium_paid_at).toISOString(), paidAt);

  // The term did NOT shift. The policy simply has less cover than its term
  // suggests, and the gap between term_start and coverage_began_at is what
  // makes that legible.
  assert.equal(new Date(rows[0].expiry).getTime(), new Date(before.expiry).getTime());
  assert.equal(new Date(rows[0].term_start).getTime(), new Date(before.term_start).getTime());
  assert.ok(
    new Date(rows[0].coverage_began_at) > new Date(rows[0].term_start),
    'cover began after the term opened, and the gap is uncovered'
  );

  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(new Date(token.createArgument.coverageBeganAt).toISOString(), paidAt);
  assert.equal(token.createArgument.coverageStartBasis, 'CSB_PremiumPaid');

  // And a trigger now works.
  const readingId = await insertTriggerReading(policy.id, -1);
  await runOnce();
  const ev = await pool.query('SELECT * FROM policy_events WHERE id = $1', [readingId]);
  assert.equal(ev.rows[0].status, 'done', ev.rows[0].error ?? '');
});

// The route answers 409; a row queued past it fails here,
// before the ledger, and the first recorded date stands in SQL and on the token.
test('a second first-premium-paid row fails before the ledger once the first premium is recorded', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyWithoutCover(ph.id);
  await activate(policy.id);
  await runOnce();
  const paidAt = '2026-09-20T09:00:00.000Z';
  await insertLifecycleEvent(policy.id, 'first_premium_paid', { paidAt });
  await runOnce();
  const recorded = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(new Date(recorded.first_premium_paid_at).toISOString(), paidAt);

  await insertLifecycleEvent(policy.id, 'first_premium_paid', { paidAt: '2026-09-21T09:00:00.000Z' });
  await runOnce();
  const { rows: events } = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'first_premium_paid' ORDER BY created_at`,
    [policy.id]
  );
  assert.deepEqual(events.map((e) => e.status), ['done', 'failed']);
  assert.match(events[1].error, /already has its first premium recorded as paid/);
  const after = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(new Date(after.first_premium_paid_at).toISOString(), paidAt, 'the first date stands');
  assert.equal(after.daml_contract_id, recorded.daml_contract_id, 'the token was not re-minted');
  assert.equal(after.current_version, recorded.current_version);
});

// A due date reported after the payment would move a paid policy into
// first-premium default. The route answers 409; a row queued past it fails
// here, before the ledger, and the policy and its token stay as they were.
test('a premium-due-date row fails before the ledger once the first premium is recorded paid', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyWithoutCover(ph.id);
  await activate(policy.id);
  await runOnce();
  const paidAt = '2026-09-20T09:00:00.000Z';
  await insertLifecycleEvent(policy.id, 'first_premium_paid', { paidAt });
  await runOnce();
  const recorded = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(new Date(recorded.first_premium_paid_at).toISOString(), paidAt);
  assert.equal(recorded.default_state, 'none');

  await insertLifecycleEvent(policy.id, 'premium_due_date', { dueDate: '2026-09-10T09:00:00.000Z' });
  await runOnce();
  const ev = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'premium_due_date'`,
    [policy.id]
  );
  assert.equal(ev.rows[0].status, 'failed');
  assert.match(ev.rows[0].error, /already has its first premium recorded as paid/);
  assert.ok(ev.rows[0].error.includes(paidAt), 'the recorded payment is named');
  const after = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(after.default_state, 'none');
  assert.equal(after.premium_due_date, null);
  assert.equal(after.daml_contract_id, recorded.daml_contract_id, 'the token was not re-minted');
  assert.equal(after.current_version, recorded.current_version);
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === recorded.daml_contract_id);
  assert.ok(token, 'the recorded token is still the active one');
  assert.equal(token.createArgument.defaultState, 'DS_None');
});

test('an agreed start earlier than payment stands, and payment does not overwrite it', async () => {
  const ph = await createPolicyholder();
  // createPolicy mints on the agreed basis, dated at the term start.
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const agreed = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(agreed.coverage_start_basis, 'CSB_AgreedWithoutPayment');

  // After the agreed start (2026-09-01) and, since v22, not in the
  // future: the ledger refuses a paidAt after its own time.
  await insertLifecycleEvent(policy.id, 'first_premium_paid', {
    paidAt: '2026-09-15T09:00:00.000Z',
  });
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(
    new Date(rows[0].coverage_began_at).getTime(),
    new Date(agreed.coverage_began_at).getTime(),
    'the earlier agreed instant governs'
  );
  assert.equal(rows[0].coverage_start_basis, 'CSB_AgreedWithoutPayment', 'and why it began is unchanged');
  assert.equal(
    new Date(rows[0].first_premium_paid_at).toISOString(),
    '2026-09-15T09:00:00.000Z',
    'the payment date is still recorded, as its own fact'
  );
});

// m. 1452(3) forbids varying m. 1421 to the insured's detriment. An agreed
// start LATER than payment would leave them paying for a gap the Code's own
// default would have covered.
test('an agreed start later than the reported payment is rejected', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);   // agreed start 2026-09-01
  await activate(policy.id);
  await runOnce();

  await insertLifecycleEvent(policy.id, 'first_premium_paid', {
    paidAt: '2026-08-01T09:00:00.000Z',       // BEFORE the agreed start
  });
  await runOnce();

  const ev = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'first_premium_paid'`,
    [policy.id]
  );
  assert.equal(ev.rows[0].status, 'failed');
  assert.match(ev.rows[0].error, /detriment/i);
  assert.match(ev.rows[0].error, /1452\(3\)/);

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].first_premium_paid_at, null, 'nothing was recorded');
});

test('a first-premium-paid event with no paidAt fails loudly instead of defaulting one', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyWithoutCover(ph.id);
  await activate(policy.id);
  await runOnce();

  await insertLifecycleEvent(policy.id, 'first_premium_paid', null);
  await runOnce();

  const ev = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'first_premium_paid'`,
    [policy.id]
  );
  assert.equal(ev.rows[0].status, 'failed');
  assert.match(ev.rows[0].error, /missing paidAt/i);
  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].coverage_began_at, null, 'no payment is ever inferred');
});

// m. 1421 and m. 1434(2) compose rather than duplicate: an unpaid first
// premium is both "cover not begun" and a withdrawal candidate.
test('cover start composes with the first-premium default flow', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyWithoutCover(ph.id);
  await pool.query('UPDATE insurers SET first_premium_withdrawal_days = 60 WHERE id = $1', [insurerId]);
  await activate(policy.id);
  await runOnce();

  await insertLifecycleEvent(policy.id, 'premium_due_date', {
    dueDate: new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  await runOnce();

  let row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  // Both facts are true at once, in separate fields.
  assert.equal(row.default_state, 'first_premium_unpaid');
  assert.equal(row.coverage_began_at, null);

  // One report settles both.
  const paidAt = new Date().toISOString();
  await insertLifecycleEvent(policy.id, 'first_premium_paid', { paidAt });
  await runOnce();

  row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(row.default_state, 'none');
  assert.equal(new Date(row.coverage_began_at).toISOString(), paidAt);
  assert.equal(row.coverage_start_basis, 'CSB_PremiumPaid');
  assert.ok(row.premium_due_date, 'the due date stays -- a fact about what happened');
});

// ---------------------------------------------------------------------------
// The two intake gaps. Neither needed a package change.
// ---------------------------------------------------------------------------

test('a distinct insured is accepted and reaches the token', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const sigortali = await createPerson('insured');
  const policy = await createPolicyWithoutCover(ph.id, { insuredId: sigortali.id });

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  const phRow = (await pool.query('SELECT * FROM policyholders WHERE id = $1', [ph.id])).rows[0];
  const insuredRow = (await pool.query('SELECT * FROM policyholders WHERE id = $1', [sigortali.id])).rows[0];
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === rows[0].daml_contract_id);

  assert.equal(token.createArgument.policyholder, phRow.canton_party_id);
  assert.equal(token.createArgument.insured, insuredRow.canton_party_id);
  assert.notEqual(
    token.createArgument.insured,
    token.createArgument.policyholder,
    'the sigortalı is a party distinct from the sigorta ettiren -- the precondition m. 1454 and m. 1431(4) need'
  );
  assert.ok(token.observers.includes(insuredRow.canton_party_id), 'and observes the contract');
});

test('omitting insured still defaults it to the policyholder', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicyWithoutCover(ph.id);
  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(
    token.createArgument.insured,
    token.createArgument.policyholder,
    'the common case, and what the statute assumes where nothing else is said'
  );
});

test('a document hash is accepted and reaches the token', async () => {
  const ph = await createPolicyholder();
  const documentHash = crypto.createHash('sha256').update('the policy document').digest('hex');
  const policy = await createPolicyWithoutCover(ph.id, { documentHash });

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(token.createArgument.documentHash, documentHash);
  assert.equal(rows[0].document_hash, documentHash);
});

// ---------------------------------------------------------------------------
// m. 1458: retroactive cover, checked against the platform's own data.
// ---------------------------------------------------------------------------
//
// Backdating cover is expressly lawful (sentence 1) and stays possible. What
// the check guards is sentence 2 -- void where the riziko's occurrence was
// already known at formation -- which m. 1486(1) names specifically, so it
// cannot be agreed around. The check decides nothing about knowledge. It
// reports what the platform's own recorded data shows, and these tests assert
// that it reports its own limits too.

// A policy whose cover began BEFORE it was created. Both instants are given
// explicitly so the window is deterministic rather than depending on when the
// suite happens to run.
async function createBackdatedPolicy(policyholderId, opts = {}) {
  const {
    coverStart = '2026-06-01T00:00:00.000Z',
    createdAt = '2026-07-01T00:00:00.000Z',
    cellIds = ['cell-test'],
  } = opts;
  const { rows } = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date, status,
        coverage_began_at, coverage_start_basis, created_at, document_hash)
     VALUES ($1,$2,500,'TRY','2026-06-01','2027-03-31','pending_mint',$3,'CSB_AgreedWithoutPayment',$4,$5)
     RETURNING *`,
    [insurerId, policyholderId, coverStart, createdAt, DOCUMENT_HASH]
  );
  const policy = rows[0];
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL',$2,10000,10000,
       '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null},{"tierOrder":2,"label":"test total loss","minValue":null,"maxValue":"-4.0","payoutPct":"100.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null}]',
       '["PDR_Insured"]','TEMPERATURE_C','PB_RemainingLimit')`,
    [policy.id, JSON.stringify(cellIds)]
  );
  return policy;
}

// A reading on a cell, belonging to some OTHER policy -- which is the only
// kind that can exist for a policy being minted for the first time. That is
// why the check joins on cell and never on policy_id.
async function readingOnCell(cellId, value, measuredAt, owningPolicyId) {
  const { rows } = await pool.query(
    `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source)
     VALUES ($1,'TEST-COVERAGE',$2,'TEMPERATURE_C',$3,$4,'test-fixture') RETURNING id`,
    [owningPolicyId, cellId, value, measuredAt]
  );
  return rows[0].id;
}

test('a backdated policy with no matching reading mints, and records that the check ran', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const cell = `cell-clean-${crypto.randomUUID()}`;
  const neighbour = await createPolicy(ph.id);
  // The platform holds data for this cell -- just nothing that matches a tier.
  await readingOnCell(cell, 5.0, '2026-06-10T00:00:00.000Z', neighbour.id);
  const policy = await createBackdatedPolicy(ph.id, { cellIds: [cell] });

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'active', 'backdating is lawful and must stay possible');
  assert.ok(rows[0].retroactive_cover_checked_at, 'and the check ran');
  assert.equal(rows[0].retroactive_cover_check_status, 'RC_PassedWithData');

  const detail = rows[0].retroactive_cover_check_result;
  assert.deepEqual(detail.cellsChecked, [cell]);
  assert.equal(detail.readingsExamined, 1);
  assert.deepEqual(detail.cellsWithNoReadings, []);
  assert.equal(detail.windowFrom, '2026-06-01T00:00:00.000Z');
  assert.equal(detail.windowTo, '2026-07-01T00:00:00.000Z');

  // The ledger carries the timestamp and nothing else -- not the reading, not
  // the tier, not the search.
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.ok(token.createArgument.retroactiveCoverCheckedAt, 'the ledger records that a check ran');
  assert.equal(
    JSON.stringify(token.createArgument).includes(cell),
    false,
    'and does not carry the search itself'
  );
});

test('a backdated policy over a tier-matching reading is refused', async () => {
  const ph = await createPolicyholder();
  const cell = `cell-frost-${crypto.randomUUID()}`;
  const neighbour = await createPolicy(ph.id);
  // -1.0 falls inside the -2.0..0.0 tier: on the platform's own data, a
  // reading that would have paid sits inside the requested window.
  const readingId = await readingOnCell(cell, -1.0, '2026-06-15T00:00:00.000Z', neighbour.id);
  const policy = await createBackdatedPolicy(ph.id, { cellIds: [cell] });

  await activate(policy.id);
  await runOnce();

  const ev = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'activation'`,
    [policy.id]
  );
  assert.equal(ev.rows[0].status, 'failed');
  assert.match(ev.rows[0].error, /1458/);
  assert.ok(ev.rows[0].error.includes(readingId), 'the reading is named');
  assert.match(ev.rows[0].error, /TEST-COVERAGE/, 'and so is the coverage');
  // The message says what it means and no more: it is the platform's own
  // rule, not a finding about the contract or about anyone's knowledge.
  assert.match(ev.rows[0].error, /does NOT assert that the contract is void/);
  assert.match(ev.rows[0].error, /knew anything/);

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'pending_mint', 'nothing minted');
  assert.equal(rows[0].daml_contract_id, null);
  assert.equal(rows[0].retroactive_cover_checked_at, null, 'a refusal records no pass');
  assert.equal(rows[0].retroactive_cover_check_status, null);
});

test('a reading matching no tier does not refuse', async () => {
  const ph = await createPolicyholder();
  const cell = `cell-mild-${crypto.randomUUID()}`;
  const neighbour = await createPolicy(ph.id);
  // -3.0 sits in the gap the seed deliberately leaves between the -2..0 tier
  // and the below--4 one. A reading matching no tier pays nothing on the
  // trigger path, so it is not an occurrence here either -- the check and the
  // payout agree about what a riziko is because they share the predicate.
  await readingOnCell(cell, -3.0, '2026-06-15T00:00:00.000Z', neighbour.id);
  const policy = await createBackdatedPolicy(ph.id, { cellIds: [cell] });

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].retroactive_cover_check_status, 'RC_PassedWithData');
  assert.equal(rows[0].retroactive_cover_check_result.readingsExamined, 1);
});

// v22: the check evaluates a reading exactly as the ledger would
// (tiers.js), so on a linear tier a reading whose computed amount is 0.00 is
// no match -- it pays nothing on the trigger path -- and does not refuse the
// mint, while one that computes to a positive amount does. The tier runs from
// 50% at -2.0 to 0% at 0.0.
test('m. 1458 on a linear tier: a reading that computes to 0.00 passes, one that pays refuses', async () => {
  const LINEAR = JSON.stringify([{
    tierOrder: 1, label: 'linear test tier', minValue: '-2.0', maxValue: '0.0', payoutPct: '50.0',
    shape: 'TS_Linear', pctAtMin: '50.0', pctAtMax: '0.0',
  }]);
  const ph = await createPolicyholder();
  const neighbour = await createPolicy(ph.id);
  for (const [value, refused] of [[0.0, false], [-1.0, true]]) {
    const cell = `cell-linear-${crypto.randomUUID()}`;
    await readingOnCell(cell, value, '2026-06-15T00:00:00.000Z', neighbour.id);
    const policy = await createBackdatedPolicy(ph.id, { cellIds: [cell] });
    await pool.query('UPDATE policy_coverages SET payout_tiers_snapshot = $2 WHERE policy_id = $1', [policy.id, LINEAR]);
    await activate(policy.id);
    await runOnce();
    const ev = (await pool.query(
      `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'activation'`, [policy.id]
    )).rows[0];
    if (refused) {
      assert.equal(ev.status, 'failed', `${value}: 25% of the limit would pay`);
      assert.match(ev.error, /1458/);
      assert.match(ev.error, /would pay 2500 on/, 'the amount the trigger path would pay is named');
    } else {
      assert.equal(ev.status, 'done', `${value}: 0% computes to 0.00, no match -- ${ev.error ?? ''}`);
    }
  }
});

// v22: a trigger row that names no window -- what fixtures wrote before v22 --
// has no event interval, cell or evidence digest to send, and is refused with
// that reason before anything reaches the ledger.
test('a trigger row with no window fails with its reason and sends nothing', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  const reading = (await pool.query(
    `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source)
     VALUES ($1,'TEST-COVERAGE','cell-test','TEMPERATURE_C',-1,now(),'test-fixture') RETURNING id`,
    [policy.id]
  )).rows[0];
  const { rows: [row] } = await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, expected_version, reading_id, payload)
     VALUES ($1, 'trigger', 1, $2, $3) RETURNING id`,
    [policy.id, reading.id, JSON.stringify({ observedValue: -1, metric: 'TEMPERATURE_C', coverageCode: 'TEST-COVERAGE' })]
  );
  await runOnce();
  const ev = (await pool.query('SELECT * FROM policy_events WHERE id = $1', [row.id])).rows[0];
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /names no trigger window/);
  assert.match(ev.error, /nothing was sent/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payout_events WHERE policy_id = $1', [policy.id])).rows[0].n, 0);
});

// A pass over a cell the platform has never observed verified NOTHING, and
// must never be read later as "we confirmed there was no frost".
test('a pass over a cell with no readings is recorded as vacuous, not as verified', async () => {
  const ph = await createPolicyholder();
  const cell = `cell-unobserved-${crypto.randomUUID()}`;
  const policy = await createBackdatedPolicy(ph.id, { cellIds: [cell] });

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'active', 'it still mints -- there is no basis to refuse');
  assert.equal(
    rows[0].retroactive_cover_check_status,
    'RC_PassedNoDataForCells',
    'but it is NOT recorded as a clean pass'
  );
  const detail = rows[0].retroactive_cover_check_result;
  assert.deepEqual(detail.cellsWithNoReadings, [cell]);
  assert.equal(detail.readingsHeldPerCell[cell], 0);
  assert.equal(detail.readingsExamined, 0);
  assert.match(detail.caveat, /VACUOUS/);
  assert.match(detail.caveat, /not evidence that no riziko occurred/);
});

test('one unobserved cell among several makes the whole pass vacuous', async () => {
  const ph = await createPolicyholder();
  const seen = `cell-seen-${crypto.randomUUID()}`;
  const unseen = `cell-unseen-${crypto.randomUUID()}`;
  const neighbour = await createPolicy(ph.id);
  await readingOnCell(seen, 5.0, '2026-06-10T00:00:00.000Z', neighbour.id);
  // Two coverages, one cell each: since v22 a coverage commits to exactly one
  // cell, and a mint of a coverage naming two is refused.
  const policy = await createBackdatedPolicy(ph.id, { cellIds: [seen] });
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     SELECT policy_id, 'TEST-COVERAGE-2', product_code, peril_type, $2, sum_insured, remaining_limit,
            payout_tiers_snapshot, payout_destination, metric, payout_basis
       FROM policy_coverages WHERE policy_id = $1 AND coverage_code = 'TEST-COVERAGE'`,
    [policy.id, JSON.stringify([unseen])]
  );

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].retroactive_cover_check_status, 'RC_PassedNoDataForCells');
  const detail = rows[0].retroactive_cover_check_result;
  assert.deepEqual(detail.cellsWithNoReadings, [unseen]);
  assert.equal(detail.readingsHeldPerCell[seen], 1);
  assert.equal(detail.readingsHeldPerCell[unseen], 0);
});

test('a forward-dated policy is unaffected -- no window, so no check', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);   // cover begins at the term start

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].retroactive_cover_checked_at, null, 'there was nothing to check');
  assert.equal(rows[0].retroactive_cover_check_status, null);
  assert.equal(rows[0].retroactive_cover_check_result, null);

  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(token.createArgument.retroactiveCoverCheckedAt ?? null, null);
});

// The window ends at contract FORMATION, not at now. m. 1458 fixes knowledge
// at "sozlesmenin yapilmasi sirasinda", so a reading measured after the
// contract was made could not have been known when it was made -- it is an
// ordinary claim in a covered window, not a m. 1458 case at all.
test('a tier-matching reading after formation is outside the window and does not refuse', async () => {
  const ph = await createPolicyholder();
  const cell = `cell-after-${crypto.randomUUID()}`;
  const neighbour = await createPolicy(ph.id);
  await readingOnCell(cell, -1.0, '2026-07-15T00:00:00.000Z', neighbour.id);
  const policy = await createBackdatedPolicy(ph.id, { cellIds: [cell] });

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].status, 'active');
  assert.equal(
    rows[0].retroactive_cover_check_result.windowTo,
    '2026-07-01T00:00:00.000Z',
    'and the record says where the boundary was, so the pass can be read back'
  );
  assert.equal(rows[0].retroactive_cover_check_result.readingsExamined, 0);
});

// The check composes with the v15 cover-start model rather than duplicating
// or overriding it.
test('a backdated policy that passes has cover begun, and triggers normally', async () => {
  const ph = await createPolicyholder();
  const policy = await createBackdatedPolicy(ph.id);

  await activate(policy.id);
  await runOnce();

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(
    rows[0].coverage_start_basis,
    'CSB_AgreedWithoutPayment',
    'a backdated start can only rest on agreement -- payment cannot precede formation'
  );
  assert.ok(rows[0].retroactive_cover_checked_at);

  const readingId = await insertTriggerReading(policy.id, -1);
  await runOnce();
  const ev = await pool.query('SELECT * FROM policy_events WHERE id = $1', [readingId]);
  assert.equal(ev.rows[0].status, 'done', 'cover has begun, so the trigger evaluates normally');
});

test('a backdated policy naming no cells is refused rather than passing vacuously', async () => {
  const ph = await createPolicyholder();
  const policy = await createBackdatedPolicy(ph.id, { cellIds: [] });

  await activate(policy.id);
  await runOnce();

  const ev = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'activation'`,
    [policy.id]
  );
  assert.equal(ev.rows[0].status, 'failed');
  assert.match(ev.rows[0].error, /names no cells/);

  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id]);
  assert.equal(rows[0].daml_contract_id, null);
});

// ---------------------------------------------------------------------------
// m. 1456: routing a payout between the mortgagee and the insured
// ---------------------------------------------------------------------------
//
// m. 1456(1) continues the sınırlı ayni hak over the sigorta tazminatı, so a
// payout from the charged coverage is owed to the bank up to its remaining
// claim. m. 1456(2) forbids paying the sigortalı without izin and offers no
// surplus carve-out, so the excess is recorded for a human rather than routed
// -- these tests assert both halves, and that the second is NOT a payout.

// The fixture's TEST-COVERAGE with a bank's charge of `claim` on it.
async function createChargedPolicy(policyholderId, bankId, claim) {
  return createPolicyWithRoles(policyholderId, {
    mortgageeId: bankId,
    claimAmounts: { 'TEST-COVERAGE': claim },
  });
}

// All payout_events rows for a policy, oldest first -- there can be several
// now, and which is which is the point.
async function payoutRows(policyId) {
  const { rows } = await pool.query(
    'SELECT * FROM payout_events WHERE policy_id = $1 ORDER BY created_at ASC, id ASC',
    [policyId]
  );
  return rows;
}

async function claimOf(policyId) {
  const { rows } = await pool.query(
    `SELECT mortgagee_claim_amount FROM policy_coverages
      WHERE policy_id = $1 AND coverage_code = 'TEST-COVERAGE'`,
    [policyId]
  );
  return rows[0].mortgagee_claim_amount;
}

// A -1 reading pays 25% of the 10000 remaining limit = 2500.
async function trigger(policyId) {
  await insertTriggerReading(policyId, -1);
  await runOnce();
}

test('a payout below the mortgagee claim goes wholly to the mortgagee', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createChargedPolicy(ph.id, bank.id, 5000);
  await activate(policy.id);
  await runOnce();

  await trigger(policy.id);

  const rows = await payoutRows(policy.id);
  assert.equal(rows.length, 1, 'one leg, no remainder');
  assert.equal(rows[0].record_kind, 'payout');
  assert.equal(rows[0].recipient, 'PDR_Mortgagee');
  assert.equal(Number(rows[0].payout_amount), 2500);
  assert.equal(rows[0].status, 'approved');
  assert.ok(rows[0].daml_contract_id);

  // The claim decrements by what was routed, like remaining_limit.
  assert.equal(Number(await claimOf(policy.id)), 2500);

  // The bank observes the leg it is owed.
  const bankRow = (await pool.query('SELECT canton_party_id FROM policyholders WHERE id = $1', [bank.id])).rows[0];
  const payout = (await ledgerContracts('Insurance.PayoutBridge', 'PayoutApproved'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(payout.createArgument.recipient, 'PDR_Mortgagee');
  assert.equal(payout.createArgument.mortgagee, bankRow.canton_party_id);
  assert.ok(payout.observers.includes(bankRow.canton_party_id));
});

test('a payout above the claim pays the bank its claim and leaves the rest for a human', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createChargedPolicy(ph.id, bank.id, 1000);
  await activate(policy.id);
  await runOnce();

  await trigger(policy.id);

  const rows = await payoutRows(policy.id);
  assert.equal(rows.length, 2);
  const leg = rows.find((r) => r.record_kind === 'payout');
  const remainder = rows.find((r) => r.record_kind === 'unrouted_remainder');

  assert.equal(leg.recipient, 'PDR_Mortgagee');
  assert.equal(Number(leg.payout_amount), 1000);

  // The remainder is NOT a payout. No PayoutApproved exists for it, nobody is
  // recorded as owed it, and it is a review item from the moment it exists.
  assert.equal(Number(remainder.payout_amount), 1500);
  assert.equal(remainder.recipient, null, 'nobody has decided who it goes to');
  assert.equal(remainder.daml_contract_id, null, 'no PayoutApproved exists for it');
  assert.equal(remainder.status, 'manual_review');
  assert.ok(remainder.review_contract_id);

  // Exactly ONE PayoutApproved on the ledger for this policy, not two.
  const approved = (await ledgerContracts('Insurance.PayoutBridge', 'PayoutApproved'))
    .filter((c) => c.createArgument.policyId === policy.id);
  assert.equal(approved.length, 1);

  const review = (await ledgerContracts('Insurance.PayoutBridge', 'ManualReviewRequired'))
    .find((c) => c.contractId === remainder.review_contract_id);
  assert.equal(Number(review.createArgument.amount), 1500);
  assert.match(review.createArgument.reason, /1456\(2\)/);
  assert.equal(review.createArgument.sourcePayoutContractId, '',
    'a remainder has no source payout -- it never became one');

  // Migration 035: a remainder is queued too, but as 'review_required'. What
  // the insurer is told is that a human has to work it, not who is owed what.
  const queuedForRemainder = await pool.query(
    `SELECT kind::text AS kind FROM payout_notifications WHERE payout_event_id = $1`,
    [remainder.id]
  );
  assert.deepEqual(queuedForRemainder.rows.map((r) => r.kind), ['review_required']);

  assert.equal(Number(await claimOf(policy.id)), 0);
});

test('a payout on an uncharged coverage goes wholly to the insured', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  // A mortgagee on the POLICY, but no claim on this coverage: the charge does
  // not reach it, so there is no ayni hak to continue over this indemnity.
  const policy = await createPolicyWithRoles(ph.id, { mortgageeId: bank.id });
  await activate(policy.id);
  await runOnce();

  await trigger(policy.id);

  const rows = await payoutRows(policy.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipient, 'PDR_Insured');
  assert.equal(Number(rows[0].payout_amount), 2500);
  assert.equal(rows[0].record_kind, 'payout');
  assert.equal(await claimOf(policy.id), null, 'never charged, and still not');

  const payout = (await ledgerContracts('Insurance.PayoutBridge', 'PayoutApproved'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(payout.createArgument.mortgagee ?? null, null);
});

test('the claim decrements across payouts and stops routing once exhausted', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createChargedPolicy(ph.id, bank.id, 3000);
  await activate(policy.id);
  await runOnce();

  // 25% of 10000 = 2500, against a 3000 claim: all of it to the bank.
  await trigger(policy.id);
  assert.equal(Number(await claimOf(policy.id)), 500);

  // 25% of the remaining 7500 = 1875, against a 500 claim: 500 routed,
  // 1375 unrouted.
  await trigger(policy.id);
  assert.equal(Number(await claimOf(policy.id)), 0);

  // The claim is spent. Nothing is routed at all, and the whole indemnity is
  // unrouted -- NOT quietly redirected to the insured, because that would let
  // the ORDER of payouts decide what the arithmetic was not allowed to.
  await trigger(policy.id);

  const rows = await payoutRows(policy.id);
  const legs = rows.filter((r) => r.record_kind === 'payout');
  const remainders = rows.filter((r) => r.record_kind === 'unrouted_remainder');
  assert.deepEqual(legs.map((r) => Number(r.payout_amount)), [2500, 500]);
  assert.deepEqual(remainders.map((r) => Number(r.payout_amount)), [1375, 1406.25]);
  assert.ok(legs.every((r) => r.recipient === 'PDR_Mortgagee'));
  assert.equal(Number(await claimOf(policy.id)), 0, 'stays at 0, never back to null');
});

test('the two records from one split settle and resolve independently', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createChargedPolicy(ph.id, bank.id, 1000);
  await activate(policy.id);
  await runOnce();
  await trigger(policy.id);

  const rows = await payoutRows(policy.id);
  const leg = rows.find((r) => r.record_kind === 'payout');
  const remainder = rows.find((r) => r.record_kind === 'unrouted_remainder');

  // The bank settles today.
  const settlement = await reportOnPayout(leg, {
    action: 'settle',
    bankReference: 'REF-BANK-1',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Mortgagee',
  });
  assert.equal(settlement.status, 'done');
  assert.equal((await reloadPayout(leg.id)).status, 'settled');

  // The remainder is untouched by that. Two obligations, two outcomes -- the
  // whole reason they are separate records.
  assert.equal((await reloadPayout(remainder.id)).status, 'manual_review');
  assert.equal((await reloadPayout(remainder.id)).resolved_at, null);
});

test('a settlement claiming to have paid the wrong recipient is rejected', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createChargedPolicy(ph.id, bank.id, 5000);
  await activate(policy.id);
  await runOnce();
  await trigger(policy.id);

  const [leg] = await payoutRows(policy.id);
  // The coverage permits both roles, so payoutDestination alone would let
  // this through; the recipient check is what stops it.
  const settlement = await reportOnPayout(leg, {
    action: 'settle',
    bankReference: 'REF-WRONG',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Insured',
  });
  assert.equal(settlement.status, 'failed');
  assert.match(settlement.error, /owed to/i);
  assert.equal((await reloadPayout(leg.id)).status, 'approved', 'still open');
});

test('a mortgagee leg can fail and be resolved without touching the remainder', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createChargedPolicy(ph.id, bank.id, 1000);
  await activate(policy.id);
  await runOnce();
  await trigger(policy.id);

  const rows = await payoutRows(policy.id);
  const leg = rows.find((r) => r.record_kind === 'payout');
  const remainder = rows.find((r) => r.record_kind === 'unrouted_remainder');

  const failure = await reportOnPayout(leg, {
    action: 'fail',
    failureReason: 'payee could not be reached',
  });
  assert.equal(failure.status, 'done');
  const failed = await reloadPayout(leg.id);
  assert.equal(failed.status, 'manual_review');
  assert.ok(failed.review_contract_id);
  assert.notEqual(failed.review_contract_id, remainder.review_contract_id,
    'two review items, one per obligation');

  assert.equal((await reloadPayout(remainder.id)).resolved_at, null);
});

test('a policy with no mortgagee is completely unaffected', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  await trigger(policy.id);

  const rows = await payoutRows(policy.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record_kind, 'payout');
  assert.equal(rows[0].recipient, 'PDR_Insured');
  assert.equal(Number(rows[0].payout_amount), 2500);
  assert.equal(rows[0].status, 'approved');
  assert.equal(await claimOf(policy.id), null);

  const payout = (await ledgerContracts('Insurance.PayoutBridge', 'PayoutApproved'))
    .find((c) => c.contractId === rows[0].daml_contract_id);
  assert.equal(payout.createArgument.mortgagee ?? null, null);
  assert.deepEqual(payout.createArgument.payoutDestination, ['PDR_Insured']);
});

// ---------------------------------------------------------------------------
// m. 1431(4): policyholder substitution
// ---------------------------------------------------------------------------
//
// The only path in this system that changes who a party is. Three externally
// reported facts in one order, and then "sözleşme bu kişilerle devam eder".

// A policy genuinely taken for another's account, and live, so the premium
// mechanisms can run against it.
async function createForAnothersAccount(policyholderId, insuredId) {
  const { rows } = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, insured_policyholder_id, premium_amount, currency,
        start_date, end_date, status, coverage_began_at, coverage_start_basis, created_at, document_hash)
     VALUES ($1,$2,$3,500,'TRY','2026-09-01','2027-03-31','pending_mint',
             '2026-09-01','CSB_AgreedWithoutPayment','2026-08-01',$4)
     RETURNING *`,
    [insurerId, policyholderId, insuredId, DOCUMENT_HASH]
  );
  const policy = rows[0];
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL','["cell-test"]',10000,10000,
       '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null}]',
       '["PDR_Insured"]','TEMPERATURE_C','PB_RemainingLimit')`,
    [policy.id]
  );
  return policy;
}

const daysAgoIso = (n) => new Date(Date.now() - n * 86400000).toISOString();

async function policyRow(policyId) {
  const { rows } = await pool.query('SELECT * FROM policies WHERE id = $1', [policyId]);
  return rows[0];
}

async function reachNotified(policyId) {
  await insertLifecycleEvent(policyId, 'enforcement_fruitless', {
    fruitlessAt: daysAgoIso(20), route: 'ER_Takip',
  });
  await runOnce();
  await insertLifecycleEvent(policyId, 'substitution_notice', { notifiedAt: daysAgoIso(10) });
  await runOnce();
}

async function substitute(policyId, at = daysAgoIso(1)) {
  await insertLifecycleEvent(policyId, 'substitution', { substitutedAt: at });
  await runOnce();
  return eventRow(policyId, 'substitution');
}

test('the three m. 1431(4) facts are recorded in order, and only in order', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ettiren = await createPolicyholder();
  const sigortali = await createPerson('sigortali');
  const policy = await createForAnothersAccount(ettiren.id, sigortali.id);
  await activate(policy.id);
  await runOnce();

  // Nothing reported: the assumption is refused, and so is the notification.
  let ev = await substitute(policy.id);
  assert.equal(ev.status, 'failed');
  await insertLifecycleEvent(policy.id, 'substitution_notice', { notifiedAt: daysAgoIso(10) });
  await runOnce();
  assert.equal((await eventRow(policy.id, 'substitution_notice')).status, 'failed');

  let row = await policyRow(policy.id);
  assert.equal(row.substituted_at, null);
  assert.equal(row.substitution_notified_at, null);

  // Fact one alone is still not enough.
  await insertLifecycleEvent(policy.id, 'enforcement_fruitless', {
    fruitlessAt: daysAgoIso(20), route: 'ER_Takip',
  });
  await runOnce();
  row = await policyRow(policy.id);
  assert.ok(row.enforcement_fruitless_at);
  assert.equal(row.enforcement_route, 'ER_Takip');
  assert.equal(row.enforcement_commenced_at, null, 'a different fact, and not touched by this one');

  ev = await substitute(policy.id);
  assert.equal(ev.status, 'failed');
  assert.equal((await policyRow(policy.id)).substituted_at, null);

  // Fact two, then fact three.
  await insertLifecycleEvent(policy.id, 'substitution_notice', { notifiedAt: daysAgoIso(10) });
  await runOnce();
  ev = await substitute(policy.id);
  assert.equal(ev.status, 'done', ev.error ?? '');
});

test('the contract continues with the sigortali, and the old party is recorded as superseded', async () => {
  const ettiren = await createPolicyholder();
  const sigortali = await createPerson('sigortali');
  const policy = await createForAnothersAccount(ettiren.id, sigortali.id);
  await activate(policy.id);
  await runOnce();
  await reachNotified(policy.id);
  const ev = await substitute(policy.id);
  assert.equal(ev.status, 'done', ev.error ?? '');

  const row = await policyRow(policy.id);
  assert.equal(row.policyholder_id, sigortali.id, 'the contract continues WITH the sigortali');
  assert.equal(row.insured_policyholder_id, sigortali.id);
  assert.equal(row.superseded_policyholder_id, ettiren.id);
  assert.ok(row.substituted_at);
  // An undertaking is not a payment: nothing about the premium changed.
  assert.equal(row.default_state, 'none');

  const ettirenRow = (await pool.query('SELECT canton_party_id FROM policyholders WHERE id = $1', [ettiren.id])).rows[0];
  const sigortaliRow = (await pool.query('SELECT canton_party_id FROM policyholders WHERE id = $1', [sigortali.id])).rows[0];
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === row.daml_contract_id);
  assert.equal(token.createArgument.policyholder, sigortaliRow.canton_party_id);
  assert.equal(token.createArgument.supersededPolicyholder, ettirenRow.canton_party_id);
  // The superseded party is no longer an observer -- it is no longer a party.
  assert.equal(token.observers.includes(ettirenRow.canton_party_id), false);
  assert.ok(token.observers.includes(sigortaliRow.canton_party_id));

  // The party change is in the supersession chain, with both axes shown
  // unchanged rather than left to be inferred from an absence.
  const { rows: history } = await pool.query(
    `SELECT * FROM policy_status_history WHERE policy_id = $1 AND event_type = 'substitution'`,
    [policy.id]
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].old_status, history[0].new_status);
  assert.equal(history[0].old_default_state, history[0].new_default_state);
  assert.match(history[0].reason, /1431\(4\)/);
  assert.ok(history[0].reason.includes(ettiren.id), 'names who was superseded');
});

test('a policy on its own account cannot be substituted at all', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);   // no distinct insured
  await activate(policy.id);
  await runOnce();

  await insertLifecycleEvent(policy.id, 'enforcement_fruitless', {
    fruitlessAt: daysAgoIso(20), route: 'ER_Takip',
  });
  await runOnce();
  const fruitless = await eventRow(policy.id, 'enforcement_fruitless');
  assert.equal(fruitless.status, 'failed');
  assert.match(fruitless.error, /another's account/);

  const ev = await substitute(policy.id);
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /another's account/);
  assert.equal((await policyRow(policy.id)).substituted_at, null);
});

test('substitution cannot happen twice -- the paragraph is spent', async () => {
  const ettiren = await createPolicyholder();
  const sigortali = await createPerson('sigortali');
  const policy = await createForAnothersAccount(ettiren.id, sigortali.id);
  await activate(policy.id);
  await runOnce();
  await reachNotified(policy.id);
  assert.equal((await substitute(policy.id)).status, 'done');

  const second = await substitute(policy.id, daysAgoIso(0));
  assert.equal(second.status, 'failed');
  const row = await policyRow(policy.id);
  assert.equal(row.superseded_policyholder_id, ettiren.id, 'still the original, not overwritten');
});

test('a substitution during a running notice period freezes the termination', async () => {
  const ettiren = await createPolicyholder();
  const sigortali = await createPerson('sigortali');
  const policy = await createForAnothersAccount(ettiren.id, sigortali.id);
  // Captured ONCE: daysAgoIso reads the clock, so recomputing it for the
  // assertion below compares two instants a few seconds apart.
  const servedAt = daysAgoIso(30);
  const noticed = await activateAndServeNotice(policy.id, servedAt);
  assert.equal(noticed.default_state, 'grace_period');

  await reachNotified(policy.id);
  assert.equal((await substitute(policy.id)).status, 'done');

  const row = await policyRow(policy.id);
  // Frozen, not reset and not cleared: the premium is as unpaid as it was.
  assert.equal(row.default_state, 'grace_period');
  assert.equal(new Date(row.notice_service_date).toISOString(), servedAt);

  // And the termination cannot complete -- the ledger refuses it.
  await insertLifecycleEvent(policy.id, 'termination', {});
  await runOnce();
  const term = await eventRow(policy.id, 'termination');
  assert.equal(term.status, 'failed');
  assert.match(term.error, /taken over by the sigortali/i);
  assert.equal((await policyRow(policy.id)).default_state, 'grace_period', 'still not terminated');
});

test('substitution is reachable out of the first-premium mechanism too', async () => {
  const ettiren = await createPolicyholder();
  const sigortali = await createPerson('sigortali');
  const policy = await createForAnothersAccount(ettiren.id, sigortali.id);
  await activate(policy.id);
  await runOnce();
  await inFirstPremiumDefault(policy.id, daysAgoIso(60));
  assert.equal((await policyRow(policy.id)).default_state, 'first_premium_unpaid');

  await reachNotified(policy.id);
  assert.equal((await substitute(policy.id)).status, 'done');

  const row = await policyRow(policy.id);
  assert.equal(row.policyholder_id, sigortali.id);
  // Untouched here too: the first premium is still unpaid.
  assert.equal(row.default_state, 'first_premium_unpaid');
});

test('an unrecognized enforcement route is refused rather than stored', async () => {
  const ettiren = await createPolicyholder();
  const sigortali = await createPerson('sigortali');
  const policy = await createForAnothersAccount(ettiren.id, sigortali.id);
  await activate(policy.id);
  await runOnce();

  await insertLifecycleEvent(policy.id, 'enforcement_fruitless', {
    fruitlessAt: daysAgoIso(20), route: 'ER_Whatever',
  });
  await runOnce();
  const ev = await eventRow(policy.id, 'enforcement_fruitless');
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /ER_Takip/);
  assert.equal((await policyRow(policy.id)).enforcement_route, null);
});

// ---------------------------------------------------------------------------
// m. 1456(6): the mortgagee's information request, and the response
// ---------------------------------------------------------------------------
//
// The information was never missing -- a named mortgagee observes the token
// and can read the cover and the sum insured whenever it likes. What these
// record is the ACT: the duty is request -> response, and standing access
// cannot evidence a response to a request nobody recorded.

// Frozen at module load, deliberately. A helper that re-reads the clock
// returns a DIFFERENT instant for the same argument each call, so recording a
// date and then asserting on it compares two values milliseconds apart -- the
// same bug the v18 round hit with a per-site fix. Pinning the base fixes the
// whole class.
const INFO_BASE = Date.now();
const infoDaysAgo = (n) => new Date(INFO_BASE - n * 86400000).toISOString();

async function infoRequest(policyId, requestedAt) {
  await insertLifecycleEvent(policyId, 'mortgagee_info_request', { requestedAt });
  await runOnce();
  return eventRow(policyId, 'mortgagee_info_request');
}

async function infoProvided(policyId, providedAt) {
  await insertLifecycleEvent(policyId, 'mortgagee_info_provided', { providedAt });
  await runOnce();
  return eventRow(policyId, 'mortgagee_info_provided');
}

test('a m. 1456(6) request and response are recorded as two dated facts', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createPolicyWithRoles(ph.id, { mortgageeId: bank.id });
  await activate(policy.id);
  await runOnce();

  const requestedAt = infoDaysAgo(5);
  assert.equal((await infoRequest(policy.id, requestedAt)).status, 'done');

  let row = await policyRow(policy.id);
  assert.equal(new Date(row.mortgagee_info_requested_at).toISOString(), requestedAt);
  assert.equal(row.mortgagee_info_provided_at, null, 'outstanding: the insurer owes an answer');

  const providedAt = infoDaysAgo(4);
  assert.equal((await infoProvided(policy.id, providedAt)).status, 'done');

  row = await policyRow(policy.id);
  assert.equal(new Date(row.mortgagee_info_provided_at).toISOString(), providedAt);
  // The request date stays: it is the fact the duty runs from.
  assert.equal(new Date(row.mortgagee_info_requested_at).toISOString(), requestedAt);

  // Both reach the ledger, where the bank -- already an observer -- can see
  // that its own request was recorded.
  const bankRow = (await pool.query('SELECT canton_party_id FROM policyholders WHERE id = $1', [bank.id])).rows[0];
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === row.daml_contract_id);
  assert.equal(new Date(token.createArgument.mortgageeInfoRequestedAt).toISOString(), requestedAt);
  assert.equal(new Date(token.createArgument.mortgageeInfoProvidedAt).toISOString(), providedAt);
  assert.ok(token.observers.includes(bankRow.canton_party_id));
});

test('a response with no request is refused, and so is answering twice', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createPolicyWithRoles(ph.id, { mortgageeId: bank.id });
  await activate(policy.id);
  await runOnce();

  const premature = await infoProvided(policy.id, infoDaysAgo(1));
  assert.equal(premature.status, 'failed');
  assert.match(premature.error, /no m\. 1456\(6\) request has been recorded/i);
  assert.equal((await policyRow(policy.id)).mortgagee_info_provided_at, null);

  await infoRequest(policy.id, infoDaysAgo(5));
  assert.equal((await infoProvided(policy.id, infoDaysAgo(4))).status, 'done');

  const twice = await infoProvided(policy.id, infoDaysAgo(3));
  assert.equal(twice.status, 'failed');
  assert.match(twice.error, /no outstanding/i);
  // The recorded answer is the first one, not overwritten by the refusal.
  assert.equal(
    new Date((await policyRow(policy.id)).mortgagee_info_provided_at).toISOString(),
    infoDaysAgo(4)
  );
});

test('a second request while one is outstanding is refused, but asking again after an answer is not', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createPolicyWithRoles(ph.id, { mortgageeId: bank.id });
  await activate(policy.id);
  await runOnce();

  const first = infoDaysAgo(5);
  await infoRequest(policy.id, first);
  const second = await infoRequest(policy.id, infoDaysAgo(3));
  assert.equal(second.status, 'failed');
  assert.match(second.error, /already outstanding/i);
  // The date the duty runs from was not overwritten -- the whole point.
  assert.equal(new Date((await policyRow(policy.id)).mortgagee_info_requested_at).toISOString(), first);

  await infoProvided(policy.id, infoDaysAgo(4));
  const again = infoDaysAgo(2);
  assert.equal((await infoRequest(policy.id, again)).status, 'done',
    'no limit in the text, and none invented');

  const row = await policyRow(policy.id);
  assert.equal(new Date(row.mortgagee_info_requested_at).toISOString(), again);
  // Outstanding again: the later request sits in front of the older response.
  assert.ok(new Date(row.mortgagee_info_provided_at) < new Date(row.mortgagee_info_requested_at));
});

test('a response cannot predate the request it answers', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createPolicyWithRoles(ph.id, { mortgageeId: bank.id });
  await activate(policy.id);
  await runOnce();

  await infoRequest(policy.id, infoDaysAgo(5));
  const backdated = await infoProvided(policy.id, infoDaysAgo(6));
  assert.equal(backdated.status, 'failed');
  assert.match(backdated.error, /cannot predate/i);
  assert.equal((await policyRow(policy.id)).mortgagee_info_provided_at, null);

  // Control: on the same instant as the request, it goes through.
  assert.equal((await infoProvided(policy.id, infoDaysAgo(5))).status, 'done');
});

test('a policy with no mortgagee has no m. 1456(6) duty to record', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  const ev = await infoRequest(policy.id, infoDaysAgo(5));
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /no mortgagee/i);
  assert.equal((await policyRow(policy.id)).mortgagee_info_requested_at, null);
});

test('the m. 1456(6) duty is independent of the premium-default flow', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createPolicyWithRoles(ph.id, { mortgageeId: bank.id });
  await activate(policy.id);
  await runOnce();

  // On an ordinary policy with nothing wrong with it. m. 1456(4) and (5) fire
  // because something went wrong; (6) can be asked at any time for no reason.
  await infoRequest(policy.id, infoDaysAgo(5));
  await infoProvided(policy.id, infoDaysAgo(4));

  const row = await policyRow(policy.id);
  assert.equal(row.default_state, 'none', 'neither axis moved');
  assert.equal(row.status, 'active');
  assert.equal(row.mortgagee_notified_at, null, 'a different fact, untouched');

  // And the m. 1456(4) notice is still refused, because no notice has been
  // served. The two mechanisms remain separate.
  await insertLifecycleEvent(policy.id, 'mortgagee_notice', { notifiedAt: infoDaysAgo(1) });
  await runOnce();
  assert.equal((await eventRow(policy.id, 'mortgagee_notice')).status, 'failed');
});

// ---------------------------------------------------------------------------
// m. 1434(4): the two-notice termination right
// ---------------------------------------------------------------------------
//
// The THIRD way a contract ends for non-payment. Discretionary, and its
// effect is deferred to the end of the insurance period. Reachable only where
// (3) did NOT fire -- which is why every fixture here serves a notice and
// then reinstates.

const TN_BASE = Date.now();
const tnDays = (n) => new Date(TN_BASE + n * 86400000).toISOString();

// Serve a notice and pay it off: the count goes up and the policy leaves
// default, which is exactly the state m. 1434(4) is about.
async function noticeThenPay(policyId, serviceDate) {
  await insertLifecycleEvent(policyId, 'notice', { serviceDate });
  await runOnce();
  await insertLifecycleEvent(policyId, 'reinstatement', {});
  await runOnce();
}

async function elect(policyId, { electedAt, start, end }) {
  await insertLifecycleEvent(policyId, 'two_notice_election', {
    electedAt, insurancePeriodStart: start, insurancePeriodEnd: end,
  });
  await runOnce();
  return eventRow(policyId, 'two_notice_election');
}

test('two notices in one period make the m. 1434(4) right available; one does not', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  await noticeThenPay(policy.id, tnDays(-50));
  let row = await policyRow(policy.id);
  assert.equal(row.notice_count, 1);
  assert.equal(row.notice_service_dates.length, 1, 'the dates list tracks the count');
  assert.equal(row.default_state, 'none');

  const tooSoon = await elect(policy.id, { electedAt: tnDays(0), start: tnDays(-60), end: tnDays(30) });
  assert.equal(tooSoon.status, 'failed');
  assert.match(tooSoon.error, /two ihtars/i);
  assert.equal((await policyRow(policy.id)).two_notice_election_at, null);

  await noticeThenPay(policy.id, tnDays(-20));
  row = await policyRow(policy.id);
  assert.equal(row.notice_count, 2);
  assert.equal(row.notice_service_dates.length, 2);

  const elected = await elect(policy.id, { electedAt: tnDays(0), start: tnDays(-60), end: tnDays(30) });
  assert.equal(elected.status, 'done', elected.error ?? '');

  row = await policyRow(policy.id);
  assert.equal(row.default_state, 'two_notice_elected');
  assert.equal(new Date(row.two_notice_effective_at).toISOString(), tnDays(30));
  // The contract RUNS ON: nothing about the election shortens it. Read from
  // the TOKEN -- coverageValidThrough has no SQL column, by design.

  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === row.daml_contract_id);
  assert.equal(token.createArgument.defaultState, 'DS_TwoNoticeElected');
  assert.equal(token.createArgument.noticeServiceDates.length, 2);
  assert.equal(
    new Date(token.createArgument.coverageValidThrough).getTime(),
    new Date(token.createArgument.expiry).getTime(),
    'the election does not shorten cover: coverageValidThrough is still the term expiry'
  );
});

test('two notices outside the named period do not count -- the dates decide, not the count', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  await noticeThenPay(policy.id, tnDays(-400));
  await noticeThenPay(policy.id, tnDays(-380));
  assert.equal((await policyRow(policy.id)).notice_count, 2);

  const wrongPeriod = await elect(policy.id, { electedAt: tnDays(0), start: tnDays(-60), end: tnDays(30) });
  assert.equal(wrongPeriod.status, 'failed');
  assert.match(wrongPeriod.error, /two ihtars/i);

  // Control: naming the period they actually fell in, it goes through.
  const right = await elect(policy.id, { electedAt: tnDays(0), start: tnDays(-410), end: tnDays(30) });
  assert.equal(right.status, 'done', right.error ?? '');
});

test('the effect lands only at the period end, and the sweeper is a state test', async () => {
  // TWO policies, because the elected state cannot be rewound: resetting
  // default_state in SQL leaves the TOKEN still elected, and the ledger is
  // the side that decides. One policy for the pending case, one for the
  // landed case.
  const ph = await createPolicyholder();

  // A: the period has not ended.
  const pending = await createPolicy(ph.id);
  await activate(pending.id);
  await runOnce();
  await noticeThenPay(pending.id, tnDays(-50));
  await noticeThenPay(pending.id, tnDays(-20));
  await elect(pending.id, { electedAt: tnDays(0), start: tnDays(-60), end: tnDays(30) });

  await sweepTwoNotice({ insurerIds: [insurerId] });
  assert.equal((await policyRow(pending.id)).default_state, 'two_notice_elected');
  const notQueued = await pool.query(
    `SELECT count(*)::int n FROM policy_events WHERE policy_no = $1 AND event_type = 'two_notice_termination'`,
    [pending.id]
  );
  assert.equal(notQueued.rows[0].n, 0, 'the period has not ended');

  // A loss in the interval is PAYABLE -- cover runs in full until the end.
  const readingId = await insertTriggerReading(pending.id, -1);
  await runOnce();
  assert.equal(
    (await pool.query('SELECT * FROM policy_events WHERE id = $1', [readingId])).rows[0].status,
    'done'
  );
  assert.equal((await policyRow(pending.id)).default_state, 'two_notice_elected');

  // B: elected from a past instant, for a period that has already ended --
  // which is also exactly the situation of a sweep that ran late.
  const landed = await createPolicy(ph.id);
  await activate(landed.id);
  await runOnce();
  await noticeThenPay(landed.id, tnDays(-50));
  await noticeThenPay(landed.id, tnDays(-20));
  await elect(landed.id, { electedAt: tnDays(-10), start: tnDays(-60), end: tnDays(-1) });

  await sweepTwoNotice({ insurerIds: [insurerId] });
  await runOnce();

  const row = await policyRow(landed.id);
  assert.equal(row.default_state, 'two_notice_terminated');
  // Cover ends at the FROZEN instant, not at the moment the sweeper ran.
  assert.equal(new Date(row.two_notice_effective_at).toISOString(), tnDays(-1));
  const landedToken = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === row.daml_contract_id);
  assert.equal(new Date(landedToken.createArgument.coverageValidThrough).toISOString(), tnDays(-1));

  const history = await pool.query(
    `SELECT * FROM policy_status_history WHERE policy_id = $1 AND event_type = 'two_notice_termination'`,
    [landed.id]
  );
  assert.equal(history.rows.length, 1);
  assert.equal(history.rows[0].new_default_state, 'two_notice_terminated');
  assert.match(history.rows[0].reason, /1434\(4\)/);

  // After it lands, a loss is outside cover, with its own message.
  const lateReading = await insertTriggerReading(landed.id, -1);
  await runOnce();
  const late = (await pool.query('SELECT * FROM policy_events WHERE id = $1', [lateReading])).rows[0];
  assert.equal(late.status, 'failed');
  assert.match(late.error, /1434\(4\)/);
});

// v22. Once the elected termination has landed, the token is archived by
// the non-payment route -- queued by the two-notice sweeper's phase two, with
// the treatment a terminated token gets: not while a payout raised on it is
// open, and not before the last window before the effective instant has been
// evaluated. Before this, nothing archived such a token.
test('a two-notice-terminated token is archived once its payouts are resolved and its last window is evaluated', async () => {
  const archiveRows = async (policyId) => (await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'termination_archive'`, [policyId]
  )).rows;
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  await noticeThenPay(policy.id, tnDays(-50));
  await noticeThenPay(policy.id, tnDays(-20));
  await elect(policy.id, { electedAt: tnDays(-10), start: tnDays(-60), end: tnDays(-1) });

  // A loss before the effective instant is payable; its payout is still open
  // when the termination lands. Its window ends two days before that instant,
  // so its reading is outside the last window checked below.
  await insertTriggerReading(policy.id, -1, { eventEnd: tnDays(-3) });
  await runOnce();
  const payout = (await pool.query('SELECT * FROM payout_events WHERE policy_id = $1', [policy.id])).rows[0];
  assert.ok(payout, 'a loss before the elected termination takes effect must pay');

  // Phase one queues the landing; phase two finds nothing while it is elected.
  await sweepTwoNotice({ insurerIds: [insurerId] });
  assert.equal((await archiveRows(policy.id)).length, 0, 'elected, not yet terminated: no archive');
  await runOnce();
  assert.equal((await policyRow(policy.id)).default_state, 'two_notice_terminated');

  // An open payout keeps the token live.
  await sweepTwoNotice({ insurerIds: [insurerId] });
  assert.equal((await archiveRows(policy.id)).length, 0, 'the token must stay live while a payout on it is open');

  const settled = await reportOnPayout(payout, {
    action: 'settle',
    bankReference: 'TEST-REF-TWO-NOTICE',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Insured',
  });
  assert.equal(settled.status, 'done', settled.error ?? '');

  // An in-cover reading in the last window before the effective instant, with
  // no trigger_windows row, holds the archive -- the expiry sweeper's own test,
  // with two_notice_effective_at as the end. The rule is written onto the row
  // here only so the sweeper has a window to look at.
  const rule = { timezone: 'UTC', startHour: 0, aggregation: 'min' };
  await pool.query(
    `UPDATE policies SET event_window_timezone = $2, event_window_start_hour = $3, event_aggregation = $4 WHERE id = $1`,
    [policy.id, rule.timezone, rule.startHour, rule.aggregation]
  );
  const effective = new Date((await policyRow(policy.id)).two_notice_effective_at);
  const lastWindow = windowFor(new Date(effective.getTime() - 1), rule);
  const measuredAt = new Date(lastWindow.start.getTime() + Math.floor((effective.getTime() - lastWindow.start.getTime()) / 2));
  await pool.query(
    `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source)
     VALUES ($1,'TEST-COVERAGE','cell-test','TEMPERATURE_C',-1.0,$2,'dispatcher-fixture')`,
    [policy.id, measuredAt.toISOString()]
  );
  await sweepTwoNotice({ insurerIds: [insurerId] });
  assert.equal(
    (await archiveRows(policy.id)).length, 0,
    'the last window before the effective instant holds an in-cover reading it has not been evaluated on'
  );

  // Once nothing is left unevaluated there, it is queued, and the archive lands.
  await pool.query(`DELETE FROM oracle_readings WHERE policy_id = $1 AND source = 'dispatcher-fixture'`, [policy.id]);
  const liveCid = (await policyRow(policy.id)).daml_contract_id;
  await sweepTwoNotice({ insurerIds: [insurerId] });
  assert.equal((await archiveRows(policy.id)).length, 1);
  await runOnce();

  const [archive] = await archiveRows(policy.id);
  assert.equal(archive.status, 'done', archive.error ?? '');
  const row = await policyRow(policy.id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.daml_contract_id, null, 'the token is burned');
  assert.equal(row.default_state, 'two_notice_terminated', 'its own state stays on the record, not "terminated"');
  // v22: the contract ended at the frozen effective instant; the record
  // closed at the archive's ledger time, later.
  assert.equal(new Date(row.contract_ended_at).getTime(), effective.getTime());
  assert.ok(new Date(row.record_closed_at) > new Date(row.contract_ended_at));
  assert.ok(
    !(await ledgerContracts('Insurance.PolicyToken', 'PolicyToken')).some((c) => c.contractId === liveCid),
    'the token is no longer active on the ledger'
  );
  const history = await pool.query(
    `SELECT * FROM policy_status_history WHERE policy_id = $1 AND event_type = 'termination_archive'`, [policy.id]
  );
  assert.equal(history.rows.length, 1);
  assert.match(history.rows[0].reason, /elected termination took effect/);
});

test('the election is refused while a notice period is running', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  await noticeThenPay(policy.id, tnDays(-50));

  // A second notice, left running.
  await insertLifecycleEvent(policy.id, 'notice', { serviceDate: tnDays(-5) });
  await runOnce();
  assert.equal((await policyRow(policy.id)).default_state, 'grace_period');

  const refused = await elect(policy.id, { electedAt: tnDays(0), start: tnDays(-60), end: tnDays(30) });
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /notice period is running/i);
  // The default axis is untouched -- which is the whole point of refusing.
  assert.equal((await policyRow(policy.id)).default_state, 'grace_period');

  // Once payment resolves it, the right is available.
  await insertLifecycleEvent(policy.id, 'reinstatement', {});
  await runOnce();
  const ok = await elect(policy.id, { electedAt: tnDays(0), start: tnDays(-60), end: tnDays(30) });
  assert.equal(ok.status, 'done', ok.error ?? '');
});

test('a policy already terminated under m. 1434(3) cannot be elected under (4)', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  await noticeThenPay(policy.id, tnDays(-50));

  // The second notice runs its 14 fixture days unpaid, so (3) ends the contract.
  await insertLifecycleEvent(policy.id, 'notice', { serviceDate: tnDays(-30) });
  await runOnce();
  await insertLifecycleEvent(policy.id, 'termination', {});
  await runOnce();
  assert.equal((await policyRow(policy.id)).default_state, 'terminated');

  const refused = await elect(policy.id, { electedAt: tnDays(0), start: tnDays(-60), end: tnDays(30) });
  assert.equal(refused.status, 'failed');
  assert.equal((await policyRow(policy.id)).default_state, 'terminated', 'still (3), not (4)');
});

test('payment in the interval does not defeat the elected termination', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  await noticeThenPay(policy.id, tnDays(-50));
  await noticeThenPay(policy.id, tnDays(-20));
  await elect(policy.id, { electedAt: tnDays(0), start: tnDays(-60), end: tnDays(30) });

  // There is nothing to pay -- the debt was cleared each time, which is why
  // (4) is reachable at all. A reinstatement has nothing to act on and is
  // refused, and the election stands.
  await insertLifecycleEvent(policy.id, 'reinstatement', {});
  await runOnce();
  assert.equal((await eventRow(policy.id, 'reinstatement')).status, 'failed');

  const row = await policyRow(policy.id);
  assert.equal(row.default_state, 'two_notice_elected');
  assert.ok(row.two_notice_election_at);
});

test('substitution does not reset the notice count', async () => {
  const ettiren = await createPolicyholder();
  const sigortali = await createPerson('sigortali');
  const policy = await createForAnothersAccount(ettiren.id, sigortali.id);
  await activate(policy.id);
  await runOnce();
  await noticeThenPay(policy.id, tnDays(-50));
  await noticeThenPay(policy.id, tnDays(-20));

  await insertLifecycleEvent(policy.id, 'enforcement_fruitless', {
    fruitlessAt: tnDays(-15), route: 'ER_Takip',
  });
  await runOnce();
  await insertLifecycleEvent(policy.id, 'substitution_notice', { notifiedAt: tnDays(-12) });
  await runOnce();
  await insertLifecycleEvent(policy.id, 'substitution', { substitutedAt: tnDays(-11) });
  await runOnce();

  const row = await policyRow(policy.id);
  assert.equal(row.policyholder_id, sigortali.id, 'the party moved');
  // Both survive it, untouched. The contrary reading is an open legal question.
  assert.equal(row.notice_count, 2);
  assert.equal(row.notice_service_dates.length, 2);

  const ok = await elect(policy.id, { electedAt: tnDays(0), start: tnDays(-60), end: tnDays(30) });
  assert.equal(ok.status, 'done', ok.error ?? '');
});

test('the sweeper leaves an expired policy alone -- both facts stay recorded', async () => {
  const ph = await createPolicyholder();
  // v22: the TOKEN's term has to have ended for the expiry archive to
  // be accepted, so the policy is minted with an end date already past; the
  // UPDATE below still aligns the SQL row as before.
  const policy = await createPolicy(ph.id, { endDate: tnDays(-1).slice(0, 10) });
  await activate(policy.id);
  await runOnce();
  await noticeThenPay(policy.id, tnDays(-50));
  await noticeThenPay(policy.id, tnDays(-20));
  await elect(policy.id, { electedAt: tnDays(-10), start: tnDays(-60), end: tnDays(-1) });

  // The term ends first and the token burns by expiry.
  // Two things this fixture has to respect: end_date is a DATE while expiry
  // is a TIMESTAMPTZ, so one bound parameter cannot serve both; and the
  // table's own CHECK refuses an end before the start, so the start moves
  // with it.
  await pool.query(
    `UPDATE policies SET start_date = $3::date, end_date = $2::date,
       expiry = $2::timestamptz WHERE id = $1`,
    [policy.id, tnDays(-1), tnDays(-200)]
  );
  await insertExpiryEvent(policy.id);
  await runOnce();
  assert.equal((await policyRow(policy.id)).status, 'expired');

  // The contract ended by its own term; m. 1434(4) has nothing left to
  // terminate. The sweeper does not touch it, and BOTH facts remain.
  await sweepTwoNotice({ insurerIds: [insurerId] });
  const row = await policyRow(policy.id);
  assert.equal(row.status, 'expired', 'the claim axis');
  assert.equal(row.default_state, 'two_notice_elected', 'the default axis, elected but overtaken');
  assert.ok(row.two_notice_election_at, 'the election is still on the record');
  const queued = await pool.query(
    `SELECT count(*)::int n FROM policy_events WHERE policy_no = $1 AND event_type = 'two_notice_termination'`,
    [policy.id]
  );
  assert.equal(queued.rows[0].n, 0, 'never queued');
});

// ---------------------------------------------------------------------------
// m. 1457: attachment of the insured property
// ---------------------------------------------------------------------------
//
// The fourth recipient, and the only one nobody designates. Recorded per
// coverage, which is an approximation -- the article attaches to the property
// and this system has no property registry.

const ATT_BASE = Date.now();
const attDays = (n) => new Date(ATT_BASE + n * 86400000).toISOString();

async function attach(policyId, coverageCode, attachedAt) {
  await insertLifecycleEvent(policyId, 'attachment', { coverageCode, attachedAt });
  await runOnce();
  return eventRow(policyId, 'attachment');
}

async function lift(policyId, coverageCode, liftedAt) {
  await insertLifecycleEvent(policyId, 'attachment_lifted', { coverageCode, liftedAt });
  await runOnce();
  return eventRow(policyId, 'attachment_lifted');
}

async function coverageRow(policyId) {
  const { rows } = await pool.query(
    `SELECT * FROM policy_coverages WHERE policy_id = $1 AND coverage_code = 'TEST-COVERAGE'`,
    [policyId]
  );
  return rows[0];
}

async function payoutRowsFor(policyId) {
  const { rows } = await pool.query(
    'SELECT * FROM payout_events WHERE policy_id = $1 ORDER BY created_at ASC, id ASC',
    [policyId]
  );
  return rows;
}

test('an attachment routes a later payout to the enforcement office', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  // Before: the ordinary path.
  await insertTriggerReading(policy.id, -1);
  await runOnce();
  let rows = await payoutRowsFor(policy.id);
  assert.equal(rows[0].recipient, 'PDR_Insured');

  const ev = await attach(policy.id, 'TEST-COVERAGE', attDays(-5));
  assert.equal(ev.status, 'done', ev.error ?? '');
  const cov = await coverageRow(policy.id);
  assert.equal(new Date(cov.attached_at).toISOString(), attDays(-5));
  assert.equal(cov.attachment_lifted_at, null);

  // After: the icra müdürlüğü.
  await insertTriggerReading(policy.id, -1);
  await runOnce();
  rows = await payoutRowsFor(policy.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].recipient, 'PDR_EnforcementOffice');
  assert.equal(rows[1].record_kind, 'payout');

  const current = await policyRow(policy.id);
  const token = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken'))
    .find((c) => c.contractId === current.daml_contract_id);
  assert.equal(new Date(token.createArgument.coverages[0].attachedAt).toISOString(), attDays(-5));

  const payout = (await ledgerContracts('Insurance.PayoutBridge', 'PayoutApproved'))
    .find((c) => c.contractId === rows[1].daml_contract_id);
  assert.equal(payout.createArgument.recipient, 'PDR_EnforcementOffice');
  // The exemption: the policy never designated this role and could not have.
  assert.deepEqual(payout.createArgument.payoutDestination, ['PDR_Insured']);
});

test('a charged AND attached coverage routes nothing, and says why', async () => {
  const ph = await createPolicyholder();
  const bank = await createPerson('bank');
  const policy = await createPolicyWithRoles(ph.id, {
    mortgageeId: bank.id,
    claimAmounts: { 'TEST-COVERAGE': 5000 },
  });
  await activate(policy.id);
  await runOnce();
  await attach(policy.id, 'TEST-COVERAGE', attDays(-5));

  await insertTriggerReading(policy.id, -1);
  await runOnce();

  const rows = await payoutRowsFor(policy.id);
  assert.equal(rows.length, 1, 'one row, and it is not a payout');
  assert.equal(rows[0].record_kind, 'unrouted_competing_claims');
  assert.equal(rows[0].recipient, null, 'nobody has decided who it goes to');
  assert.equal(rows[0].daml_contract_id, null, 'no PayoutApproved exists');
  assert.equal(rows[0].status, 'manual_review');
  assert.equal(Number(rows[0].payout_amount), 2500, 'the WHOLE indemnity, not a share');

  // No PayoutApproved on the ledger for this policy at all.
  const approved = (await ledgerContracts('Insurance.PayoutBridge', 'PayoutApproved'))
    .filter((c) => c.createArgument.policyId === policy.id);
  assert.equal(approved.length, 0);

  const review = (await ledgerContracts('Insurance.PayoutBridge', 'ManualReviewRequired'))
    .find((c) => c.contractId === rows[0].review_contract_id);
  assert.match(review.createArgument.reason, /1456 and m\. 1457/);
  assert.match(review.createArgument.reason, /Icra ve Iflas Kanunu/);

  // And the claim is NOT decremented -- nothing was routed to the bank.
  assert.equal(Number((await coverageRow(policy.id)).mortgagee_claim_amount), 5000);
});

test('lifting restores normal routing, and an attachment can be re-imposed', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  await attach(policy.id, 'TEST-COVERAGE', attDays(-30));

  // Attaching twice is refused: there is one attachment or none.
  const twice = await attach(policy.id, 'TEST-COVERAGE', attDays(-20));
  assert.equal(twice.status, 'failed');
  assert.match(twice.error, /already under attachment/i);

  // A lifting cannot predate the attachment it ends.
  const early = await lift(policy.id, 'TEST-COVERAGE', attDays(-40));
  assert.equal(early.status, 'failed');
  assert.match(early.error, /cannot be lifted before/i);

  assert.equal((await lift(policy.id, 'TEST-COVERAGE', attDays(-20))).status, 'done');
  await insertTriggerReading(policy.id, -1);
  await runOnce();
  let rows = await payoutRowsFor(policy.id);
  assert.equal(rows[rows.length - 1].recipient, 'PDR_Insured', 'routing is normal again');

  // Re-imposed. Both dates survive: a lifting OLDER than the attachment in
  // front of it is how "attached again" is expressed.
  assert.equal((await attach(policy.id, 'TEST-COVERAGE', attDays(-10))).status, 'done');
  const cov = await coverageRow(policy.id);
  assert.equal(new Date(cov.attached_at).toISOString(), attDays(-10));
  assert.equal(new Date(cov.attachment_lifted_at).toISOString(), attDays(-20));
  assert.ok(new Date(cov.attachment_lifted_at) < new Date(cov.attached_at));

  await insertTriggerReading(policy.id, -1);
  await runOnce();
  rows = await payoutRowsFor(policy.id);
  assert.equal(rows[rows.length - 1].recipient, 'PDR_EnforcementOffice');
});

test('a settlement to the original recipient on an attached coverage is refused', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  // Approved FIRST, attached afterwards -- the case the refusal exists for.
  await insertTriggerReading(policy.id, -1);
  await runOnce();
  const [payout] = await payoutRowsFor(policy.id);
  assert.equal(payout.recipient, 'PDR_Insured');

  await attach(policy.id, 'TEST-COVERAGE', attDays(-1));

  const refused = await reportOnPayout(payout, {
    action: 'settle',
    bankReference: 'REF-TO-INSURED',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Insured',
  });
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /under attachment/i);
  assert.match(refused.error, /not redirected/i);
  // The obligation is untouched: refusing asserts nothing, it declines.
  const after = await reloadPayout(payout.id);
  assert.equal(after.status, 'approved');
  assert.equal(after.recipient, 'PDR_Insured');

  // Once lifted, the original report is accepted again.
  await lift(policy.id, 'TEST-COVERAGE', attDays(0));
  const accepted = await reportOnPayout(payout, {
    action: 'settle',
    bankReference: 'REF-TO-INSURED',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Insured',
  });
  assert.equal(accepted.status, 'done', accepted.error ?? '');
  assert.equal((await reloadPayout(payout.id)).status, 'settled');
});

test('an enforcement-office payout settles as its own recipient', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  await attach(policy.id, 'TEST-COVERAGE', attDays(-5));
  await insertTriggerReading(policy.id, -1);
  await runOnce();
  const [payout] = await payoutRowsFor(policy.id);
  assert.equal(payout.recipient, 'PDR_EnforcementOffice');

  // The v17 recipient check still governs.
  const wrong = await reportOnPayout(payout, {
    action: 'settle',
    bankReference: 'REF-WRONG',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Insured',
  });
  assert.equal(wrong.status, 'failed');

  const ok = await reportOnPayout(payout, {
    action: 'settle',
    bankReference: 'REF-ICRA-1',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_EnforcementOffice',
  });
  assert.equal(ok.status, 'done', ok.error ?? '');
  const settled = await reloadPayout(payout.id);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.paid_role, 'PDR_EnforcementOffice');
});

test('a policy with no attachment is completely unchanged', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  const cov = await coverageRow(policy.id);
  assert.equal(cov.attached_at, null);
  assert.equal(cov.attachment_lifted_at, null);

  await insertTriggerReading(policy.id, -1);
  await runOnce();
  const rows = await payoutRowsFor(policy.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipient, 'PDR_Insured');
  assert.equal(rows[0].record_kind, 'payout');

  // Lifting something that was never attached is refused.
  const nothing = await lift(policy.id, 'TEST-COVERAGE', attDays(0));
  assert.equal(nothing.status, 'failed');
  assert.match(nothing.error, /not under attachment/i);
});

test('an attachment names a coverage, and an unknown one is refused', async () => {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();

  const unknown = await attach(policy.id, 'NOT-A-COVERAGE', attDays(-5));
  assert.equal(unknown.status, 'failed');
  assert.match(unknown.error, /unknown coverage/i);
  assert.equal((await coverageRow(policy.id)).attached_at, null);
});

// ---------------------------------------------------------------------------
// m. 1457: which report types an attachment blocks, and which it does not
// ---------------------------------------------------------------------------
//
// THE RULE: the refusal guards PAYMENT, not the recording of non-payment.
// Both of m. 1457's sentences turn on ödemek -- "ödeyerek borcundan kurtulur",
// "ancak icra müdürlüğüne ödenilmesiyle borçtan kurtulacağını" -- so the
// article speaks only to what discharges. A failure report or an unpaid
// closure asserts that no payment was made, which the article does not touch,
// and blocking either would leave the obligation with no legible outcome.
//
// Five paths, one test each.

// A policy whose payout was approved BEFORE the coverage was attached -- the
// only shape in which these questions arise, since a payout raised after an
// attachment is owed to the enforcement office already.
async function approvedThenAttached() {
  const ph = await createPolicyholder();
  const policy = await createPolicy(ph.id);
  await activate(policy.id);
  await runOnce();
  await insertTriggerReading(policy.id, -1);
  await runOnce();
  const [payout] = await payoutRowsFor(policy.id);
  assert.equal(payout.recipient, 'PDR_Insured');
  await attach(policy.id, 'TEST-COVERAGE', attDays(-1));
  return { policy, payout };
}

test('m. 1457 refuses a SETTLE report on an attached coverage', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const { payout } = await approvedThenAttached();
  const ev = await reportOnPayout(payout, {
    action: 'settle',
    bankReference: 'REF-1',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Insured',
  });
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /under attachment/i);
  assert.equal((await reloadPayout(payout.id)).status, 'approved', 'the obligation is untouched');
});

test('m. 1457 PERMITS a failure report on an attached coverage', async () => {
  const { payout } = await approvedThenAttached();
  // The insurer says it could not pay. That records NO discharge, so m. 1457
  // has nothing to say about it -- and blocking it would leave the obligation
  // with no legible outcome at all.
  const ev = await reportOnPayout(payout, {
    action: 'fail',
    failureReason: 'payee could not be reached',
  });
  assert.equal(ev.status, 'done', ev.error ?? '');
  const after = await reloadPayout(payout.id);
  assert.equal(after.status, 'manual_review');
  assert.ok(after.review_contract_id, 'and it has somewhere to go');
});

test('m. 1457 PERMITS closing a review item unpaid on an attached coverage', async () => {
  const { payout } = await approvedThenAttached();
  await reportOnPayout(payout, { action: 'fail', failureReason: 'payee could not be reached' });
  const inReview = await reloadPayout(payout.id);

  const ev = await reportOnPayout(inReview, {
    action: 'resolve_unpaid',
    unpaidReason: 'UR_Other',
    note: 'the icra file is unresolved; nothing was paid to anyone',
    closedAt: new Date().toISOString(),
  });
  assert.equal(ev.status, 'done', ev.error ?? '');
  const after = await reloadPayout(payout.id);
  assert.equal(after.status, 'closed_unpaid');
  assert.ok(after.resolved_at);
});

test('m. 1457 refuses RESOLVE-SETTLED on an attached coverage -- the same discharge by another door', async () => {
  const { payout } = await approvedThenAttached();
  await reportOnPayout(payout, { action: 'fail', failureReason: 'payee could not be reached' });
  const inReview = await reloadPayout(payout.id);
  assert.equal(inReview.status, 'manual_review');

  // Same money, same coverage, same assertion that the insurer paid --
  // reached through ManualReviewRequired_ResolveSettled instead of
  // PayoutApproved_ConfirmSettlement. It must be refused for the same reason.
  const ev = await reportOnPayout(inReview, {
    action: 'resolve_settled',
    bankReference: 'REF-VIA-REVIEW',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Insured',
  });
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /under attachment/i);
  assert.equal((await reloadPayout(payout.id)).status, 'manual_review', 'still open, still unresolved');
});

test('lifting the attachment reopens both discharge paths', async () => {
  const { policy, payout } = await approvedThenAttached();
  await reportOnPayout(payout, { action: 'fail', failureReason: 'payee could not be reached' });
  const inReview = await reloadPayout(payout.id);

  assert.equal(
    (await reportOnPayout(inReview, {
      action: 'resolve_settled',
      bankReference: 'REF-BEFORE-LIFT',
      settledAt: new Date().toISOString(),
      paidRole: 'PDR_Insured',
    })).status,
    'failed'
  );

  await lift(policy.id, 'TEST-COVERAGE', attDays(0));
  const ev = await reportOnPayout(inReview, {
    action: 'resolve_settled',
    bankReference: 'REF-AFTER-LIFT',
    settledAt: new Date().toISOString(),
    paidRole: 'PDR_Insured',
  });
  assert.equal(ev.status, 'done', ev.error ?? '');
  const after = await reloadPayout(payout.id);
  assert.equal(after.status, 'settled');
  assert.equal(after.paid_role, 'PDR_Insured');
});

// A pure conversion, so it needs neither the ledger nor the database; it sits
// here because it is dispatcher.js's, and pays for this file's before().
// Date.UTC reads a year from 0 to 99 as 1900 + year, and the term instant was
// built with it, so a DATE of 0026-09-12 was minted in 1926.
test('a term date in year 0026 becomes an instant in year 0026, not 1926', () => {
  assert.equal(policyTermInstant('0026-09-12').slice(0, 10), '0026-09-12');
  // The way activation gets there: pg's own DATE parser, then the dispatcher's.
  const stored = pg.types.getTypeParser(1082)('0026-09-12');
  assert.equal(policyTermInstant(pgDateToDateString(stored)).slice(0, 10), '0026-09-12');
  assert.equal(policyTermInstant('2026-09-12'), '2026-09-12T09:00:00.000Z', 'noon in Istanbul, unchanged');
});

// --- scripts/findOutboxCommand.mjs --------------------------------------------
//
// The lookup a human runs on a row left in `processing`, run the way a human
// runs it: in a process of its own, reading the database this file's guard
// pointed DATABASE_URL at. In this file rather than one of its own because
// FOUND needs a real mint by an insurer the participant has granted, and this
// file already allocates one; a file of its own would grant a second
// insurer/oracle pair on every run. Its grants could be revoked the way this
// file's are (after() calls revokeFixtureRights), but its parties would stay.

const FIND_OUTBOX_COMMAND = fileURLToPath(new URL('../../scripts/findOutboxCommand.mjs', import.meta.url));

function findOutboxCommand(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIND_OUTBOX_COMMAND, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => {
      // Printed whole: this output is what a human would act on.
      console.log(`[findOutboxCommand ${args.join(' ')}] exit ${status}\n${stdout}${stderr}`);
      resolve({ status, stdout, stderr });
    });
  });
}

async function outboxRow(policyId, eventType) {
  const { rows } = await pool.query(
    'SELECT id, status FROM policy_events WHERE policy_no = $1 AND event_type = $2',
    [policyId, eventType]
  );
  return rows[0];
}

// pending -> processing by hand, and no dispatcher: the row a process leaves
// when it exits after claiming a row and before submitting anything.
async function claimedWithoutSubmitting(policyId, eventType) {
  const { rows } = await pool.query(
    'INSERT INTO policy_events (policy_no, event_type, expected_version) VALUES ($1, $2, $3) RETURNING id',
    [policyId, eventType, eventType === 'activation' ? 0 : null]
  );
  await pool.query(`UPDATE policy_events SET status = 'processing' WHERE id = $1`, [rows[0].id]);
  return rows[0].id;
}

test('findOutboxCommand: a mint that landed while its row is still processing is FOUND, with the token\'s contract id', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const offsetBefore = await getLedgerEnd();
  const policy = await createPolicy((await createPolicyholder()).id);
  await activate(policy.id);
  const eventId = (await outboxRow(policy.id, 'activation')).id;

  // A row lock on the policy lets the dispatcher claim the row and mint, and
  // holds its write-back at its first statement, the UPDATE of that policy:
  // the row is `processing`, committed, and its ledger call has landed --
  // what a process that exits at that moment leaves behind. FOR NO KEY UPDATE
  // conflicts with that UPDATE, not with the key-share lock an insert that
  // references the policy takes.
  const holder = await pool.connect();
  let dispatching;
  let waiting = 0;
  let during;
  let tokens;
  let found;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM policies WHERE id = $1 FOR NO KEY UPDATE', [policy.id]);
    dispatching = runOnce();
    for (const started = Date.now(); Date.now() - started < 30000; await new Promise((r) => setTimeout(r, 100))) {
      waiting = (
        await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`
        )
      ).rows[0].n;
      if (waiting >= 1) break;
    }
    during = await outboxRow(policy.id, 'activation');
    tokens = (await ledgerContracts('Insurance.PolicyToken', 'PolicyToken')).filter(
      (c) => c.createArgument.policyNo === policy.id
    );
    found = await findOutboxCommand([eventId, '--from-offset', String(offsetBefore)]);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await dispatching;
  }

  assert.equal(waiting, 1, 'the write-back was waiting on the policy row');
  assert.equal(during.status, 'processing');
  assert.equal(tokens.length, 1, 'one token for this policy on the ledger, read as the insurer');
  assert.equal(found.status, 0, found.stderr);
  assert.ok(found.stdout.includes(`command id create-${eventId}`), 'the id the dispatcher submitted');
  assert.match(found.stdout, /\n {2}FOUND at offset \d+, updateId \S+, recordTime \S+/);
  assert.ok(found.stdout.includes(`    created ${tokens[0].contractId} `), 'the contract it reports is the token on the ledger');
  assert.match(found.stdout, /next: the contract is on the ledger\. Mark the row failed/);
  // Once the lock is gone the write-back finishes, naming the same contract.
  const after = (
    await pool.query('SELECT status, resulting_contract_id FROM policy_events WHERE id = $1', [eventId])
  ).rows[0];
  assert.deepEqual([after.status, after.resulting_contract_id], ['done', tokens[0].contractId]);
});

test('findOutboxCommand: a processing row that never submitted is NOT FOUND, over a range holding this insurer\'s own mint', async () => {
  const offsetBefore = await getLedgerEnd();
  // A mint inside the range, so the NOT FOUND below comes from reading this
  // insurer's transactions rather than from a range with nothing in it.
  const minted = await createPolicy((await createPolicyholder()).id);
  await activate(minted.id);
  await runOnce();
  assert.equal((await outboxRow(minted.id, 'activation')).status, 'done');
  const policy = await createPolicy((await createPolicyholder()).id);
  const eventId = await claimedWithoutSubmitting(policy.id, 'activation');

  const result = await findOutboxCommand([eventId, '--from-offset', String(offsetBefore)]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`command id create-${eventId}`));
  const line = result.stdout.match(/\n {2}NOT FOUND in scanned range \((\d+), (\d+)\]: (\d+) transaction\(s\) in it visible/);
  assert.ok(line, 'a NOT FOUND line naming its range');
  assert.equal(Number(line[1]), offsetBefore);
  assert.ok(Number(line[3]) >= 1, 'the range held at least the mint above');
  assert.doesNotMatch(result.stdout, /FOUND at offset|CANNOT SEARCH:/);
  assert.match(result.stdout, /next: widen the range \(--from-offset, --max-offsets\) or mark the row failed/);
  assert.equal((await outboxRow(policy.id, 'activation')).status, 'processing', 'the script wrote nothing');
});

test('findOutboxCommand: CANNOT SEARCH for a release row, which submits nothing, and for a ledger that does not answer', async () => {
  const policy = await createPolicy((await createPolicyholder()).id);
  const releaseId = await claimedWithoutSubmitting(policy.id, 'release');
  const activationId = await claimedWithoutSubmitting(policy.id, 'activation');

  // No id: every processing row, these two among them.
  const all = await findOutboxCommand([]);
  assert.equal(all.status, 1, 'a row that could not be searched makes the run exit 1');
  const block = (id) => all.stdout.split('\nrow ').find((b) => b.startsWith(id)) ?? '';
  assert.match(block(releaseId), /\n {2}CANNOT SEARCH: event type release submits no ledger command/);
  assert.doesNotMatch(block(releaseId), /NOT FOUND in scanned range|FOUND at offset/);
  assert.match(block(activationId), /\n {2}NOT FOUND in scanned range/, 'the other row was still searched');

  // A port nothing listens on: the search does not run, and the result says
  // that rather than NOT FOUND.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const down = await findOutboxCommand([activationId], { DAML_JSON_API_URL: `http://127.0.0.1:${port}` });
  assert.equal(down.status, 1);
  assert.match(down.stdout, /no range: the ledger did not answer GET \/v2\/state\/ledger-end/);
  assert.match(down.stdout, /\n {2}CANNOT SEARCH: the ledger did not answer GET \/v2\/state\/ledger-end/);
  assert.doesNotMatch(down.stdout, /NOT FOUND in scanned range|FOUND at offset/);

  const statuses = (
    await pool.query('SELECT status FROM policy_events WHERE id = ANY($1)', [[releaseId, activationId]])
  ).rows.map((r) => r.status);
  assert.deepEqual(statuses, ['processing', 'processing'], 'the script wrote nothing');
});

// --- the roles page (debug, loopback-only) -------------------
//
// One minted policy with a mortgagee, read through /debug/roles-data as each
// party. The page shows what the LEDGER returns to each party, so these read the
// ledger too: a column is only right if the participant said so.

let rolesServer;
let rolesBase;

async function rolesApi(method, path, body) {
  if (!rolesServer) {
    const app = createApp({
      probeDatabase: async () => true,
      probeLedger: async () => true,
      processDegraded: () => null,
      debugRoutes: 'true',
    });
    rolesServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => rolesServer.once('listening', resolve));
    rolesBase = `http://127.0.0.1:${rolesServer.address().port}/debug`;
  }
  const res = await fetch(`${rolesBase}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

after(() => rolesServer?.close());

const rightsHeld = async () => (await listUserRights(config.daml.unsafeJwtSub)).length;

// A second onboarded insurer, the outsider: allocated and granted a CanActAs as
// onboardInsurer.js would, so reading as it needs no temporary right. Its row is
// removed by the test that made it; its party stays, like every party a run
// allocates.
async function createOutsiderInsurer() {
  const party = await allocateParty(
    'Test Outsider Insurer (dispatcher.test.mjs)',
    `test-outsider-insurer-${crypto.randomUUID()}`,
    { grantActAs: true }
  );
  grantedActAs.push(party);
  const { rows } = await pool.query(
    `INSERT INTO insurers (legal_name, api_key_hash, canton_party_id, canton_party_status)
     VALUES ('Test Outsider Insurer Ltd (fixture, fake)', $1, $2, 'ALLOCATED') RETURNING id`,
    [crypto.randomBytes(16).toString('hex'), party]
  );
  return { id: rows[0].id, party };
}

async function mintedWithMortgagee() {
  const ph = await createPolicyholder();
  const bank = await createPerson('roles-bank');
  const policy = await createPolicyWithRoles(ph.id, { mortgageeId: bank.id });
  await activate(policy.id);
  await runOnce();
  const { rows: [row] } = await pool.query('SELECT status FROM policies WHERE id = $1', [policy.id]);
  assert.equal(row.status, 'active', 'the fixture minted');
  const parties = (
    await pool.query(
      `SELECT canton_party_id AS p FROM policyholders WHERE id = ANY($1)
       UNION SELECT canton_party_id FROM insurers WHERE id = $2
       UNION SELECT oracle_operator_party FROM insurers WHERE id = $2`,
      [[ph.id, bank.id], insurerId]
    )
  ).rows.map((r) => r.p);
  assert.equal(parties.filter(Boolean).length, 4, 'policyholder, mortgagee, insurer and oracle operator each hold a party');
  return { policy, parties };
}

test('roles-data: four roles, each as the ledger returns it; holder and observer see the token, the outsider sees nothing, and no full party id leaves', async () => {
  await archiveFixtureContracts(); // the earlier sections' contracts: see the note after archiveFixtureContracts
  const outsider = await createOutsiderInsurer();
  try {
    const { policy, parties } = await mintedWithMortgagee();
    const before = await rightsHeld();
    const { status, text, body } = await rolesApi('GET', `/roles-data?policyId=${policy.id}`);
    const after = await rightsHeld();
    console.log(`[roles-data] rights held by ${config.daml.unsafeJwtSub}: ${before} before, ${after} after; response rightsBefore=${body.rightsBefore} rightsAfter=${body.rightsAfter}`);

    assert.equal(status, 200, text);
    assert.deepEqual(body.roles.map((r) => r.role), ['issuer', 'holder', 'observer', 'outsider']);
    const role = (name) => body.roles.find((r) => r.role === name);
    for (const name of ['issuer', 'holder', 'observer']) {
      assert.equal(role(name).error ?? null, null, `${name}: ${role(name).error}`);
      assert.ok(role(name).contracts.some((c) => c.template === 'PolicyToken'), `${name} sees the PolicyToken`);
    }
    assert.equal(role('outsider').error ?? null, null, role('outsider').error);
    assert.equal(role('outsider').contracts.length, 0, 'the outsider was asked and the ledger returned nothing');
    assert.ok(role('outsider').queries.length > 0, 'the outsider count is a query result, not an assumption');

    assert.equal(body.rightsBefore, body.rightsAfter, 'every temporary read right was taken back');
    assert.equal(after, before, 'the ledger user holds as many rights as before the request');
    assert.equal(role('holder').readAccess.granted, true, 'the holder was read through a temporary right');
    assert.equal(role('outsider').readAccess.granted, false, 'the outsider insurer already holds a CanActAs');

    for (const party of [...parties, outsider.party]) {
      assert.ok(!text.includes(party), `${party.split('::')[0]} appears in full in the response`);
    }

    const list = await rolesApi('GET', '/roles-data');
    assert.equal(list.status, 200);
    assert.ok(list.body.policies.some((p) => p.policyId === policy.id), 'the minted policy is offered for selection');
  } finally {
    await pool.query('DELETE FROM insurers WHERE id = $1', [outsider.id]);
  }
});

test('roles-data: a read that fails after its right was granted still takes the right back', async () => {
  const { policy } = await mintedWithMortgagee();
  const { rows: [ph] } = await pool.query(
    'SELECT canton_party_id FROM policyholders WHERE id = (SELECT policyholder_id FROM policies WHERE id = $1)',
    [policy.id]
  );
  const before = await rightsHeld();
  const result = await readPolicyAsRoles(policy.id, {
    query: async (args) => {
      if (args.parties.includes(ph.canton_party_id)) throw new Error('injected read failure (test)');
      return queryActiveContracts(args);
    },
  });
  const after = await rightsHeld();
  console.log(`[roles-data, injected failure] rights held by ${config.daml.unsafeJwtSub}: ${before} before, ${after} after; result rightsBefore=${result.rightsBefore} rightsAfter=${result.rightsAfter}`);

  const holder = result.roles.find((r) => r.role === 'holder');
  assert.equal(holder.readAccess.granted, true, 'the right was granted before the read failed, so there was something to take back');
  assert.match(holder.error, /injected read failure/);
  assert.equal(after, before);
  assert.equal(result.rightsAfter, result.rightsBefore);
});

test('roles-data: of two requests at once, the second is turned away by the lock', async () => {
  const { policy } = await mintedWithMortgagee();
  const before = await rightsHeld();
  const answers = await Promise.all([
    rolesApi('GET', `/roles-data?policyId=${policy.id}`),
    rolesApi('GET', `/roles-data?policyId=${policy.id}`),
  ]);
  const after = await rightsHeld();
  console.log(`[roles-data, two at once] statuses ${answers.map((a) => a.status).join(', ')}; rights held ${before} before, ${after} after`);
  assert.deepEqual(answers.map((a) => a.status).sort(), [200, 409]);
  assert.equal(answers.find((a) => a.status === 409).body.error, 'another roles read is in progress');
  assert.equal(after, before);
});

test('try-insurer-trigger: the ledger refuses the insurer, and nothing changes on the ledger or in SQL', async () => {
  const { policy, parties } = await mintedWithMortgagee();
  const tables = ['policy_events', 'attested_evidence', 'oracle_readings'];
  const counts = async () => {
    const out = {};
    for (const t of tables) out[t] = (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    return out;
  };
  const contractSet = async () => {
    const ids = [];
    for (const [moduleName, entityName, field] of [
      ['Insurance.PolicyToken', 'PolicyToken', 'policyNo'],
      ['Insurance.PayoutBridge', 'PayoutApproved', 'policyId'],
      ['Insurance.PayoutBridge', 'ManualReviewRequired', 'policyId'],
    ]) {
      for (const c of await ledgerContracts(moduleName, entityName)) {
        if (c.createArgument[field] === policy.id) ids.push(c.contractId);
      }
    }
    return ids.sort();
  };

  const countsBefore = await counts();
  const setBefore = await contractSet();
  const { status, text, body } = await rolesApi('POST', '/roles/try-insurer-trigger', { policyId: policy.id });
  const countsAfter = await counts();
  const setAfter = await contractSet();
  console.log(`[try-insurer-trigger] ${status} ${text}`);

  assert.equal(status, 200, text);
  assert.equal(body.refused, true);
  assert.ok(body.ledgerStatus, 'the ledger\'s own status is passed on');
  assert.equal(body.oracleOperatorDistinctFromInsurer, true);
  assert.equal(setBefore.length, 1, 'the fixture holds one token');
  assert.deepEqual(setAfter, setBefore, 'the same contracts, the same ids');
  assert.deepEqual(countsAfter, countsBefore, 'no outbox row, no evidence row, no reading');
  for (const party of parties) {
    assert.ok(!text.includes(party), `${party.split('::')[0]} appears in full in the response`);
  }
});
