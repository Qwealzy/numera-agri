import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { debugRouter } from '../src/routes/debug.js';
import { debugDashboardRouter } from '../src/routes/debugDashboard.js';
import { EVENT_HANDLERS, STATUTORY_MIN_GRACE_PERIOD_DAYS } from '../src/dispatch/dispatcher.js';

// The HTTP layer, on an ephemeral loopback port, against the test database.
// NO LEDGER: not one of these routes calls Canton -- they validate, write SQL
// and an outbox row, and return -- so everything here runs with LocalNet
// down. What the outbox row then does to the ledger is dispatcher.test.mjs's
// subject, and the Daml `ensure` clauses are the Script tests'.
//
// Only the API layer's own refusals are asserted here: missing or unknown
// key, field validation, the 404/409 state checks the routes make
// themselves, and the two ordering rules the routes do enforce: a settledAt
// or closedAt before the payout's approved_at is refused, and a
// premium due date reported once the first premium is recorded paid is 409.
// Any other ordering between lifecycle facts (m. 1431(4)'s
// chain, for instance) is NOT checked at this layer -- it lives in SQL
// CHECK constraints and in Daml -- so it is not asserted here either.
//
// NOT COVERED YET, all of them API-layer refusals in routes/policies.js.
// Written down because a gap nobody wrote down is a gap nobody closes:
//   - creation: mortgageeClaimAmount not a positive number; an empty
//     beneficiaryDescriptorHash; an invalid agreedCoverageStart; an empty
//     documentHash; a coverage-level claim with no policy-level mortgagee
//   - endorsement: an unknown reason; an endorsement that changes nothing;
//     an added coverage missing its own fields other than cellIds and
//     payoutTiers (both are covered)
//   - renewal: missing policyTerms/coverages; a repeated coverageCode; 404;
//     the 409s for a predecessor in premium default and a status that is not
//     renewable; and already renewed only in part -- the check under the row
//     lock is covered, the one on the route's first read, before the lock
//     (routes/policies.js, predecessor.renewed_by_policy_id), is not
//   - payouts: settle without settledAt or with an unknown paidRole; a payout
//     already resolved (409); fail without failureReason; already under
//     manual review (409); close-unpaid without unpaidReason or note
//   - the date/field checks on every other lifecycle route: a missing
//     mortgagee-notice notifiedAt, enforcement-commenced commencedAt,
//     attachment attachedAt and attachment-lifted liftedAt,
//     mortgagee-info-request requestedAt, mortgagee-info-provided providedAt,
//     enforcement-fruitless fruitlessAt, substitution-notice notifiedAt,
//     substitute-policyholder substitutedAt and first-premium-paid paidAt (a
//     paidAt in the future is covered, and an invalid date-time on each of
//     these date fields is covered); mortgagee-election election,
//     premium-due-date dueDate, attachment and attachment-lifted
//     coverageCode, two-notice-election period dates, and
//     enforcement-fruitless route
//   - the 409 "no allocated Canton party" and 404 "policy not found" branches
//     on the routes other than activate, where they are the same two checks
//     repeated; the 404 is covered on premium-due-date and first-premium-paid

const apiKey = crypto.randomBytes(16).toString('hex');
const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
// A second insurer, with no Canton party, for the 409 that activation makes
// before it looks at anything else -- and a third, allocated one, because
// that 409 comes first: only an insurer WITH a party can reach the 404 that
// proves one tenant cannot see another's policy.
const unallocatedKey = crypto.randomBytes(16).toString('hex');
const otherKey = crypto.randomBytes(16).toString('hex');

let insurerId;
let unallocatedInsurerId;
let otherInsurerId;
let server;
let base;
// oracle_raw_responses rows carry no policy id; the story tests note theirs
// here so the cleanup below can find them.
const storyRawIds = [];

before(async () => {
  const insurer = await pool.query(
    `INSERT INTO insurers (legal_name, api_key_hash, canton_party_id, canton_party_status, default_grace_period_days)
     VALUES ('Test Insurer Ltd (api fixture, fake)', $1, $2, 'ALLOCATED', 14) RETURNING id`,
    [apiKeyHash, `api-test-party-${crypto.randomUUID()}`]
  );
  insurerId = insurer.rows[0].id;
  const unallocated = await pool.query(
    `INSERT INTO insurers (legal_name, api_key_hash, canton_party_status)
     VALUES ('Test Insurer Ltd (api fixture, no party, fake)', $1, 'PENDING') RETURNING id`,
    [crypto.createHash('sha256').update(unallocatedKey).digest('hex')]
  );
  unallocatedInsurerId = unallocated.rows[0].id;
  const other = await pool.query(
    `INSERT INTO insurers (legal_name, api_key_hash, canton_party_id, canton_party_status, default_grace_period_days)
     VALUES ('Test Insurer Ltd (api fixture, other tenant, fake)', $1, $2, 'ALLOCATED', 14) RETURNING id`,
    [crypto.createHash('sha256').update(otherKey).digest('hex'), `api-test-party-${crypto.randomUUID()}`]
  );
  otherInsurerId = other.rows[0].id;
  // Every insurer here needs its own tiers: creation resolves them per
  // insurer and refuses 422 without them.
  for (const id of [insurerId, unallocatedInsurerId, otherInsurerId]) {
    await pool.query(
      `INSERT INTO payout_tiers
         (insurer_id, product_code, peril_type, tier_order, label, threshold_min, threshold_max, payout_percentage, shape)
       VALUES ($1, 'TEST-PRODUCT', 'TEST-PERIL', 1, 'test tier', -2.0, 0.0, 25.00, 'TS_Step')`,
      [id]
    );
  }

  // The app itself, with fake /health probes: nothing here touches the
  // ledger, and the database is the test one the guard pointed us at.
  // debugRoutes is the raw DEBUG_ROUTES_ENABLED value, as server.js passes it;
  // this app turns them on for the story tests below.
  const app = createApp({ probeDatabase: async () => {}, probeLedger: async () => {}, debugRoutes: 'true' });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

// Same discipline as the other writing test files: leave the database as it
// was found. The leak gate is what catches this file if it ever does not.
after(async () => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mine = 'SELECT id FROM policies WHERE insurer_id = ANY($1)';
      const ids = [[insurerId, unallocatedInsurerId, otherInsurerId].filter(Boolean)];
      await client.query(`DELETE FROM payout_notifications WHERE payout_event_id IN (SELECT id FROM payout_events WHERE policy_id IN (${mine}))`, ids);
      await client.query(`DELETE FROM payout_events WHERE policy_id IN (${mine})`, ids);
      await client.query(`DELETE FROM policy_events WHERE policy_no IN (${mine})`, ids);
      // The story fixtures' evidence chain: window, then reading, then the raw
      // response the reading names.
      await client.query(`DELETE FROM trigger_windows WHERE policy_id IN (${mine})`, ids);
      await client.query(`DELETE FROM oracle_readings WHERE policy_id IN (${mine})`, ids);
      if (storyRawIds.length) await client.query('DELETE FROM oracle_raw_responses WHERE id = ANY($1)', [storyRawIds]);
      await client.query(`DELETE FROM policy_coverages WHERE policy_id IN (${mine})`, ids);
      await client.query('DELETE FROM policies WHERE insurer_id = ANY($1)', ids);
      await client.query('DELETE FROM policyholders WHERE insurer_id = ANY($1)', ids);
      await client.query('DELETE FROM payout_tiers WHERE insurer_id = ANY($1)', ids);
      await client.query('DELETE FROM insurers WHERE id = ANY($1)', ids);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[api fixture cleanup] FAILED -- rows may be left behind:', err.message);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    server.close();
    await pool.end();
  }
});

async function call(method, path, body, key = apiKey) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { 'x-api-key': key }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* a non-JSON body is reported as-is below */ }
  return { status: res.status, body: parsed, text };
}

// The SHA-256 of a stand-in document, in the only form the API accepts, and
// three that are not: a descriptive string, one character short, upper case.
const DOCUMENT_HASH = crypto.createHash('sha256').update('api test policy document').digest('hex');
const MALFORMED_HASHES = ['sha256-of-the-policy-document', DOCUMENT_HASH.slice(0, 63), DOCUMENT_HASH.toUpperCase()];

const policyBody = (overrides = {}) => ({
  policyholder: { externalRef: `api-test-${crypto.randomUUID()}` },
  policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2026-09-01', endDate: '2027-03-31' },
  coverages: [{
    coverageCode: 'TEST-COVERAGE',
    productCode: 'TEST-PRODUCT',
    perilType: 'TEST-PERIL',
    cellIds: ['metno:41.0082,28.9784'],
    sumInsured: 10000,
    metric: 'TEMPERATURE_C',
    payoutBasis: 'PB_RemainingLimit',
  }],
  documentHash: DOCUMENT_HASH,
  ...overrides,
});

async function createPolicy(overrides) {
  const res = await call('POST', '/policies', policyBody(overrides));
  assert.equal(res.status, 201, res.text);
  return res.body.policy;
}

// A 202 answer does not carry the queued row's payload, so a
// test reads it from the outbox row the answer names.
async function queuedPayload(eventId) {
  return (await pool.query('SELECT payload FROM policy_events WHERE id = $1', [eventId])).rows[0].payload;
}

// --- authentication ---------------------------------------------------------

test('a request with no x-api-key is 401', async () => {
  const { status, body } = await call('POST', '/policies', policyBody(), null);
  assert.equal(status, 401);
  assert.equal(body.error, 'missing x-api-key header');
});

test('a request with an unknown key is 401', async () => {
  const { status, body } = await call('POST', '/policies', policyBody(), 'not-a-real-key');
  assert.equal(status, 401);
  assert.equal(body.error, 'unknown or inactive insurer');
});

// --- POST /policies ---------------------------------------------------------

test('fullName is refused outright, not silently discarded', async () => {
  const { status, body } = await call('POST', '/policies', policyBody({
    policyholder: { externalRef: 'api-test-pii', fullName: 'Ayse Yilmaz' },
  }));
  assert.equal(status, 400);
  assert.match(body.error, /fullName and nationalId are not accepted/);
});

test('nationalId is refused outright too', async () => {
  const { status, body } = await call('POST', '/policies', policyBody({
    policyholder: { externalRef: 'api-test-pii', nationalId: '12345678901' },
  }));
  assert.equal(status, 400);
  assert.match(body.error, /identify people by externalRef only/);
});

test('a product/peril with no configured tiers is 422', async () => {
  const { status, body } = await call('POST', '/policies', policyBody({
    coverages: [{
      coverageCode: 'NO-TIERS',
      productCode: 'UNCONFIGURED-PRODUCT',
      perilType: 'UNCONFIGURED-PERIL',
      cellIds: ['metno:41.0082,28.9784'],
      sumInsured: 10000,
      metric: 'TEMPERATURE_C',
      payoutBasis: 'PB_RemainingLimit',
    }],
  }));
  assert.equal(status, 422);
  assert.match(body.error, /no payout_tiers configured/);
});

test('a missing coverages array is refused', async () => {
  const { status, body } = await call('POST', '/policies', { policyholder: { externalRef: 'x' }, policyTerms: {} });
  assert.equal(status, 400);
  assert.match(body.error, /non-empty coverages array/);
});

test('a repeated coverageCode is refused', async () => {
  const one = policyBody().coverages[0];
  const { status, body } = await call('POST', '/policies', policyBody({ coverages: [one, { ...one }] }));
  assert.equal(status, 400);
  assert.match(body.error, /coverageCode must be unique/);
});

test('naming and describing a beneficiary at once is refused', async () => {
  const { status, body } = await call('POST', '/policies', policyBody({
    beneficiary: { externalRef: 'api-test-heir' },
    beneficiaryDescriptorHash: 'sha256-of-a-description',
  }));
  assert.equal(status, 400);
  assert.match(body.error, /named \(beneficiary\) or described/);
});

test('creation writes SQL only: pending_mint, no token, and no outbox row', async () => {
  const policy = await createPolicy();
  const row = (await pool.query('SELECT * FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(row.status, 'pending_mint');
  assert.equal(row.daml_contract_id, null, 'creation never mints');
  assert.equal(row.current_version, 0);
  const events = await pool.query('SELECT * FROM policy_events WHERE policy_no = $1', [policy.id]);
  assert.equal(events.rows.length, 0, 'nothing is queued until activation');
  const coverages = await pool.query('SELECT * FROM policy_coverages WHERE policy_id = $1', [policy.id]);
  assert.equal(coverages.rows.length, 1);
  assert.equal(coverages.rows[0].payout_tiers_snapshot.length, 1, 'the tier matrix is snapshotted at creation');
});

// The first real-data run saw start_date come back a day early. Storage was
// right; pg built the DATE as local midnight and JSON rendered it in UTC. The
// response must now carry exactly the stored calendar date, in any time zone.
test('start_date and end_date come back as the stored YYYY-MM-DD, never shifted a day', async () => {
  const policy = await createPolicy({
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2026-09-12', endDate: '2027-03-31' },
  });
  const stored = (
    await pool.query('SELECT start_date::text AS s, end_date::text AS e FROM policies WHERE id = $1', [policy.id])
  ).rows[0];
  assert.equal(stored.s, '2026-09-12', 'the stored date is the one that was sent');
  assert.equal(policy.start_date, stored.s);
  assert.equal(policy.end_date, stored.e);
  assert.equal(policy.end_date, '2027-03-31');
});

test('a policyTerms.startDate carrying a time and offset is refused, and nothing is written', async () => {
  const externalRef = `api-test-${crypto.randomUUID()}`;
  const { status, body } = await call('POST', '/policies', policyBody({
    policyholder: { externalRef },
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2026-09-12T19:12:13.114Z', endDate: '2027-03-31' },
  }));
  assert.equal(status, 400);
  assert.match(body.error, /policyTerms\.startDate must be a calendar date YYYY-MM-DD/);
  const written = await pool.query(
    'SELECT 1 FROM policyholders WHERE insurer_id = $1 AND external_ref = $2', [insurerId, externalRef]
  );
  assert.equal(written.rows.length, 0, 'refused before any SQL write');
});

test('a policyTerms.endDate carrying a time and offset is refused', async () => {
  const { status, body } = await call('POST', '/policies', policyBody({
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2026-09-12', endDate: '2027-09-11T21:00:00Z' },
  }));
  assert.equal(status, 400);
  assert.match(body.error, /policyTerms\.endDate must be a calendar date YYYY-MM-DD/);
});

test('a policyTerms.startDate the calendar does not have is 400, not 500', async () => {
  const { status, body } = await call('POST', '/policies', policyBody({
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2026-02-30', endDate: '2027-03-31' },
  }));
  assert.equal(status, 400);
  assert.match(body.error, /policyTerms\.startDate must be a calendar date YYYY-MM-DD/);
});

test('a policyTerms.startDate that is not a string is refused', async () => {
  const { status, body } = await call('POST', '/policies', policyBody({
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: 20260912, endDate: '2027-03-31' },
  }));
  assert.equal(status, 400);
  assert.match(body.error, /policyTerms\.startDate must be a calendar date YYYY-MM-DD/);
});

test('a policyTerms.startDate with month 13 is 400, not 500', async () => {
  const { status, body } = await call('POST', '/policies', policyBody({
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2026-13-01', endDate: '2027-03-31' },
  }));
  assert.equal(status, 400);
  assert.match(body.error, /policyTerms\.startDate must be a calendar date YYYY-MM-DD/);
});

test('a policyTerms.startDate in year 0000 is 400, not 500', async () => {
  const { status, body } = await call('POST', '/policies', policyBody({
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '0000-01-01', endDate: '2027-03-31' },
  }));
  assert.equal(status, 400);
  assert.match(body.error, /policyTerms\.startDate must be a calendar date YYYY-MM-DD/);
});

test('a policyTerms.endDate equal to startDate is refused, and nothing is written', async () => {
  const externalRef = `api-test-${crypto.randomUUID()}`;
  const { status, body } = await call('POST', '/policies', policyBody({
    policyholder: { externalRef },
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2026-09-12', endDate: '2026-09-12' },
  }));
  assert.equal(status, 400);
  assert.match(body.error, /policyTerms\.endDate must be after policyTerms\.startDate/);
  const written = await pool.query(
    'SELECT 1 FROM policyholders WHERE insurer_id = $1 AND external_ref = $2', [insurerId, externalRef]
  );
  assert.equal(written.rows.length, 0, 'refused before any SQL write');
});

test('a policyTerms.endDate before startDate is refused', async () => {
  const { status, body } = await call('POST', '/policies', policyBody({
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2027-03-31', endDate: '2026-09-01' },
  }));
  assert.equal(status, 400);
  assert.match(body.error, /policyTerms\.endDate must be after policyTerms\.startDate/);
});

test('creation without a documentHash is refused, and nothing is written', async () => {
  const externalRef = `api-test-${crypto.randomUUID()}`;
  const request = policyBody({ policyholder: { externalRef } });
  delete request.documentHash;
  const { status, body } = await call('POST', '/policies', request);
  assert.equal(status, 400);
  assert.match(body.error, /documentHash must be a SHA-256 hash/);
  const written = await pool.query(
    'SELECT 1 FROM policyholders WHERE insurer_id = $1 AND external_ref = $2', [insurerId, externalRef]
  );
  assert.equal(written.rows.length, 0, 'refused before any SQL write');
});

test('creation with a documentHash that is not 64 lowercase hex characters is refused', async () => {
  for (const documentHash of MALFORMED_HASHES) {
    const { status, body } = await call('POST', '/policies', policyBody({ documentHash }));
    assert.equal(status, 400, JSON.stringify(documentHash));
    assert.match(body.error, /documentHash must be a SHA-256 hash/);
  }
});

// The descriptor is on the ledger for good once minted, so descriptive
// text (a name, an identity number) is refused here, before any SQL write.
test('a beneficiaryDescriptorHash that is not 64 lowercase hex characters is refused, and nothing is written', async () => {
  for (const beneficiaryDescriptorHash of ['Ahmet Yilmaz, TCKN 12345678901', 'ABCD', ...MALFORMED_HASHES]) {
    const externalRef = `api-test-${crypto.randomUUID()}`;
    const { status, body } = await call('POST', '/policies', policyBody({
      policyholder: { externalRef },
      beneficiaryDescriptorHash,
    }));
    assert.equal(status, 400, JSON.stringify(beneficiaryDescriptorHash));
    assert.match(body.error, /beneficiaryDescriptorHash must be a SHA-256 hash/);
    const written = await pool.query(
      'SELECT 1 FROM policyholders WHERE insurer_id = $1 AND external_ref = $2', [insurerId, externalRef]
    );
    assert.equal(written.rows.length, 0, 'refused before any SQL write');
  }
  const hash = crypto.createHash('sha256').update('api test beneficiary designation').digest('hex');
  const policy = await createPolicy({ beneficiaryDescriptorHash: hash });
  const row = (await pool.query('SELECT beneficiary_descriptor_hash FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(row.beneficiary_descriptor_hash, hash);
});

test('the policies table itself refuses a NULL or malformed document_hash, whatever writes it', async () => {
  const policy = await createPolicy();
  const insert = (documentHash) =>
    pool.query(
      `INSERT INTO policies
         (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date, status, document_hash)
       VALUES ($1,$2,500,'TRY','2026-09-01','2027-03-31','pending_mint',$3)`,
      [insurerId, policy.policyholder_id, documentHash]
    );
  await assert.rejects(insert(null), { code: '23502', column: 'document_hash' }, 'NULL');
  for (const documentHash of MALFORMED_HASHES) {
    await assert.rejects(
      insert(documentHash),
      { code: '23514', constraint: 'policies_document_hash_is_sha256_hex' },
      JSON.stringify(documentHash)
    );
  }
});

// --- activation -------------------------------------------------------------

test('activation is 409 while the insurer has no Canton party', async () => {
  const created = await call('POST', '/policies', policyBody(), unallocatedKey);
  assert.equal(created.status, 201, created.text);
  const { status, body } = await call('POST', `/policies/${created.body.policy.id}/activate`, {}, unallocatedKey);
  assert.equal(status, 409);
  assert.match(body.error, /no allocated Canton party/);
});

test('activation is 404 for a policy that belongs to another insurer', async () => {
  const mine = await createPolicy();
  const { status, body } = await call('POST', `/policies/${mine.id}/activate`, {}, otherKey);
  assert.equal(status, 404, 'another tenant cannot see it at all');
  assert.equal(body.error, 'policy not found');
});

test('activating twice queues ONE row and returns that same row', async () => {
  const policy = await createPolicy();
  const first = await call('POST', `/policies/${policy.id}/activate`, {});
  assert.equal(first.status, 202, first.text);
  const second = await call('POST', `/policies/${policy.id}/activate`, {});
  assert.equal(second.status, 202);
  assert.equal(second.body.event.id, first.body.event.id, 'the second call returns the first row');
  const rows = await pool.query(
    `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'activation'`, [policy.id]
  );
  assert.equal(rows.rows.length, 1, 'ON CONFLICT DO NOTHING: one row, not two');
  assert.equal(rows.rows[0].status, 'pending', 'the dispatcher has not run: nothing reached the ledger');
});

// --- what a 202 answer carries -------------------------------
//
// The queued row without its payload, error text and contract ids: the salts
// and the raw bank reference stay in SQL, and error text is never
// returned.

test('a 202 answer carries no payload, error or contract id, so no salt and no bank reference', async () => {
  const policy = await createPolicy();
  const endorsed = await call('POST', `/policies/${policy.id}/endorse`, {
    reason: 'ER_InsuredObjectChange',
    coveragesToAdd: [{ ...coverageWithCells([SECOND_VALID_CELL]), coverageCode: 'TEST-COVERAGE-ADDED', payoutTiers: [stepTier(1, '-2.0000', '0.0000')] }],
  });
  assert.equal(endorsed.status, 202, endorsed.text);

  const payoutId = await insertPayout(policy.id, { approved_at: new Date(Date.now() - 3600000).toISOString() });
  const bankReference = `api-test-bankref-${crypto.randomUUID()}`;
  const settled = await call('POST', `/payouts/${payoutId}/settle`, {
    bankReference, settledAt: new Date().toISOString(), paidRole: 'PDR_Insured',
  });
  assert.equal(settled.status, 202, settled.text);
  assert.ok(!settled.text.includes(bankReference), 'the bank reference is not in the answer');

  for (const [label, res] of [['endorse', endorsed], ['settle', settled]]) {
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('textSalt'), `${label}: no textSalt`);
    assert.ok(!text.includes('cellCommitmentSalt'), `${label}: no cellCommitmentSalt`);
    for (const key of ['payload', 'error', 'resulting_contract_id', 'source_contract_id']) {
      assert.ok(!Object.hasOwn(res.body.event, key), `${label}: no ${key} key`);
    }
    assert.ok(res.body.event.id, `${label}: the event id is kept`);
    assert.ok(res.body.event.event_type, `${label}: the event type is kept`);
    assert.equal(res.body.event.status, 'pending', `${label}: the status is kept`);
  }
});

test('activating again after the activation row failed answers 202 without the error text', async () => {
  const policy = await createPolicy();
  const first = await call('POST', `/policies/${policy.id}/activate`, {});
  assert.equal(first.status, 202, first.text);
  const error = `api-test activation failure ${crypto.randomUUID()}`;
  // Claimed first, as the dispatcher does: the table refuses pending -> failed.
  await pool.query(`UPDATE policy_events SET status = 'processing' WHERE id = $1`, [first.body.event.id]);
  await pool.query(
    `UPDATE policy_events SET status = 'failed', error = $1, processed_at = now() WHERE id = $2`,
    [error, first.body.event.id]
  );
  const again = await call('POST', `/policies/${policy.id}/activate`, {});
  assert.equal(again.status, 202, again.text);
  assert.equal(again.body.event.id, first.body.event.id, 'the failed row is the one answered');
  assert.equal(again.body.event.status, 'failed');
  assert.ok(!again.text.includes(error), 'the error text is not in the answer');
  assert.ok(!Object.hasOwn(again.body.event, 'error'), 'no error key');
});

// --- renewal ----------------------------------------------------------------

test('renewal refuses a policyTerms.startDate carrying a time and offset, and queues nothing', async () => {
  const predecessor = await createPolicy();
  // Made renewable directly in SQL, so that without the date check this
  // request would be accepted rather than refused for its status: minting a
  // real predecessor needs the ledger, which this file never touches.
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  const { status, body } = await call('POST', `/policies/${predecessor.id}/renew`, {
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2027-03-31T21:00:00Z', endDate: '2027-09-30' },
    coverages: policyBody().coverages,
  });
  assert.equal(status, 400);
  assert.match(body.error, /policyTerms\.startDate must be a calendar date YYYY-MM-DD/);
  const queued = await pool.query(
    `SELECT 1 FROM policy_events WHERE policy_no = $1 AND event_type = 'renewal'`, [predecessor.id]
  );
  assert.equal(queued.rows.length, 0, 'refused before any SQL write');
});

test('renewal refuses a policyTerms.endDate carrying a time and offset', async () => {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  const { status, body } = await call('POST', `/policies/${predecessor.id}/renew`, {
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2027-03-31', endDate: '2027-09-30T21:00:00Z' },
    coverages: policyBody().coverages,
  });
  assert.equal(status, 400);
  assert.match(body.error, /policyTerms\.endDate must be a calendar date YYYY-MM-DD/);
});

test('renewal refuses a policyTerms.endDate equal to startDate, and queues nothing', async () => {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  const { status, body } = await call('POST', `/policies/${predecessor.id}/renew`, {
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2027-03-31', endDate: '2027-03-31' },
    coverages: policyBody().coverages,
  });
  assert.equal(status, 400);
  assert.match(body.error, /policyTerms\.endDate must be after policyTerms\.startDate/);
  const queued = await pool.query(
    `SELECT 1 FROM policy_events WHERE policy_no = $1 AND event_type = 'renewal'`, [predecessor.id]
  );
  assert.equal(queued.rows.length, 0, 'refused before any SQL write');
});

test('renewal without a documentHash for the new period is refused, and queues nothing', async () => {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  const { status, body } = await call('POST', `/policies/${predecessor.id}/renew`, {
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2027-03-31', endDate: '2027-09-30' },
    coverages: policyBody().coverages,
  });
  assert.equal(status, 400);
  assert.match(body.error, /documentHash must be a SHA-256 hash/);
  const queued = await pool.query(
    `SELECT 1 FROM policy_events WHERE policy_no = $1 AND event_type = 'renewal'`, [predecessor.id]
  );
  assert.equal(queued.rows.length, 0, 'refused before any SQL write');
});

test('renewal gives the new period the documentHash it was sent, not the predecessor\'s', async () => {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  const renewalHash = crypto.createHash('sha256').update('api test renewal document').digest('hex');
  const { status, body, text } = await call('POST', `/policies/${predecessor.id}/renew`, {
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2027-03-31', endDate: '2027-09-30' },
    coverages: policyBody().coverages,
    documentHash: renewalHash,
  });
  assert.equal(status, 202, text);
  const successor = (
    await pool.query('SELECT document_hash FROM policies WHERE id = $1', [body.successorPolicyId])
  ).rows[0];
  assert.equal(successor.document_hash, renewalHash);
  assert.notEqual(successor.document_hash, predecessor.document_hash, 'nothing inherited');
});

test('renewal with valid calendar dates is accepted and queues one renewal row', async () => {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  const { status, body, text } = await call('POST', `/policies/${predecessor.id}/renew`, {
    policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2027-03-31', endDate: '2027-09-30' },
    coverages: policyBody().coverages,
    documentHash: DOCUMENT_HASH,
  });
  assert.equal(status, 202, text);
  const queued = await pool.query(
    `SELECT payload FROM policy_events WHERE policy_no = $1 AND event_type = 'renewal'`, [predecessor.id]
  );
  assert.equal(queued.rows.length, 1, 'one renewal row, keyed on the predecessor');
  assert.equal(queued.rows[0].payload.newPolicyId, body.successorPolicyId);
  const successor = (
    await pool.query('SELECT start_date::text AS s, end_date::text AS e FROM policies WHERE id = $1', [
      body.successorPolicyId,
    ])
  ).rows[0];
  assert.deepEqual([successor.s, successor.e], ['2027-03-31', '2027-09-30']);
});

const validRenewal = () => ({
  policyTerms: { premiumAmount: 500, currency: 'TRY', startDate: '2027-03-31', endDate: '2027-09-30' },
  coverages: policyBody().coverages,
  documentHash: DOCUMENT_HASH,
});

// Every policy createPolicy makes has a policyholder of its own, and a renewal
// carries the policyholder over, so the predecessor's other policies are
// exactly the successors written for it. The successor's own link back to the
// predecessor is written only by the dispatcher, which never runs here.
async function successorsOf(predecessor) {
  const { rows } = await pool.query(
    'SELECT id FROM policies WHERE policyholder_id = $1 AND id <> $2', [predecessor.policyholder_id, predecessor.id]
  );
  return rows.map((r) => r.id);
}

async function renewalRowsOf(predecessor) {
  const { rows } = await pool.query(
    `SELECT id, status, payload FROM policy_events WHERE policy_no = $1 AND event_type = 'renewal'`, [predecessor.id]
  );
  return rows;
}

test('a second renewal while the first is still pending is 409, and writes no second successor or row', async () => {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  const first = await call('POST', `/policies/${predecessor.id}/renew`, validRenewal());
  assert.equal(first.status, 202, first.text);
  const second = await call('POST', `/policies/${predecessor.id}/renew`, validRenewal());
  assert.equal(second.status, 409, second.text);
  assert.ok(second.body.error.includes(first.body.successorPolicyId), `names the successor: ${second.body.error}`);
  assert.ok(second.body.error.includes(first.body.event.id), `names the event: ${second.body.error}`);
  assert.deepEqual(await successorsOf(predecessor), [first.body.successorPolicyId]);
  const rows = await renewalRowsOf(predecessor);
  assert.equal(rows.length, 1, 'one renewal row');
  assert.equal(rows[0].payload.newPolicyId, first.body.successorPolicyId);
});

test('a renewal left in processing refuses another the same way', async () => {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  const first = await call('POST', `/policies/${predecessor.id}/renew`, validRenewal());
  assert.equal(first.status, 202, first.text);
  // What a process that exits mid-dispatch leaves behind.
  await pool.query(`UPDATE policy_events SET status = 'processing' WHERE id = $1`, [first.body.event.id]);
  const second = await call('POST', `/policies/${predecessor.id}/renew`, validRenewal());
  assert.equal(second.status, 409, second.text);
  assert.ok(second.body.error.includes(first.body.successorPolicyId), `names the successor: ${second.body.error}`);
  assert.ok(second.body.error.includes(first.body.event.id), `names the event: ${second.body.error}`);
  assert.deepEqual(await successorsOf(predecessor), [first.body.successorPolicyId]);
  assert.equal((await renewalRowsOf(predecessor)).length, 1, 'one renewal row');
});

test('two renewals racing for one predecessor: one 202, one 409, one successor, one row', async () => {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  // An EXCLUSIVE lock on policies still lets both requests read the
  // predecessor and pass every check made before the transaction, and stops
  // each at its first write or row lock inside it. Released only once both are
  // waiting, so the two transactions are open at the same moment and the route
  // alone decides which one goes through.
  const holder = await pool.connect();
  let requests = [];
  let waiting = 0;
  try {
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE policies IN EXCLUSIVE MODE');
    requests = [
      call('POST', `/policies/${predecessor.id}/renew`, validRenewal()),
      call('POST', `/policies/${predecessor.id}/renew`, validRenewal()),
    ];
    for (const started = Date.now(); Date.now() - started < 10000; await new Promise((r) => setTimeout(r, 50))) {
      // Polled on a connection of its own, outside any transaction: a session
      // keeps what it first read from pg_stat_activity until its transaction
      // ends, so the holder would see the same moment every time.
      waiting = (
        await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`
        )
      ).rows[0].n;
      if (waiting >= 2) break;
    }
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  // Settled before anything is asserted, so a failure never leaves a request
  // writing while the fixture cleanup runs.
  const results = await Promise.all(requests);
  assert.equal(waiting, 2, 'both requests were waiting on the lock at once');
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 409], results.map((r) => r.text).join(' | '));
  const accepted = results.find((r) => r.status === 202);
  assert.deepEqual(await successorsOf(predecessor), [accepted.body.successorPolicyId]);
  const rows = await renewalRowsOf(predecessor);
  assert.equal(rows.length, 1, 'one renewal row');
  assert.equal(rows[0].payload.newPolicyId, accepted.body.successorPolicyId);
});

test('a renewal completed between the route\'s first read and its row lock is 409, and writes no second successor', async () => {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  const first = await call('POST', `/policies/${predecessor.id}/renew`, validRenewal());
  assert.equal(first.status, 202, first.text);
  // The same EXCLUSIVE lock lets the second request read the predecessor,
  // still unrenewed, and stops it at its row lock. While it waits there, the
  // holder commits what the dispatcher's write-back commits -- the forward
  // link and the row 'done' -- and that commit is what releases the request.
  const holder = await pool.connect();
  let request;
  let waiting = 0;
  try {
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE policies IN EXCLUSIVE MODE');
    request = call('POST', `/policies/${predecessor.id}/renew`, validRenewal());
    for (const started = Date.now(); Date.now() - started < 10000; await new Promise((r) => setTimeout(r, 50))) {
      waiting = (
        await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`
        )
      ).rows[0].n;
      if (waiting >= 1) break;
    }
    await holder.query(`UPDATE policies SET renewed_by_policy_id = $1 WHERE id = $2`, [
      first.body.successorPolicyId,
      predecessor.id,
    ]);
    await holder.query(`UPDATE policy_events SET status = 'processing' WHERE id = $1`, [first.body.event.id]);
    await holder.query(`UPDATE policy_events SET status = 'done', processed_at = now() WHERE id = $1`, [
      first.body.event.id,
    ]);
    await holder.query('COMMIT');
  } catch (err) {
    await holder.query('ROLLBACK');
    await request;
    throw err;
  } finally {
    holder.release();
  }
  const result = await request;
  assert.equal(waiting, 1, 'the request was waiting on the lock when the write-back committed');
  assert.equal(result.status, 409, result.text);
  assert.ok(result.body.error.includes(first.body.successorPolicyId), `names the successor: ${result.body.error}`);
  assert.deepEqual(await successorsOf(predecessor), [first.body.successorPolicyId]);
  const rows = await renewalRowsOf(predecessor);
  assert.equal(rows.length, 1, 'one renewal row');
  assert.equal(rows[0].status, 'done');
});

// --- lifecycle validation ---------------------------------------------------

test('a notice without serviceDate is refused', async () => {
  const policy = await createPolicy();
  const { status, body } = await call('POST', `/policies/${policy.id}/notice`, {});
  assert.equal(status, 400);
  assert.match(body.error, /serviceDate is required/);
});

test('a notice with an unparseable serviceDate is refused', async () => {
  const policy = await createPolicy();
  const { status, body } = await call('POST', `/policies/${policy.id}/notice`, { serviceDate: 'last Tuesday' });
  assert.equal(status, 400);
  assert.match(body.error, /not a valid date/);
});

test('an endorsement with no reason is refused', async () => {
  const policy = await createPolicy();
  const { status, body } = await call('POST', `/policies/${policy.id}/endorse`, { newExpiry: '2027-06-30' });
  assert.equal(status, 400);
  assert.match(body.error, /reason is required/);
});

test('an endorsement with a newDocumentHash that is not 64 lowercase hex characters is refused, and queues nothing', async () => {
  const policy = await createPolicy();
  for (const newDocumentHash of MALFORMED_HASHES) {
    const { status, body } = await call('POST', `/policies/${policy.id}/endorse`, {
      reason: 'ER_Correction',
      newDocumentHash,
    });
    assert.equal(status, 400, JSON.stringify(newDocumentHash));
    assert.match(body.error, /newDocumentHash must be a SHA-256 hash/);
  }
  const queued = await pool.query(
    `SELECT 1 FROM policy_events WHERE policy_no = $1 AND event_type = 'endorsement'`, [policy.id]
  );
  assert.equal(queued.rows.length, 0, 'refused before the outbox row');
});

// A policyholders row with a party id. Nothing here reaches the ledger, so the
// id is a stand-in string, unique as the column requires.
async function createRegisteredParty(ownerInsurerId) {
  const partyId = `api-test-registered-party-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO policyholders (insurer_id, external_ref, canton_party_id, canton_party_status)
     VALUES ($1, $2, $3, 'ALLOCATED')`,
    [ownerInsurerId, `api-test-${crypto.randomUUID()}`, partyId]
  );
  return partyId;
}

test('an endorsement naming a mortgagee party that is not one of this insurer\'s policyholders is 400, and nothing is queued', async () => {
  const policy = await createPolicy();
  const otherInsurersParty = await createRegisteredParty(otherInsurerId);
  for (const newMortgagee of [`api-test-unregistered-party-${crypto.randomUUID()}`, otherInsurersParty]) {
    const before = await policyEventCount();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/endorse`, {
      reason: 'ER_Correction',
      newMortgagee,
    });
    assert.equal(status, 400, `${newMortgagee}: ${text}`);
    assert.match(body.error, /newMortgagee must be .*one of this insurer's policyholders/);
    assert.equal(await policyEventCount(), before, `${newMortgagee}: refused before the outbox row`);
  }
});

test('an endorsement naming this insurer\'s policyholder as mortgagee, or clearing the mortgagee, is 202 and queued', async () => {
  const ownParty = await createRegisteredParty(insurerId);
  const setPolicy = await createPolicy();
  const set = await call('POST', `/policies/${setPolicy.id}/endorse`, { reason: 'ER_Correction', newMortgagee: ownParty });
  assert.equal(set.status, 202, set.text);
  assert.deepEqual((await queuedPayload(set.body.event.id)).newMortgagee, { value: ownParty });

  const clearPolicy = await createPolicy();
  const cleared = await call('POST', `/policies/${clearPolicy.id}/endorse`, { reason: 'ER_Correction', newMortgagee: null });
  assert.equal(cleared.status, 202, cleared.text);
  assert.deepEqual((await queuedPayload(cleared.body.event.id)).newMortgagee, { value: null });
});

// --- a second request while one of its kind is in flight ----
//
// A lifecycle event of a type already pending or processing on the policy,
// or a settlement report while one is queued for the payout, is refused with
// 409 naming the queued row -- not answered 202 with that row, which dropped
// whatever the second request carried.

// A row the dispatcher finishes between the route's INSERT and its read of the
// row in flight: the INSERT finds the row in flight and writes nothing, and by
// the next statement that row is 'done'. pool.query, the pool the routes use,
// is wrapped for the one request and put back whatever happens.
async function finishingBetweenInsertAndRead(eventId, request) {
  const original = pool.query;
  let fired = false;
  pool.query = async function (...args) {
    const result = await original.apply(this, args);
    if (!fired && typeof args[0] === 'string' && args[0].includes('INSERT INTO policy_events') && result.rowCount === 0) {
      fired = true;
      await original.call(pool, `UPDATE policy_events SET status = 'processing' WHERE id = $1`, [eventId]);
      await original.call(pool, `UPDATE policy_events SET status = 'done', processed_at = now() WHERE id = $1`, [eventId]);
    }
    return result;
  };
  try {
    const result = await request();
    return { result, fired };
  } finally {
    pool.query = original;
  }
}

const lifecycleRowsOf = async (policyId, eventType) => (
  await pool.query(
    `SELECT id, status, payload FROM policy_events WHERE policy_no = $1 AND event_type = $2`, [policyId, eventType]
  )
).rows;

test('a second endorsement while the first is pending is 409, names the first row, and queues nothing', async () => {
  const policy = await createPolicy();
  const first = await call('POST', `/policies/${policy.id}/endorse`, {
    reason: 'ER_SumInsuredIncrease',
    sumInsuredChanges: [{ coverageCode: 'TEST-COVERAGE', sumInsured: 20000 }],
  });
  assert.equal(first.status, 202, first.text);
  const second = await call('POST', `/policies/${policy.id}/endorse`, {
    reason: 'ER_InsuredObjectChange',
    coveragesToAdd: [{ ...coverageWithCells([SECOND_VALID_CELL]), coverageCode: 'TEST-COVERAGE-ADDED', payoutTiers: [stepTier(1, '-2.0000', '0.0000')] }],
  });
  assert.equal(second.status, 409, second.text);
  assert.ok(second.body.error.includes(first.body.event.id), `names the queued row: ${second.body.error}`);
  const rows = await lifecycleRowsOf(policy.id, 'endorsement');
  assert.equal(rows.length, 1, 'one endorsement row');
  assert.deepEqual(rows[0].payload.sumInsuredChanges, [{ coverageCode: 'TEST-COVERAGE', sumInsured: 20000 }]);
  assert.deepEqual(rows[0].payload.coveragesToAdd, [], 'the second request\'s coverage is not in it');
});

test('a second notice while the first is pending is 409, names the first row, and queues nothing', async () => {
  const policy = await createPolicy();
  const first = await call('POST', `/policies/${policy.id}/notice`, { serviceDate: '2026-09-10' });
  assert.equal(first.status, 202, first.text);
  const second = await call('POST', `/policies/${policy.id}/notice`, { serviceDate: '2026-09-11' });
  assert.equal(second.status, 409, second.text);
  assert.ok(second.body.error.includes(first.body.event.id), `names the queued row: ${second.body.error}`);
  const rows = await lifecycleRowsOf(policy.id, 'notice');
  assert.equal(rows.length, 1, 'one notice row');
  assert.equal(rows[0].payload.serviceDate, '2026-09-10');
});

test('a notice whose in-flight row finishes before the route reads it is 409 with no row named, and queues nothing', async () => {
  const policy = await createPolicy();
  const first = await call('POST', `/policies/${policy.id}/notice`, { serviceDate: '2026-09-10' });
  assert.equal(first.status, 202, first.text);
  const { result, fired } = await finishingBetweenInsertAndRead(first.body.event.id, () =>
    call('POST', `/policies/${policy.id}/notice`, { serviceDate: '2026-09-11' })
  );
  assert.ok(fired, 'not vacuous: the row finished between the INSERT and the read');
  assert.equal(result.status, 409, result.text);
  assert.match(result.body.error, /finished before it could be named -- nothing was queued/);
  assert.ok(!result.body.error.includes(first.body.event.id), 'no row is named');
  const rows = await lifecycleRowsOf(policy.id, 'notice');
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [[first.body.event.id, 'done']]);
});

// m. 1457 is recorded per coverage but the in-flight key is per policy:
// a second coverage's attachment, or its lifting, while the first
// coverage's is queued is refused by the same 409, not lost. The accepted cost:
// during a ledger outage the dispatcher claims nothing, the first row can stay
// pending for hours, and the second coverage cannot be notified until it is done.
test('an attachment for a second coverage while the first coverage\'s is pending is 409, names it, and queues nothing', async () => {
  const policy = await createPolicy({
    coverages: [
      { ...coverageWithCells([VALID_CELL]), coverageCode: 'FIRE' },
      { ...coverageWithCells([SECOND_VALID_CELL]), coverageCode: 'GLASS' },
    ],
  });
  for (const [route, eventType, dateField] of [
    ['attachment', 'attachment', 'attachedAt'],
    ['attachment-lifted', 'attachment_lifted', 'liftedAt'],
  ]) {
    const first = await call('POST', `/policies/${policy.id}/${route}`, { coverageCode: 'FIRE', [dateField]: '2026-09-15T00:00:00Z' });
    assert.equal(first.status, 202, first.text);
    const second = await call('POST', `/policies/${policy.id}/${route}`, { coverageCode: 'GLASS', [dateField]: '2026-09-15T00:00:00Z' });
    assert.equal(second.status, 409, second.text);
    assert.ok(second.body.error.includes(first.body.event.id), `names the queued row: ${second.body.error}`);
    const rows = await lifecycleRowsOf(policy.id, eventType);
    assert.equal(rows.length, 1, `one ${eventType} row`);
    assert.equal(rows[0].payload.coverageCode, 'FIRE');
  }
});

// --- coverage cells and customer references ----
//
// A coverage's cells must parse as the oracle parses them, a coverage names
// exactly one cell, and an externalRef may not have the form of a national id
// or a name. Every refusal is checked to leave NOTHING behind: no policy, no
// policyholder, no coverage, no outbox row.

const VALID_CELL = 'metno:41.0082,28.9784';
const SECOND_VALID_CELL = 'metno:41.0082,28.9785';

// [cellIds as sent, what the refusal must say]. The first three are the ones
// the oracle cannot read; the last is two cells the oracle can.
const REFUSED_CELLS = [
  [['cell-test'], /not in the stand-in format/],
  [['metno:41.00821,28.9784'], /at most 4 decimals/],
  [[], /cellIds on coverage .* must be a non-empty array/],
  [VALID_CELL, /cellIds/],
  [undefined, /cellIds/],
  [[VALID_CELL, SECOND_VALID_CELL], /names 2 cells; one cell per coverage is accepted.*not defined.*each cell would pay on its own/],
];

// Counted across the fixture insurer: a refused creation has no policy id to
// look under.
async function insurerRowCounts() {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM policies WHERE insurer_id = $1)::int AS policies,
            (SELECT count(*) FROM policyholders WHERE insurer_id = $1)::int AS policyholders,
            (SELECT count(*) FROM policy_coverages c JOIN policies p ON p.id = c.policy_id
              WHERE p.insurer_id = $1)::int AS coverages,
            (SELECT count(*) FROM policy_events e JOIN policies p ON p.id = e.policy_no
              WHERE p.insurer_id = $1)::int AS outbox`,
    [insurerId]
  );
  return rows[0];
}

const coverageWithCells = (cellIds) => ({ ...policyBody().coverages[0], cellIds });

test('creation refuses a coverage whose cells the oracle cannot read, or that names more than one, and writes nothing', async () => {
  for (const [cellIds, message] of REFUSED_CELLS) {
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', '/policies', policyBody({ coverages: [coverageWithCells(cellIds)] }));
    assert.equal(status, 400, `${JSON.stringify(cellIds)}: ${text}`);
    assert.match(body.error, message);
    assert.deepEqual(await insurerRowCounts(), before, `${JSON.stringify(cellIds)} left no row behind`);
  }
});

test('an endorsement refuses an added coverage whose cells the oracle cannot read, or that names more than one, and queues nothing', async () => {
  const policy = await createPolicy();
  for (const [cellIds, message] of REFUSED_CELLS) {
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/endorse`, {
      reason: 'ER_InsuredObjectChange',
      coveragesToAdd: [{ ...coverageWithCells(cellIds), coverageCode: 'TEST-COVERAGE-ADDED' }],
    });
    assert.equal(status, 400, `${JSON.stringify(cellIds)}: ${text}`);
    assert.match(body.error, message);
    assert.deepEqual(await insurerRowCounts(), before, `${JSON.stringify(cellIds)} left no row behind`);
  }
});

test('a renewal refuses a coverage whose cells the oracle cannot read, or that names more than one, and writes nothing', async () => {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  for (const [cellIds, message] of REFUSED_CELLS) {
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', `/policies/${predecessor.id}/renew`, {
      ...validRenewal(),
      coverages: [coverageWithCells(cellIds)],
    });
    assert.equal(status, 400, `${JSON.stringify(cellIds)}: ${text}`);
    assert.match(body.error, message);
    assert.deepEqual(await insurerRowCounts(), before, `${JSON.stringify(cellIds)} left no row behind`);
  }
});

// A premium or sum insured policies.premium_amount and
// policy_coverages.sum_insured (NUMERIC(14,2), > 0) cannot hold, or would
// round, and a coverageCode policy_coverages.coverage_code (NOT NULL) cannot
// hold or that is empty. Each one changes a create or renew body built by policyBody() or
// validRenewal().
const AMOUNT_RULE = 'must be greater than zero with at most 12 integer digits and 2 decimals';
const withPremium = (v) => (b) => ({ ...b, policyTerms: { ...b.policyTerms, premiumAmount: v } });
const withSecondSumInsured = (v) => (b) => ({
  ...b,
  coverages: [b.coverages[0], { ...b.coverages[0], coverageCode: 'FIRE', sumInsured: v }],
});
const withFirstCoverageCode = (v) => (b) => {
  const { coverageCode: _dropped, ...rest } = b.coverages[0];
  return { ...b, coverages: [v === undefined ? rest : { ...rest, coverageCode: v }] };
};
const REFUSED_TERMS = [
  ...[0, -5, 'abc', 1000.005].map((v) => [
    `premiumAmount ${JSON.stringify(v)}`, withPremium(v), `policyTerms.premiumAmount ${AMOUNT_RULE}`,
  ]),
  ...[0, 1000.005, 1e12].map((v) => [
    `sumInsured ${v}`, withSecondSumInsured(v), `coverages[1] (coverage FIRE) sumInsured ${AMOUNT_RULE}`,
  ]),
  ['no coverageCode', withFirstCoverageCode(undefined), 'coverages[0] coverageCode must be a non-empty string'],
  ['coverageCode ""', withFirstCoverageCode(''), 'coverages[0] coverageCode must be a non-empty string'],
];

test('creation refuses a premiumAmount, sumInsured or coverageCode its column cannot hold or would round, naming the field, and writes nothing', async () => {
  for (const [label, change, message] of REFUSED_TERMS) {
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', '/policies', change(policyBody()));
    assert.equal(status, 400, `${label}: ${text}`);
    assert.equal(body.error, message, label);
    assert.deepEqual(await insurerRowCounts(), before, `${label} left no row behind`);
  }
});

test('a renewal refuses the same premiumAmount, sumInsured and coverageCode, naming the field, with no successor and no renewal row', async () => {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  for (const [label, change, message] of REFUSED_TERMS) {
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', `/policies/${predecessor.id}/renew`, change(validRenewal()));
    assert.equal(status, 400, `${label}: ${text}`);
    assert.equal(body.error, message, label);
    assert.deepEqual(await insurerRowCounts(), before, `${label} left no row behind`);
    assert.deepEqual(await successorsOf(predecessor), [], `${label}: no successor`);
    assert.deepEqual(await renewalRowsOf(predecessor), [], `${label}: no renewal row`);
  }
});

test('a premiumAmount of "1500.50" or 1500 and a sumInsured of "1000.05" are 201 on creation, stored as sent, and 202 on renewal', async () => {
  for (const premiumAmount of ['1500.50', 1500]) {
    const change = (b) => withSecondSumInsured('1000.05')(withPremium(premiumAmount)(b));
    const created = await call('POST', '/policies', change(policyBody()));
    assert.equal(created.status, 201, `${premiumAmount}: ${created.text}`);
    assert.equal(created.body.policy.premium_amount, Number(premiumAmount).toFixed(2));
    assert.equal(created.body.coverages.find((c) => c.coverage_code === 'FIRE').sum_insured, '1000.05');

    await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [created.body.policy.id]);
    const renewed = await call('POST', `/policies/${created.body.policy.id}/renew`, change(validRenewal()));
    assert.equal(renewed.status, 202, `${premiumAmount}: ${renewed.text}`);
  }
});

test('an externalRef in the form of a national id or a name is refused for every role, and writes nothing', async () => {
  const refused = [
    ['12345678901', /11 digits, the form of a T\.C\. kimlik numarası/],
    ['Ayse Yilmaz', /contains whitespace, the form of a name/],
  ];
  for (const role of ['policyholder', 'insured', 'beneficiary', 'mortgagee']) {
    for (const [externalRef, message] of refused) {
      const before = await insurerRowCounts();
      const { status, body, text } = await call('POST', '/policies', policyBody({ [role]: { externalRef } }));
      assert.equal(status, 400, `${role} ${externalRef}: ${text}`);
      assert.match(body.error, message);
      assert.ok(body.error.startsWith(`${role}.externalRef`), `names the role: ${body.error}`);
      assert.ok(!body.error.includes(externalRef), `the refused value is not echoed back: ${body.error}`);
      assert.deepEqual(await insurerRowCounts(), before, `${role} ${externalRef} left no row behind`);
    }
  }
});

test('fullName or nationalId is refused for every role, and writes nothing', async () => {
  for (const role of ['policyholder', 'insured', 'beneficiary', 'mortgagee']) {
    for (const field of [{ fullName: 'Ayse Yilmaz' }, { nationalId: '12345678901' }]) {
      const before = await insurerRowCounts();
      const { status, body, text } = await call('POST', '/policies', policyBody({
        [role]: { externalRef: `api-test-${crypto.randomUUID()}`, ...field },
      }));
      assert.equal(status, 400, `${role} ${Object.keys(field)[0]}: ${text}`);
      assert.match(body.error, /fullName and nationalId are not accepted/);
      assert.deepEqual(await insurerRowCounts(), before, `${role} ${Object.keys(field)[0]} left no row behind`);
    }
  }
});

test('one readable cell per coverage and an insurer\'s own reference are accepted at all three entry points', async () => {
  const created = await call('POST', '/policies', policyBody({
    policyholder: { externalRef: `CRM-${crypto.randomUUID()}` },
    insured: { externalRef: `12345678901-${crypto.randomUUID().slice(0, 8)}` },
  }));
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.body.coverages[0].cell_ids, [VALID_CELL]);

  const endorsed = await call('POST', `/policies/${created.body.policy.id}/endorse`, {
    reason: 'ER_InsuredObjectChange',
    coveragesToAdd: [{ ...coverageWithCells([SECOND_VALID_CELL]), coverageCode: 'TEST-COVERAGE-ADDED', payoutTiers: [stepTier(1, '-2.0000', '0.0000')] }],
  });
  assert.equal(endorsed.status, 202, endorsed.text);
  assert.deepEqual((await queuedPayload(endorsed.body.event.id)).coveragesToAdd[0].cellIds, [SECOND_VALID_CELL]);

  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [created.body.policy.id]);
  const renewed = await call('POST', `/policies/${created.body.policy.id}/renew`, validRenewal());
  assert.equal(renewed.status, 202, renewed.text);
});

// The role rows are written in the policy's own transaction. A
// mortgageeClaimAmount of 1e13 passes every check the route makes and
// overflows policy_coverages.mortgagee_claim_amount NUMERIC(14,2): the last
// write of that transaction, after all four roles' rows, so a 500 here is the
// database refusing, not the route.
test('a creation the database refuses inside its transaction leaves no role\'s policyholder row behind', async () => {
  const before = await insurerRowCounts();
  const { status, text } = await call('POST', '/policies', policyBody({
    mortgagee: { externalRef: `api-test-${crypto.randomUUID()}` },
    insured: { externalRef: `api-test-${crypto.randomUUID()}` },
    beneficiary: { externalRef: `api-test-${crypto.randomUUID()}` },
    coverages: [{ ...policyBody().coverages[0], mortgageeClaimAmount: 1e13 }],
  }));
  assert.equal(status, 500, text);
  assert.deepEqual(await insurerRowCounts(), before, 'no policyholders row, of any role, and nothing else');
});

// A bank named on many policies is one row. Its first use arriving on several
// creations at once must not answer 500 on UNIQUE (insurer_id, external_ref).
test('concurrent creations naming the same new mortgagee all succeed and share one row', async () => {
  const bankRef = `api-test-bank-${crypto.randomUUID()}`;
  // A warm pool, as a running API has: cold, each request waits on a connect
  // of its own, which staggers them and hides the race.
  await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT 1')));
  const results = await Promise.all(
    Array.from({ length: 8 }, () => call('POST', '/policies', policyBody({ mortgagee: { externalRef: bankRef } })))
  );
  for (const r of results) assert.equal(r.status, 201, r.text);
  const { rows } = await pool.query(
    'SELECT id FROM policyholders WHERE insurer_id = $1 AND external_ref = $2', [insurerId, bankRef]
  );
  assert.equal(rows.length, 1);
  for (const r of results) assert.equal(r.body.mortgagee.id, rows[0].id);
});

// Two creations naming the same new people in crossed roles: X policyholder
// and Y insured on one, the reverse on the other, and two banks crossed
// between mortgagee and beneficiary. Rows written in role order let each hold
// a row the other waited on, and Postgres ended that deadlock with a 500.
test('concurrent creations naming the same new people in crossed roles all succeed', async () => {
  await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT 1')));
  for (let round = 0; round < 10; round++) {
    const [x, y, bankA, bankB] = Array.from({ length: 4 }, () => `api-test-${crypto.randomUUID()}`);
    const roles = [
      { policyholder: x, insured: y, mortgagee: bankA, beneficiary: bankB },
      { policyholder: y, insured: x, mortgagee: bankB, beneficiary: bankA },
    ];
    const results = await Promise.all(roles.map((refs) => call('POST', '/policies', policyBody(
      Object.fromEntries(Object.entries(refs).map(([role, externalRef]) => [role, { externalRef }]))
    ))));
    results.forEach((r, i) => {
      assert.equal(r.status, 201, r.text);
      for (const [role, externalRef] of Object.entries(roles[i])) assert.equal(r.body[role].external_ref, externalRef, role);
    });
    assert.equal(results[0].body.policyholder.id, results[1].body.insured.id);
    assert.equal(results[0].body.mortgagee.id, results[1].body.beneficiary.id);
  }
});

test('one person named in two roles on one creation is one row', async () => {
  const externalRef = `api-test-${crypto.randomUUID()}`;
  const created = await call('POST', '/policies', policyBody({ policyholder: { externalRef }, insured: { externalRef } }));
  assert.equal(created.status, 201, created.text);
  const { rows } = await pool.query(
    'SELECT id FROM policyholders WHERE insurer_id = $1 AND external_ref = $2', [insurerId, externalRef]
  );
  assert.equal(rows.length, 1);
  assert.equal(created.body.policyholder.id, rows[0].id);
  assert.equal(created.body.insured.id, rows[0].id);
});

// --- payouts ----------------------------------------------------------------

test('settling an unknown payout is 404', async () => {
  const { status, body } = await call('POST', `/payouts/${crypto.randomUUID()}/settle`, {
    bankReference: 'REF-1', settledAt: new Date().toISOString(), paidRole: 'PDR_Insured',
  });
  assert.equal(status, 404);
  assert.equal(body.error, 'payout not found');
});

test('settling without a bankReference is refused', async () => {
  const { status, body } = await call('POST', `/payouts/${crypto.randomUUID()}/settle`, {
    settledAt: new Date().toISOString(), paidRole: 'PDR_Insured',
  });
  assert.equal(status, 400);
  assert.match(body.error, /bankReference is required/);
});

// The API layer's own state check: a payout that is not under manual review
// cannot be closed unpaid.
test('closing an approved payout unpaid is 409 -- only a review item can be', async () => {
  const policy = await createPolicy();
  // record_kind 'payout' requires a daml_contract_id (the table's own CHECK):
  // a payout row exists because a PayoutApproved does. Nothing here reads the
  // ledger, so a fixture id stands in for one.
  const payout = (await pool.query(
    `INSERT INTO payout_events
       (policy_id, coverage_code, payout_percentage, payout_amount, currency, status, recipient,
        record_kind, daml_contract_id)
     VALUES ($1,'TEST-COVERAGE',25.00,2500.00,'TRY','approved','PDR_Insured','payout',$2) RETURNING id`,
    [policy.id, `api-test-cid-${crypto.randomUUID()}`]
  )).rows[0];
  const { status, body } = await call('POST', `/payouts/${payout.id}/close-unpaid`, {
    unpaidReason: 'UR_Other', note: 'api test', closedAt: new Date().toISOString(),
  });
  assert.equal(status, 409);
  assert.match(body.error, /is not under manual review/);
  const after = (await pool.query('SELECT status FROM payout_events WHERE id = $1', [payout.id])).rows[0];
  assert.equal(after.status, 'approved', 'a refused call changes nothing');
});

const settlementRowsOf = async (contractId) => (
  await pool.query(
    `SELECT id, status, payload FROM policy_events WHERE event_type = 'settlement' AND source_contract_id = $1`,
    [contractId]
  )
).rows;

const SETTLE_REPORT = () => ({ bankReference: 'REF-1', settledAt: new Date().toISOString(), paidRole: 'PDR_Insured' });
const FAIL_REPORT = () => ({ failureReason: 'api test: account closed' });
const CLOSE_UNPAID_REPORT = () => ({ unpaidReason: 'UR_Other', note: 'api test', closedAt: new Date().toISOString() });

test('a second settlement report while one is queued for the payout is 409, names the queued row and its action, and queues nothing', async () => {
  const policy = await createPolicy();
  const approvedAt = new Date(Date.now() - 3600000).toISOString();
  for (const [review, firstRoute, firstReport, firstAction, secondRoute, secondReport] of [
    [false, 'fail', FAIL_REPORT, 'fail', 'settle', SETTLE_REPORT],
    [false, 'settle', SETTLE_REPORT, 'settle', 'fail', FAIL_REPORT],
    [true, 'close-unpaid', CLOSE_UNPAID_REPORT, 'resolve_unpaid', 'settle', SETTLE_REPORT],
  ]) {
    const contractId = `api-test-${review ? 'review' : 'cid'}-${crypto.randomUUID()}`;
    const payoutId = await insertPayout(policy.id, review
      ? { status: 'manual_review', review_contract_id: contractId, approved_at: approvedAt }
      : { daml_contract_id: contractId, approved_at: approvedAt });
    const label = `${firstRoute} then ${secondRoute}`;
    const first = await call('POST', `/payouts/${payoutId}/${firstRoute}`, firstReport());
    assert.equal(first.status, 202, `${label}: ${first.text}`);
    // The second is a different report, the third the first one again: both refused.
    for (const [route, report] of [[secondRoute, secondReport], [firstRoute, firstReport]]) {
      const again = await call('POST', `/payouts/${payoutId}/${route}`, report());
      assert.equal(again.status, 409, `${label}, ${route}: ${again.text}`);
      assert.ok(again.body.error.includes(first.body.event.id), `${label}, ${route}: names the queued row: ${again.body.error}`);
      assert.ok(again.body.error.includes(`'${firstAction}'`), `${label}, ${route}: names its action: ${again.body.error}`);
    }
    const rows = await settlementRowsOf(contractId);
    assert.equal(rows.length, 1, `${label}: one settlement row`);
    assert.equal(rows[0].payload.action, firstAction, `${label}: the queued report is the first one`);
    assert.equal(rows[0].status, 'pending');
  }
});

test('a settlement report whose queued row finishes before the route reads it is 409 with no row named, and queues nothing', async () => {
  const policy = await createPolicy();
  const contractId = `api-test-cid-${crypto.randomUUID()}`;
  const payoutId = await insertPayout(policy.id, {
    daml_contract_id: contractId, approved_at: new Date(Date.now() - 3600000).toISOString(),
  });
  const first = await call('POST', `/payouts/${payoutId}/settle`, SETTLE_REPORT());
  assert.equal(first.status, 202, first.text);
  const { result, fired } = await finishingBetweenInsertAndRead(first.body.event.id, () =>
    call('POST', `/payouts/${payoutId}/fail`, FAIL_REPORT())
  );
  assert.ok(fired, 'not vacuous: the row finished between the INSERT and the read');
  assert.equal(result.status, 409, result.text);
  assert.match(result.body.error, /finished before it could be named -- nothing was queued/);
  assert.ok(!result.body.error.includes(first.body.event.id), 'no row is named');
  const rows = await settlementRowsOf(contractId);
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.payload.action]), [[first.body.event.id, 'done', 'settle']]);
});

// --- v22: coverage terms, closedAt, a future first-premium paidAt ------------

test('a coverage without its metric or payoutBasis, or with a metric the oracle does not supply, is refused and writes nothing', async () => {
  const one = policyBody().coverages[0];
  const refused = [
    [{ ...one, metric: undefined }, /metric on coverage TEST-COVERAGE is required and must be a code the oracle supplies \(TEMPERATURE_C\)/],
    [{ ...one, metric: 'RAINFALL_MM' }, /must be a code the oracle supplies/],
    [{ ...one, payoutBasis: undefined }, /payoutBasis on coverage TEST-COVERAGE is required, with no default/],
    [{ ...one, payoutBasis: 'PB_Whatever' }, /must be one of PB_RemainingLimit, PB_SumInsured/],
  ];
  for (const [coverage, message] of refused) {
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', '/policies', policyBody({ coverages: [coverage] }));
    assert.equal(status, 400, text);
    assert.match(body.error, message);
    assert.deepEqual(await insurerRowCounts(), before, `${JSON.stringify(coverage)} left no row behind`);
  }
});

test('a created coverage holds its metric and basis, and its cell-commitment salt is not returned', async () => {
  const created = await call('POST', '/policies', policyBody({
    coverages: [{ ...policyBody().coverages[0], payoutBasis: 'PB_SumInsured' }],
  }));
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.coverages[0].metric, 'TEMPERATURE_C');
  assert.equal(created.body.coverages[0].payout_basis, 'PB_SumInsured');
  assert.ok(!('cell_commitment_salt' in created.body.coverages[0]), 'the salt stays in SQL');
  const stored = (await pool.query('SELECT cell_commitment_salt FROM policy_coverages WHERE policy_id = $1', [
    created.body.policy.id,
  ])).rows[0].cell_commitment_salt;
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.ok(!created.text.includes(stored), 'not anywhere in the response');
});

test('close-unpaid without a valid closedAt is refused before anything is queued', async () => {
  for (const closedAt of [undefined, 'not a date']) {
    const before = await policyEventCount();
    const { status, body } = await call('POST', `/payouts/${crypto.randomUUID()}/close-unpaid`, {
      unpaidReason: 'UR_Other', note: 'api test', closedAt,
    });
    assert.equal(status, 400);
    assert.match(body.error, /closedAt is required and must be a valid date/);
    assert.equal(await policyEventCount(), before);
  }
});

test('a first-premium paidAt in the future is refused with no margin, and nothing is queued', async () => {
  const policy = await createPolicy();
  const before = await policyEventCount();
  const { status, body } = await call('POST', `/policies/${policy.id}/first-premium-paid`, {
    paidAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(status, 400);
  assert.match(body.error, /is in the future/);
  assert.equal(await policyEventCount(), before);
  const past = await call('POST', `/policies/${policy.id}/first-premium-paid`, { paidAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(past.status, 202, past.text);
});

// --- the insurer's reported instants: settledAt, closedAt, a first premium --

test('a settledAt in the future is refused with no margin, and nothing is queued', async () => {
  const policy = await createPolicy();
  const payoutId = await insertPayout(policy.id, { approved_at: new Date(Date.now() - 3600000).toISOString() });
  const before = await policyEventCount();
  const { status, body } = await call('POST', `/payouts/${payoutId}/settle`, {
    bankReference: 'REF-1', settledAt: new Date(Date.now() + 60000).toISOString(), paidRole: 'PDR_Insured',
  });
  assert.equal(status, 400);
  assert.match(body.error, /settledAt \S+ is in the future/);
  assert.equal(await policyEventCount(), before);
});

test('a settledAt before the payout\'s approved_at is refused and nothing is queued; one at approved_at is accepted', async () => {
  const policy = await createPolicy();
  const approvedAt = new Date(Date.now() - 3600000);
  const payoutId = await insertPayout(policy.id, { approved_at: approvedAt.toISOString() });
  const before = await policyEventCount();
  const { status, body } = await call('POST', `/payouts/${payoutId}/settle`, {
    bankReference: 'REF-1', settledAt: new Date(approvedAt.getTime() - 1).toISOString(), paidRole: 'PDR_Insured',
  });
  assert.equal(status, 400);
  assert.match(body.error, /settledAt \S+ is before .*approved_at/);
  assert.equal(await policyEventCount(), before);
  const at = await call('POST', `/payouts/${payoutId}/settle`, {
    bankReference: 'REF-1', settledAt: approvedAt.toISOString(), paidRole: 'PDR_Insured',
  });
  assert.equal(at.status, 202, at.text);
});

// A payout reported failed, now a review item. Not an unrouted remainder: the
// recordKind filter test below counts this insurer's remainders exactly.
test('a closedAt in the future, or before the review item\'s approved_at, is refused, and nothing is queued', async () => {
  const policy = await createPolicy();
  const approvedAt = new Date(Date.now() - 3600000);
  const payoutId = await insertPayout(policy.id, {
    status: 'manual_review', review_contract_id: `api-test-review-${crypto.randomUUID()}`,
    approved_at: approvedAt.toISOString(),
  });
  for (const [closedAt, message] of [
    [new Date(Date.now() + 60000).toISOString(), /closedAt \S+ is in the future/],
    [new Date(approvedAt.getTime() - 1).toISOString(), /closedAt \S+ is before .*approved_at/],
  ]) {
    const before = await policyEventCount();
    const { status, body } = await call('POST', `/payouts/${payoutId}/close-unpaid`, {
      unpaidReason: 'UR_Other', note: 'api test', closedAt,
    });
    assert.equal(status, 400, closedAt);
    assert.match(body.error, message);
    assert.equal(await policyEventCount(), before);
  }
});

test('settle and close-unpaid on a payout with no approved_at are 409 and queue nothing: the bound cannot be checked', async () => {
  const policy = await createPolicy();
  const approved = await insertPayout(policy.id);
  const inReview = await insertPayout(policy.id, {
    status: 'manual_review', review_contract_id: `api-test-review-${crypto.randomUUID()}`,
  });
  for (const [payoutId, route, report] of [
    [approved, 'settle', { bankReference: 'REF-1', settledAt: new Date().toISOString(), paidRole: 'PDR_Insured' }],
    [inReview, 'close-unpaid', { unpaidReason: 'UR_Other', note: 'api test', closedAt: new Date().toISOString() }],
  ]) {
    const before = await policyEventCount();
    const { status, body, text } = await call('POST', `/payouts/${payoutId}/${route}`, report);
    assert.equal(status, 409, text);
    assert.match(body.error, /has no approved_at/);
    assert.equal(await policyEventCount(), before);
  }
});

test('a second first-premium-paid report on a policy whose first premium is recorded is 409, and nothing is queued', async () => {
  const policy = await createPolicy();
  // Only the dispatcher's write-back sets this, and nothing here reaches the
  // ledger, so the recorded payment is written directly.
  const recorded = new Date(Date.now() - 86400000).toISOString();
  await pool.query('UPDATE policies SET first_premium_paid_at = $1 WHERE id = $2', [recorded, policy.id]);
  const before = await policyEventCount();
  const { status, body } = await call('POST', `/policies/${policy.id}/first-premium-paid`, {
    paidAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(status, 409);
  assert.match(body.error, /already has its first premium recorded as paid/);
  assert.ok(body.error.includes(recorded), 'the recorded date is named');
  assert.equal(await policyEventCount(), before);
});

test('a premium due date on a policy whose first premium is recorded paid is 409, and nothing is queued', async () => {
  const policy = await createPolicy();
  // Only the dispatcher's write-back sets this, and nothing here reaches the
  // ledger, so the recorded payment is written directly.
  const recorded = new Date(Date.now() - 86400000).toISOString();
  await pool.query('UPDATE policies SET first_premium_paid_at = $1 WHERE id = $2', [recorded, policy.id]);
  const before = await policyEventCount();
  const { status, body } = await call('POST', `/policies/${policy.id}/premium-due-date`, {
    dueDate: new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  assert.equal(status, 409);
  assert.match(body.error, /already has its first premium recorded as paid/);
  assert.ok(body.error.includes(recorded), 'the recorded payment date is named');
  assert.equal(await policyEventCount(), before);
});

test('a premium due date on a policy whose first premium is not recorded paid is 202, and one row is queued', async () => {
  const policy = await createPolicy();
  const stored = (await pool.query('SELECT first_premium_paid_at FROM policies WHERE id = $1', [policy.id])).rows[0];
  assert.equal(stored.first_premium_paid_at, null, 'not vacuous: no payment is recorded');
  const { status, body, text } = await call('POST', `/policies/${policy.id}/premium-due-date`, {
    dueDate: new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  assert.equal(status, 202, text);
  assert.equal(body.event.event_type, 'premium_due_date');
  const queued = await pool.query(
    `SELECT status FROM policy_events WHERE policy_no = $1 AND event_type = 'premium_due_date'`,
    [policy.id]
  );
  assert.deepEqual(queued.rows.map((r) => r.status), ['pending']);
});

test('a premium due date or a first-premium-paid report on another insurer\'s paid policy is 404, not 409, and nothing is queued', async () => {
  const policy = await createPolicy();
  const recorded = new Date(Date.now() - 86400000).toISOString();
  await pool.query('UPDATE policies SET first_premium_paid_at = $1 WHERE id = $2', [recorded, policy.id]);
  for (const [route, report] of [
    ['premium-due-date', { dueDate: new Date(Date.now() - 30 * 86400000).toISOString() }],
    ['first-premium-paid', { paidAt: new Date(Date.now() - 1000).toISOString() }],
  ]) {
    const before = await policyEventCount();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/${route}`, report, otherKey);
    assert.equal(status, 404, `${route}: ${text}`);
    assert.equal(body.error, 'policy not found');
    assert.ok(!text.includes(recorded), `${route}: the recorded payment date is not disclosed`);
    assert.equal(await policyEventCount(), before);
    const own = await call('POST', `/policies/${policy.id}/${route}`, report);
    assert.equal(own.status, 409, `${route}, not vacuous: the owner is refused 409: ${own.text}`);
  }
});

// --- the reported instants' format ---------------------
//
// Only an RFC 3339 date-time with a Z or +-hh:mm offset and at most three
// fraction digits is accepted, and a refusal queues nothing.

test('a paidAt that is not an RFC 3339 date-time with an offset is 400, and nothing is queued', async () => {
  const policy = await createPolicy();
  for (const paidAt of [
    true, 1, '2024-03-05 10:00', '2026-09-10', '2026-09-10T09:00:00.1234Z', '2026-02-30T09:00:00Z',
    '2026-09-10T24:00:00Z', '2026-09-10T09:60:00Z', '2026-09-10T09:00:60Z', '2026-09-10T09:00:00+24:00',
    '0000-09-10T09:00:00Z', '2026-09-10T09:00:00', '2026-09-10T09:00:00+03:60',
  ]) {
    const before = await policyEventCount();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/first-premium-paid`, { paidAt });
    assert.equal(status, 400, `${JSON.stringify(paidAt)}: ${text}`);
    assert.match(body.error, /paidAt is required and must be a valid date.*RFC 3339/);
    assert.equal(await policyEventCount(), before, JSON.stringify(paidAt));
  }
});

test('a paidAt with Z, with +03:00, with three fraction digits or in lower case is 202, each on its own policy, and queued as sent', async () => {
  for (const paidAt of [
    '2026-09-10T09:00:00Z', '2026-09-10T12:00:00+03:00', '2026-09-10T09:00:00.123Z', '2026-09-10t09:00:00z',
  ]) {
    const policy = await createPolicy();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/first-premium-paid`, { paidAt });
    assert.equal(status, 202, `${paidAt}: ${text}`);
    assert.equal((await queuedPayload(body.event.id)).paidAt, paidAt);
  }
});

test('a withdrawnAt of 0, false or a bare date is 400, and nothing is queued', async () => {
  const policy = await createPolicy();
  for (const withdrawnAt of [0, false, '2026-09-10']) {
    const before = await policyEventCount();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/withdraw-first-premium`, { withdrawnAt });
    assert.equal(status, 400, `${JSON.stringify(withdrawnAt)}: ${text}`);
    assert.match(body.error, /withdrawnAt, if given, must be a valid date.*RFC 3339/);
    assert.equal(await policyEventCount(), before, JSON.stringify(withdrawnAt));
  }
});

test('a withdrawal with no withdrawnAt, or a null one, is 202 and dated at the request', async () => {
  for (const report of [{}, { withdrawnAt: null }]) {
    const policy = await createPolicy();
    const sent = Date.now();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/withdraw-first-premium`, report);
    const answered = Date.now();
    assert.equal(status, 202, `${JSON.stringify(report)}: ${text}`);
    const withdrawnAt = new Date((await queuedPayload(body.event.id)).withdrawnAt).getTime();
    assert.ok(withdrawnAt >= sent && withdrawnAt <= answered, `${JSON.stringify(report)}: dated at the request`);
  }
});

test('every other reported instant sent as a bare date is 400, and nothing is queued', async () => {
  const policy = await createPolicy();
  const bare = '2026-09-10';
  for (const [route, field, body] of [
    [`/payouts/${crypto.randomUUID()}/settle`, 'settledAt', { bankReference: 'REF-1', paidRole: 'PDR_Insured' }],
    [`/payouts/${crypto.randomUUID()}/close-unpaid`, 'closedAt', { unpaidReason: 'UR_Other', note: 'api test' }],
    [`/policies/${policy.id}/mortgagee-notice`, 'notifiedAt', {}],
    [`/policies/${policy.id}/enforcement-commenced`, 'commencedAt', {}],
    [`/policies/${policy.id}/attachment`, 'attachedAt', { coverageCode: 'TEST-COVERAGE' }],
    [`/policies/${policy.id}/attachment-lifted`, 'liftedAt', { coverageCode: 'TEST-COVERAGE' }],
    [`/policies/${policy.id}/two-notice-election`, 'electedAt',
      { insurancePeriodStart: '2026-09-01', insurancePeriodEnd: '2027-03-31' }],
    [`/policies/${policy.id}/mortgagee-info-request`, 'requestedAt', {}],
    [`/policies/${policy.id}/mortgagee-info-provided`, 'providedAt', {}],
    [`/policies/${policy.id}/enforcement-fruitless`, 'fruitlessAt', { route: 'ER_Takip' }],
    [`/policies/${policy.id}/substitution-notice`, 'notifiedAt', {}],
    [`/policies/${policy.id}/substitute-policyholder`, 'substitutedAt', {}],
  ]) {
    const before = await policyEventCount();
    const res = await call('POST', route, { ...body, [field]: bare });
    assert.equal(res.status, 400, `${route}: ${res.text}`);
    assert.match(res.body.error, new RegExp(`^${field} is required and must be a valid date.*RFC 3339`));
    assert.equal(await policyEventCount(), before, route);
  }
});

// --- reading payouts (Stage 2 Part 3) ----------------------------------------
//
// The two GET endpoints the insurer pulls approved payouts from. They READ:
// nothing here may leave a policy_events row behind. The rows they read are
// inserted directly, as above -- nothing at this layer reaches the ledger.

// Read inside the tests, not at load: a missing or broken contract then fails
// the tests that need it instead of the whole file before its fixtures exist.
const recordSchema = () => JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../../docs/api/notifications-v1.openapi.json'), 'utf8')
).components.schemas.PayoutRecord;
const recordKeys = () => Object.keys(recordSchema().properties).sort();

async function createPolicyAs(key, overrides) {
  const res = await call('POST', '/policies', policyBody(overrides), key);
  assert.equal(res.status, 201, res.text);
  return res.body.policy;
}

async function insertPayout(policyId, overrides = {}) {
  const row = {
    status: 'approved', recipient: 'PDR_Insured', record_kind: 'payout',
    daml_contract_id: `api-test-cid-${crypto.randomUUID()}`, review_contract_id: null,
    created_at: null, approved_at: null, ...overrides,
  };
  return (await pool.query(
    `INSERT INTO payout_events
       (policy_id, coverage_code, payout_percentage, payout_amount, currency, status, recipient,
        record_kind, daml_contract_id, review_contract_id, created_at, approved_at)
     VALUES ($1,'TEST-COVERAGE',25.00,2500.00,'TRY',$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()), $8) RETURNING id`,
    [policyId, row.status, row.recipient, row.record_kind, row.daml_contract_id, row.review_contract_id, row.created_at,
      row.approved_at]
  )).rows[0].id;
}

const policyEventCount = async () =>
  Number((await pool.query('SELECT count(*) AS n FROM policy_events')).rows[0].n);

test('reading payouts with no x-api-key is 401, on both endpoints', async () => {
  const list = await call('GET', '/payouts', undefined, null);
  assert.equal(list.status, 401);
  assert.equal(list.body.error, 'missing x-api-key header');
  const one = await call('GET', `/payouts/${crypto.randomUUID()}`, undefined, null);
  assert.equal(one.status, 401);
});

test('a payout reads back as the contract\'s PayoutRecord, with its notifications, and writes nothing', async () => {
  const externalRef = `api-test-${crypto.randomUUID()}`;
  const policy = await createPolicy({ policyholder: { externalRef } });
  const payoutId = await insertPayout(policy.id);
  await pool.query(
    `INSERT INTO payout_notifications (payout_event_id, insurer_id, kind, last_error)
     VALUES ($1, $2, 'payout_approved', 'api test: must not be published')`,
    [payoutId, insurerId]
  );
  const before = await policyEventCount();

  const { status, body, text } = await call('GET', `/payouts/${payoutId}`);
  assert.equal(status, 200, text);
  assert.deepEqual(Object.keys(body).sort(), recordKeys());
  assert.equal(body.payoutId, payoutId);
  assert.equal(body.policyId, policy.id);
  assert.equal(body.customerRef, externalRef);
  assert.equal(body.productCode, 'TEST-PRODUCT');
  assert.equal(body.perilType, 'TEST-PERIL');
  // NUMERIC as text, to the digit.
  assert.strictEqual(body.amount, '2500.00');
  // Since v22 (migration 036) the column holds the ledger's Decimal at its
  // ten places: 25.00 inserted reads back as the same number, written out.
  assert.strictEqual(body.payoutPercentage, '25.0000000000');
  assert.strictEqual(body.approvedAt, null, 'this fixture row has no ledger approval instant');
  assert.equal(body.notifications.length, 1);
  assert.deepEqual(
    Object.keys(body.notifications[0]).sort(),
    Object.keys(recordSchema().properties.notifications.items.properties).sort()
  );
  assert.equal(body.notifications[0].type, 'payout.approved');
  assert.equal(body.notifications[0].status, 'pending');
  assert.doesNotMatch(text, /must not be published/);

  assert.equal(await policyEventCount(), before, 'a GET queues no policy_events row');
});

test('another insurer\'s payout is 404, not 403: its existence is not disclosed', async () => {
  const policy = await createPolicy();
  const payoutId = await insertPayout(policy.id);
  const asOther = await call('GET', `/payouts/${payoutId}`, undefined, otherKey);
  assert.equal(asOther.status, 404);
  assert.equal(asOther.body.error, 'payout not found');
  const unknown = await call('GET', `/payouts/${crypto.randomUUID()}`);
  assert.deepEqual(unknown.body, asOther.body, 'the same body as a payout that does not exist at all');
  assert.equal((await call('GET', `/payouts/${payoutId}`)).status, 200);
});

test('a payoutId that is not a UUID is 400, not 500', async () => {
  for (const bad of ['not-a-uuid', '123', `${crypto.randomUUID()}x`]) {
    const { status, body } = await call('GET', `/payouts/${bad}`);
    assert.equal(status, 400, bad);
    assert.equal(body.error, 'payoutId must be a UUID');
  }
});

test('a policyId or payoutId that is not a UUID is 400 on the POST routes too, not 500', async () => {
  const settle = { bankReference: 'REF-1', settledAt: new Date().toISOString(), paidRole: 'PDR_Insured' };
  for (const bad of ['not-a-uuid', '123', `${crypto.randomUUID()}x`]) {
    for (const [route, body, error] of [
      [`/policies/${bad}/activate`, {}, 'policyId must be a UUID'],
      [`/policies/${bad}/reinstate`, {}, 'policyId must be a UUID'],
      [`/policies/${bad}/renew`, {}, 'policyId must be a UUID'],
      [`/payouts/${bad}/settle`, settle, 'payoutId must be a UUID'],
    ]) {
      const res = await call('POST', route, body);
      assert.equal(res.status, 400, `${route}: ${res.text}`);
      assert.equal(res.body.error, error);
    }
  }
});

test('the list holds the caller\'s payouts only, each one a PayoutRecord, and writes nothing', async () => {
  const mine = await insertPayout((await createPolicy()).id);
  const theirs = await insertPayout((await createPolicyAs(otherKey)).id);
  const before = await policyEventCount();

  const asMe = await call('GET', '/payouts?limit=200');
  assert.equal(asMe.status, 200, asMe.text);
  const myIds = asMe.body.items.map((r) => r.payoutId);
  assert.ok(myIds.includes(mine));
  assert.ok(!myIds.includes(theirs));
  const owners = await pool.query(
    `SELECT DISTINCT p.insurer_id FROM payout_events pe JOIN policies p ON p.id = pe.policy_id
      WHERE pe.id = ANY($1::uuid[])`,
    [myIds]
  );
  assert.deepEqual(owners.rows.map((r) => r.insurer_id), [insurerId]);
  for (const record of asMe.body.items) assert.deepEqual(Object.keys(record).sort(), recordKeys());

  const asOther = await call('GET', '/payouts?limit=200', undefined, otherKey);
  assert.deepEqual(asOther.body.items.map((r) => r.payoutId), [theirs]);

  assert.equal(await policyEventCount(), before, 'a GET queues no policy_events row');
});

test('status and recordKind filter the list, and an unknown or dead value is 400', async () => {
  const policy = await createPolicy();
  const approved = await insertPayout(policy.id);
  const settled = await insertPayout(policy.id, { status: 'settled' });
  const remainder = await insertPayout(policy.id, {
    status: 'manual_review', recipient: null, record_kind: 'unrouted_remainder',
    daml_contract_id: null, review_contract_id: `api-test-review-${crypto.randomUUID()}`,
  });

  const byStatus = await call('GET', '/payouts?status=settled&limit=200');
  assert.equal(byStatus.status, 200, byStatus.text);
  assert.ok(byStatus.body.items.some((r) => r.payoutId === settled));
  assert.ok(byStatus.body.items.every((r) => r.status === 'settled'));

  const byKind = await call('GET', '/payouts?recordKind=unrouted_remainder&limit=200');
  assert.equal(byKind.status, 200, byKind.text);
  assert.deepEqual(byKind.body.items.map((r) => r.payoutId), [remainder]);
  assert.strictEqual(byKind.body.items[0].recipientRole, null);
  assert.strictEqual(byKind.body.items[0].ledgerContractId, null);

  const both = await call('GET', '/payouts?status=approved&recordKind=payout&limit=200');
  const bothIds = both.body.items.map((r) => r.payoutId);
  assert.ok(bothIds.includes(approved) && !bothIds.includes(settled) && !bothIds.includes(remainder));

  for (const query of ['status=paid', 'status=eft_pending', 'recordKind=refund']) {
    const refused = await call('GET', `/payouts?${query}`);
    assert.equal(refused.status, 400, `${query}: ${refused.text}`);
    assert.match(refused.body.error, /must be one of/);
  }
});

// The tenant with no Canton party has no other payouts in this file, so the
// page count below is exact -- and reading needs no party: nothing here
// reaches the ledger.
test('limit=2 walks five payouts in three pages: none skipped, none repeated, equal and sub-millisecond created_at included', async () => {
  const policy = await createPolicyAs(unallocatedKey);
  // B and C share one created_at, so only the id orders them. A, B/C and D
  // fall inside ONE millisecond: a cursor that carried a JS Date would round
  // all four to the same instant and lose its place among them.
  for (const createdAt of [
    '2026-01-01 00:00:00.000100+00',
    '2026-01-01 00:00:00.000200+00',
    '2026-01-01 00:00:00.000200+00',
    '2026-01-01 00:00:00.000900+00',
    '2026-01-01 00:00:01+00',
  ]) await insertPayout(policy.id, { created_at: createdAt });
  const expected = (await pool.query(
    'SELECT id FROM payout_events WHERE policy_id = $1 ORDER BY created_at ASC, id ASC', [policy.id]
  )).rows.map((r) => r.id);
  assert.equal(expected.length, 5);

  const pages = [];
  let cursor = null;
  do {
    const res = await call('GET', `/payouts?limit=2${cursor ? `&after=${cursor}` : ''}`, undefined, unallocatedKey);
    assert.equal(res.status, 200, res.text);
    pages.push(res.body.items.map((r) => r.payoutId));
    cursor = res.body.nextCursor;
    assert.ok(pages.length <= 5, 'the cursor is not advancing');
  } while (cursor);

  assert.deepEqual(pages.map((p) => p.length), [2, 2, 1]);
  assert.deepEqual(pages.flat(), expected);
});

test('a broken cursor is 400, whatever is wrong with it', async () => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const id = crypto.randomUUID();
  for (const after of [
    'not a cursor',
    Buffer.from('not json').toString('base64url'),
    encode({ c: '2026-01-01T00:00:00.000100Z' }),
    encode({ c: 'yesterday', i: id }),
    encode({ c: '2026-02-30T00:00:00.000100Z', i: id }),
    encode({ c: '2026-01-01T00:00:00.000100Z', i: 'not-a-uuid' }),
    encode(['2026-01-01T00:00:00.000100Z', id]),
  ]) {
    const res = await call('GET', `/payouts?after=${encodeURIComponent(after)}`);
    assert.equal(res.status, 400, `${after}: ${res.text}`);
    assert.equal(res.body.error, 'after is not a cursor this API issued');
  }
});

test('limit outside 1..200, or not an integer, is 400', async () => {
  for (const limit of ['0', '201', '-1', '1.5', 'ten', '']) {
    const res = await call('GET', `/payouts?limit=${limit}`);
    assert.equal(res.status, 400, `limit=${limit}: ${res.text}`);
    assert.match(res.body.error, /limit must be an integer between 1 and 200/);
  }
  assert.equal((await call('GET', '/payouts?limit=1')).status, 200);
  assert.equal((await call('GET', '/payouts?limit=200')).status, 200);
});

// --- reading a policy --------------------------------------
//
// GET /policies/:policyId: the policy's state and the outcome of the outbox
// rows its requests queued. Same authentication and tenant scope as
// GET /payouts/:payoutId. The failure below is the dispatcher's own text,
// produced by its activation handler, which refuses before any ledger call
// when the insurer has no oracle party -- as this file's insurer has not.

const policyRecordSchema = () => JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../../docs/api/notifications-v1.openapi.json'), 'utf8')
).components.schemas.PolicyRecord;

async function failActivationAsTheDispatcherWould(policyId) {
  const activated = await call('POST', `/policies/${policyId}/activate`);
  assert.equal(activated.status, 202, activated.text);
  const event = activated.body.event;
  const { rows: [policy] } = await pool.query(
    `SELECT p.*, i.canton_party_id AS insurer_canton_party_id, i.oracle_operator_party,
            i.default_grace_period_days AS insurer_default_grace_period_days
       FROM policies p JOIN insurers i ON i.id = p.insurer_id WHERE p.id = $1`,
    [policyId]
  );
  const error = await EVENT_HANDLERS.activation(event, policy).then(
    () => assert.fail('the activation handler was expected to refuse'),
    (err) => err.message
  );
  // Claimed first, as the dispatcher does: the table refuses pending -> failed.
  await pool.query(`UPDATE policy_events SET status = 'processing' WHERE id = $1`, [event.id]);
  await pool.query(
    `UPDATE policy_events SET status = 'failed', error = $1, processed_at = now() WHERE id = $2`,
    [error, event.id]
  );
  return { eventId: event.id, error };
}

test('reading a policy with no x-api-key is 401', async () => {
  const { status, body } = await call('GET', `/policies/${crypto.randomUUID()}`, undefined, null);
  assert.equal(status, 401);
  assert.equal(body.error, 'missing x-api-key header');
});

test('the insurer reads its own policy: state, coverages and events, and the read writes nothing', async () => {
  const policy = await createPolicy();
  const activated = await call('POST', `/policies/${policy.id}/activate`);
  assert.equal(activated.status, 202, activated.text);
  const before = await policyEventCount();

  const { status, body, text } = await call('GET', `/policies/${policy.id}`);
  assert.equal(status, 200, text);
  assert.deepEqual(Object.keys(body).sort(), Object.keys(policyRecordSchema().properties).sort());
  assert.equal(body.policyId, policy.id);
  assert.equal(body.status, 'pending_mint');
  assert.equal(body.defaultState, 'none');
  assert.equal(body.startDate, '2026-09-01');
  assert.equal(body.endDate, '2027-03-31');
  assert.strictEqual(body.termStart, null);
  assert.strictEqual(body.coverageBegun, false);
  assert.strictEqual(body.coverageBeganAt, null);
  assert.strictEqual(body.onLedger, false);
  assert.strictEqual(body.ledgerContractId, null);
  assert.deepEqual(body.coverages, [{
    coverageCode: 'TEST-COVERAGE', productCode: 'TEST-PRODUCT', perilType: 'TEST-PERIL',
    sumInsured: '10000.00', remainingLimit: '10000.00', cellIds: ['metno:41.0082,28.9784'],
  }]);
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].eventId, activated.body.event.id, 'the id the 202 returned');
  assert.equal(body.events[0].eventType, 'activation');
  assert.equal(body.events[0].status, 'pending');
  assert.strictEqual(body.events[0].processedAt, null);
  assert.strictEqual(body.events[0].failure, null);
  assert.strictEqual(body.eventsTruncated, false);

  // A minted policy reads its current token's id in its own field.
  const cid = `api-test-cid-${crypto.randomUUID()}`;
  await pool.query(`UPDATE policies SET daml_contract_id = $1, status = 'active' WHERE id = $2`, [cid, policy.id]);
  const minted = await call('GET', `/policies/${policy.id}`);
  assert.strictEqual(minted.body.onLedger, true);
  assert.equal(minted.body.ledgerContractId, cid);

  assert.equal(await policyEventCount(), before, 'a GET queues no policy_events row');
});

test('another insurer\'s policy is 404, the same answer as one that does not exist', async () => {
  const policy = await createPolicy();
  const asOther = await call('GET', `/policies/${policy.id}`, undefined, otherKey);
  assert.equal(asOther.status, 404);
  assert.equal(asOther.body.error, 'policy not found');
  const unknown = await call('GET', `/policies/${crypto.randomUUID()}`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, asOther.body, 'the same body as a policy that does not exist at all');
  assert.equal((await call('GET', `/policies/${policy.id}`)).status, 200);
});

// The dispatcher's write-back for a done enforcement_fruitless row, done by
// hand: nothing at this layer reaches the ledger.
async function recordFruitlessAsTheDispatcherWould(policyId, eventId, route) {
  await pool.query(`UPDATE policy_events SET status = 'processing' WHERE id = $1`, [eventId]);
  await pool.query(`UPDATE policy_events SET status = 'done', processed_at = now() WHERE id = $1`, [eventId]);
  await pool.query(
    `UPDATE policies SET enforcement_fruitless_at = now(), enforcement_route = $1 WHERE id = $2`,
    [route, policyId]
  );
}

test('the policy record carries its own recorded fruitless-enforcement route, null until one is recorded', async () => {
  const policy = await createPolicy();
  const unrecorded = await call('GET', `/policies/${policy.id}`);
  assert.equal(unrecorded.status, 200, unrecorded.text);
  assert.strictEqual(unrecorded.body.enforcementRoute, null);

  const reported = await call('POST', `/policies/${policy.id}/enforcement-fruitless`,
    { fruitlessAt: new Date().toISOString(), route: 'ER_Dava' });
  assert.equal(reported.status, 202, reported.text);
  const pending = await call('GET', `/policies/${policy.id}`);
  assert.strictEqual(pending.body.enforcementRoute, null, 'a report not yet recorded is not the policy\'s route');

  await recordFruitlessAsTheDispatcherWould(policy.id, reported.body.event.id, 'ER_Dava');
  const recorded = await call('GET', `/policies/${policy.id}`);
  assert.equal(recorded.body.enforcementRoute, 'ER_Dava');
  assert.equal((await call('GET', `/policies/${policy.id}`, undefined, otherKey)).status, 404, 'another insurer reads no route');
});

test('a policyId that is not a UUID is 400, not 500', async () => {
  for (const bad of ['not-a-uuid', '123', `${crypto.randomUUID()}x`]) {
    const { status, body } = await call('GET', `/policies/${bad}`);
    assert.equal(status, 400, bad);
    assert.equal(body.error, 'policyId must be a UUID');
  }
});

test('a failed activation reads back as a reason code, never as the dispatcher\'s error text', async () => {
  const policy = await createPolicy();
  const { eventId, error } = await failActivationAsTheDispatcherWould(policy.id);
  assert.match(error, /oracle_operator_party/, 'fixture: the dispatcher refused for the missing oracle party');
  const { rows: [insurer] } = await pool.query('SELECT canton_party_id FROM insurers WHERE id = $1', [insurerId]);

  const { status, body, text } = await call('GET', `/policies/${policy.id}`);
  assert.equal(status, 200, text);
  const event = body.events.find((e) => e.eventId === eventId);
  assert.equal(event.status, 'failed');
  assert.ok(event.processedAt);
  assert.equal(event.failure.code, 'oracle_party_not_configured');
  assert.deepEqual(Object.keys(event.failure).sort(), ['code', 'message']);
  assert.ok(!text.includes(error), 'the raw error text is not in the response');
  assert.ok(!text.includes(insurerId), 'nor the insurer row id it names');
  assert.ok(!text.includes(insurer.canton_party_id), 'nor the insurer party');
  assert.doesNotMatch(text, /oracle_operator_party|onboardInsurer/);
});

test('an error the reason table does not know reads back as internal_or_ledger_error, and its text does not', async () => {
  const policy = await createPolicy();
  const activated = await call('POST', `/policies/${policy.id}/activate`);
  const cid = `api-test-cid-${crypto.randomUUID()}`;
  const party = `api-test-party-${crypto.randomUUID()}`;
  const raw = `ledger succeeded (commandId=x, contractId=${cid}) but write-back failed: party ${party} at C:\\internal\\path.js`;
  await pool.query(`UPDATE policy_events SET status = 'processing' WHERE id = $1`, [activated.body.event.id]);
  await pool.query(
    `UPDATE policy_events SET status = 'failed', error = $1, processed_at = now() WHERE id = $2`,
    [raw, activated.body.event.id]
  );
  const { body, text } = await call('GET', `/policies/${policy.id}`);
  const failure = body.events.find((e) => e.eventId === activated.body.event.id).failure;
  assert.equal(failure.code, 'internal_or_ledger_error');
  for (const fragment of [cid, party, 'path.js', 'write-back', 'commandId', raw]) {
    assert.ok(!text.includes(fragment), `${fragment} is not in the response`);
  }
});

test('a settled payout\'s event reads back, and the bank reference and text salt are nowhere in the response', async () => {
  const policy = await createPolicy();
  const payoutId = await insertPayout(policy.id, { approved_at: '2026-09-10T09:00:00Z' });
  const bankReference = `api-test-bankref-${crypto.randomUUID()}`;
  const settled = await call('POST', `/payouts/${payoutId}/settle`, {
    bankReference, settledAt: '2026-09-10T10:00:00Z', paidRole: 'PDR_Insured',
  });
  assert.equal(settled.status, 202, settled.text);
  const eventId = settled.body.event.id;
  const { rows: [row] } = await pool.query('SELECT payload FROM policy_events WHERE id = $1', [eventId]);
  assert.equal(typeof row.payload.textSalt, 'string', 'fixture: the outbox row carries a salt');
  await pool.query(`UPDATE policy_events SET status = 'processing' WHERE id = $1`, [eventId]);
  await pool.query(`UPDATE policy_events SET status = 'done', processed_at = now() WHERE id = $1`, [eventId]);

  const { status, body, text } = await call('GET', `/policies/${policy.id}`);
  assert.equal(status, 200, text);
  const event = body.events.find((e) => e.eventId === eventId);
  assert.equal(event.eventType, 'settlement');
  assert.equal(event.status, 'done');
  assert.strictEqual(event.failure, null);
  assert.ok(!text.includes(bankReference), 'the bank reference is not in the response');
  assert.ok(!text.includes(row.payload.textSalt), 'the salt is not in the response');
  assert.doesNotMatch(text, /bankReference|textSalt|payload/);
});

test('no party id of any role is anywhere in the response', async () => {
  const policy = await createPolicy({
    insured: { externalRef: `api-test-${crypto.randomUUID()}` },
    mortgagee: { externalRef: `api-test-${crypto.randomUUID()}` },
    beneficiary: { externalRef: `api-test-${crypto.randomUUID()}` },
  });
  const { rows: [p] } = await pool.query(
    `SELECT policyholder_id, insured_policyholder_id, mortgagee_policyholder_id, beneficiary_policyholder_id
       FROM policies WHERE id = $1`,
    [policy.id]
  );
  const roleIds = [p.policyholder_id, p.insured_policyholder_id, p.mortgagee_policyholder_id, p.beneficiary_policyholder_id];
  assert.equal(new Set(roleIds).size, 4, 'fixture: four distinct role rows');
  const parties = [];
  for (const id of roleIds) {
    const party = `api-test-party-${crypto.randomUUID()}`;
    await pool.query(`UPDATE policyholders SET canton_party_id = $1, canton_party_status = 'ALLOCATED' WHERE id = $2`, [party, id]);
    parties.push(party);
  }
  const { rows: [insurer] } = await pool.query('SELECT canton_party_id FROM insurers WHERE id = $1', [insurerId]);
  parties.push(insurer.canton_party_id);
  const oracle = `api-test-oracle-${crypto.randomUUID()}`;
  parties.push(oracle);
  await pool.query('UPDATE insurers SET oracle_operator_party = $1 WHERE id = $2', [oracle, insurerId]);
  try {
    await pool.query(`UPDATE policies SET daml_contract_id = $1 WHERE id = $2`, [`api-test-cid-${crypto.randomUUID()}`, policy.id]);
    await call('POST', `/policies/${policy.id}/notice`, { serviceDate: '2026-09-10' });
    const { status, text } = await call('GET', `/policies/${policy.id}`);
    assert.equal(status, 200, text);
    for (const party of parties) assert.ok(!text.includes(party), `${party} is not in the response`);
  } finally {
    await pool.query('UPDATE insurers SET oracle_operator_party = NULL WHERE id = $1', [insurerId]);
  }
});

// --- listing policies ---------------------------------------------------------
//
// GET /policies: the caller's own policies, newest first, a summary of each.
// Authentication, tenant scope, limit and cursor are those of GET /payouts.

const policySummaryKeys = () => Object.keys(JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../../docs/api/notifications-v1.openapi.json'), 'utf8')
).components.schemas.PolicySummary.properties).sort();

// Every page of one caller's list, and the response bodies as sent.
async function listAllPolicies(key = apiKey) {
  const items = [];
  const texts = [];
  let cursor = null;
  do {
    const res = await call('GET', `/policies?limit=200${cursor ? `&after=${cursor}` : ''}`, undefined, key);
    assert.equal(res.status, 200, res.text);
    items.push(...res.body.items);
    texts.push(res.text);
    cursor = res.body.nextCursor;
    assert.ok(texts.length <= 100, 'the cursor is not advancing');
  } while (cursor);
  return { items, text: texts.join('\n') };
}

test('listing policies with no x-api-key, or with an unknown key, is 401', async () => {
  const none = await call('GET', '/policies', undefined, null);
  assert.equal(none.status, 401);
  assert.equal(none.body.error, 'missing x-api-key header');
  const unknown = await call('GET', '/policies', undefined, 'not-a-real-key');
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, 'unknown or inactive insurer');
});

test('the policy list holds the caller\'s policies only, all of them, each one a PolicySummary, and writes nothing', async () => {
  const mine = await createPolicy();
  const theirs = await createPolicyAs(otherKey);
  const before = await policyEventCount();
  const ownerCount = async (id) =>
    Number((await pool.query('SELECT count(*) AS n FROM policies WHERE insurer_id = $1', [id])).rows[0].n);

  for (const [key, ownId, own, foreign] of [
    [apiKey, insurerId, mine, theirs],
    [otherKey, otherInsurerId, theirs, mine],
  ]) {
    const { items } = await listAllPolicies(key);
    const ids = items.map((s) => s.policyId);
    assert.ok(ids.includes(own.id));
    assert.ok(!ids.includes(foreign.id), 'another insurer\'s policy is not listed');
    const owners = await pool.query('SELECT DISTINCT insurer_id FROM policies WHERE id = ANY($1::uuid[])', [ids]);
    assert.deepEqual(owners.rows.map((r) => r.insurer_id), [ownId]);
    assert.equal(new Set(ids).size, ids.length, 'none repeated');
    assert.equal(ids.length, await ownerCount(ownId), 'every one of the caller\'s policies');
    for (const summary of items) assert.deepEqual(Object.keys(summary).sort(), policySummaryKeys());
  }

  assert.equal(await policyEventCount(), before, 'a GET queues no policy_events row');
});

test('an insurer with no policies lists nothing, while other insurers have policies', async () => {
  const emptyKey = crypto.randomBytes(16).toString('hex');
  const { rows: [empty] } = await pool.query(
    `INSERT INTO insurers (legal_name, api_key_hash, canton_party_status)
     VALUES ('Test Insurer Ltd (api fixture, no policies, fake)', $1, 'PENDING') RETURNING id`,
    [crypto.createHash('sha256').update(emptyKey).digest('hex')]
  );
  try {
    const others = Number((await pool.query('SELECT count(*) AS n FROM policies')).rows[0].n);
    assert.ok(others > 0, 'not vacuous: the database holds other insurers\' policies');
    const res = await call('GET', '/policies', undefined, emptyKey);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { items: [], nextCursor: null });
  } finally {
    await pool.query('DELETE FROM insurers WHERE id = $1', [empty.id]);
  }
});

// Five of the no-party tenant's policies are moved to known creation times
// older than anything else it holds, so they are its last five, in a known
// order; the rest of its policies are whatever this file created before.
test('limit=2 walks the list newest first: none skipped, none repeated, equal and sub-millisecond created_at included', async () => {
  const created = [];
  for (let i = 0; i < 5; i += 1) created.push((await createPolicyAs(unallocatedKey)).id);
  // B and C share one created_at, so only the id orders them. A, B/C and D
  // fall inside ONE millisecond, as in the payout list's own test.
  const times = [
    '2025-01-01 00:00:00.000100+00',
    '2025-01-01 00:00:00.000200+00',
    '2025-01-01 00:00:00.000200+00',
    '2025-01-01 00:00:00.000900+00',
    '2025-01-01 00:00:01+00',
  ];
  for (const [i, id] of created.entries()) {
    await pool.query('UPDATE policies SET created_at = $1 WHERE id = $2', [times[i], id]);
  }
  const expected = (await pool.query(
    'SELECT id FROM policies WHERE insurer_id = $1 ORDER BY created_at DESC, id DESC', [unallocatedInsurerId]
  )).rows.map((r) => r.id);
  const [b, c] = [created[1], created[2]].sort().reverse();
  assert.deepEqual(expected.slice(-5), [created[4], created[3], b, c, created[0]], 'fixture: the five are the oldest');

  const pages = [];
  let cursor = null;
  do {
    const res = await call('GET', `/policies?limit=2${cursor ? `&after=${cursor}` : ''}`, undefined, unallocatedKey);
    assert.equal(res.status, 200, res.text);
    pages.push(res.body.items.map((s) => s.policyId));
    cursor = res.body.nextCursor;
    assert.ok(pages.length <= expected.length, 'the cursor is not advancing');
  } while (cursor);

  assert.deepEqual(pages.flat(), expected);
  assert.ok(pages.slice(0, -1).every((p) => p.length === 2), 'every page but the last is full');
  assert.ok(pages[pages.length - 1].length >= 1, 'no empty last page');
});

test('a broken cursor, or a limit outside 1..200, is 400 on the policy list', async () => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const after of ['not a cursor', encode({ c: '2026-02-30T00:00:00.000100Z', i: crypto.randomUUID() })]) {
    const res = await call('GET', `/policies?after=${encodeURIComponent(after)}`);
    assert.equal(res.status, 400, `${after}: ${res.text}`);
    assert.equal(res.body.error, 'after is not a cursor this API issued');
  }
  for (const limit of ['0', '201', '1.5', 'ten', '']) {
    const res = await call('GET', `/policies?limit=${limit}`);
    assert.equal(res.status, 400, `limit=${limit}: ${res.text}`);
    assert.match(res.body.error, /limit must be an integer between 1 and 200/);
  }
});

test('a list item carries its term, coverages and newest outbox row, a failure only as its code, and no reference, cell or document hash', async () => {
  const externalRef = `api-test-${crypto.randomUUID()}`;
  const untouched = await createPolicy({ policyholder: { externalRef } });
  const failed = await createPolicy();
  const { eventId, error } = await failActivationAsTheDispatcherWould(failed.id);
  const later = await createPolicy();
  await failActivationAsTheDispatcherWould(later.id);
  const { rows: [expiry] } = await pool.query(
    `INSERT INTO policy_events (policy_no, event_type) VALUES ($1, 'expiry') RETURNING id`, [later.id]
  );

  const { items, text } = await listAllPolicies();
  assert.deepEqual(items.find((s) => s.policyId === untouched.id), {
    policyId: untouched.id,
    status: 'pending_mint',
    defaultState: 'none',
    currency: 'TRY',
    startDate: '2026-09-01',
    endDate: '2027-03-31',
    coverageBegun: false,
    coverageBeganAt: null,
    coverages: [{
      coverageCode: 'TEST-COVERAGE', productCode: 'TEST-PRODUCT', perilType: 'TEST-PERIL',
      sumInsured: '10000.00', remainingLimit: '10000.00',
    }],
    lastEvent: null,
  });
  const failedItem = items.find((s) => s.policyId === failed.id).lastEvent;
  assert.equal(failedItem.eventId, eventId);
  assert.equal(failedItem.eventType, 'activation');
  assert.equal(failedItem.status, 'failed');
  assert.equal(failedItem.failure.code, 'oracle_party_not_configured');
  const laterItem = items.find((s) => s.policyId === later.id).lastEvent;
  assert.equal(laterItem.eventId, expiry.id, 'the newest of the policy\'s rows');
  assert.equal(laterItem.status, 'pending');
  assert.strictEqual(laterItem.failure, null);

  assert.ok(!text.includes(error), 'the raw error text is not in the response');
  assert.ok(!text.includes(externalRef), 'nor the insurer\'s customer reference');
  assert.ok(!text.includes(DOCUMENT_HASH), 'nor the document hash');
  assert.doesNotMatch(text, /metno:|cellIds|premiumAmount|payload/);
});

// --- the insurer console (/konsol) --------------------------------------------
//
// A static page that reads GET /policies, GET /policies/:policyId, GET
// /payouts and GET /payouts/:payoutId with the key the insurer pastes, and
// nothing else. Here: that it is served, what it may call, where the key may
// be kept, and the words it must not say.

const KONSOL_DIR = path.resolve(import.meta.dirname, '../public/konsol');
const konsolSources = () => ['index.html', 'konsol.js'].map((f) => fs.readFileSync(path.join(KONSOL_DIR, f), 'utf8'));

test('the insurer console is served on /konsol, with its script and the logo', async () => {
  const page = await fetch(`${base}/konsol`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.url, /\/konsol\/$/);
  assert.match(html, /<script src="konsol\.js"><\/script>/);
  for (const asset of ['/konsol/konsol.js', '/numera-mark.png']) {
    const res = await fetch(`${base}${asset}`);
    await res.arrayBuffer();
    assert.equal(res.status, 200, asset);
  }
});

test('the console reads the insurer API only, sends the key as a header, and keeps it in sessionStorage only', () => {
  const [html, js] = konsolSources();
  const both = html + js;
  assert.equal(js.match(/\bfetch\(/g)?.length, 1, 'one fetch call');
  assert.match(js, /fetch\(`\/api\/v1\$\{path\}`/, 'and it reaches /api/v1 only');
  for (const read of ['/policies', '/payouts']) assert.ok(js.includes(`'${read}`) || js.includes(`\`${read}`), read);
  assert.match(js, /'x-api-key'/);
  assert.match(js, /sessionStorage/);
  assert.doesNotMatch(both, /localStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(js, /\bmethod\s*:/, 'no method other than the default GET');
  assert.doesNotMatch(both, /\/settle|\/close-unpaid|\/activate|\/debug\//);
  assert.doesNotMatch(both, /[?&](api[-_]?key|key)=/i, 'the key never goes into a query string');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'data reaches the page as text only');
});

test('the console loads nothing from outside, says it is a prototype on synthetic data, and none of the words it must not', () => {
  const [html, js] = konsolSources();
  const both = html + js;
  assert.doesNotMatch(both, /\b(src|href)\s*=\s*["']?\s*https?:\/\//i, 'no external src or href');
  assert.doesNotMatch(both, /url\(\s*["']?\s*https?:|@import/i, 'no external stylesheet or font');
  assert.match(html, /Prototip · test ortamı · sentetik veri/);
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  const word = (w) => new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, 'iu');
  for (const w of [
    'canlı', 'üretimde', 'mevzuata uygun', 'kurcalanamaz', 'değiştirilemez', 'öder', 'ödedi',
    'live', 'production', 'compliant', 'tamper-proof', 'pays',
  ]) assert.doesNotMatch(both, word(w), w);
});

// konsol.js is an IIFE with no export, and pill()/el() reach into the
// DOM, so statusPill cannot be imported or exercised through the DOM. Instead
// its source (and the POLICY_STATUS map it falls back to) is cut out of the
// file by text markers and evaluated with node:vm as a plain function.
function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found in konsol.js: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `end marker not found in konsol.js after "${startMarker}": ${endMarker}`);
  return text.slice(start, end + endMarker.length);
}

function loadStatusPill() {
  const [, js] = konsolSources();
  const policyStatusSrc = sliceBetween(js, 'const POLICY_STATUS = {', '\n  };');
  const statusPillSrc = sliceBetween(js, 'function statusPill(status, defaultState) {', '\n  }');
  // Run in this context (not a fresh vm realm): a fresh realm's Array is a
  // different constructor from this file's, and assert.deepEqual on arrays
  // returned from it fails as "same structure but not reference-equal".
  const factory = vm.runInThisContext(`(function () {\n${policyStatusSrc}\n${statusPillSrc}\nreturn statusPill;\n})`);
  return factory();
}

test('statusPill: a contract past termination shows active/cancelled label-less and toneless, and partially_paid as "Limit kısmen kullanıldı" with no tone; other default states and other statuses are unchanged', () => {
  const statusPill = loadStatusPill();
  assert.deepEqual(statusPill('active', 'terminated'), ['active', '']);
  assert.deepEqual(statusPill('partially_paid', 'two_notice_terminated'), ['Limit kısmen kullanıldı', '']);
  assert.deepEqual(statusPill('partially_paid', 'terminated'), ['Limit kısmen kullanıldı', '']);
  assert.deepEqual(statusPill('active', 'withdrawn_for_first_premium'), ['active', '']);
  assert.notEqual(statusPill('cancelled', 'terminated')[0], 'İptal edildi');
  assert.deepEqual(statusPill('active', 'none'), ['Yürürlükte', 'ok']);
  assert.deepEqual(statusPill('partially_paid', 'none'), ['Yürürlükte, limit kısmen kullanıldı', 'ok']);
});

test('the console does not promise the key is gone once the tab closes, and says how to remove it', () => {
  const [html] = konsolSources();
  assert.ok(!html.includes('sekme kapanınca silinir'), 'no promise that closing the tab deletes the key');
  assert.match(html, /"Anahtarı unut" düğmesine basın/);
  assert.match(html, /geri yüklerse/);
});

// showApp, cut out of konsol.js as statusPill is above, with the DOM it
// touches stubbed: the header line under the key is the only .who element.
function runShowApp(storageRefused) {
  const [, js] = konsolSources();
  const showAppSrc = sliceBetween(js, 'function showApp() {', '\n  }');
  const nodes = { gate: { hidden: false }, app: { hidden: true }, session: { hidden: true } };
  const who = { textContent: 'Anahtar bu sekmenin oturum belleğinde' };
  const factory = vm.runInThisContext(`(function ($, document, storageRefused) {\n${showAppSrc}\nreturn showApp;\n})`);
  factory((id) => nodes[id], { querySelector: () => who }, storageRefused)();
  return who.textContent;
}

test('the console header says the key is in page memory only when the browser refused session storage', () => {
  assert.equal(runShowApp(false), 'Anahtar bu sekmenin oturum belleğinde');
  const refused = runShowApp(true);
  assert.notEqual(refused, 'Anahtar bu sekmenin oturum belleğinde');
  assert.match(refused, /yalnızca bu sayfa açıkken/);
});

// start() and ApiError, cut out of konsol.js the same way; every function
// start() calls is a recording stub, so the order of what it draws shows.
function loadStart() {
  const [, js] = konsolSources();
  const apiErrorSrc = sliceBetween(js, 'class ApiError extends Error {', '\n  }');
  const startSrc = sliceBetween(js, 'async function start() {', '\n  }');
  const names = ['$', 'showApp', 'listError', 'loadPolicies', 'loadPayouts', 'failed', 'renderKpis', 'renderList', 'selectPolicy', 'readKey'];
  const factory = vm.runInThisContext(`(function (env) {
${names.map((n) => `const ${n} = (...a) => env[${JSON.stringify(n)}](...a);`).join('\n')}
const state = env.state;
${apiErrorSrc}
${startSrc}
return { start, ApiError };
})`);
  const calls = [];
  const refresh = { disabled: false };
  const env = {
    state: { loadToken: 0, selected: null, payouts: [] },
    $: (id) => (id === 'refresh' ? refresh : {}),
    showApp: () => {},
    listError: (m) => calls.push(['listError', m]),
    failed: (err) => calls.push(['failed', err]),
    renderKpis: () => calls.push(['renderKpis']),
    renderList: () => calls.push(['renderList']),
    selectPolicy: async () => calls.push(['selectPolicy']),
    readKey: () => 'k',
  };
  const { start, ApiError } = factory(env);
  return { start, ApiError, env, calls, refresh };
}

test('start() draws the policy list without waiting for the payouts, and a failed payout read marks only the payout parts', async () => {
  const t = loadStart();
  let failPayouts;
  t.env.loadPolicies = async () => {};
  t.env.loadPayouts = () => new Promise((_, reject) => { failPayouts = reject; });
  const running = t.start();
  await new Promise((r) => setImmediate(r));
  assert.ok(t.calls.some(([c]) => c === 'renderList'), 'the list is drawn while the payout walk is still running');
  failPayouts(new t.ApiError(500, 'boom'));
  await running;
  assert.equal(t.calls.filter(([c]) => c === 'failed').length, 0, 'a payout read error is not the list error');
  assert.deepEqual(t.calls.filter(([c]) => c === 'listError'), [['listError', null]]);
  assert.equal(t.calls.filter(([c]) => c === 'renderList').length, 1);
  assert.deepEqual(t.calls.at(-1), ['renderKpis'], 'the summary is drawn again once the payout read has failed');
  assert.equal(t.env.state.payoutsStatus, 'failed');
  assert.equal(t.env.state.payoutsError.status, 500);
  assert.equal(t.refresh.disabled, false);
});

test('start() marks the payouts ready once read, and a 401 on either read still goes back to the key gate', async () => {
  const ok = loadStart();
  ok.env.loadPolicies = async () => {};
  ok.env.loadPayouts = async () => {};
  await ok.start();
  assert.equal(ok.env.state.payoutsStatus, 'ready');
  assert.equal(ok.calls.filter(([c]) => c === 'failed').length, 0);

  for (const which of ['loadPolicies', 'loadPayouts']) {
    const t = loadStart();
    t.env.loadPolicies = async () => {};
    t.env.loadPayouts = async () => {};
    t.env[which] = async () => { throw new t.ApiError(401, 'unauthorized'); };
    await t.start();
    const failedCalls = t.calls.filter(([c]) => c === 'failed');
    assert.equal(failedCalls.length, 1, which);
    assert.equal(failedCalls[0][1].status, 401, which);
  }
});

test('start() still settles the payout status when the policy read fails, so the rows left on screen do not say a read is in progress', async () => {
  for (const [payoutsResult, expected] of [[null, 'ready'], [500, 'failed']]) {
    const t = loadStart();
    t.env.state.selected = 'P-1';
    t.env.loadPolicies = async () => { throw new t.ApiError(500, 'boom'); };
    t.env.loadPayouts = async () => { if (payoutsResult) throw new t.ApiError(payoutsResult, 'payouts'); };
    await t.start();
    const failedCalls = t.calls.filter(([c]) => c === 'failed');
    assert.equal(failedCalls.length, 1, expected);
    assert.equal(failedCalls[0][1].status, 500, 'the list error is the policy read error');
    assert.equal(t.calls.filter(([c]) => c === 'renderList').length, 0, 'the list is not redrawn from a failed read');
    assert.equal(t.env.state.payoutsStatus, expected);
    assert.deepEqual(t.calls.slice(-2), [['renderKpis'], ['selectPolicy']], 'the summary and the open policy are drawn again once the payouts are settled');
    assert.equal(t.refresh.disabled, false);
  }

  const gate = loadStart();
  gate.env.state.selected = 'P-1';
  gate.env.loadPolicies = async () => { throw new gate.ApiError(401, 'unauthorized'); };
  gate.env.loadPayouts = async () => {};
  await gate.start();
  assert.deepEqual(gate.calls.filter(([c]) => c !== 'listError').map(([c]) => c), ['failed'], 'a 401 on the policy read goes to the key gate and draws nothing more');
});

// renderKpis, cut out the same way, with each element it writes a plain object.
function runRenderKpis(payoutsStatus) {
  const [, js] = konsolSources();
  const src = sliceBetween(js, 'function renderKpis(policiesRead = true) {', '\n  }');
  const nodes = {};
  const $ = (id) => (nodes[id] ??= {
    hidden: true,
    textContent: '',
    replaceChildren(...children) { this.textContent = children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); },
  });
  const factory = vm.runInThisContext(`(function ($, state, storageRefused, PAYOUT_MAX_PAGES, PAYOUT_PAGE, totalsByCurrency, describe) {\n${src}\nreturn renderKpis;\n})`);
  const state = {
    policies: [{ lastEvent: null }],
    nextCursor: null,
    payouts: [],
    payoutsTruncated: false,
    payoutsStatus,
    payoutsError: payoutsStatus === 'failed' ? { status: 500, message: 'boom' } : null,
  };
  factory($, state, false, 50, 200, () => 'total', (err) => `described ${err.status}`)();
  return nodes;
}

test('renderKpis shows the payout counts as unavailable, not as zero, until the payouts are read, and says why when the read failed', () => {
  const failed = runRenderKpis('failed');
  assert.equal(failed['kpi-policies'].textContent, '1');
  assert.equal(failed['kpi-approved'].textContent, '–');
  assert.equal(failed['kpi-review'].textContent, '–');
  assert.match(failed['kpi-approved-sub'].textContent, /okunamadı/);
  assert.equal(failed['payouts-warning'].hidden, false);
  assert.match(failed['payouts-warning'].textContent, /okunamadı/);
  assert.match(failed['payouts-warning'].textContent, /described 500/);

  const loading = runRenderKpis('loading');
  assert.equal(loading['kpi-approved'].textContent, '–');
  assert.match(loading['kpi-approved-sub'].textContent, /okunuyor/);
  assert.equal(loading['payouts-warning'].hidden, true);

  const ready = runRenderKpis('ready');
  assert.equal(ready['kpi-approved'].textContent, '0');
  assert.equal(ready['kpi-approved-sub'].textContent, 'Bekleyen yok');
  assert.equal(ready['payouts-warning'].hidden, true);
});

test('start() with the real renderKpis: a failed policy read leaves the policy tiles as they were and settles only the payout tiles', async () => {
  const [, js] = konsolSources();
  const renderKpisSrc = sliceBetween(js, 'function renderKpis(policiesRead = true) {', '\n  }');
  // Page opened with a stored key, or a new key just entered: no rows yet, and
  // the tiles still show the page's '–'. Then a refresh over rows already drawn.
  const befores = [
    { policies: [], tiles: { 'kpi-policies': '–', 'kpi-policies-sub': '', 'kpi-failed': '–', 'kpi-failed-sub': '' } },
    { policies: [{ lastEvent: { status: 'failed' } }, { lastEvent: null }], tiles: { 'kpi-policies': '2', 'kpi-policies-sub': 'Tümü yüklendi', 'kpi-failed': '1', 'kpi-failed-sub': 'Yüklenen poliçeler arasında' } },
  ];
  for (const before of befores) {
    for (const payoutsFail of [false, true]) {
      const label = `${before.policies.length} rows before, payout read ${payoutsFail ? 'failed' : 'ok'}`;
      const t = loadStart();
      Object.assign(t.env.state, { policies: before.policies, nextCursor: null, payoutsByPolicy: new Map(), payoutsTruncated: false });
      const nodes = {};
      const node = (id) => (nodes[id] ??= {
        hidden: true,
        textContent: before.tiles[id] ?? '–',
        replaceChildren(...children) { this.textContent = children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); },
      });
      t.env.$ = (id) => (id === 'refresh' ? t.refresh : node(id));
      const factory = vm.runInThisContext(`(function ($, state, storageRefused, PAYOUT_MAX_PAGES, PAYOUT_PAGE, totalsByCurrency, describe) {\n${renderKpisSrc}\nreturn renderKpis;\n})`);
      t.env.renderKpis = factory(t.env.$, t.env.state, false, 50, 200, () => 'total', (err) => `described ${err.status}`);
      t.env.loadPolicies = async () => { throw new t.ApiError(500, 'boom'); };
      t.env.loadPayouts = async () => { if (payoutsFail) throw new t.ApiError(503, 'payouts'); };
      await t.start();
      assert.equal(t.env.state.payoutsStatus, payoutsFail ? 'failed' : 'ready', label);
      for (const [id, text] of Object.entries(before.tiles)) {
        assert.equal(nodes[id]?.textContent ?? text, text, `${id} is not redrawn from a failed policy read (${label})`);
      }
      assert.equal(nodes['kpi-approved'].textContent, payoutsFail ? '–' : '0', `the payout tiles are settled (${label})`);
      assert.equal(nodes['kpi-review'].textContent, payoutsFail ? '–' : '0', label);
      assert.doesNotMatch(nodes['kpi-approved-sub'].textContent, /okunuyor/, label);
      assert.equal(nodes['payouts-warning'].hidden, !payoutsFail, label);
      assert.doesNotMatch(nodes['payouts-warning'].textContent, /poliçe listesi gösteriliyor/, `the payout warning does not say a policy list is shown (${label})`);
    }
  }
});

test('the console has a Turkish heading for every event type the database has, so none is shown as its raw code alone', async () => {
  const [, js] = konsolSources();
  const eventTypeSrc = sliceBetween(js, 'const EVENT_TYPE = {', '\n  };');
  const EVENT_TYPE = vm.runInThisContext(`(function () {\n${eventTypeSrc}\nreturn EVENT_TYPE;\n})`)();
  const { rows } = await pool.query('SELECT unnest(enum_range(NULL::event_type)) AS value');
  assert.ok(rows.length > 0, 'the event_type enum has no values -- the query read nothing');
  const missing = rows.map((r) => r.value).filter((v) => !Object.hasOwn(EVENT_TYPE, v) || EVENT_TYPE[v] === v);
  assert.deepEqual(missing, [], `no Turkish heading in konsol.js EVENT_TYPE for: ${missing.join(', ')}`);
});

function loadEventHeading() {
  const [, js] = konsolSources();
  const src = [
    sliceBetween(js, 'const EVENT_TYPE = {', '\n  };'),
    sliceBetween(js, 'const ENFORCEMENT_ROUTE_HEADING = {', '\n  };'),
    sliceBetween(js, 'function eventHeading(e, record) {', '\n  }'),
  ].join('\n');
  return vm.runInThisContext(`(function () {\n${src}\nreturn eventHeading;\n})`)();
}

test('the console heads a fruitless enforcement, and the substitution notice after it, by the recorded route, and names both where the route is not known', async () => {
  const eventHeading = loadEventHeading();
  const NEITHER_FRUITLESS = 'Prim borcu için dava veya takibin semeresiz kalması';
  const NEITHER_NOTICE = 'Semeresiz dava veya takibin sigortalıya bildirilmesi';
  const policy = await createPolicy();
  const report = async (route) => {
    const res = await call('POST', `/policies/${policy.id}/enforcement-fruitless`,
      { fruitlessAt: new Date().toISOString(), route });
    assert.equal(res.status, 202, res.text);
    return res.body.event.id;
  };
  const read = async () => {
    const res = await call('GET', `/policies/${policy.id}`);
    assert.equal(res.status, 200, res.text);
    return res.body;
  };
  const headingOf = (record, eventId) => eventHeading(record.events.find((e) => e.eventId === eventId), record);

  const takip = await report('ER_Takip');
  assert.equal(headingOf(await read(), takip), NEITHER_FRUITLESS, 'a report not yet recorded has no known route');
  await recordFruitlessAsTheDispatcherWould(policy.id, takip, 'ER_Takip');
  assert.equal(headingOf(await read(), takip), 'Prim borcu için takibin semeresiz kalması');

  const dava = await report('ER_Dava');
  let record = await read();
  assert.equal(headingOf(record, dava), NEITHER_FRUITLESS, 'pending: not yet the recorded route');
  assert.equal(headingOf(record, takip), 'Prim borcu için takibin semeresiz kalması', 'still the recorded one');

  await recordFruitlessAsTheDispatcherWould(policy.id, dava, 'ER_Dava');
  const notice = await call('POST', `/policies/${policy.id}/substitution-notice`, { notifiedAt: new Date().toISOString() });
  assert.equal(notice.status, 202, notice.text);
  record = await read();
  assert.equal(headingOf(record, dava), 'Prim borcu için davanın semeresiz kalması');
  assert.equal(headingOf(record, notice.body.event.id), 'Semeresiz davanın sigortalıya bildirilmesi');
  assert.equal(headingOf(record, takip), NEITHER_FRUITLESS, 'a record the later one replaced: its route is no longer on the policy');

  // The list's last event comes with no record: its route is not known.
  assert.equal(eventHeading(record.events[0]), NEITHER_NOTICE);
  assert.equal(eventHeading({ eventType: 'substitution_notice' }, { enforcementRoute: null, events: [] }), NEITHER_NOTICE);
  assert.equal(eventHeading({ eventType: 'enforcement_commenced' }, record), 'Prim alacağının dava veya takip yoluyla istenmesi');
  assert.equal(eventHeading({ eventType: 'not_a_type' }), 'not_a_type');
});

test('the console names the mortgagee as one party: "sınırlı ayni hak sahibi" only in brackets after "İpotekli alacaklı", and the recipient label carries both', () => {
  const [html, js] = konsolSources();
  const both = html + js;
  const uses = [...both.matchAll(/sınırlı ayni hak sahib/giu)];
  assert.ok(uses.length > 0, 'the statute term is not on the console at all');
  for (const m of uses) {
    const before = both.slice(Math.max(0, m.index - 40), m.index);
    assert.match(before, /[İi]potekli alacaklı\p{L}* \($/u, `names the role without "İpotekli alacaklı" before it: ${both.slice(Math.max(0, m.index - 40), m.index + 30)}`);
  }
  const recipientSrc = sliceBetween(js, 'const RECIPIENT = {', '\n  };');
  const RECIPIENT = vm.runInThisContext(`(function () {\n${recipientSrc}\nreturn RECIPIENT;\n})`)();
  assert.equal(RECIPIENT.PDR_Mortgagee, 'İpotekli alacaklı (sınırlı ayni hak sahibi)');
});

// --- the story page (debug, loopback-only) ------------------------------------
//
// GET /debug/story-data and the page that reads it. Read-only, like the rest
// of /debug; the rows it reads are inserted directly, as above.

const debugGet = async (p) => {
  const res = await fetch(`${base}/debug${p}`);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* the page is HTML */ }
  return { status: res.status, body: parsed, text };
};

// Every key anywhere in a JSON value, however deep.
function allKeys(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); allKeys(v, out); }
  }
  return out;
}

// One payout with every step behind it: raw response -> reading -> window ->
// approval -> delivered notification -> settlement. The bank reference, the
// notification's last_error, the resolution note and the attestation's
// request URL are planted so the test can prove none of them comes back.
async function insertStoryPayout() {
  const policy = await createPolicy();
  const body = Buffer.from(`{"story fixture":"${crypto.randomUUID()}"}`);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const raw = (await pool.query(
    `INSERT INTO oracle_raw_responses (request_url, request_params, http_status, body, sha256, fetched_at)
     VALUES ('https://fixture.invalid/story', '{}', 200, $1, $2, '2026-09-18T10:00:05Z') RETURNING id`,
    [body, sha256]
  )).rows[0].id;
  storyRawIds.push(raw);
  const reading = (await pool.query(
    `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source, raw_response_id)
     VALUES ($1,'TEST-COVERAGE',$3,'TEMPERATURE_C',-1.5,'2026-09-18T10:00:00Z','story-fixture',$2) RETURNING id`,
    [policy.id, raw, VALID_CELL]
  )).rows[0].id;
  const attestation = JSON.stringify({
    v: 1, evidence: { sha256, request: { url: 'https://fixture.invalid/story', params: {} } },
  });
  const window = (await pool.query(
    `INSERT INTO trigger_windows
       (policy_id, coverage_code, cell_id, window_start, window_end, timezone, start_hour, aggregation, metric,
        aggregated_value, determining_reading_id, reading_ids, attestation_ref, created_at)
     VALUES ($1,'TEST-COVERAGE',$4,'2026-09-17T21:00:00Z','2026-09-18T09:00:00Z','Europe/Istanbul',0,'min',
             'TEMPERATURE_C',-1.5,$2,ARRAY[$2]::uuid[],$3,'2026-09-18T10:00:10Z') RETURNING id`,
    [policy.id, reading, attestation, VALID_CELL]
  )).rows[0].id;
  const cid = `story-cid-${crypto.randomUUID()}`;
  const payout = (await pool.query(
    `INSERT INTO payout_events
       (policy_id, coverage_code, trigger_window_id, tier_label, payout_percentage, payout_amount, currency,
        status, recipient, record_kind, daml_contract_id, approved_at, bank_reference, settled_at, paid_role,
        resolved_at, resolution_note)
     VALUES ($1,'TEST-COVERAGE',$2,'test tier',25.00,2500.00,'TRY','settled','PDR_Insured','payout',$3,
             '2026-09-18T10:00:12Z','MOCK-must-not-appear','2026-09-18T10:00:20Z','PDR_Insured',
             '2026-09-18T10:00:22Z','note: must not appear') RETURNING id`,
    [policy.id, window, cid]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO payout_notifications
       (payout_event_id, insurer_id, kind, status, attempt_count, last_status_code, last_error, delivered_at)
     VALUES ($1,$2,'payout_approved','delivered',1,200,'error: must not appear','2026-09-18T10:00:15Z')`,
    [payout, insurerId]
  );
  return { policy, cid, sha256 };
}

const storyOf = (data, policy) => data.payouts.find((p) => p.policy.idPrefix === policy.id.slice(0, 8));

test('story-data is 200 with its top-level keys, and writes nothing', async () => {
  const before = await policyEventCount();
  const { status, body, text } = await debugGet('/story-data');
  assert.equal(status, 200, text);
  assert.deepEqual(Object.keys(body).sort(), ['checkedAt', 'evaluations', 'header', 'payouts']);
  assert.deepEqual(Object.keys(body.header).sort(), ['dataSource', 'network', 'packageIdPrefix']);
  assert.equal(body.header.network, 'Canton LocalNet, this machine');
  assert.equal(body.header.packageIdPrefix.length, 12);
  // oracleBot.js marks its source STAND-IN; the label is read from there.
  assert.equal(body.header.dataSource.interim, true);
  assert.equal(body.header.dataSource.label, 'interim data source: a forecast service, not a measurement');
  assert.ok(Array.isArray(body.payouts) && body.payouts.length <= 20);
  assert.equal(await policyEventCount(), before, 'a GET queues no policy_events row');
});

test('story-data carries no key naming a key, secret, webhook URL, party, IBAN, account or bank, at any depth', async () => {
  const { policy, cid } = await insertStoryPayout();
  const { status, body, text } = await debugGet('/story-data');
  assert.equal(status, 200, text);
  assert.ok(storyOf(body, policy), 'the fixture payout is in the response, so its keys were scanned');
  const bad = allKeys(body).filter((k) => /api_key|secret|webhook_url|party|iban|account|bank/i.test(k));
  assert.deepEqual(bad, []);
  for (const planted of ['MOCK-must-not-appear', 'must not appear', 'fixture.invalid', cid, policy.id]) {
    assert.ok(!text.includes(planted), `${planted} is not in the response`);
  }
});

test('a fixture payout maps onto its six steps, in order, with the recorded times', async () => {
  const { policy, cid, sha256 } = await insertStoryPayout();
  const story = storyOf((await debugGet('/story-data')).body, policy);
  assert.equal(story.policy.idPrefix, policy.id.slice(0, 8));
  assert.equal(story.policy.productCode, 'TEST-PRODUCT');
  assert.equal(story.policy.perilType, 'TEST-PERIL');
  assert.equal(story.policy.coverageCode, 'TEST-COVERAGE');
  assert.equal(story.policy.cell, VALID_CELL);
  assert.equal(story.recordKind, 'payout');
  assert.equal(story.reading.value, '-1.5000');
  assert.equal(story.reading.sourceLabel, 'story-fixture');
  assert.equal(story.evidence.sha256, sha256);
  assert.equal(story.window.aggregation, 'min');
  assert.deepEqual(story.window.attestation, { recorded: true, evidenceSha256: sha256 });
  assert.equal(story.approval.amount, '2500.00');
  assert.equal(story.approval.recipientRole, 'PDR_Insured');
  assert.equal(story.approval.contractIdPrefix, cid.slice(0, 12));
  assert.deepEqual(story.notifications, [{
    kind: 'payout_approved', status: 'delivered', attemptCount: 1,
    attemptCountMeans: 'failed attempts', delivery: 'delivered',
    deliveredAt: '2026-09-18T10:00:15.000Z', lastStatusCode: 200,
  }]);
  assert.equal(story.closure.status, 'settled');
  assert.equal(story.closure.paidRole, 'PDR_Insured');
  assert.deepEqual(story.steps, [
    { key: 'reading', timeKind: 'measured', state: 'done', at: '2026-09-18T10:00:00.000Z' },
    { key: 'evidence', timeKind: 'fetched', state: 'done', at: '2026-09-18T10:00:05.000Z' },
    { key: 'window', timeKind: 'window recorded', state: 'done', at: '2026-09-18T10:00:10.000Z' },
    { key: 'approved', timeKind: 'approved', state: 'done', at: '2026-09-18T10:00:12.000Z' },
    { key: 'notified', timeKind: 'notified', state: 'done', at: '2026-09-18T10:00:15.000Z' },
    { key: 'settled', timeKind: 'closed', state: 'done', at: '2026-09-18T10:00:22.000Z' },
  ]);
  assert.equal(story.path, 'automatic');
});

test('a payout with nothing behind it is "not yet" at every missing step, never filled in', async () => {
  const policy = await createPolicy();
  await insertPayout(policy.id);
  const story = storyOf((await debugGet('/story-data')).body, policy);
  assert.ok(story, 'the bare payout is in the response');
  assert.deepEqual(story.steps.map((s) => [s.key, s.state, s.at]), [
    ['reading', 'not yet', null], ['evidence', 'not yet', null], ['window', 'not yet', null],
    ['approved', 'not yet', null], ['notified', 'not yet', null], ['settled', 'not yet', null],
  ]);
  assert.equal(story.reading.state, 'not yet');
  assert.equal(story.window.state, 'not yet');
  assert.deepEqual(story.notifications, []);
  assert.equal(story.path, 'in progress');
});

test('a payout under manual review is on the human path', async () => {
  const policy = await createPolicy();
  await insertPayout(policy.id, { status: 'manual_review', review_contract_id: `story-review-${crypto.randomUUID()}` });
  const story = storyOf((await debugGet('/story-data')).body, policy);
  assert.equal(story.path, 'human');
});

// A window and a payout built on it, with the aggregation and the readings
// asked for. A mean has NO determining reading (eventWindow.js returns null
// for one) and the table's own constraint enforces that, so the two cases
// cannot be mixed up here by accident either.
async function insertWindowPayout(policy, { aggregation, readings }) {
  const ids = [];
  for (let i = 0; i < readings; i += 1) {
    ids.push((await pool.query(
      `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source)
       VALUES ($1,'TEST-COVERAGE',$2,'TEMPERATURE_C',$3,$4,'story-fixture') RETURNING id`,
      [policy.id, VALID_CELL, -1 - i, new Date(Date.UTC(2026, 8, 18, i)).toISOString()]
    )).rows[0].id);
  }
  const determining = aggregation === 'mean' ? null : ids[0];
  const window = (await pool.query(
    `INSERT INTO trigger_windows
       (policy_id, coverage_code, cell_id, window_start, window_end, timezone, start_hour, aggregation, metric,
        aggregated_value, determining_reading_id, reading_ids, attestation_ref)
     VALUES ($1,'TEST-COVERAGE',$2,'2026-09-17T21:00:00Z','2026-09-18T21:00:00Z','Europe/Istanbul',0,$3,
             'TEMPERATURE_C',-1.5,$4,$5::uuid[],'{"v":1,"evidence":"absent"}') RETURNING id`,
    [policy.id, VALID_CELL, aggregation, determining, ids]
  )).rows[0].id;
  return { window, readingIds: ids };
}

test('a mean window names no determining reading and says how many it folded', async () => {
  const policy = await createPolicy();
  const { window } = await insertWindowPayout(policy, { aggregation: 'mean', readings: 3 });
  await pool.query('UPDATE payout_events SET trigger_window_id = $1 WHERE id = $2',
    [window, await insertPayout(policy.id)]);
  const story = storyOf((await debugGet('/story-data')).body, policy);
  assert.equal(story.reading.kind, 'none for a mean');
  assert.equal(story.reading.note, 'mean of 3 readings; no single determining reading');
  assert.equal(story.window.readingCount, 3);
  // A mean has no tie to break, so there is no rule to state.
  assert.equal(story.window.tieRule, null);
});

test('a min window states the tie rule and its reading count', async () => {
  const policy = await createPolicy();
  const { window } = await insertWindowPayout(policy, { aggregation: 'min', readings: 2 });
  await pool.query('UPDATE payout_events SET trigger_window_id = $1 WHERE id = $2',
    [window, await insertPayout(policy.id)]);
  const story = storyOf((await debugGet('/story-data')).body, policy);
  assert.equal(story.reading.kind, 'determining');
  assert.equal(story.reading.note, null);
  assert.equal(story.window.readingCount, 2);
  assert.equal(story.window.tieRule, 'ties go to the earliest measurement, then the lowest reading id');
});

test('an evaluated window that matched no tier is listed, and says so', async () => {
  const policy = await createPolicy();
  const { window } = await insertWindowPayout(policy, { aggregation: 'min', readings: 1 });
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, trigger_window_id, status, processed_at)
     VALUES ($1,'trigger',$2,'done', now())`,
    [policy.id, window]
  );
  const { body } = await debugGet('/story-data');
  const row = body.evaluations.find((e) => e.policyIdPrefix === policy.id.slice(0, 8));
  assert.ok(row, 'the evaluated window is in the second list even though nothing was paid');
  assert.equal(row.outcome, 'no tier matched');
  assert.equal(row.payoutLegs, 0);
  assert.equal(row.tierLabel, null);
  assert.equal(row.refusalCode, null);
  assert.equal(row.readingCount, 1);
});

test('a window the ledger refused is listed as refused, by code, with no party id or free text', async () => {
  const policy = await createPolicy();
  const { window } = await insertWindowPayout(policy, { aggregation: 'min', readings: 1 });
  const party = `api-test-party-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, trigger_window_id, status, error, processed_at)
     VALUES ($1,'trigger',$2,'failed',$3, now())`,
    [policy.id, window, `Request failed with status code 400 -- DAML_AUTHORIZATION_ERROR: ${party} may not do this -- must not appear`]
  );
  const { body, text } = await debugGet('/story-data');
  const row = body.evaluations.find((e) => e.policyIdPrefix === policy.id.slice(0, 8));
  assert.equal(row.outcome, 'refused');
  assert.equal(row.refusalCode, 'DAML_AUTHORIZATION_ERROR');
  for (const planted of [party, 'must not appear', 'may not do this']) {
    assert.ok(!text.includes(planted), `${planted} is not in the response`);
  }
});

// A failed trigger row is told apart by
// the shape of the text that failed it -- damlClient.js's "Request failed
// with status code N -- CODE" for a ledger refusal, the dispatcher's own
// "nothing was sent" for a refusal before any submission, and its "ledger
// succeeded (...) but write-back failed" for a row the ledger accepted. Any
// other text says only that the row failed.
test('a failed trigger row says whether the ledger refused it, it was never sent, or the ledger accepted it and the record was not written', async () => {
  const cases = [
    ['refused', 'DAML_FAILURE',
      'Request failed with status code 400 -- DAML_FAILURE: the policy is terminated (correlationId=c-1)'],
    ['not sent', null,
      'trigger event 1: window 2 records its evidence as absent -- at least one of its readings has no stored ' +
        'provider response, so there is no evidence digest to send, and the ledger takes no trigger without one. ' +
        'Nothing was sent. This says what the platform holds; it is not a finding about whether the riziko occurred'],
    ['not sent', null,
      'trigger event 1: policy p has no coverage FROST-COVER in SQL, so there is no salt to commit the ' +
        "window's cell with; nothing was sent"],
    ['accepted, not recorded', null,
      'ledger succeeded (commandId=cmd-1, contractId=cid-1) but write-back failed: connection lost -- needs ' +
        'manual reconciliation, do not re-submit'],
    ['failed', null, 'timeout of 15000ms exceeded'],
  ];
  const policies = [];
  for (const [, , error] of cases) {
    const policy = await createPolicy();
    const { window } = await insertWindowPayout(policy, { aggregation: 'min', readings: 1 });
    await pool.query(
      `INSERT INTO policy_events (policy_no, event_type, trigger_window_id, status, error, processed_at)
       VALUES ($1,'trigger',$2,'failed',$3, now())`,
      [policy.id, window, error]
    );
    policies.push(policy);
  }
  const { body } = await debugGet('/story-data');
  cases.forEach(([outcome, code, error], i) => {
    const row = body.evaluations.find((e) => e.policyIdPrefix === policies[i].id.slice(0, 8));
    assert.equal(row.outcome, outcome, error);
    assert.equal(row.refusalCode, code, error);
  });
});

test('a notification tells apart no address, queued and delivered', async () => {
  const waiting = await createPolicy();
  const done = await createPolicy();
  const waitingPayout = await insertPayout(waiting.id);
  const donePayout = await insertPayout(done.id);
  await pool.query(
    `INSERT INTO payout_notifications (payout_event_id, insurer_id, kind, status)
     VALUES ($1,$2,'payout_approved','pending')`,
    [waitingPayout, insurerId]
  );
  await pool.query(
    `INSERT INTO payout_notifications
       (payout_event_id, insurer_id, kind, status, attempt_count, last_status_code, delivered_at)
     VALUES ($1,$2,'payout_approved','delivered',0,200,'2026-09-18T10:00:15Z')`,
    [donePayout, insurerId]
  );
  const stateOf = async (policy) =>
    storyOf((await debugGet('/story-data')).body, policy).notifications[0];

  // sender.js's claimNext never claims a row whose insurer has no address, so
  // this one is not waiting its turn -- there is nowhere for it to go.
  assert.equal((await stateOf(waiting)).delivery, 'no address configured');
  const delivered = await stateOf(done);
  assert.equal(delivered.delivery, 'delivered');
  // sender.js raises attempt_count only on the failure paths, so a row
  // delivered first time carries 0; the name says which number it is.
  assert.equal(delivered.attemptCount, 0);
  assert.equal(delivered.attemptCountMeans, 'failed attempts');

  try {
    await pool.query('UPDATE insurers SET webhook_url = $1 WHERE id = $2', ['http://127.0.0.1:9099/webhook', insurerId]);
    assert.equal((await stateOf(waiting)).delivery, 'queued');
    assert.equal((await stateOf(done)).delivery, 'delivered');
  } finally {
    await pool.query('UPDATE insurers SET webhook_url = NULL WHERE id = $1', [insurerId]);
  }
  // The address itself is never part of the answer, whichever state it is in.
  const { text } = await debugGet('/story-data');
  assert.ok(!text.includes('9099'), 'the insurer address is not in the response');
});

// The data the page names the closing step from. A record closed
// unpaid has its last step done, and says how it closed.
test('a payout closed unpaid has its closing step done and its status closed_unpaid', async () => {
  const policy = await createPolicy();
  const payout = await insertPayout(policy.id, { status: 'closed_unpaid' });
  await pool.query(`UPDATE payout_events SET unpaid_reason = 'UR_Waived', resolved_at = now() WHERE id = $1`, [payout]);
  const story = storyOf((await debugGet('/story-data')).body, policy);
  assert.equal(story.closure.status, 'closed_unpaid');
  assert.equal(story.steps[5].key, 'settled');
  assert.equal(story.steps[5].state, 'done');
});

test('a payout still short of a step says on which step it is waiting', async () => {
  const policy = await createPolicy();
  await insertPayout(policy.id);
  const story = storyOf((await debugGet('/story-data')).body, policy);
  assert.equal(story.path, 'in progress');
  assert.match(story.pathReason, /^not every step is recorded yet: /);
  assert.match(story.pathReason, /the insurer has not reported it settled/);
});

test('every step names what its own time is', async () => {
  const { policy } = await insertStoryPayout();
  const story = storyOf((await debugGet('/story-data')).body, policy);
  assert.deepEqual(story.steps.map((s) => s.timeKind),
    ['measured', 'fetched', 'window recorded', 'approved', 'notified', 'closed']);
});

test('the roles page shows amounts to two places, never the raw ledger string', async () => {
  const { status, text } = await debugGet('/roles');
  assert.equal(status, 200);
  assert.match(text, /function amount\(value, currency\)/);
  assert.match(text, /n\.toFixed\(2\)/);
  // Every place an amount is drawn goes through it.
  assert.ok(!/\$\{c\.amount\} \$\{c\.currency\}/.test(text), 'no amount is interpolated raw');
  assert.ok(!/remaining limit \$\{cv\.remainingLimit\}/.test(text), 'no remaining limit is interpolated raw');
});

test('the roles page says whose right heldBefore is', async () => {
  const { text } = await debugGet('/roles');
  assert.match(text, /That is the PLATFORM\u2019s right/);
  assert.match(text, /not a right this party has on this policy/);
});

// The page reads the code the route
// already returns and says the ledger refused only on the measured
// authorization refusal (.env.example, 400 DAML_AUTHORIZATION_ERROR).
test('the roles page says "The ledger refused it." only for an authorization refusal', () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../public/roles.html'), 'utf8');
  const isAuthorityRefusal = vm.runInThisContext(
    `(function () {\n${sliceBetween(html, 'function isAuthorityRefusal(body) {', '\n  }')}\nreturn isAuthorityRefusal;\n})`
  )();
  assert.equal(isAuthorityRefusal({ sent: true, refused: true, ledgerStatus: 400, ledgerCode: 'DAML_AUTHORIZATION_ERROR' }), true);
  assert.equal(isAuthorityRefusal({ sent: true, refused: true, ledgerStatus: 404, ledgerCode: 'CONTRACT_NOT_FOUND' }), false);
  assert.equal(isAuthorityRefusal({ sent: true, refused: true, ledgerStatus: null, ledgerCode: null }), false);
  assert.match(html, /\} else if \(isAuthorityRefusal\(body\)\) \{\s*answer\.append\(\s*el\('div', 'refused', 'The ledger refused it\.'\)/);
  // Any other refused answer is drawn as an error, never as the accepted banner.
  assert.match(html, /\} else if \(body\.refused\) \{\s*answer\.append\(\s*el\('div', 'error', /);
});

// No debug route had a test before these; the loopback floor is exercised by
// calling each router directly with a socket address that is not loopback.
function callRouter(router, url, remoteAddress) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', url, headers: {}, socket: { remoteAddress } };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      sendFile() { resolve({ status: this.statusCode, body: 'file' }); },
    };
    router(req, res, (err) => (err ? reject(err) : resolve({ status: 'fell through' })));
  });
}

test('story-data and the story page refuse a caller that is not on loopback', async () => {
  for (const [router, url] of [[debugRouter, '/story-data'], [debugDashboardRouter, '/story']]) {
    for (const address of ['192.0.2.10', '::ffff:192.0.2.10', undefined]) {
      const res = await callRouter(router, url, address);
      assert.equal(res.status, 403, `${url} from ${address}`);
      assert.deepEqual(res.body, { error: 'debug routes are loopback-only' });
    }
  }
});

// /debug is mounted only when DEBUG_ROUTES_ENABLED is exactly 'true'.
// Each case builds its own app the way server.js does, with the raw value.
async function storyDataStatusWith(debugRoutes) {
  const app = createApp({ probeDatabase: async () => {}, probeLedger: async () => {}, debugRoutes });
  const s = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => s.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/debug/story-data`);
    await res.text();
    return res.status;
  } finally {
    await new Promise((resolve) => s.close(resolve));
  }
}

test('with DEBUG_ROUTES_ENABLED unset or empty, /debug/story-data is 404', async () => {
  assert.equal(await storyDataStatusWith(undefined), 404);
  assert.equal(await storyDataStatusWith(''), 404);
});

test('with DEBUG_ROUTES_ENABLED exactly "true", /debug/story-data is 200', async () => {
  assert.equal(await storyDataStatusWith('true'), 200);
});

test('with DEBUG_ROUTES_ENABLED set to anything but "true", /debug/story-data is 404 (fail closed)', async () => {
  for (const value of ['1', 'TRUE', 'yes', 'false', ' true']) {
    assert.equal(await storyDataStatusWith(value), 404, `DEBUG_ROUTES_ENABLED=${JSON.stringify(value)}`);
  }
});

test('the story page is served on /debug/story', async () => {
  const { status, text } = await debugGet('/story');
  assert.equal(status, 200);
  assert.match(text, /\/debug\/story-data/);
});

test('story.html loads nothing from outside and says none of the words it must not', () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../public/story.html'), 'utf8');
  assert.doesNotMatch(html, /\b(src|href)\s*=\s*["']?\s*https?:\/\//i, 'no external src or href');
  assert.doesNotMatch(html, /url\(\s*["']?\s*https?:|@import/i, 'no external stylesheet or font');
  assert.doesNotMatch(html, /\b(live|production|compliant|tamper-proof|immutable|pays)\b|payment instruction/i);
});

// story.html's script is
// inline and draws into the DOM, so the two functions that choose its words
// are cut out of the page by text markers and run with node:vm, as statusPill
// is above.
function storyPageFunction(name, parts) {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../public/story.html'), 'utf8');
  const src = parts.map(([start, end]) => sliceBetween(html, start, end)).join('\n');
  return vm.runInThisContext(`(function () {\n${src}\nreturn ${name};\n})`)();
}

test('story.html says "refused by the ledger" only for a ledger refusal, and names the other failures', () => {
  const outcomeText = storyPageFunction('outcomeText', [
    ['const orNotYet = ', ';\n'],
    ['function outcomeText(e) {', '\n  }'],
  ]);
  assert.equal(outcomeText({ outcome: 'refused', refusalCode: 'DAML_FAILURE' }), 'refused by the ledger: DAML_FAILURE');
  const texts = {};
  for (const outcome of ['not sent', 'accepted, not recorded', 'failed']) {
    texts[outcome] = outcomeText({ outcome, refusalCode: null });
    assert.doesNotMatch(texts[outcome], /refused by the ledger|no trigger queued/, outcome);
  }
  assert.match(texts['not sent'], /not sent to the ledger/);
  assert.match(texts['accepted, not recorded'], /accepted by the ledger/);
  assert.equal(new Set(Object.values(texts)).size, 3, 'each failure has its own words');
});

test('story.html names a closed record\'s last step by how it closed', () => {
  const stepName = storyPageFunction('stepName', [
    ['const STEP_NAMES = {', '\n  };'],
    ['const CLOSED_AS = {', '\n  };'],
    ['function stepName(s, closureStatus) {', '\n  }'],
  ]);
  const closed = { key: 'settled', state: 'done' };
  assert.equal(stepName(closed, 'settled'), 'Settled by insurer');
  assert.equal(stepName(closed, 'closed_unpaid'), 'Closed unpaid');
  assert.notEqual(stepName(closed, 'approved'), 'Settled by insurer', 'no other closing is shown as a settlement');
  // The step not reached yet keeps its name, and the other steps are untouched.
  assert.equal(stepName({ key: 'settled', state: 'not yet' }, 'approved'), 'Settled by insurer');
  assert.equal(stepName({ key: 'approved', state: 'done' }, 'closed_unpaid'), 'Approved on ledger');
});

// --- the roles page (debug, loopback-only) -------------------
// What each party's ledger view returns is tested against the ledger in
// dispatcher.test.mjs. Here: the switch, the loopback floor and the page itself.

async function debugStatusWith(debugRoutes, method, url) {
  const app = createApp({ probeDatabase: async () => {}, probeLedger: async () => {}, debugRoutes });
  const s = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => s.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ policyId: crypto.randomUUID() }) : undefined,
    });
    await res.text();
    return res.status;
  } finally {
    await new Promise((resolve) => s.close(resolve));
  }
}

test('with DEBUG_ROUTES_ENABLED unset, empty or not exactly "true", the roles data, the insurer\'s attempt and the roles page are 404', async () => {
  for (const value of [undefined, '', '1', 'TRUE', ' true']) {
    for (const [method, url] of [['GET', '/debug/roles-data'], ['POST', '/debug/roles/try-insurer-trigger'], ['GET', '/debug/roles']]) {
      assert.equal(await debugStatusWith(value, method, url), 404, `${method} ${url} with DEBUG_ROUTES_ENABLED=${JSON.stringify(value)}`);
    }
  }
});

test('the roles data, the insurer\'s attempt and the roles page refuse a caller that is not on loopback', async () => {
  for (const [router, url] of [[debugRouter, '/roles-data'], [debugDashboardRouter, '/roles']]) {
    for (const address of ['192.0.2.10', '::ffff:192.0.2.10', undefined]) {
      const res = await callRouter(router, url, address);
      assert.equal(res.status, 403, `${url} from ${address}`);
    }
  }
  const res = await new Promise((resolve, reject) => {
    const req = { method: 'POST', url: '/roles/try-insurer-trigger', headers: {}, body: {}, socket: { remoteAddress: '192.0.2.10' } };
    const out = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    debugRouter(req, out, (err) => (err ? reject(err) : resolve({ status: 'fell through' })));
  });
  assert.equal(res.status, 403);
});

test('the roles page is served on /debug/roles and asks for its data only when told to', async () => {
  const { status, text } = await debugGet('/roles');
  assert.equal(status, 200);
  assert.match(text, /\/debug\/roles-data/);
  assert.match(text, /\/debug\/roles\/try-insurer-trigger/);
  assert.doesNotMatch(text, /setInterval|setTimeout/, 'no automatic refresh');
});

test('roles.html loads nothing from outside and says none of the words it must not', () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../public/roles.html'), 'utf8');
  assert.doesNotMatch(html, /\b(src|href)\s*=\s*["']?\s*https?:\/\//i, 'no external src or href');
  assert.doesNotMatch(html, /url\(\s*["']?\s*https?:|@import/i, 'no external stylesheet or font');
  assert.doesNotMatch(html, /\b(live|production|compliant|tamper-proof|pays)\b/i);
  assert.match(html, /synthetic data, LocalNet/i);
});

// --- the insurer's terms and tier sets ----------------------------
//
// GET/PUT /terms and GET/PUT/DELETE /terms/payout-tiers/:productCode/:perilType,
// all on insurer A unless a test says otherwise. Every terms test puts A's six
// columns back as it found them, so nothing later in this file sees its values.

const TERMS_COLUMNS_UNDER_TEST = {
  defaultGracePeriodDays: 'default_grace_period_days',
  mortgageeContinuationDays: 'mortgagee_continuation_days',
  firstPremiumWithdrawalDays: 'first_premium_withdrawal_days',
  defaultEventWindowTimezone: 'default_event_window_timezone',
  defaultEventWindowStartHour: 'default_event_window_start_hour',
  defaultEventAggregation: 'default_event_aggregation',
};
const TERMS_KEYS = Object.keys(TERMS_COLUMNS_UNDER_TEST);

// Test values only: not a period anyone chose, beyond the grace floor itself.
const termsDoc = (overrides = {}) => ({
  defaultGracePeriodDays: STATUTORY_MIN_GRACE_PERIOD_DAYS + 3,
  mortgageeContinuationDays: 21,
  firstPremiumWithdrawalDays: 45,
  defaultEventWindowTimezone: 'Europe/Istanbul',
  defaultEventWindowStartHour: 6,
  defaultEventAggregation: 'min',
  ...overrides,
});

async function termsRow(id = insurerId) {
  const { rows } = await pool.query(
    `SELECT ${Object.values(TERMS_COLUMNS_UNDER_TEST).join(', ')} FROM insurers WHERE id = $1`,
    [id]
  );
  return rows[0];
}

async function withTermsRestored(fn) {
  const saved = await termsRow();
  try {
    await fn();
  } finally {
    const columns = Object.values(TERMS_COLUMNS_UNDER_TEST);
    await pool.query(
      `UPDATE insurers SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [insurerId, ...columns.map((c) => saved[c])]
    );
  }
}

const frostFixture = JSON.parse(
  fs.readFileSync(new URL('../test-support/frostStandardGapSetFixture.json', import.meta.url), 'utf8')
);
// A product code no other test uses, so a tier set here never meets TEST-PRODUCT.
const termsProduct = (name) => `TERMS-${name}-${crypto.randomUUID().slice(0, 8)}`;
const stepTier = (tierOrder, minValue, maxValue, label = `test tier ${tierOrder}`) => ({
  tierOrder, label, minValue, maxValue, payoutPct: '25.00', shape: 'TS_Step', pctAtMin: null, pctAtMax: null,
});
const threeTiers = [stepTier(1, '-2.0000', '0.0000'), stepTier(2, '-6.0000', '-3.0000'), stepTier(3, null, '-8.0000')];
const twoTiers = [stepTier(1, '-2.0000', '0.0000'), stepTier(2, null, '-4.0000')];

async function tierRowCount(productCode, perilType, id = insurerId) {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM payout_tiers WHERE insurer_id = $1 AND product_code = $2 AND peril_type = $3',
    [id, productCode, perilType]
  );
  return rows[0].n;
}

test('the terms and tier-set routes with no x-api-key are 401', async () => {
  for (const [method, url, body] of [
    ['GET', '/terms'],
    ['PUT', '/terms', termsDoc()],
    ['GET', '/terms/payout-tiers/FROST-STANDARD/FROST'],
    ['PUT', '/terms/payout-tiers/FROST-STANDARD/FROST', { tiers: frostFixture.tiers }],
    ['DELETE', '/terms/payout-tiers/FROST-STANDARD/FROST'],
  ]) {
    const { status } = await call(method, url, body, null);
    assert.equal(status, 401, `${method} ${url}`);
  }
});

test("another insurer's GET /terms never shows insurer A's values", () =>
  withTermsRestored(async () => {
    const mine = termsDoc({
      defaultGracePeriodDays: STATUTORY_MIN_GRACE_PERIOD_DAYS + 7,
      mortgageeContinuationDays: 41,
      firstPremiumWithdrawalDays: 43,
      defaultEventWindowTimezone: 'Asia/Tokyo',
      defaultEventWindowStartHour: 5,
      defaultEventAggregation: 'max',
    });
    const put = await call('PUT', '/terms', mine);
    assert.equal(put.status, 200, put.text);
    const own = await call('GET', '/terms');
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(own.body, mine);
    const other = await call('GET', '/terms', undefined, otherKey);
    assert.equal(other.status, 200, other.text);
    const otherRow = await termsRow(otherInsurerId);
    assert.deepEqual(other.body, Object.fromEntries(TERMS_KEYS.map((k) => [k, otherRow[TERMS_COLUMNS_UNDER_TEST[k]]])));
    for (const k of TERMS_KEYS) assert.notEqual(other.body[k], mine[k], `${k} is A's value`);
  }));

test('a PUT /terms missing any one of the six keys is 400, and the row is unchanged', () =>
  withTermsRestored(async () => {
    const before = await termsRow();
    for (const missing of TERMS_KEYS) {
      const doc = termsDoc();
      delete doc[missing];
      const { status, body, text } = await call('PUT', '/terms', doc);
      assert.equal(status, 400, `${missing}: ${text}`);
      assert.match(body.error, new RegExp(missing));
      assert.deepEqual(await termsRow(), before, `${missing}: the row changed`);
    }
  }));

test('the grace period: one day under the statutory floor is 400 naming it, the floor is 200, null is 200 and NULL', () =>
  withTermsRestored(async () => {
    const before = await termsRow();
    const under = await call('PUT', '/terms', termsDoc({ defaultGracePeriodDays: STATUTORY_MIN_GRACE_PERIOD_DAYS - 1 }));
    assert.equal(under.status, 400, under.text);
    assert.match(under.body.error, new RegExp(`\\b${STATUTORY_MIN_GRACE_PERIOD_DAYS}\\b`));
    assert.deepEqual(await termsRow(), before);

    const floor = await call('PUT', '/terms', termsDoc({ defaultGracePeriodDays: STATUTORY_MIN_GRACE_PERIOD_DAYS }));
    assert.equal(floor.status, 200, floor.text);
    assert.deepEqual(floor.body, termsDoc({ defaultGracePeriodDays: STATUTORY_MIN_GRACE_PERIOD_DAYS }));
    assert.equal((await termsRow()).default_grace_period_days, STATUTORY_MIN_GRACE_PERIOD_DAYS);

    const unset = await call('PUT', '/terms', termsDoc({ defaultGracePeriodDays: null }));
    assert.equal(unset.status, 200, unset.text);
    assert.equal(unset.body.defaultGracePeriodDays, null);
    assert.equal((await termsRow()).default_grace_period_days, null);
  }));

test('the mortgagee continuation and first-premium withdrawal days: 0, -1, 1.5 and "10" are 400; null is 200 and NULL', () =>
  withTermsRestored(async () => {
    for (const key of ['mortgageeContinuationDays', 'firstPremiumWithdrawalDays']) {
      const before = await termsRow();
      for (const value of [0, -1, 1.5, '10']) {
        const { status, text } = await call('PUT', '/terms', termsDoc({ [key]: value }));
        assert.equal(status, 400, `${key} ${JSON.stringify(value)}: ${text}`);
        assert.deepEqual(await termsRow(), before, `${key} ${JSON.stringify(value)}: the row changed`);
      }
      const unset = await call('PUT', '/terms', termsDoc({ [key]: null }));
      assert.equal(unset.status, 200, unset.text);
      assert.equal(unset.body[key], null);
      assert.equal((await termsRow())[TERMS_COLUMNS_UNDER_TEST[key]], null);
    }
  }));

// 2147483647 is the largest value of a PostgreSQL INTEGER, the type of all three columns.
test('a grace, continuation or withdrawal period of 3000000000 is 400 naming it, not 500; 2147483647 is 200', () =>
  withTermsRestored(async () => {
    for (const key of ['defaultGracePeriodDays', 'mortgageeContinuationDays', 'firstPremiumWithdrawalDays']) {
      const before = await termsRow();
      const { status, body, text } = await call('PUT', '/terms', termsDoc({ [key]: 3000000000 }));
      assert.equal(status, 400, `${key}: ${text}`);
      assert.match(body.error, new RegExp(key));
      assert.deepEqual(await termsRow(), before, `${key}: the row changed`);
      const max = await call('PUT', '/terms', termsDoc({ [key]: 2147483647 }));
      assert.equal(max.status, 200, `${key}: ${max.text}`);
      assert.equal((await termsRow())[TERMS_COLUMNS_UNDER_TEST[key]], 2147483647);
    }
  }));

test('the event window: an unknown zone, hour 24, "median" and a mixed triple are 400; all three null is 200 and NULL', () =>
  withTermsRestored(async () => {
    const before = await termsRow();
    for (const overrides of [
      { defaultEventWindowTimezone: 'Not/AZone' },
      { defaultEventWindowStartHour: 24 },
      { defaultEventAggregation: 'median' },
      { defaultEventWindowStartHour: null },
    ]) {
      const { status, text } = await call('PUT', '/terms', termsDoc(overrides));
      assert.equal(status, 400, `${JSON.stringify(overrides)}: ${text}`);
      assert.deepEqual(await termsRow(), before, `${JSON.stringify(overrides)}: the row changed`);
    }
    const unset = await call('PUT', '/terms', termsDoc({
      defaultEventWindowTimezone: null, defaultEventWindowStartHour: null, defaultEventAggregation: null,
    }));
    assert.equal(unset.status, 200, unset.text);
    const row = await termsRow();
    assert.equal(row.default_event_window_timezone, null);
    assert.equal(row.default_event_window_start_hour, null);
    assert.equal(row.default_event_aggregation, null);
  }));

test('a PUT of the FROST-STANDARD set is 200, lists only the (-4, -2) gap, and a GET reads the input back', async () => {
  const url = `/terms/payout-tiers/${frostFixture.productCode}/${frostFixture.perilType}`;
  const put = await call('PUT', url, { tiers: frostFixture.tiers });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.body.productCode, frostFixture.productCode);
  assert.equal(put.body.perilType, frostFixture.perilType);
  assert.deepEqual(put.body.tiers, frostFixture.tiers);
  assert.deepEqual(put.body.gaps, [{ from: '-4.0000', to: '-2.0000', betweenTiers: [2, 1] }]);
  const get = await call('GET', url);
  assert.equal(get.status, 200, get.text);
  assert.deepEqual(get.body, { productCode: frostFixture.productCode, perilType: frostFixture.perilType, tiers: frostFixture.tiers });
});

test('a PUT of an overlapping tier set is 400, and the previous rows are intact', async () => {
  const product = termsProduct('overlap');
  const url = `/terms/payout-tiers/${product}/FROST`;
  assert.equal((await call('PUT', url, { tiers: twoTiers })).status, 200);
  const { status, text } = await call('PUT', url, { tiers: [stepTier(1, '-2.0000', '0.0000'), stepTier(2, '-3.0000', '-2.0000')] });
  assert.equal(status, 400, text);
  const get = await call('GET', url);
  assert.deepEqual(get.body.tiers, twoTiers);
});

test('a PUT of three tiers, then of two, leaves exactly two rows', async () => {
  const product = termsProduct('replace');
  const url = `/terms/payout-tiers/${product}/FROST`;
  assert.equal((await call('PUT', url, { tiers: threeTiers })).status, 200);
  assert.equal(await tierRowCount(product, 'FROST'), 3);
  assert.equal((await call('PUT', url, { tiers: twoTiers })).status, 200);
  assert.equal(await tierRowCount(product, 'FROST'), 2);
  assert.deepEqual((await call('GET', url)).body.tiers, twoTiers);
});

test('a PUT with an 81-character label, or a label of spaces only, is 400 and writes nothing', async () => {
  const product = termsProduct('label');
  const url = `/terms/payout-tiers/${product}/FROST`;
  for (const label of ['x'.repeat(81), '   ']) {
    const { status, text } = await call('PUT', url, { tiers: [stepTier(1, '-2.0000', '0.0000', label)] });
    assert.equal(status, 400, `${JSON.stringify(label)}: ${text}`);
    assert.equal(await tierRowCount(product, 'FROST'), 0);
  }
});

test('a PUT with a tierOrder of 3000000000 or -3000000000 is 400 naming tierOrder, not 500, and writes nothing', async () => {
  const product = termsProduct('tierorder');
  const url = `/terms/payout-tiers/${product}/FROST`;
  for (const tierOrder of [3000000000, -3000000000]) {
    const { status, body, text } = await call('PUT', url, { tiers: [stepTier(tierOrder, '-2.0000', '0.0000', 'test tier')] });
    assert.equal(status, 400, `${tierOrder}: ${text}`);
    assert.match(body.error, /tierOrder/);
    assert.equal(await tierRowCount(product, 'FROST'), 0);
  }
});

test('after DELETE the set is 404 and POST /policies for that product is 422; a set that does not exist is 404 to DELETE', async () => {
  const product = termsProduct('delete');
  const url = `/terms/payout-tiers/${product}/FROST`;
  const coverages = [{ ...policyBody().coverages[0], productCode: product, perilType: 'FROST' }];
  assert.equal((await call('PUT', url, { tiers: twoTiers })).status, 200);
  const created = await call('POST', '/policies', policyBody({ coverages }));
  assert.equal(created.status, 201, created.text);

  const del = await call('DELETE', url);
  assert.equal(del.status, 200, del.text);
  assert.equal(await tierRowCount(product, 'FROST'), 0);
  assert.equal((await call('GET', url)).status, 404);
  const refused = await call('POST', '/policies', policyBody({ coverages }));
  assert.equal(refused.status, 422, refused.text);

  assert.equal((await call('DELETE', url)).status, 404);
  assert.equal((await call('DELETE', `/terms/payout-tiers/${termsProduct('never')}/FROST`)).status, 404);
});

test('PUTs of one tier set in parallel never give a 500', async () => {
  const product = termsProduct('parallel');
  const url = `/terms/payout-tiers/${product}/FROST`;
  for (let round = 0; round < 5; round += 1) {
    const results = await Promise.all([threeTiers, twoTiers, threeTiers, twoTiers].map((tiers) => call('PUT', url, { tiers })));
    for (const r of results) assert.equal(r.status, 200, r.text);
    assert.ok([2, 3].includes(await tierRowCount(product, 'FROST')), 'one whole set is left, never a mix');
  }
});

test("another insurer's GET of a set only insurer A configured is 404", async () => {
  const product = termsProduct('tenant');
  const url = `/terms/payout-tiers/${product}/FROST`;
  assert.equal((await call('PUT', url, { tiers: twoTiers })).status, 200);
  const other = await call('GET', url, undefined, otherKey);
  assert.equal(other.status, 404, other.text);
  assert.equal((await call('GET', url)).status, 200);
});

// --- a configured tier set that breaks validateTierSet ------------
//
// A set written by SQL, setupDemo or seed has not passed the PUT's checks.
// Creation and renewal refuse it 422 before any write. Each case
// writes its rows straight into payout_tiers under a product code of its own.

async function insertTierRows(productCode, perilType, tiers) {
  for (const t of tiers) {
    await pool.query(
      `INSERT INTO payout_tiers
         (insurer_id, product_code, peril_type, tier_order, label, threshold_min, threshold_max,
          payout_percentage, shape, pct_at_min, pct_at_max)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [insurerId, productCode, perilType, t.tierOrder, t.label, t.minValue, t.maxValue, t.payoutPct, t.shape,
        t.pctAtMin, t.pctAtMax]
    );
  }
}

const overlappingTiers = [stepTier(1, '-2.0000', '0.0000'), stepTier(2, '0.0000', '1.0000')];
const configuredCoverage = (productCode) => [{
  ...policyBody().coverages[0], coverageCode: 'S4-COVERAGE', productCode, perilType: 'FROST',
}];

test('creation with a configured set whose tiers overlap is 422 naming the product, peril and coverage, and writes nothing', async () => {
  const product = termsProduct('s4-overlap-create');
  await insertTierRows(product, 'FROST', overlappingTiers);
  const before = await insurerRowCounts();
  const { status, body, text } = await call('POST', '/policies', policyBody({ coverages: configuredCoverage(product) }));
  assert.equal(status, 422, text);
  assert.match(body.error, /overlap/);
  for (const name of [product, 'FROST', 'S4-COVERAGE']) assert.ok(body.error.includes(name), `names ${name}: ${body.error}`);
  assert.deepEqual(await insurerRowCounts(), before, 'no row of any kind');
});

test('renewal with a configured set whose tiers overlap is 422, with no successor and no renewal row', async () => {
  const product = termsProduct('s4-overlap-renew');
  await insertTierRows(product, 'FROST', overlappingTiers);
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  const before = await insurerRowCounts();
  const { status, body, text } = await call('POST', `/policies/${predecessor.id}/renew`, {
    ...validRenewal(),
    coverages: configuredCoverage(product),
  });
  assert.equal(status, 422, text);
  assert.match(body.error, /overlap/);
  assert.deepEqual(await successorsOf(predecessor), [], 'no successor');
  assert.deepEqual(await renewalRowsOf(predecessor), [], 'no renewal row');
  assert.deepEqual(await insurerRowCounts(), before, 'no row of any kind');
});

test('creation with a configured tier label holding 11 digits in a row is 422, and the label is not echoed', async () => {
  const product = termsProduct('s4-label');
  const label = 'frost 12345678901';
  await insertTierRows(product, 'FROST', [stepTier(1, '-2.0000', '0.0000', label)]);
  const before = await insurerRowCounts();
  const { status, body, text } = await call('POST', '/policies', policyBody({ coverages: configuredCoverage(product) }));
  assert.equal(status, 422, text);
  assert.match(body.error, /11 digits in a row/);
  assert.ok(!text.includes('12345678901'), `the digits are not echoed: ${text}`);
  assert.ok(!text.includes(label), `the label is not echoed: ${text}`);
  assert.deepEqual(await insurerRowCounts(), before, 'no row of any kind');
});

test('creation with a configured FROST-STANDARD-shaped gap set is 201, and the snapshot equals the rows', async () => {
  const product = termsProduct('s4-gapset');
  await insertTierRows(product, frostFixture.perilType, frostFixture.tiers);
  const { status, body, text } = await call('POST', '/policies', policyBody({
    coverages: [{ ...configuredCoverage(product)[0], perilType: frostFixture.perilType }],
  }));
  assert.equal(status, 201, text);
  assert.deepEqual(body.coverages[0].payout_tiers_snapshot, frostFixture.tiers);
});

// --- an added coverage's tier set on endorse ----------------------
//
// The route runs validateTierSet on each coveragesToAdd[].payoutTiers before
// the outbox row is written
// and queues the set sorted by tierOrder. A fresh policy per case:
// a case that wrongly queued a row would turn the next one into a 409.

const addedCoverage = (payoutTiers) => ({
  ...coverageWithCells([SECOND_VALID_CELL]),
  coverageCode: 'TEST-COVERAGE-ADDED',
  ...(payoutTiers === undefined ? {} : { payoutTiers }),
});

test('an endorsement refuses an added coverage whose tier set is missing, empty, overlapping, out of range, too precise or badly labelled, and queues nothing', async () => {
  const label = 'frost 12345678901';
  const cases = [
    ['no payoutTiers', undefined, /non-empty array/],
    ['payoutTiers []', [], /non-empty array/],
    ['overlapping', overlappingTiers, /overlap/],
    ['step payoutPct 150', [{ ...stepTier(1, '-2.0000', '0.0000'), payoutPct: '150.00' }], /payoutPct must be in \(0, 100\]/],
    ['threshold with 5 decimals', [stepTier(1, '-2.00001', '0.0000')], /more than 4 decimal places/],
    ['label with 11 digits in a row', [stepTier(1, '-2.0000', '0.0000', label)], /11 digits in a row/],
  ];
  for (const [name, payoutTiers, message] of cases) {
    const policy = await createPolicy();
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/endorse`, {
      reason: 'ER_InsuredObjectChange',
      coveragesToAdd: [addedCoverage(payoutTiers)],
    });
    assert.equal(status, 400, `${name}: ${text}`);
    assert.match(body.error, message, name);
    assert.ok(body.error.includes('TEST-COVERAGE-ADDED'), `${name}: names the coverage: ${body.error}`);
    assert.ok(!text.includes(label), `${name}: no label is echoed: ${text}`);
    assert.deepEqual(await insurerRowCounts(), before, `${name}: no row of any kind`);
  }
});

test('an endorsement adding a coverage with a valid tier set out of order is 202, and queues the set sorted by tierOrder', async () => {
  const policy = await createPolicy();
  const { status, body, text } = await call('POST', `/policies/${policy.id}/endorse`, {
    reason: 'ER_InsuredObjectChange',
    coveragesToAdd: [addedCoverage([twoTiers[1], twoTiers[0]])],
  });
  assert.equal(status, 202, text);
  assert.deepEqual((await queuedPayload(body.event.id)).coveragesToAdd[0].payoutTiers, twoTiers);
});

// --- sumInsured on endorse -----------------------------------------
//
// The rule: a
// sumInsured in sumInsuredChanges or coveragesToAdd is greater than zero, with
// at most 12 integer digits and 2 decimals -- policy_coverages.sum_insured's
// NUMERIC(14,2) -- and a number or a numeric string. Refused with 400
// before the outbox row. A fresh policy per case, as above.

const SUM_INSURED_RULE = [/greater than zero/, /12 integer digits/, /2 decimals/];

test('an endorsement refuses a sumInsured that is not greater than zero with at most 12 integer digits and 2 decimals, and queues nothing', async () => {
  const refused = [1000.005, 1e12, -5, 0, '0', 'abc', 1e-7, 0.001, true, [1000]];
  for (const sumInsured of refused) {
    const name = `sumInsuredChanges ${JSON.stringify(sumInsured)}`;
    const policy = await createPolicy();
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/endorse`, {
      reason: 'ER_SumInsuredIncrease',
      sumInsuredChanges: [{ coverageCode: 'TEST-COVERAGE', sumInsured }],
    });
    assert.equal(status, 400, `${name}: ${text}`);
    for (const rule of SUM_INSURED_RULE) assert.match(body.error, rule, name);
    assert.deepEqual(await insurerRowCounts(), before, `${name}: no row of any kind`);
  }

  const policy = await createPolicy();
  const before = await insurerRowCounts();
  const notAnArray = await call('POST', `/policies/${policy.id}/endorse`, {
    reason: 'ER_SumInsuredIncrease',
    sumInsuredChanges: 'x',
  });
  assert.equal(notAnArray.status, 400, notAnArray.text);
  assert.deepEqual(await insurerRowCounts(), before, 'sumInsuredChanges \'x\': no row of any kind');

  const added = await createPolicy();
  const beforeAdded = await insurerRowCounts();
  const { status, body, text } = await call('POST', `/policies/${added.id}/endorse`, {
    reason: 'ER_InsuredObjectChange',
    coveragesToAdd: [{ ...addedCoverage([stepTier(1, '-2.0000', '0.0000')]), sumInsured: 1000.005 }],
  });
  assert.equal(status, 400, text);
  for (const rule of SUM_INSURED_RULE) assert.match(body.error, rule, 'coveragesToAdd');
  assert.ok(body.error.includes('TEST-COVERAGE-ADDED'), `names the coverage: ${body.error}`);
  assert.deepEqual(await insurerRowCounts(), beforeAdded, 'coveragesToAdd: no row of any kind');
});

test('an endorsement with a sumInsured of 1000.05, \'1000.05\' or 250000 is 202, and queues the value sent', async () => {
  for (const sumInsured of [1000.05, '1000.05', 250000]) {
    const policy = await createPolicy();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/endorse`, {
      reason: 'ER_SumInsuredIncrease',
      sumInsuredChanges: [{ coverageCode: 'TEST-COVERAGE', sumInsured }],
    });
    assert.equal(status, 202, `${JSON.stringify(sumInsured)}: ${text}`);
    assert.deepEqual(
      (await queuedPayload(body.event.id)).sumInsuredChanges,
      [{ coverageCode: 'TEST-COVERAGE', sumInsured }],
      JSON.stringify(sumInsured)
    );
  }
});

// --- an added coverage's payout routing and mortgagee claim on endorse
//
// Create's rule moves over to endorse. payoutDestination and
// remainingLimit of an added coverage are derived by the dispatcher, so a
// coveragesToAdd item carrying either key is refused -- stricter than create,
// which ignores them. A mortgageeClaimAmount is held to the sumInsured rule
// and needs an effective mortgagee: newMortgagee
// when the body changes it, otherwise the policy's own. Refused with 400 before
// the outbox row; another insurer's policy is 404. A fresh policy per case.

const mortgagedPolicy = () => createPolicy({ mortgagee: { externalRef: `api-test-${crypto.randomUUID()}` } });
const claimingCoverage = (mortgageeClaimAmount, extra = {}) => ({
  ...addedCoverage([stepTier(1, '-2.0000', '0.0000')]),
  sumInsured: 1000,
  mortgageeClaimAmount,
  ...extra,
});

test('an endorsement refuses an added coverage carrying payoutDestination or remainingLimit, and queues nothing', async () => {
  const cases = [
    ['payoutDestination', { payoutDestination: ['PDR_Beneficiary'] }, /payoutDestination/],
    ['remainingLimit', { remainingLimit: 1 }, /remainingLimit/],
  ];
  for (const [name, extra, message] of cases) {
    const policy = await createPolicy();
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/endorse`, {
      reason: 'ER_InsuredObjectChange',
      coveragesToAdd: [{ ...addedCoverage([stepTier(1, '-2.0000', '0.0000')]), sumInsured: 1000, ...extra }],
    });
    assert.equal(status, 400, `${name}: ${text}`);
    assert.match(body.error, message, name);
    assert.match(body.error, /derived/, name);
    assert.ok(body.error.includes('TEST-COVERAGE-ADDED'), `${name}: names the coverage: ${body.error}`);
    assert.deepEqual(await insurerRowCounts(), before, `${name}: no row of any kind`);
  }
});

test('an endorsement refuses a mortgageeClaimAmount of -5, 0 or 100.005, and queues nothing', async () => {
  for (const claim of [-5, 0, 100.005]) {
    const name = `mortgageeClaimAmount ${JSON.stringify(claim)}`;
    const policy = await mortgagedPolicy();
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/endorse`, {
      reason: 'ER_InsuredObjectChange',
      coveragesToAdd: [claimingCoverage(claim)],
    });
    assert.equal(status, 400, `${name}: ${text}`);
    assert.match(body.error, /mortgageeClaimAmount/, name);
    for (const rule of SUM_INSURED_RULE) assert.match(body.error, rule, name);
    assert.ok(body.error.includes('TEST-COVERAGE-ADDED'), `${name}: names the coverage: ${body.error}`);
    assert.deepEqual(await insurerRowCounts(), before, `${name}: no row of any kind`);
  }
});

test('an endorsement refuses a mortgageeClaimAmount with no effective mortgagee, and queues nothing', async () => {
  const cases = [
    ['a policy with no mortgagee', createPolicy, {}],
    ['newMortgagee: null in the same body', mortgagedPolicy, { newMortgagee: null }],
  ];
  for (const [name, makePolicy, extra] of cases) {
    const policy = await makePolicy();
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', `/policies/${policy.id}/endorse`, {
      reason: 'ER_InsuredObjectChange',
      coveragesToAdd: [claimingCoverage(100)],
      ...extra,
    });
    assert.equal(status, 400, `${name}: ${text}`);
    assert.match(body.error, /mortgageeClaimAmount but the policy names no mortgagee/, name);
    assert.ok(body.error.includes('TEST-COVERAGE-ADDED'), `${name}: names the coverage: ${body.error}`);
    assert.deepEqual(await insurerRowCounts(), before, `${name}: no row of any kind`);
  }
});

test('an endorsement with a mortgageeClaimAmount on another insurer\'s policy is 404, not 400, and queues nothing', async () => {
  // The other insurer's policy names no mortgagee, so a read not scoped to the
  // caller would answer 400 here.
  const othersPolicy = await createPolicyAs(otherKey);
  const before = await insurerRowCounts();
  const { status, text } = await call('POST', `/policies/${othersPolicy.id}/endorse`, {
    reason: 'ER_InsuredObjectChange',
    coveragesToAdd: [claimingCoverage(100)],
  });
  assert.equal(status, 404, text);
  assert.deepEqual(await insurerRowCounts(), before, 'no row of any kind');
  assert.equal((await lifecycleRowsOf(othersPolicy.id, 'endorsement')).length, 0, 'nothing queued on the other policy');
});

test('an endorsement adding a coverage with a claim of 100 is 202 on a mortgaged policy, or with newMortgagee in the same body', async () => {
  const mortgaged = await mortgagedPolicy();
  const onMortgaged = await call('POST', `/policies/${mortgaged.id}/endorse`, {
    reason: 'ER_InsuredObjectChange',
    coveragesToAdd: [claimingCoverage(100)],
  });
  assert.equal(onMortgaged.status, 202, onMortgaged.text);
  const [queued] = (await queuedPayload(onMortgaged.body.event.id)).coveragesToAdd;
  assert.equal(queued.mortgageeClaimAmount, 100);
  assert.ok(!('payoutDestination' in queued), 'no payoutDestination key: the dispatcher derives it');

  const ownParty = await createRegisteredParty(insurerId);
  const unmortgaged = await createPolicy();
  const withNewMortgagee = await call('POST', `/policies/${unmortgaged.id}/endorse`, {
    reason: 'ER_InsuredObjectChange',
    coveragesToAdd: [claimingCoverage(100)],
    newMortgagee: ownParty,
  });
  assert.equal(withNewMortgagee.status, 202, withNewMortgagee.text);
  assert.deepEqual((await queuedPayload(withNewMortgagee.body.event.id)).newMortgagee, { value: ownParty });
});

// --- a same-code replace, and removing an attached coverage, on endorse
//
// A code both removed and added in one endorsement is refused, and
// so is removing a coverage that is attached now (m. 1457), whether or not a
// replacement is added: the added coverage carries no attachment, so the
// attachment would not survive the replacement. 'Attached now' is schema.sql's
// idx_policy_coverages_attached. Refused with 400 before the outbox row.

const fireCoverage = (coverageCode) => ({ ...policyBody().coverages[0], coverageCode });

test('an endorsement removing and adding the same coverage code is 400, and queues nothing', async () => {
  const policy = await createPolicy({ coverages: [fireCoverage('FIRE')] });
  const before = await insurerRowCounts();
  const { status, body, text } = await call('POST', `/policies/${policy.id}/endorse`, {
    reason: 'ER_TierChange',
    coverageCodesToRemove: ['FIRE'],
    coveragesToAdd: [{ ...addedCoverage([stepTier(1, '-2.0000', '0.0000')]), coverageCode: 'FIRE', sumInsured: 1000 }],
  });
  assert.equal(status, 400, text);
  assert.ok(body.error.includes('FIRE'), `names the coverage: ${body.error}`);
  assert.match(body.error, /different code/);
  assert.deepEqual(await insurerRowCounts(), before, 'no row of any kind');
});

test('an endorsement removing a coverage that is attached now is 400 even with a new code added, and queues nothing', async () => {
  const policy = await createPolicy({ coverages: [fireCoverage('FIRE')] });
  await pool.query(
    `UPDATE policy_coverages SET attached_at = now() - interval '1 day'
      WHERE policy_id = $1 AND coverage_code = 'FIRE'`,
    [policy.id]
  );
  const before = await insurerRowCounts();
  const { status, body, text } = await call('POST', `/policies/${policy.id}/endorse`, {
    reason: 'ER_TierChange',
    coverageCodesToRemove: ['FIRE'],
    coveragesToAdd: [{ ...addedCoverage([stepTier(1, '-2.0000', '0.0000')]), coverageCode: 'FIRE-2', sumInsured: 1000 }],
  });
  assert.equal(status, 400, text);
  assert.ok(body.error.includes('FIRE'), `names the coverage: ${body.error}`);
  assert.match(body.error, /attach/);
  assert.deepEqual(await insurerRowCounts(), before, 'no row of any kind');
});

// --- inline coverages[].payoutTiers on create and renew -----------
//
// A coverage that carries payoutTiers is snapshotted from them, not from
// payout_tiers: inline wins. The set is held to
// validateTierSet's rules and refused with 400 before any write. Both answers
// name each coverage's tier source and the inner gaps of the set its snapshot
// used. The source is not stored.

const inlineCoverage = (payoutTiers, productCode = 'TEST-PRODUCT') => ({
  ...policyBody().coverages[0], coverageCode: 'S9-COVERAGE', productCode, payoutTiers,
});
const TWO_TIERS_GAP = [{ from: '-4.0000', to: '-2.0000', betweenTiers: [2, 1] }];

const refusedInlineSets = () => [
  ['overlapping', overlappingTiers, /overlap/],
  ['an 81-character label', [stepTier(1, '-2.0000', '0.0000', 'a'.repeat(81))], /longer than 80 characters/],
  ['a label of spaces only', [stepTier(1, '-2.0000', '0.0000', '   ')], /empty or only spaces/],
  ['a threshold with 5 decimals', [stepTier(1, '-2.00001', '0.0000')], /more than 4 decimal places/],
  ['payoutTiers null', null, /non-empty array/],
  ['a label with 11 digits in a row', [stepTier(1, '-2.0000', '0.0000', 'frost 12345678901')], /11 digits in a row/],
];

test('creation with an inline set for a product with no configured rows is 201: the snapshot is the sorted set, with its source and gaps', async () => {
  const product = termsProduct('s9-inline-norows');
  const { status, body, text } = await call('POST', '/policies', policyBody({
    coverages: [inlineCoverage([twoTiers[1], twoTiers[0]], product)],
  }));
  assert.equal(status, 201, text);
  assert.deepEqual(body.coverages[0].payout_tiers_snapshot, twoTiers);
  assert.equal(body.coverages[0].tiersSource, 'inline');
  assert.deepEqual(body.coverages[0].gaps, TWO_TIERS_GAP);
});

test('creation with an inline set for a product with configured rows uses the inline set', async () => {
  const { status, body, text } = await call('POST', '/policies', policyBody({ coverages: [inlineCoverage(threeTiers)] }));
  assert.equal(status, 201, text);
  assert.deepEqual(body.coverages[0].payout_tiers_snapshot, threeTiers);
  assert.equal(body.coverages[0].tiersSource, 'inline');
});

test('creation with no inline set on the fixture product is 201 with tiersSource configured and no gaps', async () => {
  const { status, body, text } = await call('POST', '/policies', policyBody());
  assert.equal(status, 201, text);
  assert.equal(body.coverages[0].tiersSource, 'configured');
  assert.deepEqual(body.coverages[0].gaps, []);
});

test('an inline set\'s decimals are snapshotted as strings in the form the configured columns give them', async () => {
  const linear = {
    tierOrder: 2, label: 'linear', minValue: '-10', maxValue: -3, payoutPct: 100, shape: 'TS_Linear', pctAtMin: '100', pctAtMax: 50.5,
  };
  const step = { ...stepTier(1, -2, '0'), payoutPct: 25 };
  const { status, body, text } = await call('POST', '/policies', policyBody({ coverages: [inlineCoverage([linear, step])] }));
  assert.equal(status, 201, text);
  assert.deepEqual(body.coverages[0].payout_tiers_snapshot, [
    { ...stepTier(1, '-2.0000', '0.0000'), payoutPct: '25.00' },
    { ...linear, minValue: '-10.0000', maxValue: '-3.0000', payoutPct: '100.00', pctAtMin: '100.00', pctAtMax: '50.50' },
  ]);
  assert.deepEqual(body.coverages[0].gaps, [{ from: '-3.0000', to: '-2.0000', betweenTiers: [2, 1] }]);
});

test('creation with an inline FROST-STANDARD set lists exactly the (-4, -2) gap', async () => {
  const { status, body, text } = await call('POST', '/policies', policyBody({
    coverages: [{ ...inlineCoverage(frostFixture.tiers, termsProduct('s9-frost')), perilType: frostFixture.perilType }],
  }));
  assert.equal(status, 201, text);
  assert.deepEqual(body.coverages[0].payout_tiers_snapshot, frostFixture.tiers);
  assert.deepEqual(body.coverages[0].gaps, [{ from: '-4.0000', to: '-2.0000', betweenTiers: [2, 1] }]);
});

test('creation refuses an inline set that is overlapping, badly labelled, too precise or null with 400, and writes nothing', async () => {
  for (const [name, payoutTiers, message] of refusedInlineSets()) {
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', '/policies', policyBody({ coverages: [inlineCoverage(payoutTiers)] }));
    assert.equal(status, 400, `${name}: ${text}`);
    assert.match(body.error, message, name);
    assert.ok(body.error.includes('S9-COVERAGE'), `${name}: names the coverage: ${body.error}`);
    assert.ok(!text.includes('12345678901'), `${name}: no label is echoed: ${text}`);
    assert.deepEqual(await insurerRowCounts(), before, `${name}: no row of any kind`);
  }
});

async function renewablePolicy() {
  const predecessor = await createPolicy();
  await pool.query(`UPDATE policies SET status = 'active' WHERE id = $1`, [predecessor.id]);
  return predecessor;
}

test('renewal with an inline set for a product with no configured rows is 202, snapshots the sorted set and names its source and gaps', async () => {
  const predecessor = await renewablePolicy();
  const product = termsProduct('s9-inline-renew');
  const { status, body, text } = await call('POST', `/policies/${predecessor.id}/renew`, {
    ...validRenewal(),
    coverages: [inlineCoverage([twoTiers[1], twoTiers[0]], product)],
  });
  assert.equal(status, 202, text);
  assert.deepEqual(body.coverages, [{ coverageCode: 'S9-COVERAGE', tiersSource: 'inline', gaps: TWO_TIERS_GAP }]);
  const { rows } = await pool.query(
    'SELECT payout_tiers_snapshot FROM policy_coverages WHERE policy_id = $1', [body.successorPolicyId]
  );
  assert.deepEqual(rows.map((r) => r.payout_tiers_snapshot), [twoTiers]);
});

test('renewal names each coverage\'s tier source and gaps in request order: configured with none, inline with its own', async () => {
  const predecessor = await renewablePolicy();
  const { status, body, text } = await call('POST', `/policies/${predecessor.id}/renew`, {
    ...validRenewal(),
    coverages: [
      { ...coverageWithCells([VALID_CELL]), coverageCode: 'S9-B' },
      { ...inlineCoverage(twoTiers), cellIds: [SECOND_VALID_CELL], coverageCode: 'S9-A' },
    ],
  });
  assert.equal(status, 202, text);
  assert.deepEqual(body.coverages, [
    { coverageCode: 'S9-B', tiersSource: 'configured', gaps: [] },
    { coverageCode: 'S9-A', tiersSource: 'inline', gaps: TWO_TIERS_GAP },
  ]);
});

test('renewal refuses an inline set that is overlapping, badly labelled, too precise or null with 400, with no successor and no renewal row', async () => {
  for (const [name, payoutTiers, message] of refusedInlineSets()) {
    const predecessor = await renewablePolicy();
    const before = await insurerRowCounts();
    const { status, body, text } = await call('POST', `/policies/${predecessor.id}/renew`, {
      ...validRenewal(),
      coverages: [inlineCoverage(payoutTiers)],
    });
    assert.equal(status, 400, `${name}: ${text}`);
    assert.match(body.error, message, name);
    assert.ok(body.error.includes('S9-COVERAGE'), `${name}: names the coverage: ${body.error}`);
    assert.ok(!text.includes('12345678901'), `${name}: no label is echoed: ${text}`);
    assert.deepEqual(await successorsOf(predecessor), [], `${name}: no successor`);
    assert.deepEqual(await renewalRowsOf(predecessor), [], `${name}: no renewal row`);
    assert.deepEqual(await insurerRowCounts(), before, `${name}: no row of any kind`);
  }
});
