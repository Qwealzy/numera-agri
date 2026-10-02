import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from '../src/db.js';
import { allocateParty, queryActiveContracts, exerciseChoice, revokeUserRights } from '../src/damlClient.js';
import { config } from '../src/config.js';
import { runOnce as dispatch } from '../src/dispatch/dispatcher.js';
import { windowFor } from '../src/oracle/eventWindow.js';
import { writeRecording, fileStem, sha256 } from '../../scripts/recordProviderResponses.mjs';
import { replay } from '../../scripts/replayRecordedResponses.mjs';

// scripts/replayRecordedResponses.mjs against LocalNet: recorded responses on
// disk go through the oracle's own parse-and-store path onto a minted policy,
// keep their recorded times, and reach a window through queueClosedWindows.
// The recordings are synthetic, in the shape of the provider's response, and
// are written by the recorder's own writeRecording into a directory each test
// removes.

let insurerId;
let insurerParty;
let oracleParty;

const DOCUMENT_HASH = crypto.createHash('sha256').update('replay test policy document').digest('hex');
const CELL = 'metno:0.2468,0.1357';
const RULE = { timezone: 'Europe/Istanbul', startHour: 0, aggregation: 'min' };
// Three hours of one Istanbul day (2026-09-01T21:00Z to 2026-09-02T21:00Z),
// well in the past, so the window is closed.
const NIGHT = [
  ['2026-09-01T22:00:00Z', -1.0],
  ['2026-09-01T23:00:00Z', -1.5],
  ['2026-09-02T00:00:00Z', -0.5],
];

before(async () => {
  insurerParty = await allocateParty(
    'Test Insurer (replayRecorded.test.mjs)',
    `test-insurer-${crypto.randomUUID()}`,
    { grantActAs: true }
  );
  oracleParty = await allocateParty(
    'Test Oracle Operator (replayRecorded.test.mjs)',
    `test-oracle-operator-${crypto.randomUUID()}`,
    { grantActAs: true }
  );
  // 14 and the tier below are fixture values for this file only, as in
  // oracleWindow.test.mjs -- not statutory figures and not defaults anything
  // in production reads.
  const inserted = await pool.query(
    `INSERT INTO insurers
       (legal_name, api_key_hash, canton_party_id, canton_party_status, oracle_operator_party,
        default_grace_period_days)
     VALUES ($1, $2, $3, 'ALLOCATED', $4, 14) RETURNING id`,
    ['Test Insurer Ltd (replayRecorded fixture, fake)', crypto.randomBytes(16).toString('hex'), insurerParty, oracleParty]
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
        await client.query(`DELETE FROM policy_events WHERE policy_no IN (${mine})`, [insurerId]);
        await client.query(`DELETE FROM trigger_windows WHERE policy_id IN (${mine})`, [insurerId]);
        for (const t of ['policy_status_history', 'policy_coverages']) {
          await client.query(`DELETE FROM ${t} WHERE policy_id IN (${mine})`, [insurerId]);
        }
        const raws = (
          await client.query(
            `SELECT raw_response_id FROM oracle_readings WHERE policy_id IN (${mine}) AND raw_response_id IS NOT NULL`,
            [insurerId]
          )
        ).rows.map((r) => r.raw_response_id);
        await client.query(`DELETE FROM oracle_readings WHERE policy_id IN (${mine})`, [insurerId]);
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
      [insurerId, ph, windowRule.timezone, windowRule.startHour, windowRule.aggregation, DOCUMENT_HASH]
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL',$2,10000,10000,
       '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0","shape":"TS_Step","pctAtMin":null,"pctAtMax":null}]',
       '["PDR_Insured"]','TEMPERATURE_C','PB_RemainingLimit')`,
    [policy.id, JSON.stringify([CELL])]
  );
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, expected_version) VALUES ($1, 'activation', 0)`,
    [policy.id]
  );
  await dispatch();
  const row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(row.status, 'active', 'fixture policy must mint before anything can be replayed onto it');
  return row;
}

// A response in the provider's shape for one hour, written the way the
// recorder writes one. fetchedAt is five minutes past the hour.
function record(dir, [time, value]) {
  const body = Buffer.from(
    JSON.stringify({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0.1357, 0.2468, 10] },
      properties: {
        meta: { updated_at: time, units: { air_temperature: 'celsius' } },
        timeseries: [{ time, data: { instant: { details: { air_temperature: value } } } }],
      },
    }),
    'utf8'
  );
  const fetchedAt = new Date(Date.parse(time) + 5 * 60 * 1000).toISOString();
  writeRecording(dir, {
    cellId: CELL,
    body,
    meta: {
      cellId: CELL,
      requestUrl: 'https://fixture.invalid/weatherapi/locationforecast/2.0/compact',
      requestParams: { lat: '0.2468', lon: '0.1357' },
      httpStatus: 200,
      sha256: sha256(body),
      bytes: body.length,
      fetchedAt,
      providerUpdatedAt: time,
      timeseriesTime: time,
    },
  });
  return { time, value, fetchedAt, body };
}

function recordingsDir(t, hours) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, recorded: hours.map((h) => record(dir, h)) };
}

const quiet = () => {};
const args = (dir, policy, hours) => ({
  dir, cell: CELL, from: hours[0][0], to: hours[hours.length - 1][0], policyId: policy.id, coverageCode: 'TEST-COVERAGE',
});
const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;
const readingsOf = (policyId) =>
  pool.query(
    `SELECT r.id, r.value, r.measured_at, r.source, rr.fetched_at, rr.body, rr.sha256
       FROM oracle_readings r JOIN oracle_raw_responses rr ON rr.id = r.raw_response_id
      WHERE r.policy_id = $1 ORDER BY r.measured_at`,
    [policyId]
  ).then((r) => r.rows);
const triggerRows = (policyId) =>
  count(`SELECT count(*)::int AS n FROM policy_events WHERE policy_no = $1 AND event_type = 'trigger'`, [policyId]);

test('three recorded hours become three readings at their recorded times, labelled REPLAY; one window, one trigger', async (t) => {
  const policy = await mintedPolicy(RULE);
  const { dir, recorded } = recordingsDir(t, NIGHT);

  const result = await replay(args(dir, policy, NIGHT), quiet);
  assert.deepEqual(result, { written: 3, skipped: 0, gaps: [], windowsClosed: 1, triggersQueued: 1 });

  const rows = await readingsOf(policy.id);
  assert.equal(rows.length, 3);
  rows.forEach((r, i) => {
    const rec = recorded[i];
    assert.equal(new Date(r.measured_at).toISOString(), new Date(rec.time).toISOString(), 'measured_at is the recorded hour');
    assert.equal(new Date(r.fetched_at).toISOString(), rec.fetchedAt, 'fetched_at is the recorded fetch, not now');
    assert.deepEqual(r.body, rec.body, 'the stored bytes are the recorded bytes');
    assert.equal(r.sha256, sha256(rec.body));
    assert.equal(Number(r.value), rec.value);
    assert.ok(r.source.endsWith(` REPLAY(recorded ${rec.fetchedAt})`), r.source);
    assert.match(r.source, /STAND-IN\(forecast,not-observation\)/, 'the parser built the label, as for a live reading');
  });

  const win = (await pool.query('SELECT * FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows;
  assert.equal(win.length, 1);
  assert.equal(Number(win[0].aggregated_value), -1.5);
  assert.equal(win[0].reading_ids.length, 3);
  assert.equal(JSON.parse(win[0].attestation_ref).evidence.sha256, sha256(recorded[1].body), 'attested to the deciding recorded response');
  assert.equal(await triggerRows(policy.id), 1);
  assert.equal(
    await count(`SELECT count(*)::int AS n FROM policy_events WHERE policy_no = $1 AND event_type = 'trigger' AND status = 'pending'`, [policy.id]),
    1,
    'queued for the dispatcher, not exercised by the replay'
  );
});

test('replaying the same hours again writes no second reading', async (t) => {
  const policy = await mintedPolicy(RULE);
  const { dir } = recordingsDir(t, NIGHT);
  await replay(args(dir, policy, NIGHT), quiet);
  const lines = [];
  const again = await replay(args(dir, policy, NIGHT), (l) => lines.push(l));
  assert.equal(again.written, 0);
  assert.equal(again.skipped, 3);
  assert.equal(again.triggersQueued, 0);
  assert.equal(lines.filter((l) => l.startsWith('skipped ')).length, 3, 'each skipped hour is named');
  assert.equal((await readingsOf(policy.id)).length, 3);
  assert.equal(await triggerRows(policy.id), 1);
});

test('one changed byte in one recording refuses the replay with nothing written', async (t) => {
  const policy = await mintedPolicy(RULE);
  const { dir } = recordingsDir(t, NIGHT);
  const rawPath = path.join(dir, `${fileStem(CELL, NIGHT[2][0])}.raw`);
  const bytes = fs.readFileSync(rawPath);
  bytes[bytes.length - 2] ^= 1;
  fs.writeFileSync(rawPath, bytes);
  const rawsBefore = await count('SELECT count(*)::int AS n FROM oracle_raw_responses');

  await assert.rejects(replay(args(dir, policy, NIGHT), quiet), /1 recording\(s\) do not hash to their record, 0 lack their pair -- nothing written/);
  assert.equal((await readingsOf(policy.id)).length, 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM oracle_raw_responses'), rawsBefore);
  assert.equal(await triggerRows(policy.id), 0);
});

test('a missing hour in the range stops the replay unless gaps are allowed', async (t) => {
  const policy = await mintedPolicy(RULE);
  const { dir } = recordingsDir(t, [NIGHT[0], NIGHT[2]]);
  await assert.rejects(replay(args(dir, policy, NIGHT), quiet), /1 hour\(s\) in the range have no recording -- nothing written/);
  assert.equal((await readingsOf(policy.id)).length, 0);
  const result = await replay({ ...args(dir, policy, NIGHT), allowGaps: true }, quiet);
  assert.deepEqual(result.gaps, [NIGHT[1][0]]);
  assert.equal(result.written, 2);
});

test('a recorded hour before cover began is stored but not folded into the window', async (t) => {
  const coverStart = new Date((await pool.query(`SELECT '2026-08-15'::timestamptz AS t`)).rows[0].t);
  assert.equal(coverStart.getTime() % (60 * 60 * 1000), 0, 'fixture: cover starts on the hour');
  // One UTC day centred on the cover start, so the window straddles it.
  const rule = { timezone: 'UTC', startHour: (coverStart.getUTCHours() + 12) % 24, aggregation: 'min' };
  const policy = await mintedPolicy(rule);
  assert.equal(new Date(policy.coverage_began_at).getTime(), coverStart.getTime());
  const at = (h) => new Date(coverStart.getTime() + h * 60 * 60 * 1000).toISOString().replace('.000Z', 'Z');
  const hours = [[at(-1), -1.8], [at(0), -0.5], [at(1), -0.7]];
  assert.equal(windowFor(hours[0][0], rule).start.getTime(), windowFor(hours[2][0], rule).start.getTime(), 'fixture: one window');
  const { dir } = recordingsDir(t, hours);

  const result = await replay(args(dir, policy, hours), quiet);
  assert.equal(result.written, 3, 'every recorded hour is stored');
  const rows = await readingsOf(policy.id);
  const beforeCover = rows.find((r) => new Date(r.measured_at).getTime() < coverStart.getTime());
  assert.ok(beforeCover, 'the hour before cover began is in oracle_readings');

  const win = (await pool.query('SELECT * FROM trigger_windows WHERE policy_id = $1', [policy.id])).rows;
  assert.equal(win.length, 1);
  assert.equal(win[0].reading_ids.length, 2, 'only the in-cover readings are folded in');
  assert.ok(!win[0].reading_ids.includes(beforeCover.id), 'the pre-cover reading is not in the window');
  assert.equal(Number(win[0].aggregated_value), -0.7, 'the -1.8 before cover began does not decide it');
});
