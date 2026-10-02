import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { allocateParty, queryActiveContracts, exerciseChoice, revokeUserRights } from '../src/damlClient.js';
import { runOnce } from '../src/dispatch/dispatcher.js';
import { insertWindowedTrigger, deleteWindowedTriggerRows } from '../test-support/windowedTrigger.mjs';
import { archiveContract, teardownRun } from '../../scripts/lib/policyTeardown.mjs';

// verify-all's teardown (scripts/runVerifications.mjs, through teardownRun in
// scripts/lib/policyTeardown.mjs), against a simulated run on the real ledger:
// the run's insurer mints a policy and pays on it; meanwhile an unrelated
// insurer mints one of its own, and an OLDER policy of the run's insurer -- a
// demo, say -- pays and re-mints. Only the run's own policy may be taken back.

const granted = [];
const fixtureInsurerIds = [];
const fixturePolicyIds = [];
const fixtureRawResponseIds = [];

const DOCUMENT_HASH = crypto.createHash('sha256').update('verifyTeardown test policy document').digest('hex');
const TEMPLATES = [
  ['Insurance.PolicyToken', 'PolicyToken'],
  ['Insurance.PayoutBridge', 'PayoutApproved'],
  ['Insurance.PayoutBridge', 'ManualReviewRequired'],
  ['Insurance.PayoutBridge', 'PayoutSettled'],
  ['Insurance.PayoutBridge', 'PayoutClosedUnpaid'],
];

async function makeInsurer(label) {
  const party = await allocateParty(`Test Insurer (verifyTeardown ${label})`, `test-insurer-${crypto.randomUUID()}`, { grantActAs: true });
  granted.push(party);
  const oracle = await allocateParty(
    `Test Oracle Operator (verifyTeardown ${label})`, `test-oracle-operator-${crypto.randomUUID()}`, { grantActAs: true }
  );
  granted.push(oracle);
  // 14 is a fixture value for this file only, as in dispatcher.test.mjs.
  const { rows: [row] } = await pool.query(
    `INSERT INTO insurers
       (legal_name, api_key_hash, canton_party_id, canton_party_status, oracle_operator_party, default_grace_period_days)
     VALUES ($1, $2, $3, 'ALLOCATED', $4, 14) RETURNING id`,
    [`Test Insurer Ltd (verifyTeardown ${label} fixture, fake)`, crypto.randomBytes(16).toString('hex'), party, oracle]
  );
  fixtureInsurerIds.push(row.id);
  await pool.query(
    `INSERT INTO payout_tiers
       (insurer_id, product_code, peril_type, tier_order, label, threshold_min, threshold_max, payout_percentage, shape)
     VALUES ($1, 'TEST-PRODUCT', 'TEST-PERIL', 1, 'test tier', -2.0, 0.0, 25.00, 'TS_Step')`,
    [row.id]
  );
  return { id: row.id, party };
}

// A minted policy on a cell of its own. `createdAt` pins formation for the
// policy that stands for one made before the run.
async function mintedPolicy(insurer, { createdAt } = {}) {
  const { rows: [ph] } = await pool.query(
    'INSERT INTO policyholders (insurer_id, external_ref) VALUES ($1, $2) RETURNING id',
    [insurer.id, `test-ref-${crypto.randomUUID()}`]
  );
  const cell = `verify-teardown-cell-${crypto.randomUUID()}`;
  // end_date is derived from today, not a literal, so the fixture's cover
  // window stays ahead of payOn's wall-clock trigger regardless of when the
  // suite runs (a hardcoded calendar date would eventually fall behind).
  const endDate = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { rows: [policy] } = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date, status,
        coverage_began_at, coverage_start_basis, document_hash, created_at)
     VALUES ($1,$2,500,'TRY','2026-09-01',$5,'pending_mint','2026-09-01','CSB_AgreedWithoutPayment',$3,
             COALESCE($4::timestamptz, now()))
     RETURNING id`,
    [insurer.id, ph.id, DOCUMENT_HASH, createdAt ?? null, endDate]
  );
  fixturePolicyIds.push(policy.id);
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL',$2,10000,10000,
       '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null}]',
       '["PDR_Insured"]','TEMPERATURE_C','PB_RemainingLimit')`,
    [policy.id, JSON.stringify([cell])]
  );
  await pool.query(`INSERT INTO policy_events (policy_no, event_type, expected_version) VALUES ($1, 'activation', 0)`, [policy.id]);
  await runOnce();
  const row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(row.status, 'active', 'the fixture policy must mint');
  return { ...row, cell };
}

// A payable window an hour long that ended a minute ago, inside cover.
async function payOn(policy) {
  const eventEnd = new Date(Date.now() - 60 * 1000);
  const { eventId, rawResponseId } = await insertWindowedTrigger(pool, {
    policyId: policy.id, coverageCode: 'TEST-COVERAGE', cellId: policy.cell, value: -1,
    eventStart: new Date(eventEnd.getTime() - 60 * 60 * 1000), eventEnd, expectedVersion: 1,
  });
  fixtureRawResponseIds.push(rawResponseId);
  await runOnce();
  const { rows: [ev] } = await pool.query('SELECT status, error FROM policy_events WHERE id = $1', [eventId]);
  assert.equal(ev.status, 'done', ev.error ?? '');
}

// Contract id -> what runVerifications.mjs keeps for each, read over parties.
async function contractsOf(parties) {
  const found = new Map();
  for (const [moduleName, entityName] of TEMPLATES) {
    for (const e of await queryActiveContracts({ moduleName, entityName, parties })) {
      const c = e.contractEntry.JsActiveContract.createdEvent;
      found.set(c.contractId, { templateId: c.templateId, signatories: c.signatories, createArgument: c.createArgument, entity: entityName });
    }
  }
  return found;
}
const ofPolicy = (contracts, policyId) =>
  [...contracts].filter(([, c]) => (c.createArgument.policyNo ?? c.createArgument.policyId) === policyId);
const entities = (pairs) => pairs.map(([, c]) => c.entity).sort();

let runInsurer;
let otherInsurer;

before(async () => {
  runInsurer = await makeInsurer('run');
  otherInsurer = await makeInsurer('unrelated');
});

after(async () => {
  try {
    // The ledger first: whatever the test left for either insurer.
    for (const party of [runInsurer?.party, otherInsurer?.party].filter(Boolean)) {
      for (const [contractId, c] of await contractsOf([party]).catch((err) => {
        console.error('[fixture cleanup] could not list contracts:', err.message);
        return new Map();
      })) {
        await archiveContract({
          exerciseChoice, contractId, templateId: c.templateId, signatories: c.signatories,
          createArgument: c.createArgument, fallbackActAs: [party],
        }).catch((err) => console.error(`[fixture cleanup] could not archive ${c.entity}:`, err.message));
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mine = 'SELECT id FROM policies WHERE insurer_id = ANY($1::uuid[])';
      await client.query(`DELETE FROM payout_notifications WHERE payout_event_id IN (SELECT id FROM payout_events WHERE policy_id IN (${mine}))`, [fixtureInsurerIds]);
      await client.query(`DELETE FROM payout_events WHERE policy_id IN (${mine})`, [fixtureInsurerIds]);
      await client.query(`DELETE FROM policy_events WHERE policy_no IN (${mine})`, [fixtureInsurerIds]);
      await deleteWindowedTriggerRows(client, fixturePolicyIds);
      for (const t of ['policy_documents', 'policy_status_history', 'policy_coverages', 'oracle_readings']) {
        await client.query(`DELETE FROM ${t} WHERE policy_id IN (${mine})`, [fixtureInsurerIds]);
      }
      // The responses teardownRun kept because attested_evidence held them;
      // this is a test database, where both may go.
      await client.query('DELETE FROM attested_evidence WHERE policy_id = ANY($1::uuid[])', [fixturePolicyIds]);
      await client.query('DELETE FROM oracle_raw_responses WHERE id = ANY($1::uuid[])', [fixtureRawResponseIds]);
      await client.query('DELETE FROM policies WHERE insurer_id = ANY($1::uuid[])', [fixtureInsurerIds]);
      await client.query('DELETE FROM policyholders WHERE insurer_id = ANY($1::uuid[])', [fixtureInsurerIds]);
      await client.query('DELETE FROM payout_tiers WHERE insurer_id = ANY($1::uuid[])', [fixtureInsurerIds]);
      await client.query('DELETE FROM insurers WHERE id = ANY($1::uuid[])', [fixtureInsurerIds]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[fixture cleanup] FAILED -- rows may be left behind:', err.message);
      throw err;
    } finally {
      client.release();
    }
    if (granted.length) {
      const rights = granted.map((party) => ({ kind: { CanActAs: { value: { party } } } }));
      const revoked = await revokeUserRights(config.daml.unsafeJwtSub, rights);
      if (revoked.length !== rights.length) {
        throw new Error(`[fixture cleanup] asked to revoke ${rights.length} CanActAs, the ledger revoked ${revoked.length}`);
      }
    }
  } finally {
    await pool.end();
  }
});

test('the verify-all teardown takes back only the run\'s own policies: another insurer\'s, and an older one of its own, survive', async () => {
  // Before the run: an older policy of the run's own insurer (a demo).
  const older = await mintedPolicy(runInsurer, { createdAt: '2026-08-01T00:00:00Z' });
  const before = await contractsOf([runInsurer.party]);
  const runStart = new Date();

  // During the run: the run's own policy, paid on; the older one pays and
  // re-mints; the unrelated insurer mints one of its own.
  const mine = await mintedPolicy(runInsurer);
  await payOn(mine);
  await payOn(older);
  const unrelated = await mintedPolicy(otherInsurer);

  // As runVerifications.mjs reads it: over the run's insurer's parties only.
  const afterRun = await contractsOf([runInsurer.party]);
  assert.equal(ofPolicy(afterRun, unrelated.id).length, 0, 'another insurer\'s contracts are not even listed');
  assert.deepEqual(entities(ofPolicy(afterRun, mine.id)), ['PayoutApproved', 'PolicyToken'], 'the run left a token and a payout');
  const olderAfterRun = ofPolicy(afterRun, older.id);
  assert.deepEqual(entities(olderAfterRun), ['PayoutApproved', 'PolicyToken']);
  assert.ok(olderAfterRun.every(([id]) => !before.has(id)), 'the older policy\'s contracts are new since the run started');

  const client = await pool.connect();
  let result;
  try {
    result = await teardownRun({
      exerciseChoice, client, runStart, insurerIds: [runInsurer.id], before, after: afterRun,
      fallbackActAs: [runInsurer.party], log: () => {},
    });
  } finally {
    client.release();
  }
  assert.equal(result.failed, 0);
  assert.equal(result.archived, 2, 'the run policy\'s token, and its payout closed through ConfirmSettlement');
  assert.equal(result.leftAlone, 2, 'the older policy\'s re-minted token and its payout are left alone');
  assert.equal(result.rows.policies, 1, 'one policy row: the run\'s own');

  // The ledger: nothing left of the run's policy, not even the settlement record.
  const now = await contractsOf([runInsurer.party]);
  assert.equal(ofPolicy(now, mine.id).length, 0, 'the run policy has no active contract left');
  // The older policy of the same insurer: the same contracts, untouched.
  assert.deepEqual(
    ofPolicy(now, older.id).map(([id]) => id).sort(), olderAfterRun.map(([id]) => id).sort(),
    'the older policy keeps its re-minted token and its payout'
  );
  // The unrelated insurer: token still there.
  assert.deepEqual(entities(ofPolicy(await contractsOf([otherInsurer.party]), unrelated.id)), ['PolicyToken'],
    'the unrelated insurer\'s token survives');

  // SQL: the run's policy row is gone, the other two are not.
  const { rows } = await pool.query('SELECT id FROM policies WHERE id = ANY($1::uuid[])', [[mine.id, older.id, unrelated.id]]);
  assert.deepEqual(rows.map((r) => r.id).sort(), [older.id, unrelated.id].sort());
});
