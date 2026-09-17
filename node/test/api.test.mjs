import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from '../src/db.js';
import { createApp } from '../src/app.js';

// The HTTP layer, on an ephemeral loopback port, against the test database.
// NO LEDGER: not one of these routes calls Canton -- they validate, write SQL
// and an outbox row, and return -- so everything here runs with LocalNet
// down. What the outbox row then does to the ledger is dispatcher.test.mjs's
// subject, and the Daml `ensure` clauses are the Script tests'.
//
// Only the API layer's own refusals are asserted here: missing or unknown
// key, field validation, the 404/409 state checks the routes make
// themselves. Ordering between lifecycle facts (m. 1431(4)'s chain, for
// instance) is NOT checked at this layer -- it lives in SQL CHECK
// constraints and in Daml -- so it is not asserted here either.
//
// NOT COVERED YET, all of them API-layer refusals in routes/policies.js.
// Written down because a gap nobody wrote down is a gap nobody closes:
//   - creation: mortgageeClaimAmount not a positive number; an empty
//     beneficiaryDescriptorHash; an invalid agreedCoverageStart; an empty
//     documentHash; a coverage-level claim with no policy-level mortgagee
//   - endorsement: an unknown reason; an endorsement that changes nothing;
//     an added coverage missing its own fields
//   - renewal: missing policyTerms/coverages; a repeated coverageCode; 404;
//     and the three 409s -- predecessor in premium default, a status that is
//     not renewable, already renewed
//   - payouts: settle without settledAt or with an unknown paidRole; a payout
//     already resolved (409); fail without failureReason; already under
//     manual review (409); close-unpaid without unpaidReason or note
//   - the date/field checks on every other lifecycle route: mortgagee-notice
//     notifiedAt, mortgagee-election election, premium-due-date dueDate,
//     enforcement-commenced commencedAt, attachment and attachment-lifted
//     coverageCode/attachedAt/liftedAt, two-notice-election period dates,
//     mortgagee-info-request requestedAt, mortgagee-info-provided providedAt,
//     enforcement-fruitless fruitlessAt/route, substitution-notice
//     notifiedAt, substitute-policyholder substitutedAt, first-premium-paid
//     paidAt, withdraw-first-premium withdrawnAt
//   - the 409 "no allocated Canton party" and 404 "policy not found" branches
//     on the routes other than activate, where they are the same two checks
//     repeated

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
         (insurer_id, product_code, peril_type, tier_order, label, threshold_min, threshold_max, payout_percentage)
       VALUES ($1, 'TEST-PRODUCT', 'TEST-PERIL', 1, 'test tier', -2.0, 0.0, 25.00)`,
      [id]
    );
  }

  // The app itself, with fake /health probes: nothing here touches the
  // ledger, and the database is the test one the guard pointed us at.
  const app = createApp({ probeDatabase: async () => {}, probeLedger: async () => {} });
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
    cellIds: ['cell-test'],
    sumInsured: 10000,
  }],
  documentHash: DOCUMENT_HASH,
  ...overrides,
});

async function createPolicy(overrides) {
  const res = await call('POST', '/policies', policyBody(overrides));
  assert.equal(res.status, 201, res.text);
  return res.body.policy;
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
      cellIds: ['cell-test'],
      sumInsured: 10000,
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

// The API layer's own state check, and the one ordering rule it does enforce:
// a payout that is not under manual review cannot be closed unpaid.
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
    unpaidReason: 'UR_Other', note: 'api test',
  });
  assert.equal(status, 409);
  assert.match(body.error, /is not under manual review/);
  const after = (await pool.query('SELECT status FROM payout_events WHERE id = $1', [payout.id])).rows[0];
  assert.equal(after.status, 'approved', 'a refused call changes nothing');
});
