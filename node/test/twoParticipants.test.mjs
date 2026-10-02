import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { oracleNodeUrl } from '../test-support/setup-oracle-node.mjs'; // must stay second: config.js reads the key at load
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import {
  allocateParty,
  queryActiveContracts,
  exerciseChoice,
  listUserRights,
  revokeUserRights,
  insurerEndpoint,
  oracleEndpoint,
  oracleIsOnItsOwnParticipant,
} from '../src/damlClient.js';
import { runOnce as dispatch } from '../src/dispatch/dispatcher.js';
import { queueClosedWindows } from '../src/oracle/oracleBot.js';
import { archiveContract } from '../../scripts/lib/policyTeardown.mjs';

// The two-participant configuration against a REAL second participant: the
// oracle operator party hosted somewhere the insurer's node does not control,
// the token minted on the insurer's node, the trigger submitted on the
// oracle's, and the payout readable from both. What
// a maintenance script kept outside this repository measured as a one-off, run through
// the production path -- onboarding, the outbox, the dispatcher -- instead.
//
// THE ADDRESS IS NOT IN THIS FILE. It comes from
// TEST_DAML_JSON_API_URL_ORACLE (see test-support/setup-oracle-node.mjs); with
// it unset every test here skips and the suite is what it was. It is a TEST
// variable on purpose: a developer's own node/.env stays single-participant, and
// nothing here reads or writes it.
//
// The DAR has to be on BOTH participants. scripts/uploadDar.mjs already
// uploads to :3975 and :2975, and `npm run doctor` says so per participant;
// a trigger sent to a participant without the package fails on an unknown
// template, which is a different failure from the one under test here.
const SKIP = oracleNodeUrl
  ? false
  : 'TEST_DAML_JSON_API_URL_ORACLE is not set: there is no second participant to run against';

let insurerId;
let insurerParty;
let oracleParty;
// Rights are granted PER PARTICIPANT, so what was granted has to be taken back
// per participant too: the two lists are kept apart because
// revoking on the wrong node silently revokes nothing.
const grantedOnInsurerNode = [];
const grantedOnOracleNode = [];
// The raw counts, both ends, before and after: printed rather than asserted
// against a number, because other parties live on these participants.
let rightsBefore = null;

const DOCUMENT_HASH = crypto.createHash('sha256').update('twoParticipants test policy document').digest('hex');
const RULE = { timezone: 'Europe/Istanbul', startHour: 0, aggregation: 'min' };
// A closed local day, well in the past. The minimum is what the single tier
// below matches.
const DAY = [
  ['2026-09-01T01:00:00+03:00', -1.0],
  ['2026-09-01T03:00:00+03:00', -1.5],
];
const SECOND_DAY = [
  ['2026-09-02T01:00:00+03:00', -1.2],
  ['2026-09-02T03:00:00+03:00', -1.7],
];

const rightsCount = async (endpoint) =>
  (await listUserRights(config.daml.unsafeJwtSub, endpoint ? { endpoint } : {})).length;

before(async () => {
  if (SKIP) return;
  rightsBefore = {
    insurerNode: await rightsCount(insurerEndpoint()),
    oracleNode: await rightsCount(oracleEndpoint()),
  };
  console.log(
    `[twoParticipants] rights held by ${config.daml.unsafeJwtSub} before the run: ` +
      `${rightsBefore.insurerNode} on ${insurerEndpoint()}, ${rightsBefore.oracleNode} on ${oracleEndpoint()}`
  );

  insurerParty = await allocateParty(
    'Test Insurer (twoParticipants.test.mjs)',
    `test-insurer-${crypto.randomUUID()}`,
    { grantActAs: true }
  );
  grantedOnInsurerNode.push(insurerParty);
  // The one difference from every other fixture in this suite, and the whole
  // point of the file: this party is allocated by, and hosted on, the OTHER
  // participant -- exactly what onboardInsurer.js does when the key is set.
  oracleParty = await allocateParty(
    'Test Oracle Operator (twoParticipants.test.mjs)',
    `test-oracle-operator-${crypto.randomUUID()}`,
    { grantActAs: true, endpoint: oracleEndpoint() }
  );
  grantedOnOracleNode.push(oracleParty);

  // 14 is a fixture value for this file only, as in dispatcher.test.mjs -- not
  // a statutory figure and not a default anything in production reads.
  insurerId = (
    await pool.query(
      `INSERT INTO insurers
         (legal_name, api_key_hash, canton_party_id, canton_party_status, oracle_operator_party,
          default_grace_period_days)
       VALUES ($1, $2, $3, 'ALLOCATED', $4, 14) RETURNING id`,
      [
        'Test Insurer Ltd (twoParticipants fixture, fake)',
        crypto.randomBytes(16).toString('hex'),
        insurerParty,
        oracleParty,
      ]
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO payout_tiers
       (insurer_id, product_code, peril_type, tier_order, label, threshold_min, threshold_max, payout_percentage, shape)
     VALUES ($1, 'TEST-PRODUCT', 'TEST-PERIL', 1, 'test tier', -2.0, 0.0, 25.00, 'TS_Step')`,
    [insurerId]
  );
});

after(async () => {
  if (SKIP) {
    await pool.end();
    return;
  }
  try {
    // The ledger first, then SQL: a live contract with no SQL row is as much a
    // reconciliation failure as the reverse (dispatcher.test.mjs says why).
    // PayoutApproved is signed by insurer AND oracleOperator, and with the two
    // on different participants neither end can submit a bare Archive of it
    // (403 from both ends) -- so it is archived through
    // PayoutApproved_ConfirmSettlement, controlled by the insurer alone, which
    // is the path measured with two participants. That belongs to the cleanup work
    // tracked separately; here the PayoutApproved contracts this file creates are
    // reported rather than archived, so nothing is left silently.
    for (const e of await queryActiveContracts({
      moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', parties: [insurerParty],
    }).catch((err) => {
      console.error('[fixture cleanup] could not list PolicyToken:', err.message);
      return [];
    })) {
      const c = e.contractEntry.JsActiveContract.createdEvent;
      await exerciseChoice({
        moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', contractId: c.contractId,
        choice: 'Archive', argument: {}, actAs: c.signatories?.length ? c.signatories : [insurerParty],
      }).catch((err) => console.error('[fixture cleanup] could not archive PolicyToken:', err.message));
    }
    // Closed now, through that path -- archiveContract
    // (scripts/lib/policyTeardown.mjs) exercises ConfirmSettlement as the
    // insurer and archives the PayoutSettled it leaves. The last test below
    // does it and asserts nothing is left; this repeats it for a run in which
    // that test did not get that far, and the report stays for any that fail.
    await closeFixturePayouts().catch((err) => console.error('[fixture cleanup] could not close PayoutApproved:', err.message));
    const payouts = await queryActiveContracts({
      moduleName: 'Insurance.PayoutBridge', entityName: 'PayoutApproved', parties: [insurerParty],
    }).catch((err) => {
      console.error('[fixture cleanup] could not list PayoutApproved:', err.message);
      return [];
    });
    if (payouts.length) {
      console.log(
        `[twoParticipants] ${payouts.length} PayoutApproved left on the ledger for this fixture insurer: ` +
          'a two-signatory contract across two participants archives through ' +
          'PayoutApproved_ConfirmSettlement, which is the cleanup work tracked separately'
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mine = 'SELECT id FROM policies WHERE insurer_id = $1';
      await client.query(`DELETE FROM payout_notifications WHERE payout_event_id IN (SELECT id FROM payout_events WHERE policy_id IN (${mine}))`, [insurerId]);
      await client.query(`DELETE FROM payout_events WHERE policy_id IN (${mine})`, [insurerId]);
      // policy_events references trigger_windows, which references
      // oracle_readings: the three have to go in exactly this order.
      await client.query(`DELETE FROM policy_events WHERE policy_no IN (${mine})`, [insurerId]);
      await client.query(`DELETE FROM attested_evidence WHERE policy_id IN (${mine})`, [insurerId]);
      await client.query(`DELETE FROM trigger_windows WHERE policy_id IN (${mine})`, [insurerId]);
      for (const t of ['policy_documents', 'policy_status_history', 'policy_coverages', 'oracle_readings']) {
        await client.query(`DELETE FROM ${t} WHERE policy_id IN (${mine})`, [insurerId]);
      }
      await client.query(`DELETE FROM oracle_raw_responses WHERE request_url = 'https://fixture.invalid/two-participants'`);
      await client.query('DELETE FROM policies WHERE insurer_id = $1', [insurerId]);
      await client.query('DELETE FROM policyholders WHERE insurer_id = $1', [insurerId]);
      await client.query('DELETE FROM payout_tiers WHERE insurer_id = $1', [insurerId]);
      await client.query('DELETE FROM insurers WHERE id = $1', [insurerId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[fixture cleanup] FAILED -- rows may be left behind:', err.message);
      throw err;
    } finally {
      client.release();
    }

    // Both ends, each with the rights it actually granted.
    for (const [endpoint, parties] of [
      [insurerEndpoint(), grantedOnInsurerNode],
      [oracleEndpoint(), grantedOnOracleNode],
    ]) {
      if (!parties.length) continue;
      const rights = parties.map((party) => ({ kind: { CanActAs: { value: { party } } } }));
      const revoked = await revokeUserRights(config.daml.unsafeJwtSub, rights, { endpoint });
      if (revoked.length !== rights.length) {
        throw new Error(
          `[fixture cleanup] asked ${endpoint} to revoke ${rights.length} CanActAs, it revoked ${revoked.length}`
        );
      }
    }
    console.log(
      `[twoParticipants] rights held by ${config.daml.unsafeJwtSub} after the run: ` +
        `${await rightsCount(insurerEndpoint())} on ${insurerEndpoint()} (was ${rightsBefore.insurerNode}), ` +
        `${await rightsCount(oracleEndpoint())} on ${oracleEndpoint()} (was ${rightsBefore.oracleNode})`
    );
  } finally {
    await pool.end();
  }
});

async function mintedPolicy() {
  const ph = (
    await pool.query(`INSERT INTO policyholders (insurer_id, external_ref) VALUES ($1,$2) RETURNING id`, [
      insurerId, `test-ref-${crypto.randomUUID()}`,
    ])
  ).rows[0].id;
  const policy = (
    await pool.query(
      `INSERT INTO policies
         (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date, status,
          coverage_began_at, coverage_start_basis, created_at,
          event_window_timezone, event_window_start_hour, event_aggregation, document_hash)
       VALUES ($1,$2,500,'TRY','2026-08-01','2027-03-31','pending_mint','2026-08-15','CSB_AgreedWithoutPayment',
               '2026-08-01',$3,$4,$5,$6)
       RETURNING id`,
      [insurerId, ph, RULE.timezone, RULE.startHour, RULE.aggregation, DOCUMENT_HASH]
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL','["two-participant-cell"]',10000,10000,
       '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null}]',
       '["PDR_Insured"]','TEMPERATURE_C','PB_RemainingLimit')`,
    [policy.id]
  );
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, expected_version) VALUES ($1, 'activation', 0)`,
    [policy.id]
  );
  await dispatch();
  const row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(row.status, 'active', 'the fixture policy must mint before a trigger can be sent for it');
  return row;
}

// Readings with their stored provider response, as the oracle bot records
// them since migration 031 -- the path that writes attested_evidence, which is
// what the retry must not write twice.
async function insertDayWithEvidence(policyId, day) {
  for (const [measuredAt, value] of day) {
    const body = Buffer.from(JSON.stringify({ fixture: 'twoParticipants', measuredAt, value }));
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const raw = (
      await pool.query(
        `INSERT INTO oracle_raw_responses
           (request_url, request_params, http_status, body, sha256, provider_updated_at, fetched_at)
         VALUES ('https://fixture.invalid/two-participants', '{}', 200, $1, $2, $3, now()) RETURNING id`,
        [body, sha256, new Date(measuredAt).toISOString()]
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO oracle_readings
         (policy_id, coverage_code, cell_id, metric, value, measured_at, source, raw_response_id)
       VALUES ($1,'TEST-COVERAGE','two-participant-cell','TEMPERATURE_C',$2,$3,'twoParticipants-fixture',$4)`,
      [policyId, value, measuredAt, raw]
    );
  }
}

// Every PayoutApproved of this file's insurer, closed the way a split topology
// allows: the insurer's ConfirmSettlement from the insurer's participant, then
// the PayoutSettled record archived as the insurer (archiveContract).
async function closeFixturePayouts() {
  for (const e of await queryActiveContracts({
    moduleName: 'Insurance.PayoutBridge', entityName: 'PayoutApproved', parties: [insurerParty],
  })) {
    const c = e.contractEntry.JsActiveContract.createdEvent;
    await archiveContract({
      exerciseChoice, contractId: c.contractId, templateId: c.templateId, signatories: c.signatories,
      createArgument: c.createArgument, fallbackActAs: [insurerParty],
    });
  }
}

const triggerEvents = async (policyId) =>
  (await pool.query(
    `SELECT id, status, error FROM policy_events WHERE policy_no = $1 AND event_type = 'trigger' ORDER BY created_at`,
    [policyId]
  )).rows;

test('the configuration really is two participants', { skip: SKIP }, () => {
  assert.equal(oracleIsOnItsOwnParticipant(), true);
  assert.notEqual(oracleEndpoint(), insurerEndpoint());
});

test('the oracle party is hosted on the SECOND participant, and only there', { skip: SKIP }, async () => {
  const actAsOn = async (endpoint) =>
    new Set(
      (await listUserRights(config.daml.unsafeJwtSub, { endpoint }))
        .map((r) => r.kind?.CanActAs?.value?.party)
        .filter(Boolean)
    );
  const onInsurerNode = await actAsOn(insurerEndpoint());
  const onOracleNode = await actAsOn(oracleEndpoint());
  assert.equal(onOracleNode.has(oracleParty), true, 'the oracle participant holds a CanActAs for the oracle party');
  assert.equal(
    onInsurerNode.has(oracleParty), false,
    'the insurer participant must hold NO right for the oracle party -- that is what makes the split real'
  );
  assert.equal(onInsurerNode.has(insurerParty), true, 'the insurer party stayed on the insurer participant');
});

test('minted on the first participant, triggered from the second, and the payout is readable from both',
  { skip: SKIP }, async () => {
    const policy = await mintedPolicy();
    await insertDayWithEvidence(policy.id, DAY);
    await queueClosedWindows({ insurerIds: [insurerId] });
    await dispatch();

    const events = await triggerEvents(policy.id);
    assert.equal(events.length, 1, 'one closed window, one trigger');
    assert.equal(events[0].status, 'done', events[0].error ?? '');

    // One evidence row for the outbox row, whether or not it was retried:
    // handleTrigger writes it before the first call and attested_evidence is
    // append-only, keyed on (policy_event_id, raw_response_id).
    const evidence = (
      await pool.query('SELECT raw_response_id FROM attested_evidence WHERE policy_event_id = $1', [events[0].id])
    ).rows;
    assert.equal(evidence.length, 1, 'exactly one evidence row, however many attempts the submission took');

    const onEachNode = {};
    for (const [name, endpoint] of [['insurer', insurerEndpoint()], ['oracle', oracleEndpoint()]]) {
      const parties = name === 'insurer' ? [insurerParty] : [oracleParty];
      onEachNode[name] = (
        await queryActiveContracts({
          moduleName: 'Insurance.PayoutBridge', entityName: 'PayoutApproved', parties, endpoint,
        })
      ).filter((e) => e.contractEntry.JsActiveContract.createdEvent.createArgument.policyId === policy.id);
    }
    assert.equal(onEachNode.insurer.length, 1, 'the insurer participant sees the PayoutApproved');
    assert.equal(onEachNode.oracle.length, 1, 'and so does the oracle participant: the approval is on both nodes');
    assert.equal(
      onEachNode.insurer[0].contractEntry.JsActiveContract.createdEvent.contractId,
      onEachNode.oracle[0].contractEntry.JsActiveContract.createdEvent.contractId,
      'and it is the same contract, not two'
    );
  });

test('two triggers in a row on the same policy, the second right after the re-mint, both end done',
  { skip: SKIP }, async () => {
    const policy = await mintedPolicy();
    await insertDayWithEvidence(policy.id, DAY);
    await queueClosedWindows({ insurerIds: [insurerId] });
    // The first dispatch re-mints the token; the second window is queued and
    // dispatched immediately after, which is exactly the window measured earlier
    // the race in. It may or may not appear on any given run -- what has to
    // hold either way is that both rows end `done`.
    await dispatch();
    await insertDayWithEvidence(policy.id, SECOND_DAY);
    await queueClosedWindows({ insurerIds: [insurerId] });
    await dispatch();

    const events = await triggerEvents(policy.id);
    assert.equal(events.length, 2, 'two closed windows, two triggers');
    for (const e of events) assert.equal(e.status, 'done', e.error ?? '');
    for (const e of events) {
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM attested_evidence WHERE policy_event_id = $1', [e.id]
      );
      assert.equal(rows[0].n, 1, 'one evidence row per outbox row, retried or not');
    }
  });

// The teardown a split topology allows, run against the payouts the tests
// above left: a bare two-signatory Archive is refused (403), the
// insurer's ConfirmSettlement closes each one and the PayoutSettled
// it leaves is archived, and afterwards neither participant holds either.
test('the payouts close through the insurer\'s ConfirmSettlement, and neither participant holds one afterwards',
  { skip: SKIP }, async () => {
    const payoutsOn = async (endpoint, party, entityName = 'PayoutApproved') =>
      queryActiveContracts({ moduleName: 'Insurance.PayoutBridge', entityName, parties: [party], endpoint });
    const open = await payoutsOn(insurerEndpoint(), insurerParty);
    assert.ok(open.length > 0, 'the tests above leave payouts to close');

    const first = open[0].contractEntry.JsActiveContract.createdEvent;
    await assert.rejects(
      exerciseChoice({
        moduleName: 'Insurance.PayoutBridge', entityName: 'PayoutApproved', contractId: first.contractId,
        choice: 'Archive', argument: {}, actAs: [insurerParty, oracleParty],
      }),
      (err) => err.response?.status === 403,
      'a bare Archive as both signatories cannot be submitted from the insurer\'s participant'
    );

    await closeFixturePayouts();
    assert.equal((await payoutsOn(insurerEndpoint(), insurerParty)).length, 0, 'no PayoutApproved on the insurer participant');
    assert.equal((await payoutsOn(oracleEndpoint(), oracleParty)).length, 0, 'none on the oracle participant either');
    assert.equal((await payoutsOn(insurerEndpoint(), insurerParty, 'PayoutSettled')).length, 0, 'and no settlement record left');
  });
