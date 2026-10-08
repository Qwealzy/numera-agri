import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from '../src/db.js';
import { runOnce as sweep } from '../src/sweepers/expirySweeper.js';
import { windowFor, isClosed } from '../src/oracle/eventWindow.js';

// SQL-query tests of the sweeper's own "expired and still open" query. Now
// expirySweeper.js reads the ledger for which tokens are active
// (livePolicyNos, from oracle/oracleBot.js), and submits nothing; runOnce
// below injects activeTokens in its place, so unlike dispatcher.test.mjs
// this file needs no live Canton participant or real allocated party.

let insurerId;
// No ledger here: every fixture policy counts as having an active token,
// unless a test passes its own activeTokens.
const everyFixtureLive = async () =>
  new Map([
    [
      insurerId,
      new Map(
        (await pool.query('SELECT id, daml_contract_id FROM policies WHERE insurer_id = $1', [insurerId])).rows.map((r) => [
          r.id,
          new Set([r.daml_contract_id]),
        ])
      ),
    ],
  ]);
const runOnce = (opts) => sweep({ activeTokens: everyFixtureLive, ...opts });

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
// A fixture policy carrying `fake-cid` (or no contract id) while still
// `active` has no matching token on the ledger, so a leftover one would read
// as an orphan in the /debug/contracts reconciliation. The reconciliation is
// right -- it was the fixtures that were wrong.
//
// Scoped by this file's own insurerId, so the three test files cannot delete
// each other's rows, and nothing outside the fixtures is touched. Deleting by
// insurer also sweeps the role registry whole, which matters: a mortgagee's or beneficiary's `policyholders` row survives a
// policyholder-only sweep as residue otherwise.
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
    await client.query(`DELETE FROM trigger_windows WHERE policy_id IN (${mine})`, [insurerId]);
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

// The behaviour decided on
// 2026-09-19: the sweeper does not expire a policy before the
// last window overlapping its term has closed and been evaluated, which
// expirySweeper.js checks with lastWindowPending. This test was written red
// first, as todo, and has passed since.
//
// The sweeper reads the clock from SQL now() and takes no `now`, so the
// scenario is built around the real clock: expiry a minute ago, and a window
// rule (one UTC day from the hour three hours ago) under which the window
// holding expiry is still open.
test(
  'a policy is not expired while the last window overlapping its term is still open',
  async () => {
    const ph = await createPolicyholder();
    const nowMs = Date.now();
    const expiry = new Date(nowMs - 60 * 1000);
    const coverBegan = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
    const rule = { timezone: 'UTC', startHour: new Date(nowMs - 3 * 60 * 60 * 1000).getUTCHours(), aggregation: 'min' };
    const window = windowFor(expiry, rule);
    assert.ok(!isClosed(window, new Date()), 'fixture: the window holding expiry must still be open');
    const { rows: [policy] } = await pool.query(
      `INSERT INTO policies
         (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date,
          status, expiry, daml_contract_id, current_version, document_hash,
          coverage_began_at, coverage_start_basis, first_premium_paid_at,
          event_window_timezone, event_window_start_hour, event_aggregation)
       VALUES ($1,$2,500,'TRY',$3,$4,'active',$5,'fake-cid',1,$6,$7,'CSB_PremiumPaid',$7,$8,$9,$10)
       RETURNING *`,
      [insurerId, ph.id, coverBegan.toISOString().slice(0, 10), expiry.toISOString().slice(0, 10), expiry.toISOString(),
        DOCUMENT_HASH, coverBegan.toISOString(), rule.timezone, rule.startHour, rule.aggregation]
    );
    await pool.query(
      `INSERT INTO policy_coverages
         (policy_id, coverage_code, product_code, peril_type, cell_ids,
          sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
       VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL','["window-cell"]',10000,10000,
         '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0"}]',
         '["PDR_Insured"]','TEMPERATURE_C','PB_RemainingLimit')`,
      [policy.id]
    );
    // Measured inside cover, before expiry, in the window that is still open.
    const measuredAt = new Date(nowMs - 2 * 60 * 60 * 1000);
    assert.ok(measuredAt >= window.start && measuredAt < expiry, 'fixture: the reading is in the window, before expiry');
    await pool.query(
      `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source)
       VALUES ($1,'TEST-COVERAGE','window-cell','TEMPERATURE_C',-1.0,$2,'expirySweeper-fixture')`,
      [policy.id, measuredAt.toISOString()]
    );

    await runOnce({ insurerIds: [insurerId] });

    const rows = await expiryEventCount(policy.id);
    assert.equal(
      rows.length,
      0,
      `expiry ${expiry.toISOString()} lies in the window ${window.start.toISOString()}..` +
        `${window.end.toISOString()}, which is still open and not yet evaluated, so expected no 'expiry' ` +
        `outbox row; got ${rows.length}`
    );
  }
);

// The other side of that rule: a last window with no reading in it never gets a
// trigger_windows row, so "a row exists" cannot be what the sweeper waits for.
// Expiry two days ago under a calendar-day UTC rule, so the window holding the
// instant before expiry has closed; no readings at all. It must expire.
test('a policy past expiry whose closed last window has no readings is expired', async () => {
  const ph = await createPolicyholder();
  const nowMs = Date.now();
  const expiry = new Date(nowMs - 2 * 24 * 60 * 60 * 1000);
  const coverBegan = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
  const rule = { timezone: 'UTC', startHour: 0, aggregation: 'min' };
  const window = windowFor(new Date(expiry.getTime() - 1), rule);
  assert.ok(isClosed(window, new Date()), 'fixture: the last window must already be closed');
  const { rows: [policy] } = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date,
        status, expiry, daml_contract_id, current_version, document_hash,
        coverage_began_at, coverage_start_basis, first_premium_paid_at,
        event_window_timezone, event_window_start_hour, event_aggregation)
     VALUES ($1,$2,500,'TRY',$3,$4,'active',$5,'fake-cid',1,$6,$7,'CSB_PremiumPaid',$7,$8,$9,$10)
     RETURNING *`,
    [insurerId, ph.id, coverBegan.toISOString().slice(0, 10), expiry.toISOString().slice(0, 10), expiry.toISOString(),
      DOCUMENT_HASH, coverBegan.toISOString(), rule.timezone, rule.startHour, rule.aggregation]
  );

  await runOnce({ insurerIds: [insurerId] });

  const rows = await expiryEventCount(policy.id);
  assert.equal(
    rows.length,
    1,
    `the last window ${window.start.toISOString()}..${window.end.toISOString()} is closed and holds no ` +
      `reading, so nothing is left to evaluate and the policy expires; got ${rows.length} 'expiry' row(s)`
  );
});

// A policy past expiry whose last window, under a calendar-day UTC rule, has
// already closed, with one coverage over the given cells. Returns the policy
// and that window, and an instant inside both the window and the cover.
//
// The expiry is pinned to 00:30 UTC two days ago rather than taken from the
// clock: the half hour after a UTC midnight is where an instant a fixed hour
// before expiry falls into the previous day's window, which failed these
// fixtures every night between 00:00 and 01:00 UTC. Pinned there, every run
// exercises that case, and the instant is taken from inside the window.
async function policyWithClosedLastWindow(cellIds) {
  const ph = await createPolicyholder();
  const nowMs = Date.now();
  const utcMidnight = new Date(nowMs);
  utcMidnight.setUTCHours(0, 0, 0, 0);
  const expiry = new Date(utcMidnight.getTime() - 2 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000);
  const coverBegan = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
  const rule = { timezone: 'UTC', startHour: 0, aggregation: 'min' };
  const window = windowFor(new Date(expiry.getTime() - 1), rule);
  assert.ok(isClosed(window, new Date()), 'fixture: the last window must already be closed');
  const { rows: [policy] } = await pool.query(
    `INSERT INTO policies
       (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date,
        status, expiry, daml_contract_id, current_version, document_hash,
        coverage_began_at, coverage_start_basis, first_premium_paid_at,
        event_window_timezone, event_window_start_hour, event_aggregation)
     VALUES ($1,$2,500,'TRY',$3,$4,'active',$5,'fake-cid',1,$6,$7,'CSB_PremiumPaid',$7,$8,$9,$10)
     RETURNING *`,
    [insurerId, ph.id, coverBegan.toISOString().slice(0, 10), expiry.toISOString().slice(0, 10), expiry.toISOString(),
      DOCUMENT_HASH, coverBegan.toISOString(), rule.timezone, rule.startHour, rule.aggregation]
  );
  await pool.query(
    `INSERT INTO policy_coverages
       (policy_id, coverage_code, product_code, peril_type, cell_ids,
        sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, metric, payout_basis)
     VALUES ($1,'TEST-COVERAGE','TEST-PRODUCT','TEST-PERIL',$2,10000,10000,
       '[{"tierOrder":1,"label":"test tier","minValue":"-2.0","maxValue":"0.0","payoutPct":"25.0"}]',
       '["PDR_Insured"]','TEMPERATURE_C','PB_RemainingLimit')`,
    [policy.id, JSON.stringify(cellIds)]
  );
  // Halfway between the window's start and expiry: in the window, in cover and
  // before expiry, whatever the hour.
  const measuredAt = new Date(window.start.getTime() + Math.floor((expiry.getTime() - window.start.getTime()) / 2));
  assert.ok(measuredAt >= window.start && measuredAt >= coverBegan, 'fixture: the instant is in the window and in cover');
  return { policy, window, measuredAt };
}

async function insertReading(policyId, cellId, measuredAt) {
  const { rows: [reading] } = await pool.query(
    `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source)
     VALUES ($1,'TEST-COVERAGE',$2,'TEMPERATURE_C',-1.0,$3,'expirySweeper-fixture') RETURNING id`,
    [policyId, cellId, measuredAt.toISOString()]
  );
  return reading.id;
}

test('a closed last window with an in-cover reading and no trigger_windows row holds expiry', async () => {
  const { policy, window, measuredAt } = await policyWithClosedLastWindow(['window-cell']);
  await insertReading(policy.id, 'window-cell', measuredAt);

  await runOnce({ insurerIds: [insurerId] });

  const rows = await expiryEventCount(policy.id);
  assert.equal(
    rows.length,
    0,
    `TEST-COVERAGE/window-cell has an in-cover reading in the closed last window ` +
      `${window.start.toISOString()}..${window.end.toISOString()} and no trigger_windows row, so expected no ` +
      `'expiry' outbox row; got ${rows.length}`
  );
});

test('a pending trigger row holds expiry, and once it is done or failed the policy expires', async () => {
  for (const outcome of ['done', 'failed']) {
    const { policy, window, measuredAt } = await policyWithClosedLastWindow(['window-cell']);
    const readingId = await insertReading(policy.id, 'window-cell', measuredAt);
    const { rows: [win] } = await pool.query(
      `INSERT INTO trigger_windows
         (policy_id, coverage_code, cell_id, window_start, window_end, timezone, start_hour, aggregation, metric,
          aggregated_value, determining_reading_id, reading_ids)
       VALUES ($1,'TEST-COVERAGE','window-cell',$2,$3,'UTC',0,'min','TEMPERATURE_C',-1.0,$4,$5)
       RETURNING id`,
      [policy.id, window.start.toISOString(), window.end.toISOString(), readingId, [readingId]]
    );
    const { rows: [trigger] } = await pool.query(
      `INSERT INTO policy_events (policy_no, event_type, trigger_window_id, payload)
       VALUES ($1,'trigger',$2,'{"observedValue":-1.0,"metric":"TEMPERATURE_C","coverageCode":"TEST-COVERAGE"}')
       RETURNING id`,
      [policy.id, win.id]
    );

    await runOnce({ insurerIds: [insurerId] });
    assert.equal(
      (await expiryEventCount(policy.id)).length,
      0,
      `the last window is evaluated but its trigger row is still pending, so expected no 'expiry' outbox row`
    );

    // The outbox trigger allows pending -> processing -> {done, failed} only.
    await pool.query(`UPDATE policy_events SET status = 'processing' WHERE id = $1`, [trigger.id]);
    await pool.query(`UPDATE policy_events SET status = $2 WHERE id = $1`, [trigger.id, outcome]);

    await runOnce({ insurerIds: [insurerId] });
    assert.equal(
      (await expiryEventCount(policy.id)).length,
      1,
      `the last window's trigger row is ${outcome}, so nothing is left pending and the policy expires`
    );
  }
});

test('a reading on a cell the policy no longer covers does not hold expiry', async () => {
  const { policy, window, measuredAt } = await policyWithClosedLastWindow(['window-cell']);
  // The oracle walks policy_coverages.cell_ids, so it never evaluates this cell.
  await insertReading(policy.id, 'dropped-cell', measuredAt);

  await runOnce({ insurerIds: [insurerId] });

  const rows = await expiryEventCount(policy.id);
  assert.equal(
    rows.length,
    1,
    `the only reading in the closed last window ${window.start.toISOString()}..${window.end.toISOString()} ` +
      `is on dropped-cell, which is not in the coverage's cell_ids and so is never evaluated; expected one ` +
      `'expiry' outbox row, got ${rows.length}`
  );
});

const policyJson = async (id) =>
  (await pool.query('SELECT to_jsonb(p)::text AS j FROM policies p WHERE id = $1', [id])).rows[0].j;
const loggedLines = (errors) => errors.mock.calls.map((c) => c.arguments.map(String).join(' '));

test('an expired policy with no active token gets no expiry row and is logged; its row is untouched; a live one beside it expires', async (t) => {
  const ph = await createPolicyholder();
  const D = await createPolicyAt(ph.id, { status: 'partially_paid', expiry: YESTERDAY, damlContractId: 'fake-cid' });
  const L = await createPolicyAt(ph.id, { status: 'partially_paid', expiry: YESTERDAY, damlContractId: 'fake-cid' });
  const before = await policyJson(D.id);
  const errors = t.mock.method(console, 'error');

  await runOnce({
    insurerIds: [insurerId],
    activeTokens: async () => new Map([[insurerId, new Map([[L.id, new Set(['fake-cid'])]])]]),
  });

  assert.equal((await expiryEventCount(L.id)).length, 1, 'the policy whose token is active expires as before');
  assert.equal((await expiryEventCount(D.id)).length, 0, 'no expiry row for a policy with no active token');
  assert.equal(await policyJson(D.id), before, 'its policies row is left exactly as it was');
  const lines = loggedLines(errors);
  assert.equal(
    lines.filter((l) => l.includes(D.id) && l.includes('not queued for expiry')).length,
    1,
    `expected one logged skip for ${D.id}; got: ${JSON.stringify(lines)}`
  );
  assert.equal(lines.filter((l) => l.includes(L.id)).length, 0, 'nothing is logged against the live one');
});

test('a failed liveness read queues no expiry row this run, logs it, and the next run does', async (t) => {
  const ph = await createPolicyholder();
  const policies = [
    await createPolicyAt(ph.id, { status: 'active', expiry: YESTERDAY, damlContractId: 'fake-cid' }),
    await createPolicyAt(ph.id, { status: 'partially_paid', expiry: YESTERDAY, damlContractId: 'fake-cid' }),
  ];
  const errors = t.mock.method(console, 'error');

  await runOnce({
    insurerIds: [insurerId],
    activeTokens: async () => new Map([[insurerId, new Error('simulated: ledger unreachable')]]),
  });

  const lines = loggedLines(errors);
  for (const policy of policies) {
    assert.equal((await expiryEventCount(policy.id)).length, 0, 'not known is not a reason to expire it');
    assert.ok(
      lines.some((l) => l.includes(policy.id) && l.includes('simulated') && l.includes('looked at again')),
      `expected a logged line for ${policy.id} naming the failed read; got: ${JSON.stringify(lines)}`
    );
  }

  await runOnce({ insurerIds: [insurerId] });
  for (const policy of policies) {
    assert.equal((await expiryEventCount(policy.id)).length, 1, 'the next run, with a read that succeeds, expires it');
  }
});

// The token is active, but under another contract id than SQL records.
test('an expired policy whose SQL contract id is not its active token\'s gets no expiry row this run; once they match, it does', async (t) => {
  const ph = await createPolicyholder();
  const policy = await createPolicyAt(ph.id, { status: 'active', expiry: YESTERDAY, damlContractId: 'fake-cid' });
  const before = await policyJson(policy.id);
  const errors = t.mock.method(console, 'error');

  await runOnce({
    insurerIds: [insurerId],
    activeTokens: async () => new Map([[insurerId, new Map([[policy.id, new Set(['live-cid'])]])]]),
  });

  assert.equal((await expiryEventCount(policy.id)).length, 0, 'a contract id that is not the live one is not a reason to expire it');
  assert.equal(await policyJson(policy.id), before, 'its policies row is left exactly as it was');
  const lines = loggedLines(errors);
  assert.ok(
    lines.some((l) => l.includes(policy.id) && l.includes('fake-cid') && l.includes('live-cid') && l.includes('looked at again')),
    `expected a logged line for ${policy.id} naming both contract ids; got: ${JSON.stringify(lines)}`
  );

  await runOnce({ insurerIds: [insurerId] });
  assert.equal((await expiryEventCount(policy.id)).length, 1, 'with the live contract id SQL records, the next run expires it');
});
