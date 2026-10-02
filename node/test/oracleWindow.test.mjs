import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { pool } from '../src/db.js';
import { allocateParty, queryActiveContracts, exerciseChoice, getLedgerEnd, revokeUserRights } from '../src/damlClient.js';
import { config } from '../src/config.js';
import { runOnce as dispatch } from '../src/dispatch/dispatcher.js';
import { queueClosedWindows, coverBoundFor, tokenNotLive, runOnce as runOracle } from '../src/oracle/oracleBot.js';
import { windowFor } from '../src/oracle/eventWindow.js';
import { runOnce as sweepGrace } from '../src/sweepers/graceSweeper.js';
import { insertWindowedTrigger } from '../test-support/windowedTrigger.mjs';

// The event window, end to end against LocalNet: readings in, triggers out,
// payouts on the ledger. Before migration 030 every reading produced its own
// trigger, so the core claim here -- several matching readings in one window
// give ONE trigger and ONE payout -- would have given three of each.
//
// Readings are inserted directly, the way verify-m1458.mjs inserts them: in
// production the oracle bot accumulates them over a day, and what is under
// test is what happens once that day is over, not the fetch.

let insurerId;
let insurerParty;
let oracleParty;

// policies.document_hash is required, as a SHA-256 in lowercase hex (migration
// 034), and this fixture writes policies directly.
const DOCUMENT_HASH = crypto.createHash('sha256').update('oracle window test policy document').digest('hex');

// A local calendar day in Istanbul, well in the past, so it is closed.
const DAY = [
  ['2026-09-01T01:00:00+03:00', -1.0],
  ['2026-09-01T03:00:00+03:00', -1.5],
  ['2026-09-01T05:00:00+03:00', -0.5],
];
const RULE = { timezone: 'Europe/Istanbul', startHour: 0, aggregation: 'min' };

before(async () => {
  insurerParty = await allocateParty(
    'Test Insurer (oracleWindow.test.mjs)',
    `test-insurer-${crypto.randomUUID()}`,
    { grantActAs: true }
  );
  oracleParty = await allocateParty(
    'Test Oracle Operator (oracleWindow.test.mjs)',
    `test-oracle-operator-${crypto.randomUUID()}`,
    { grantActAs: true }
  );
  // 14 is a fixture value for this file only, as in dispatcher.test.mjs -- not
  // a statutory figure and not a default anything in production reads.
  const inserted = await pool.query(
    `INSERT INTO insurers
       (legal_name, api_key_hash, canton_party_id, canton_party_status, oracle_operator_party,
        default_grace_period_days)
     VALUES ($1, $2, $3, 'ALLOCATED', $4, 14) RETURNING id`,
    ['Test Insurer Ltd (oracleWindow fixture, fake)', crypto.randomBytes(16).toString('hex'), insurerParty, oracleParty]
  );
  insurerId = inserted.rows[0].id;
  await pool.query(
    `INSERT INTO payout_tiers
       (insurer_id, product_code, peril_type, tier_order, label, threshold_min, threshold_max, payout_percentage, shape)
     VALUES ($1, 'TEST-PRODUCT', 'TEST-PERIL', 1, 'test tier', -2.0, 0.0, 25.00, 'TS_Step')`,
    [insurerId]
  );
});

after(async () => {
  try {
    for (const [moduleName, entityName] of [
      ['Insurance.PolicyToken', 'PolicyToken'],
      ['Insurance.PayoutBridge', 'PayoutApproved'],
    ]) {
      const entries = await queryActiveContracts({ moduleName, entityName, parties: [insurerParty] }).catch((err) => {
        console.error(`[fixture cleanup] could not list ${entityName}:`, err.message);
        return [];
      });
      for (const e of entries) {
        const c = e.contractEntry.JsActiveContract.createdEvent;
        await exerciseChoice({
          moduleName, entityName, contractId: c.contractId, choice: 'Archive', argument: {},
          actAs: c.signatories?.length ? c.signatories : [insurerParty],
        }).catch((err) => console.error(`[fixture cleanup] could not archive ${entityName}:`, err.message));
      }
    }
    if (insurerId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const mine = 'SELECT id FROM policies WHERE insurer_id = $1';
        await client.query(`DELETE FROM payout_notifications WHERE payout_event_id IN (SELECT id FROM payout_events WHERE policy_id IN (${mine}))`, [insurerId]);
        await client.query(`DELETE FROM payout_events WHERE policy_id IN (${mine})`, [insurerId]);
        // policy_events references trigger_windows, which references
        // oracle_readings: the three have to go in exactly this order.
        await client.query(`DELETE FROM policy_events WHERE policy_no IN (${mine})`, [insurerId]);
        await client.query(`DELETE FROM trigger_windows WHERE policy_id IN (${mine})`, [insurerId]);
        for (const t of ['policy_status_history', 'policy_coverages']) {
          await client.query(`DELETE FROM ${t} WHERE policy_id IN (${mine})`, [insurerId]);
        }
        // Readings point at the raw responses (migration 031), so the ids are
        // collected first, the readings go, and then the responses they named.
        const raws = (
          await client.query(
            `SELECT raw_response_id FROM oracle_readings WHERE policy_id IN (${mine}) AND raw_response_id IS NOT NULL`,
            [insurerId]
          )
        ).rows.map((r) => r.raw_response_id);
        await client.query(`DELETE FROM oracle_readings WHERE policy_id IN (${mine})`, [insurerId]);
        // An attested response is held by its evidence row (migration 032),
        // which only a database marked as a test database lets go of.
        if (raws.length) await client.query('DELETE FROM attested_evidence WHERE raw_response_id = ANY($1)', [raws]);
        if (raws.length) await client.query('DELETE FROM oracle_raw_responses WHERE id = ANY($1)', [raws]);
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
    }
    // The two CanActAs before() granted, taken back after the archive that
    // acts as these parties; loud if the ledger takes back fewer.
    const rights = [insurerParty, oracleParty].filter(Boolean).map((party) => ({ kind: { CanActAs: { value: { party } } } }));
    if (rights.length) {
      const revoked = await revokeUserRights(config.daml.unsafeJwtSub, rights);
      if (revoked.length !== rights.length) {
        throw new Error(`[fixture cleanup] asked to revoke ${rights.length} CanActAs, the ledger revoked ${revoked.length}`);
      }
    }
  } finally {
    await pool.end();
  }
});

// A minted policy. `windowRule` is written as the policy's OVERRIDE before
// activation, which is what gets frozen; pass null to leave it unset.
async function mintedPolicy(windowRule) {
  const ph = (
    await pool.query(`INSERT INTO policyholders (insurer_id, external_ref) VALUES ($1,$2) RETURNING id`, [
      insurerId,
      `test-ref-${crypto.randomUUID()}`,
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
      [insurerId, ph, windowRule?.timezone ?? null, windowRule?.startHour ?? null, windowRule?.aggregation ?? null,
        DOCUMENT_HASH]
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL','["window-cell"]',10000,10000,
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
  assert.equal(row.status, 'active', 'fixture policy must mint before a window can be tested on it');
  return row;
}

async function insertDay(policyId, day = DAY) {
  for (const [measuredAt, value] of day) {
    await pool.query(
      `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source)
       VALUES ($1,'TEST-COVERAGE','window-cell','TEMPERATURE_C',$2,$3,'oracleWindow-fixture')`,
      [policyId, value, measuredAt]
    );
  }
}

// The same day, but each reading carries a stored provider response, the way
// the oracle bot records them since migration 031. The body is a fixture, and
// its hash is computed here exactly as the bot computes the real one.
async function insertDayWithEvidence(policyId, day = DAY) {
  const ids = [];
  for (const [measuredAt, value] of day) {
    const body = Buffer.from(JSON.stringify({ fixture: 'oracleWindow', measuredAt, value }));
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const raw = (
      await pool.query(
        `INSERT INTO oracle_raw_responses
           (request_url, request_params, http_status, body, sha256, provider_updated_at, fetched_at)
         VALUES ('https://fixture.invalid/compact', '{"lat":"41.0082","lon":"28.9784"}', 200, $1, $2, $3, now())
         RETURNING id`,
        [body, sha256, new Date(measuredAt).toISOString()]
      )
    ).rows[0].id;
    const reading = (
      await pool.query(
        `INSERT INTO oracle_readings
           (policy_id, coverage_code, cell_id, metric, value, measured_at, source, raw_response_id)
         VALUES ($1,'TEST-COVERAGE','window-cell','TEMPERATURE_C',$2,$3,'oracleWindow-fixture',$4) RETURNING id`,
        [policyId, value, measuredAt, raw]
      )
    ).rows[0].id;
    ids.push({ reading, raw, sha256, value });
  }
  return ids;
}

const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;
const triggerRows = (policyId) =>
  count(`SELECT count(*)::int AS n FROM policy_events WHERE policy_no = $1 AND event_type = 'trigger'`, [policyId]);

test('three matching readings in one closed window give ONE trigger and ONE payout', async () => {
  const policy = await mintedPolicy(RULE);
  // With stored responses: since v22 a window whose evidence is absent is not
  // sent (the test after next), so the one-payout claim is shown on readings
  // that carry their evidence.
  const readings = await insertDayWithEvidence(policy.id);

  await queueClosedWindows({ insurerIds: [insurerId] });
  assert.equal(await triggerRows(policy.id), 1, 'one window, one trigger -- not one per reading');

  const win = (await pool.query('SELECT * FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows;
  assert.equal(win.length, 1);
  assert.equal(win[0].aggregation, 'min');
  assert.equal(Number(win[0].aggregated_value), -1.5, 'the day minimum is what gets evaluated');
  assert.equal(win[0].reading_ids.length, 3, 'the window names every reading that fed it');

  await dispatch();
  const payouts = await count(`SELECT count(*)::int AS n FROM payout_events WHERE policy_id = $1`, [policy.id]);
  assert.equal(payouts, 1, 'one payout row');
  const onLedger = (
    await queryActiveContracts({ moduleName: 'Insurance.PayoutBridge', entityName: 'PayoutApproved', parties: [insurerParty] })
  ).filter((e) => e.contractEntry.JsActiveContract.createdEvent.createArgument.policyId === policy.id);
  assert.equal(onLedger.length, 1, 'one PayoutApproved on the LEDGER, not just in SQL');

  const cov = (await pool.query('SELECT remaining_limit FROM policy_coverages WHERE policy_id = $1', [policy.id])).rows[0];
  assert.equal(Number(cov.remaining_limit), 7500, 'the limit is consumed once: 25% of 10000');

  // Migration 031: the payout points straight at what caused it.
  const payout = (await pool.query('SELECT * FROM payout_events WHERE policy_id = $1', [policy.id])).rows[0];
  assert.equal(payout.trigger_window_id, win[0].id, 'the payout names its window');
  assert.equal(payout.oracle_reading_id, win[0].determining_reading_id, 'and, for a min, the reading that decided it');

  // v22: the interval the window was queued with, the digest of
  // the deciding response, and the approval instant are what the LEDGER holds.
  const deciding = readings.find((r) => r.value === -1.5);
  const approved = onLedger[0].contractEntry.JsActiveContract.createdEvent.createArgument;
  assert.equal(new Date(approved.eventStart).getTime(), new Date(win[0].event_start).getTime());
  assert.equal(new Date(approved.eventEnd).getTime(), new Date(win[0].event_end).getTime());
  assert.equal(approved.evidenceDigest, `sha256:${deciding.sha256}`, 'the digest is the deciding response\'s hash');
  assert.equal(payout.evidence_digest, approved.evidenceDigest);
  assert.equal(new Date(payout.event_start).getTime(), new Date(approved.eventStart).getTime());
  assert.equal(new Date(payout.event_end).getTime(), new Date(approved.eventEnd).getTime());
  // Compared as instants: SQL holds a timestamptz, the ledger an ISO string.
  assert.equal(new Date(payout.approved_at).getTime(), new Date(approved.approvedAt).getTime(), 'approved_at is the ledger time read back');
  assert.equal(payout.payout_percentage, '25.0000000000', 'the applied rate at the ledger Decimal\'s ten places');
});

test('a min window attests to the deciding response, and its hash is the one stored', async () => {
  const policy = await mintedPolicy(RULE);
  const readings = await insertDayWithEvidence(policy.id);
  const deciding = readings.find((r) => r.value === -1.5);

  await queueClosedWindows({ insurerIds: [insurerId] });
  const win = (await pool.query('SELECT * FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows[0];
  const att = JSON.parse(win.attestation_ref);

  assert.equal(att.v, 1);
  assert.equal(att.reading, deciding.reading, 'the attestation names the deciding reading');
  assert.equal(att.evidence.sha256, deciding.sha256);
  const stored = (
    await pool.query(`SELECT encode(digest(body, 'sha256'), 'hex') AS h FROM oracle_raw_responses WHERE id = $1`, [
      deciding.raw,
    ])
  ).rows[0].h;
  assert.equal(att.evidence.sha256, stored, 'recomputed from the stored bytes, the hash matches');
  assert.deepEqual(att.evidence.request.params, { lat: '41.0082', lon: '28.9784' });
  assert.equal(att.window.aggregation, 'min');
  assert.equal(att.window.readings, 3);

  await dispatch();
  const payout = (await pool.query('SELECT * FROM payout_events WHERE policy_id = $1', [policy.id])).rows[0];
  assert.equal(payout.oracle_reading_id, deciding.reading);
});

test('a mean window has no deciding reading and commits to every response it combines', async () => {
  const policy = await mintedPolicy({ ...RULE, aggregation: 'mean' });
  const readings = await insertDayWithEvidence(policy.id);

  await queueClosedWindows({ insurerIds: [insurerId] });
  const win = (await pool.query('SELECT * FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows[0];
  const att = JSON.parse(win.attestation_ref);
  assert.equal(Number(win.aggregated_value), -1.0, 'the mean of -1.0, -1.5 and -0.5');
  assert.equal(att.reading, null);
  assert.equal(att.evidence.combines, 3);
  const combined = crypto.createHash('sha256').update(readings.map((r) => r.sha256).sort().join('\n')).digest('hex');
  assert.equal(att.evidence.sha256, combined, 'one hash over the sorted per-response hashes');

  await dispatch();
  const payout = (await pool.query('SELECT * FROM payout_events WHERE policy_id = $1', [policy.id])).rows[0];
  assert.equal(payout.oracle_reading_id, null, 'a mean has no single causing reading');
  assert.equal(payout.trigger_window_id, win.id, 'the window is what names every reading of it');
});

// This was left unverified earlier: whether two readings of
// one window can share a stored response. The oracle does not write that --
// storeReading inserts one response per reading -- but the schema allows it
// (oracle_readings.raw_response_id is not unique), so the readings are written
// directly here and what follows is what the code does with them.
test('a mean window whose readings share one stored response is refused before the ledger: nothing is sent', async () => {
  const policy = await mintedPolicy({ ...RULE, aggregation: 'mean' });
  const [shared] = await insertDayWithEvidence(policy.id, DAY.slice(0, 1));
  for (const [measuredAt, value] of DAY.slice(1)) {
    await pool.query(
      `INSERT INTO oracle_readings
         (policy_id, coverage_code, cell_id, metric, value, measured_at, source, raw_response_id)
       VALUES ($1,'TEST-COVERAGE','window-cell','TEMPERATURE_C',$2,$3,'oracleWindow-fixture',$4)`,
      [policy.id, value, measuredAt, shared.raw]
    );
  }

  await queueClosedWindows({ insurerIds: [insurerId] });
  const win = (await pool.query('SELECT * FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows[0];
  const att = JSON.parse(win.attestation_ref);
  assert.equal(att.evidence.combines, 3, 'combines counts readings, not distinct responses');
  const listedThrice = crypto.createHash('sha256').update([shared.sha256, shared.sha256, shared.sha256].join('\n')).digest('hex');
  assert.equal(att.evidence.sha256, listedThrice, 'the one response\'s hash is listed once per reading');

  await dispatch();
  const ev = (await pool.query('SELECT id, status, error FROM policy_events WHERE trigger_window_id = $1', [win.id])).rows[0];
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /attested_evidence_pkey/, 'the evidence insert meets its own primary key');
  assert.equal(
    await count(`SELECT count(*)::int AS n FROM attested_evidence WHERE policy_event_id = $1`, [ev.id]),
    0,
    'one INSERT statement: none of its rows is written'
  );
  assert.equal(await count(`SELECT count(*)::int AS n FROM payout_events WHERE policy_id = $1`, [policy.id]), 0);
  const onLedger = (
    await queryActiveContracts({ moduleName: 'Insurance.PayoutBridge', entityName: 'PayoutApproved', parties: [insurerParty] })
  ).filter((e) => e.contractEntry.JsActiveContract.createdEvent.createArgument.policyId === policy.id);
  assert.equal(onLedger.length, 0, 'no PayoutApproved on the ledger for the policy');
});

test('readings with no stored response are attested as absent, not left quietly empty', async () => {
  const policy = await mintedPolicy(RULE);
  await insertDay(policy.id);
  await queueClosedWindows({ insurerIds: [insurerId] });
  const win = (await pool.query('SELECT id, attestation_ref FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows[0];
  assert.equal(JSON.parse(win.attestation_ref).evidence, 'absent');

  // v22: such a window has no evidence digest, and the ledger takes no
  // trigger without one. The row fails with a reason that says so, before
  // anything is sent -- and says it is not a finding about the riziko.
  await dispatch();
  const ev = (await pool.query('SELECT status, error FROM policy_events WHERE trigger_window_id = $1', [win.id])).rows[0];
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /records its evidence as absent/);
  assert.match(ev.error, /Nothing was sent/);
  assert.match(ev.error, /not a finding about whether the riziko occurred/);
  assert.equal(await count(`SELECT count(*)::int AS n FROM payout_events WHERE policy_id = $1`, [policy.id]), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM attested_evidence WHERE trigger_window_id = $1`, [win.id]), 0);
});

test('a windowed trigger whose window carries no attestation is refused, not evaluated', async () => {
  const policy = await mintedPolicy(RULE);
  await insertDay(policy.id);
  const readingIds = (await pool.query('SELECT id FROM oracle_readings WHERE policy_id = $1', [policy.id])).rows.map(
    (r) => r.id
  );
  const win = (
    await pool.query(
      `INSERT INTO trigger_windows
         (policy_id, coverage_code, cell_id, window_start, window_end, timezone, start_hour, aggregation, metric,
          aggregated_value, determining_reading_id, reading_ids)
       VALUES ($1,'TEST-COVERAGE','window-cell','2026-08-31T21:00:00Z','2026-09-01T21:00:00Z','Europe/Istanbul',0,
               'mean','TEMPERATURE_C',-1.0,NULL,$2)
       RETURNING id`,
      [policy.id, readingIds]
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, trigger_window_id, payload)
     VALUES ($1,'trigger',$2,'{"observedValue":-1.0,"metric":"TEMPERATURE_C","coverageCode":"TEST-COVERAGE"}')`,
    [policy.id, win.id]
  );
  await dispatch();
  const ev = (
    await pool.query(`SELECT status, error FROM policy_events WHERE trigger_window_id = $1`, [win.id])
  ).rows[0];
  assert.equal(ev.status, 'failed');
  assert.match(ev.error, /carries no attestation/);
  assert.equal(await count(`SELECT count(*)::int AS n FROM payout_events WHERE policy_id = $1`, [policy.id]), 0);
});

test('closing the same window again queues nothing more', async () => {
  const policy = await mintedPolicy(RULE);
  await insertDay(policy.id);
  await queueClosedWindows({ insurerIds: [insurerId] });
  await queueClosedWindows({ insurerIds: [insurerId] });
  assert.equal(await triggerRows(policy.id), 1);
});

test('a second trigger row for one window cannot be created, whatever inserts it', async () => {
  const policy = await mintedPolicy(RULE);
  await insertDay(policy.id);
  await queueClosedWindows({ insurerIds: [insurerId] });
  const { id: windowId } = (await pool.query('SELECT id FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows[0];
  await assert.rejects(
    pool.query(
      `INSERT INTO policy_events (policy_no, event_type, trigger_window_id, payload)
       VALUES ($1, 'trigger', $2, '{"observedValue":-1.5,"metric":"TEMPERATURE_C","coverageCode":"TEST-COVERAGE"}')`,
      [policy.id, windowId]
    ),
    /idx_policy_events_trigger_window_key/
  );
});

test('a window that has not closed yet is not evaluated', async () => {
  const policy = await mintedPolicy(RULE);
  await insertDay(policy.id);
  // One millisecond before that local day ends: 2026-09-01T21:00:00Z.
  await queueClosedWindows({ insurerIds: [insurerId], now: new Date('2026-09-01T20:59:59.999Z') });
  assert.equal(await triggerRows(policy.id), 0, 'the day minimum is not known until the day is over');
});

test('a policy with no window frozen onto it is never triggered', async () => {
  const policy = await mintedPolicy(null);
  assert.equal(policy.event_window_timezone, null);
  await insertDay(policy.id);
  await queueClosedWindows({ insurerIds: [insurerId] });
  assert.equal(await triggerRows(policy.id), 0, 'no rule is a refusal, not a default');
});

test('the insurer default is frozen at activation and a later change does not reach the policy', async () => {
  await pool.query(
    `UPDATE insurers SET default_event_window_timezone = 'Europe/Istanbul', default_event_window_start_hour = 0,
       default_event_aggregation = 'min' WHERE id = $1`,
    [insurerId]
  );
  try {
    const policy = await mintedPolicy(null);
    assert.equal(policy.event_window_timezone, 'Europe/Istanbul');
    assert.equal(policy.event_aggregation, 'min');

    await pool.query(`UPDATE insurers SET default_event_aggregation = 'max' WHERE id = $1`, [insurerId]);
    const after = (await pool.query('SELECT event_aggregation FROM policies WHERE id = $1', [policy.id])).rows[0];
    assert.equal(after.event_aggregation, 'min', 'an issued policy keeps the rule it was issued under');
  } finally {
    await pool.query(
      `UPDATE insurers SET default_event_window_timezone = NULL, default_event_window_start_hour = NULL,
         default_event_aggregation = NULL WHERE id = $1`,
      [insurerId]
    );
  }
});

// Deletes a policy's chain in the order a teardown does -- payouts, outbox,
// windows, readings -- and then tries each named response on its own, under a
// savepoint. Returns, per response, the database's refusal or null. Rolled
// back unless `commit` is set and nothing was refused.
async function deleteChainThenResponses(policyId, rawIds, { commit = false } = {}) {
  const client = await pool.connect();
  const refusals = new Map();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM payout_notifications WHERE payout_event_id IN (SELECT id FROM payout_events WHERE policy_id = $1)', [policyId]);
    await client.query('DELETE FROM payout_events WHERE policy_id = $1', [policyId]);
    await client.query('DELETE FROM policy_events WHERE policy_no = $1', [policyId]);
    await client.query('DELETE FROM trigger_windows WHERE policy_id = $1', [policyId]);
    await client.query('DELETE FROM oracle_readings WHERE policy_id = $1', [policyId]);
    for (const id of rawIds) {
      await client.query('SAVEPOINT response');
      try {
        await client.query('DELETE FROM oracle_raw_responses WHERE id = $1', [id]);
        await client.query('RELEASE SAVEPOINT response');
        refusals.set(id, null);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT response');
        refusals.set(id, err.message);
      }
    }
    const refusedAny = [...refusals.values()].some((m) => m !== null);
    await client.query(commit && !refusedAny ? 'COMMIT' : 'ROLLBACK');
    return refusals;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// The command id the LEDGER recorded for the trigger exercise on `contractId`,
// read back from /v2/updates as the oracle party sees it. damlClient.js has no
// updates reader and does not export its HTTP client, so the request is made
// here, with the credentials config.js gives damlClient.
async function ledgerCommandIdOfTrigger(afterOffset, contractId) {
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
          eventFormat: { filtersByParty: { [oracleParty]: { cumulative: [] } }, verbose: false },
          transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
        },
      },
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const transactions = (await res.json()).map((u) => u.update?.Transaction?.value).filter(Boolean);
  const matches = transactions.filter((t) =>
    t.events.some(
      (e) => e.ExercisedEvent?.choice === 'PolicyToken_EvaluateTrigger' && e.ExercisedEvent.contractId === contractId
    )
  );
  assert.equal(matches.length, 1, 'exactly one trigger exercise on this token in the range');
  return matches[0].commandId;
}

test('an attested min window: its deciding response survives the chain being deleted, the others do not', async () => {
  const policy = await mintedPolicy(RULE);
  const readings = await insertDayWithEvidence(policy.id);
  const deciding = readings.find((r) => r.value === -1.5);
  const others = readings.filter((r) => r !== deciding);
  await queueClosedWindows({ insurerIds: [insurerId] });
  const win = (await pool.query('SELECT * FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows[0];
  const offsetBefore = await getLedgerEnd();
  await dispatch();
  const ev = (await pool.query('SELECT id, status, error FROM policy_events WHERE trigger_window_id = $1', [win.id]))
    .rows[0];
  assert.equal(ev.status, 'done', ev.error ?? '');

  const refusals = await deleteChainThenResponses(policy.id, readings.map((r) => r.raw));
  assert.match(refusals.get(deciding.raw) ?? '(deleted)', /attested_evidence/, 'the deciding response is held');
  for (const r of others) assert.equal(refusals.get(r.raw), null, 'a response the hash does not cover still deletes');

  const evidence = (await pool.query('SELECT * FROM attested_evidence WHERE policy_event_id = $1', [ev.id])).rows;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].raw_response_id, deciding.raw);
  assert.equal(evidence[0].sha256, deciding.sha256);
  assert.equal(evidence[0].trigger_window_id, win.id);
  assert.equal(evidence[0].policy_id, policy.id);
  assert.equal(evidence[0].attestation_ref, win.attestation_ref, 'the attestation exactly as it was sent');
  assert.equal(
    evidence[0].command_id,
    await ledgerCommandIdOfTrigger(offsetBefore, policy.daml_contract_id),
    'the command id the ledger recorded for the exercise'
  );
});

test('an attested mean window: every response it combines survives the chain being deleted', async () => {
  const policy = await mintedPolicy({ ...RULE, aggregation: 'mean' });
  const readings = await insertDayWithEvidence(policy.id);
  await queueClosedWindows({ insurerIds: [insurerId] });
  await dispatch();
  const ev = (
    await pool.query(`SELECT id, status, error FROM policy_events WHERE policy_no = $1 AND event_type = 'trigger'`, [
      policy.id,
    ])
  ).rows[0];
  assert.equal(ev.status, 'done', ev.error ?? '');

  const refusals = await deleteChainThenResponses(policy.id, readings.map((r) => r.raw));
  for (const r of readings) assert.match(refusals.get(r.raw) ?? '(deleted)', /attested_evidence/);
  const locked = (await pool.query('SELECT raw_response_id FROM attested_evidence WHERE policy_event_id = $1', [ev.id]))
    .rows.map((r) => r.raw_response_id);
  assert.deepEqual(locked.sort(), readings.map((r) => r.raw).sort());
});

test('a window never dispatched locks nothing: its whole chain, responses included, deletes', async () => {
  const policy = await mintedPolicy(RULE);
  const readings = await insertDayWithEvidence(policy.id);
  await queueClosedWindows({ insurerIds: [insurerId] });
  assert.equal(await triggerRows(policy.id), 1, 'queued, not dispatched');

  const refusals = await deleteChainThenResponses(policy.id, readings.map((r) => r.raw), { commit: true });
  for (const r of readings) assert.equal(refusals.get(r.raw), null);
  assert.equal(
    await count('SELECT count(*)::int AS n FROM oracle_raw_responses WHERE id = ANY($1)', [readings.map((r) => r.raw)]),
    0
  );
});

test('a trigger the ledger refuses still leaves its evidence locked: the lock is written before the call', async () => {
  const policy = await mintedPolicy(RULE);
  const readings = await insertDayWithEvidence(policy.id);
  const deciding = readings.find((r) => r.value === -1.5);
  await queueClosedWindows({ insurerIds: [insurerId] });
  // Archive the token behind the dispatcher's back, so the exercise is refused.
  const token = (await queryActiveContracts({ moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', parties: [insurerParty] }))
    .map((e) => e.contractEntry.JsActiveContract.createdEvent)
    .find((c) => c.contractId === policy.daml_contract_id);
  await exerciseChoice({
    moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', contractId: token.contractId,
    choice: 'Archive', argument: {}, actAs: token.signatories,
  });
  await dispatch();

  const ev = (
    await pool.query(`SELECT id, status FROM policy_events WHERE policy_no = $1 AND event_type = 'trigger'`, [policy.id])
  ).rows[0];
  assert.equal(ev.status, 'failed', 'the ledger refused the exercise');
  const locked = (await pool.query('SELECT raw_response_id FROM attested_evidence WHERE policy_event_id = $1', [ev.id]))
    .rows.map((r) => r.raw_response_id);
  assert.deepEqual(locked, [deciding.raw], 'written before the call, so the refusal did not undo it');
});

// The behaviour decided on 2026-09-19: a window folds in only the
// readings measured in [cover start, expiry), and a policy whose cover
// has not begun gets no window and no trigger. queueCellWindows selects
// only the readings measured in [coverage_began_at, end), where end is
// coverBoundFor's -- expiry, or earlier where the contract ends earlier --
// and a NULL coverage_began_at selects none, so the second follows from the first. All
// three were first written red and marked todo; they pass since
// then.

test(
  'a reading measured after expiry is not folded into the window',
  async () => {
    const policy = await mintedPolicy(RULE);
    const expiry = new Date(policy.expiry);
    const inCover = new Date(expiry.getTime() - 7 * 60 * 60 * 1000);
    const afterExpiry = new Date(expiry.getTime() + 3 * 60 * 60 * 1000);
    assert.equal(
      windowFor(inCover, RULE).start.getTime(),
      windowFor(afterExpiry, RULE).start.getTime(),
      'fixture: both readings must fall in the one window that holds expiry'
    );
    await insertDay(policy.id, [
      [inCover.toISOString(), -0.5],
      [afterExpiry.toISOString(), -1.8],
    ]);
    const inCoverId = (
      await pool.query('SELECT id FROM oracle_readings WHERE policy_id = $1 AND measured_at = $2', [policy.id, inCover])
    ).rows[0].id;

    await queueClosedWindows({ insurerIds: [insurerId], now: new Date(expiry.getTime() + 2 * 24 * 60 * 60 * 1000) });

    const win = (await pool.query('SELECT * FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows;
    assert.equal(win.length, 1, 'fixture: the window holding expiry is closed and evaluated');
    assert.equal(
      Number(win[0].aggregated_value),
      -0.5,
      `expected the min of the readings inside cover (-0.5, measured ${inCover.toISOString()}); ` +
        `got ${win[0].aggregated_value}, and -1.8 was measured ${afterExpiry.toISOString()}, after expiry ` +
        `${expiry.toISOString()}`
    );
    assert.equal(win[0].determining_reading_id, inCoverId, 'the deciding reading is the one inside cover');
    // v22: the event interval the trigger will send ends at expiry.
    assert.equal(new Date(win[0].event_end).getTime(), expiry.getTime(), 'the interval is clipped at expiry');
    assert.equal(new Date(win[0].event_start).getTime(), new Date(win[0].window_start).getTime());
  }
);

test(
  'a reading measured before cover began is not folded into the window',
  async () => {
    const probe = await mintedPolicy(RULE);
    const coverStart = new Date(probe.coverage_began_at);
    // One UTC day centred on the cover start, so the window straddles it. The
    // rule is frozen at activation, so a second policy is minted under it.
    const rule = { timezone: 'UTC', startHour: (coverStart.getUTCHours() + 12) % 24, aggregation: 'min' };
    const policy = await mintedPolicy(rule);
    assert.equal(new Date(policy.coverage_began_at).getTime(), coverStart.getTime());
    const beforeCover = new Date(coverStart.getTime() - 2 * 60 * 60 * 1000);
    const inCover = new Date(coverStart.getTime() + 2 * 60 * 60 * 1000);
    assert.equal(
      windowFor(beforeCover, rule).start.getTime(),
      windowFor(inCover, rule).start.getTime(),
      'fixture: both readings must fall in the one window that holds the cover start'
    );
    await insertDay(policy.id, [
      [beforeCover.toISOString(), -1.8],
      [inCover.toISOString(), -0.5],
    ]);
    const inCoverId = (
      await pool.query('SELECT id FROM oracle_readings WHERE policy_id = $1 AND measured_at = $2', [policy.id, inCover])
    ).rows[0].id;

    await queueClosedWindows({ insurerIds: [insurerId] });

    const win = (await pool.query('SELECT * FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows;
    assert.equal(win.length, 1, 'fixture: the window holding the cover start is closed and evaluated');
    assert.equal(
      Number(win[0].aggregated_value),
      -0.5,
      `expected the min of the readings inside cover (-0.5, measured ${inCover.toISOString()}); ` +
        `got ${win[0].aggregated_value}, and -1.8 was measured ${beforeCover.toISOString()}, before cover ` +
        `began at ${coverStart.toISOString()}`
    );
    assert.equal(win[0].determining_reading_id, inCoverId, 'the deciding reading is the one inside cover');
    // v22: and the interval starts where cover began.
    assert.equal(new Date(win[0].event_start).getTime(), coverStart.getTime(), 'the interval is clipped at the cover start');
  }
);

// ---------------------------------------------------------------------------
// The hold rule (v22). While a
// m. 1434(3) notice's deadline has passed and no outcome is recorded, a window
// ending after the deadline is neither queued nor sent; the outcome, once
// recorded, decides the interval: a termination clips it at the termination
// instant, a payment reported late releases the whole window.
//
// The notice is served with a service date 14 days (this file's fixture grace
// period) before a noon in Istanbul, 2026-09-10, so the deadline falls inside
// that local day's window, which is long closed: the "late sweeper" case, run
// here on demand.
// ---------------------------------------------------------------------------
const DEADLINE = new Date('2026-09-10T09:00:00.000Z');
const SERVICE_DATE = new Date(DEADLINE.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
const HELD_DAYS = [
  ['2026-09-09T03:00:00+03:00', -1.2], // the day before: its window ends before the deadline
  ['2026-09-10T03:00:00+03:00', -1.5], // the deadline's own day, before the deadline
  ['2026-09-10T18:00:00+03:00', -1.9], // the same day, after the deadline
  ['2026-09-11T03:00:00+03:00', -1.0], // a day wholly after the deadline
];
const windowOf = (policyId, start) =>
  pool.query('SELECT * FROM trigger_windows WHERE policy_id = $1 AND window_start = $2', [policyId, start]).then((r) => r.rows[0]);
const DAY_09 = new Date('2026-09-08T21:00:00.000Z');
const DAY_10 = new Date('2026-09-09T21:00:00.000Z');
const DAY_11 = new Date('2026-09-10T21:00:00.000Z');

async function servedNotice(policyId, serviceDate = SERVICE_DATE) {
  await pool.query(`INSERT INTO policy_events (policy_no, event_type, payload) VALUES ($1,'notice',$2)`, [
    policyId,
    JSON.stringify({ serviceDate }),
  ]);
  await dispatch();
  const row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policyId])).rows[0];
  assert.equal(row.default_state, 'grace_period', 'fixture: the notice is served');
  return row;
}

test('coverBoundFor: the deadline, the recorded termination and the two-notice instant, from SQL alone', () => {
  const base = { id: 'p', expiry: '2027-03-31T09:00:00.000Z', grace_period_days: 14 };
  assert.deepEqual(coverBoundFor({ ...base, default_state: 'none' }), { end: new Date(base.expiry), deadline: null });
  const inGrace = coverBoundFor({ ...base, default_state: 'grace_period', notice_service_date: SERVICE_DATE });
  assert.equal(inGrace.deadline.getTime(), DEADLINE.getTime(), 'the service date plus the frozen grace period');
  assert.equal(inGrace.end.getTime(), new Date(base.expiry).getTime(), 'the end does not move before the outcome');
  assert.equal(
    coverBoundFor({ ...base, default_state: 'grace_period', notice_service_date: SERVICE_DATE, substituted_at: '2026-09-05T00:00:00Z' }).deadline,
    null,
    'a substituted policy is never terminated, so nothing is held'
  );
  const terminated = coverBoundFor({ ...base, default_state: 'terminated', terminated_at: DEADLINE.toISOString() });
  assert.equal(terminated.end.getTime(), DEADLINE.getTime());
  assert.equal(terminated.deadline, null);
  const elected = coverBoundFor({ ...base, default_state: 'two_notice_elected', two_notice_effective_at: '2026-12-31T21:00:00Z' });
  assert.equal(elected.end.getTime(), new Date('2026-12-31T21:00:00Z').getTime(), 'clipped at the election\'s instant from the election on');
  assert.match(coverBoundFor({ ...base, default_state: 'terminated' }).reason, /records no terminated_at/);
});

test('late sweeper: a window ending after the deadline is held, not queued; once the termination is recorded it is clipped at the termination instant', async () => {
  const policy = await mintedPolicy(RULE);
  await servedNotice(policy.id);
  const readings = await insertDayWithEvidence(policy.id, HELD_DAYS);

  await queueClosedWindows({ insurerIds: [insurerId] });
  assert.ok(await windowOf(policy.id, DAY_09), 'the window ending before the deadline is queued as usual');
  assert.equal(await windowOf(policy.id, DAY_10), undefined, 'HELD: the deadline\'s own day ends after it');
  assert.equal(await windowOf(policy.id, DAY_11), undefined, 'HELD: the day after the deadline');
  await dispatch();
  assert.equal(await triggerRows(policy.id), 1, 'only the one window was queued, and sent');

  // The sweeper runs late: the termination is recorded now, at the instant the
  // notice fixed, not at the clock.
  await sweepGrace({ insurerIds: [insurerId] });
  await dispatch();
  const terminated = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(terminated.default_state, 'terminated');
  assert.equal(new Date(terminated.terminated_at).getTime(), DEADLINE.getTime());

  await queueClosedWindows({ insurerIds: [insurerId] });
  const clipped = await windowOf(policy.id, DAY_10);
  assert.ok(clipped, 'the held window is queued once the outcome is recorded');
  assert.equal(new Date(clipped.event_start).getTime(), DAY_10.getTime());
  assert.equal(new Date(clipped.event_end).getTime(), DEADLINE.getTime(), 'clipped at the termination instant');
  assert.equal(Number(clipped.aggregated_value), -1.5, 'the reading after the termination instant is not folded in');
  assert.deepEqual(clipped.reading_ids, [readings[1].reading], 'nor named by the window');
  assert.equal(await windowOf(policy.id, DAY_11), undefined, 'a window wholly after the termination has no in-cover reading');

  await dispatch();
  const payout = (
    await pool.query('SELECT * FROM payout_events WHERE trigger_window_id = $1', [clipped.id])
  ).rows[0];
  assert.ok(payout, 'the in-cover part of the last window is evaluated and paid');
  assert.equal(new Date(payout.event_end).getTime(), DEADLINE.getTime());
  assert.equal(payout.evidence_digest, `sha256:${readings[1].sha256}`, 'the digest covers the in-cover reading only');
});

test('a late payment report releases the full window', async () => {
  const policy = await mintedPolicy(RULE);
  await servedNotice(policy.id);
  await insertDayWithEvidence(policy.id, HELD_DAYS);

  await queueClosedWindows({ insurerIds: [insurerId] });
  assert.equal(await windowOf(policy.id, DAY_10), undefined, 'held while the outcome is undecided');

  await pool.query(`INSERT INTO policy_events (policy_no, event_type) VALUES ($1,'reinstatement')`, [policy.id]);
  await dispatch();
  assert.equal((await pool.query('SELECT default_state FROM policies WHERE id = $1', [policy.id])).rows[0].default_state, 'none');

  await queueClosedWindows({ insurerIds: [insurerId] });
  const full = await windowOf(policy.id, DAY_10);
  assert.equal(new Date(full.event_end).getTime(), new Date(full.window_end).getTime(), 'the whole window, not clipped');
  assert.equal(Number(full.aggregated_value), -1.9, 'every reading of the day is folded in');
  assert.ok(await windowOf(policy.id, DAY_11), 'and the day after is released too');
  await dispatch();
  const statuses = (
    await pool.query(`SELECT status FROM policy_events WHERE policy_no = $1 AND event_type = 'trigger'`, [policy.id])
  ).rows.map((r) => r.status);
  assert.deepEqual(statuses, ['done', 'done', 'done'], 'all three windows sent and accepted');
});

test('the dispatcher refuses a held row: it stays pending, and is sent once a payment is reported', async () => {
  const policy = await mintedPolicy(RULE);
  await servedNotice(policy.id);
  // Queued as if before the notice was reported: a window ending after the
  // deadline, already in the outbox.
  const { eventId } = await insertWindowedTrigger(pool, {
    policyId: policy.id, coverageCode: 'TEST-COVERAGE', cellId: 'window-cell', value: -1.0,
    eventStart: DAY_11, eventEnd: new Date(DAY_11.getTime() + 24 * 60 * 60 * 1000),
  });

  await dispatch();
  const held = (await pool.query('SELECT status FROM policy_events WHERE id = $1', [eventId])).rows[0];
  assert.equal(held.status, 'pending', 'not claimed, not failed: nothing is sent while the outcome is undecided');
  assert.equal(await count(`SELECT count(*)::int AS n FROM payout_events WHERE policy_id = $1`, [policy.id]), 0);

  await pool.query(`INSERT INTO policy_events (policy_no, event_type) VALUES ($1,'reinstatement')`, [policy.id]);
  await dispatch();
  const sent = (await pool.query('SELECT status, error FROM policy_events WHERE id = $1', [eventId])).rows[0];
  assert.equal(sent.status, 'done', sent.error ?? '');
  assert.equal(await count(`SELECT count(*)::int AS n FROM payout_events WHERE policy_id = $1`, [policy.id]), 1);
});

test('a m. 1434(4) election clips a window at the elected period end, from the election on', async () => {
  const policy = await mintedPolicy(RULE);
  // Two notices in the period, each paid, then the election -- the only way
  // m. 1434(4) is reached. The period ends at DEADLINE, inside a closed day.
  for (const serviceDate of ['2026-08-20T09:00:00.000Z', '2026-09-01T09:00:00.000Z']) {
    await servedNotice(policy.id, serviceDate);
    await pool.query(`INSERT INTO policy_events (policy_no, event_type) VALUES ($1,'reinstatement')`, [policy.id]);
    await dispatch();
  }
  await pool.query(`INSERT INTO policy_events (policy_no, event_type, payload) VALUES ($1,'two_notice_election',$2)`, [
    policy.id,
    JSON.stringify({
      electedAt: '2026-09-09T00:00:00.000Z', insurancePeriodStart: '2026-08-01T00:00:00.000Z',
      insurancePeriodEnd: DEADLINE.toISOString(),
    }),
  ]);
  await dispatch();
  assert.equal(
    (await pool.query('SELECT default_state FROM policies WHERE id = $1', [policy.id])).rows[0].default_state,
    'two_notice_elected',
    'fixture: elected, not landed'
  );
  await insertDayWithEvidence(policy.id, HELD_DAYS.slice(1));

  await queueClosedWindows({ insurerIds: [insurerId] });
  const clipped = await windowOf(policy.id, DAY_10);
  assert.equal(new Date(clipped.event_end).getTime(), DEADLINE.getTime(), 'clipped at the elected end, not held');
  assert.equal(Number(clipped.aggregated_value), -1.5, 'the reading after the elected end is not folded in');
  assert.equal(await windowOf(policy.id, DAY_11), undefined);
  await dispatch();
  const ev = (await pool.query('SELECT status, error FROM policy_events WHERE trigger_window_id = $1', [clipped.id])).rows[0];
  assert.equal(ev.status, 'done', ev.error ?? '');
});

// The same as mintedPolicy, but with no cover start: the policy is minted and
// active, and its cover has not begun because no first premium is recorded.
async function mintedPolicyCoverNotBegun(windowRule) {
  const ph = (
    await pool.query(`INSERT INTO policyholders (insurer_id, external_ref) VALUES ($1,$2) RETURNING id`, [
      insurerId,
      `test-ref-${crypto.randomUUID()}`,
    ])
  ).rows[0].id;
  const policy = (
    await pool.query(
      `INSERT INTO policies
         (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date, status, created_at,
          event_window_timezone, event_window_start_hour, event_aggregation, document_hash)
       VALUES ($1,$2,500,'TRY','2026-08-01','2027-03-31','pending_mint','2026-08-01',$3,$4,$5,$6)
       RETURNING id`,
      [insurerId, ph, windowRule.timezone, windowRule.startHour, windowRule.aggregation, DOCUMENT_HASH]
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL','["window-cell"]',10000,10000,
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
  assert.equal(row.status, 'active', 'fixture policy must mint before a window can be tested on it');
  assert.equal(row.coverage_began_at, null, 'fixture: cover has not begun');
  return row;
}

test('tokenNotLive: live, no token, no party, failed read', () => {
  const policy = { id: 'p1', insurer_id: 'i1', daml_contract_id: '00abcdef0123456789' };
  assert.equal(
    tokenNotLive(policy, new Map([['i1', new Map([['p1', new Set(['00abcdef0123456789'])]])]])),
    null,
    'an active token with its policyNo and the contract id SQL records'
  );
  const gone = tokenNotLive(policy, new Map([['i1', new Map([['p2', new Set(['00fedcba9876543210'])]])]]));
  assert.equal(gone.known, true);
  assert.match(gone.why, /00abcdef0123/, 'names the contract id SQL records');
  const noParty = tokenNotLive(policy, new Map());
  assert.equal(noParty.known, true);
  assert.match(noParty.why, /no Canton party/);
  const failed = tokenNotLive(policy, new Map([['i1', new Error('boom')]]));
  assert.equal(failed.known, false, 'a failed read is not known, not "no token"');
  assert.match(failed.why, /boom/);
});

// A token re-created on the ledger whose new contract id never reached
// SQL carries the same policyNo, so the policyNo alone calls it live.
test('tokenNotLive: an active token whose contract id is not the one SQL records, or two active tokens, is not known', () => {
  const policy = { id: 'p1', insurer_id: 'i1', daml_contract_id: '00old00000000000000' };
  const stale = tokenNotLive(policy, new Map([['i1', new Map([['p1', new Set(['00new11111111111111'])]])]]));
  assert.equal(stale?.known, false, 'the SQL contract id is not the live one: not known, so not queued');
  assert.match(stale.why, /00old0000000/, 'names the contract id SQL records');
  assert.match(stale.why, /00new1111111/, 'and the one active on the ledger');
  const two = tokenNotLive(policy, new Map([['i1', new Map([['p1', new Set(['00old00000000000000', '00bbb22222222222222'])]])]]));
  assert.equal(two?.known, false, 'two active tokens with one policyNo: not known');
  assert.match(two.why, /00old0000000/);
  assert.match(two.why, /00bbb2222222/);
});

const loggedLines = (errors) => errors.mock.calls.map((c) => c.arguments.map(String).join(' '));
const windowRows = (policyId) =>
  count('SELECT count(*)::int AS n FROM trigger_windows WHERE policy_id = $1', [policyId]);

test('a policy whose token was archived behind the platform gets no window, no trigger and no evidence row; a live one beside it does', async (t) => {
  const A = await mintedPolicy(RULE);
  const B = await mintedPolicy(RULE);
  await insertDayWithEvidence(A.id);
  await insertDayWithEvidence(B.id);
  // Archived behind the platform's back, as the ledger-refusal test above does:
  // SQL still records B as active with its contract id.
  const token = (await queryActiveContracts({ moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', parties: [insurerParty] }))
    .map((e) => e.contractEntry.JsActiveContract.createdEvent)
    .find((c) => c.contractId === B.daml_contract_id);
  await exerciseChoice({
    moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', contractId: token.contractId,
    choice: 'Archive', argument: {}, actAs: token.signatories,
  });
  const snapshot = async (id) => ({
    row: (await pool.query('SELECT to_jsonb(p)::text AS j FROM policies p WHERE id = $1', [id])).rows[0].j,
    readings: await count('SELECT count(*)::int AS n FROM oracle_readings WHERE policy_id = $1', [id]),
    events: await count('SELECT count(*)::int AS n FROM policy_events WHERE policy_no = $1', [id]),
  });
  const before = await snapshot(B.id);
  const errors = t.mock.method(console, 'error');

  await queueClosedWindows({ insurerIds: [insurerId] });

  assert.equal(await windowRows(A.id), 1, 'the live policy gets its window');
  assert.equal(await triggerRows(A.id), 1, 'and its trigger');
  assert.equal(await windowRows(B.id), 0, 'no window for a policy with no active token');
  assert.equal(await triggerRows(B.id), 0, 'no trigger for it');
  assert.deepEqual(await snapshot(B.id), before, 'its row, readings and outbox are left as they were');
  const lines = loggedLines(errors);
  assert.equal(
    lines.filter((l) => l.includes(B.id) && l.includes('no PolicyToken with its policyNo')).length,
    1,
    `expected one logged skip for ${B.id}; got: ${JSON.stringify(lines)}`
  );

  await dispatch();
  const ev = (
    await pool.query(`SELECT status, error FROM policy_events WHERE policy_no = $1 AND event_type = 'trigger'`, [A.id])
  ).rows[0];
  assert.equal(ev.status, 'done', ev.error ?? '');
  assert.equal(
    await count('SELECT count(*)::int AS n FROM attested_evidence WHERE policy_id = $1', [B.id]),
    0,
    'no permanent evidence row is written for it'
  );
  assert.deepEqual(await snapshot(B.id), before, 'nor does the dispatcher touch it');
});

test('a failed liveness read queues nothing this run, and the next run queues the same window', async (t) => {
  const C = await mintedPolicy(RULE);
  await insertDayWithEvidence(C.id);
  const errors = t.mock.method(console, 'error');

  await queueClosedWindows({
    insurerIds: [insurerId],
    activeTokens: async () => new Map([[insurerId, new Error('simulated: ledger unreachable')]]),
  });

  assert.equal(await windowRows(C.id), 0, 'not known is not a reason to queue');
  assert.equal(await triggerRows(C.id), 0);
  const lines = loggedLines(errors);
  assert.ok(
    lines.some((l) => l.includes(C.id) && l.includes('simulated')),
    `expected a logged line for ${C.id} naming the failed read; got: ${JSON.stringify(lines)}`
  );

  await queueClosedWindows({ insurerIds: [insurerId] });
  assert.equal(await windowRows(C.id), 1, 'the next run, with a read that succeeds, queues the window');
  assert.equal(await triggerRows(C.id), 1);
  await dispatch();
  const ev = (
    await pool.query(`SELECT status, error FROM policy_events WHERE policy_no = $1 AND event_type = 'trigger'`, [C.id])
  ).rows[0];
  assert.equal(ev.status, 'done', ev.error ?? '');
});

// The token is live on the ledger, but SQL records another contract id
// (a re-create whose write-back never landed). The ledger read is real.
test('a policy whose SQL contract id is not its live token\'s queues no window; once SQL matches, the next run does', async (t) => {
  const S = await mintedPolicy(RULE);
  await insertDayWithEvidence(S.id);
  const liveCid = S.daml_contract_id;
  const staleCid = `00${'5'.repeat(10)}${liveCid.slice(12)}`;
  await pool.query('UPDATE policies SET daml_contract_id = $2 WHERE id = $1', [S.id, staleCid]);
  const readings = () => count('SELECT count(*)::int AS n FROM oracle_readings WHERE policy_id = $1', [S.id]);
  const readingsBefore = await readings();
  const errors = t.mock.method(console, 'error');

  await queueClosedWindows({ insurerIds: [insurerId] });

  assert.equal(await windowRows(S.id), 0, 'a contract id that is not the live one is not a reason to queue');
  assert.equal(await triggerRows(S.id), 0);
  assert.equal(await readings(), readingsBefore, 'its readings are left where they are');
  const lines = loggedLines(errors);
  assert.ok(
    lines.some((l) => l.includes(S.id) && l.includes(staleCid.slice(0, 12)) && l.includes(liveCid.slice(0, 12)) &&
      l.includes('looked at again on the next run')),
    `expected a logged line for ${S.id} naming both contract ids; got: ${JSON.stringify(lines)}`
  );

  await pool.query('UPDATE policies SET daml_contract_id = $2 WHERE id = $1', [S.id, liveCid]);
  await queueClosedWindows({ insurerIds: [insurerId] });
  assert.equal(await windowRows(S.id), 1, 'with SQL on the live contract id, the next run queues the window');
  assert.equal(await triggerRows(S.id), 1);
  await dispatch();
  const ev = (
    await pool.query(`SELECT status, error FROM policy_events WHERE policy_no = $1 AND event_type = 'trigger'`, [S.id])
  ).rows[0];
  assert.equal(ev.status, 'done', ev.error ?? '');
});

// The readings half, which the rest of this file leaves out by inserting
// readings directly: a policy whose token is gone must stop getting readings
// too, and that is decided in runOnce. So runOnce is run here, against a
// provider stub on a loopback port (the stub-server pattern of
// oracleEndpoint.test.mjs); the ledger read and the archive are real.
test('runOnce records no reading for a policy whose token was archived and one for a live one; a failed liveness read records both', async (t) => {
  const A = await mintedPolicy(RULE);
  const B = await mintedPolicy(RULE);
  // fetchProviderResponse asks only for a cell in the stand-in format.
  await pool.query('UPDATE policy_coverages SET cell_ids = $2 WHERE policy_id = ANY($1)', [
    [A.id, B.id],
    JSON.stringify(['metno:-12.3456,98.7654']),
  ]);
  const token = (await queryActiveContracts({ moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', parties: [insurerParty] }))
    .map((e) => e.contractEntry.JsActiveContract.createdEvent)
    .find((c) => c.contractId === B.daml_contract_id);
  await exerciseChoice({
    moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', contractId: token.contractId,
    choice: 'Archive', argument: {}, actAs: token.signatories,
  });
  // Measured now, so no window of it closes during the test; 20 is outside the
  // fixture tier either way.
  const provider = http.createServer((req, res) => {
    const now = new Date().toISOString();
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        geometry: { coordinates: [98.7654, -12.3456, 0] },
        properties: {
          meta: { updated_at: now, units: { air_temperature: 'celsius' } },
          timeseries: [{ time: now, data: { instant: { details: { air_temperature: 20.0 } } } }],
        },
      })
    );
  });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  const saved = { ...config.oracle };
  config.oracle.climateApiUrl = `http://127.0.0.1:${provider.address().port}`;
  config.oracle.climateApiUserAgent = 'oracleWindow.test.mjs provider stub';
  const readings = (id) => count('SELECT count(*)::int AS n FROM oracle_readings WHERE policy_id = $1', [id]);
  try {
    const errors = t.mock.method(console, 'error');

    await runOracle({ insurerIds: [insurerId] });

    assert.equal(await readings(A.id), 1, 'the live policy gets its reading');
    assert.equal(await readings(B.id), 0, 'no reading for a policy with no active token');
    const first = loggedLines(errors);
    assert.equal(
      first.filter((l) => l.includes(B.id) && l.includes('skipped, no reading recorded')).length,
      1,
      `expected one logged skip for ${B.id}; got: ${JSON.stringify(first)}`
    );
    assert.equal(first.filter((l) => l.includes(A.id)).length, 0, 'nothing is logged against the live one');

    await runOracle({
      insurerIds: [insurerId],
      activeTokens: async () => new Map([[insurerId, new Error('simulated: ledger unreachable')]]),
    });

    assert.equal(await readings(A.id), 2, 'a failed read does not cost the live policy its reading');
    assert.equal(await readings(B.id), 1, 'not known is not "no token": the reading is recorded anyway');
    const second = loggedLines(errors).slice(first.length);
    for (const id of [A.id, B.id]) {
      assert.ok(
        second.some((l) => l.includes(id) && l.includes('NOT KNOWN') && l.includes('simulated')),
        `expected a logged NOT KNOWN line for ${id}; got: ${JSON.stringify(second)}`
      );
    }
  } finally {
    Object.assign(config.oracle, saved);
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
  }
});

// Kept last in this file: should it regress, it leaves a queued trigger, and
// no dispatch() may run after it.
test(
  'a policy whose cover has not begun gets no window and no trigger',
  async () => {
    const policy = await mintedPolicyCoverNotBegun(RULE);
    await insertDay(policy.id);

    await queueClosedWindows({ insurerIds: [insurerId] });

    const windows = await count(`SELECT count(*)::int AS n FROM trigger_windows WHERE policy_id = $1`, [policy.id]);
    const triggers = await triggerRows(policy.id);
    assert.deepEqual(
      { windows, triggers },
      { windows: 0, triggers: 0 },
      `cover has not begun (coverage_began_at is null), so expected no trigger_windows row and no trigger ` +
        `outbox row; got ${windows} window(s) and ${triggers} trigger(s)`
    );
  }
);
