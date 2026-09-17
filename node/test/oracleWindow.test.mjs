import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from '../src/db.js';
import { allocateParty, queryActiveContracts, exerciseChoice, getLedgerEnd } from '../src/damlClient.js';
import { config } from '../src/config.js';
import { runOnce as dispatch } from '../src/dispatch/dispatcher.js';
import { queueClosedWindows } from '../src/oracle/oracleBot.js';

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
       (insurer_id, product_code, peril_type, tier_order, label, threshold_min, threshold_max, payout_percentage)
     VALUES ($1, 'TEST-PRODUCT', 'TEST-PERIL', 1, 'test tier', -2.0, 0.0, 25.00)`,
    [insurerId]
  );
});

after(async () => {
  try {
    for (const [moduleName, entityName] of [
      ['Insurance.PolicyToken', 'PolicyToken'],
      ['Insurance.PayoutBridge', 'PayoutApproved'],
    ]) {
      const entries = await queryActiveContracts({ moduleName, entityName, parties: [insurerParty] }).catch(() => []);
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
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL','["window-cell"]',10000,10000,
       '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0"}]',
       '["PDR_Insured"]')`,
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
  await insertDay(policy.id);

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

test('readings with no stored response are attested as absent, not left quietly empty', async () => {
  const policy = await mintedPolicy(RULE);
  await insertDay(policy.id);
  await queueClosedWindows({ insurerIds: [insurerId] });
  const win = (await pool.query('SELECT attestation_ref FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows[0];
  assert.equal(JSON.parse(win.attestation_ref).evidence, 'absent');
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
