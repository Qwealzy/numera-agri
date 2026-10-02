// The machine-readable contract (docs/api/notifications-v1.openapi.json) and
// the two builders that produce what it describes -- buildEnvelope for the
// webhook body, buildRecord for the GET endpoints -- are held to each other
// here, structurally. A field added to a builder and not to the contract, an
// enum value added to the database and not to the contract, or a field whose
// NAME suggests account data, fails this file.
//
// JSON, not YAML: there is no YAML parser among the dependencies, and none is
// added for this.
//
// It writes to no database. The enum values are read from the working
// database the way enumOrdering.test.mjs reads them: through its own
// read-only connection. The CHECK lists are read from sql/schema.sql.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from '../src/config.js';
import { buildEnvelope } from '../src/notifications/envelope.js';
import { buildRecord } from '../src/notifications/payoutRecord.js';
import { buildPolicyRecord, buildPolicySummary, FAILURE_CODES } from '../src/notifications/policyRecord.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CONTRACT_PATH = path.join(ROOT, 'docs/api/notifications-v1.openapi.json');

// Read-only by construction, not by promise -- see enumOrdering.test.mjs.
const pool = new pg.Pool({ connectionString: config.databaseUrl, options: '-c default_transaction_read_only=on' });

after(async () => { await pool.end(); });

const contract = () => JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
const sorted = (values) => [...values].sort();

async function enumValues(typname) {
  const { rows } = await pool.query(
    `SELECT e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = $1`,
    [typname]
  );
  assert.ok(rows.length > 0, `the database has no enum '${typname}'`);
  return rows.map((r) => r.enumlabel);
}

// The IN (...) list of one named CHECK constraint in sql/schema.sql. The file
// is CRLF and its comments hold parentheses; both are stripped first, for the
// reasons enumOrdering.test.mjs gives.
function checkList(constraintName) {
  const text = fs.readFileSync(path.join(ROOT, 'sql/schema.sql'), 'utf8')
    .replace(/\r/g, '')
    .split('\n').map((l) => l.replace(/--.*/, '')).join('\n');
  const m = text.match(new RegExp(`CONSTRAINT\\s+${constraintName}\\s+CHECK\\s*\\([^;]*?\\bIN\\s*\\(([^)]*)\\)`, 'i'));
  assert.ok(m, `sql/schema.sql has no CHECK constraint '${constraintName}' with an IN list`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((v) => v[1]);
}

// A payout row as the route's query returns it, PLUS the columns the record
// must never carry, each holding a marker that would be visible if it leaked.
const LEAK = 'MUST-NOT-APPEAR';
const samplePayoutRow = (overrides = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  policy_id: '22222222-2222-4222-8222-222222222222',
  customer_ref: 'contract-test-customer',
  coverage_code: 'TEST-COVERAGE',
  product_code: 'TEST-PRODUCT',
  peril_type: 'TEST-PERIL',
  tier_label: 'test tier',
  payout_percentage: '25.00',
  payout_amount: '12345678901.25',
  currency: 'TRY',
  recipient: 'PDR_Insured',
  record_kind: 'payout',
  is_full_settlement: false,
  status: 'approved',
  approved_at: new Date('2026-09-18T09:00:00.000Z'),
  created_at: new Date('2026-09-18T09:00:01.000Z'),
  settled_at: null,
  resolved_at: null,
  trigger_window_id: '33333333-3333-4333-8333-333333333333',
  daml_contract_id: 'contract-test-cid',
  bank_reference: LEAK,
  resolution_note: LEAK,
  unpaid_reason: LEAK,
  review_contract_id: LEAK,
  insurer_id: LEAK,
  paid_role: LEAK,
  oracle_reading_id: LEAK,
  ...overrides,
});
const sampleNotificationRow = (overrides = {}) => ({
  id: '44444444-4444-4444-8444-444444444444',
  payout_event_id: '11111111-1111-4111-8111-111111111111',
  insurer_id: LEAK,
  kind: 'payout_approved',
  status: 'pending',
  attempt_count: 3,
  last_status_code: 500,
  last_error: LEAK,
  delivered_at: null,
  created_at: new Date('2026-09-18T09:00:02.000Z'),
  ...overrides,
});

// Every property name anywhere in the contract, and every parameter name.
function namesIn(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) namesIn(item, found);
  } else if (node && typeof node === 'object') {
    if (node.properties && typeof node.properties === 'object') {
      for (const name of Object.keys(node.properties)) found.add(name);
    }
    if (typeof node.name === 'string' && typeof node.in === 'string') found.add(node.name);
    for (const value of Object.values(node)) namesIn(value, found);
  }
  return found;
}

test('the contract is valid JSON and has the sections an integrator needs', () => {
  const c = contract();
  assert.match(c.openapi, /^3\.0\./);
  assert.equal(typeof c.info.description, 'string');
  assert.deepEqual(c.components.securitySchemes.ApiKeyAuth, { type: 'apiKey', in: 'header', name: 'x-api-key' });

  const list = c.paths['/api/v1/payouts'].get;
  assert.deepEqual(sorted(list.parameters.map((p) => p.name)), ['after', 'limit', 'recordKind', 'status']);
  assert.deepEqual(sorted(Object.keys(list.responses)), ['200', '400', '401']);
  const one = c.paths['/api/v1/payouts/{payoutId}'].get;
  assert.deepEqual(one.parameters.map((p) => p.name), ['payoutId']);
  assert.deepEqual(sorted(Object.keys(one.responses)), ['200', '400', '401', '404']);
  for (const op of [list, one]) assert.deepEqual(op.security, [{ ApiKeyAuth: [] }]);

  assert.ok(c.components.schemas.PayoutRecord);
  assert.ok(c.components.schemas.Envelope);

  const hook = c['x-webhooks'].payoutNotification.post;
  assert.deepEqual(
    sorted(hook.parameters.map((p) => p.name)),
    ['X-Webhook-Id', 'X-Webhook-Signature', 'X-Webhook-Timestamp']
  );
  assert.deepEqual(hook.requestBody.content['application/json'].schema, { $ref: '#/components/schemas/Envelope' });
});

test('the contract names no retry count or interval: the schedule is configuration', () => {
  const hook = contract()['x-webhooks'].payoutNotification;
  assert.doesNotMatch(JSON.stringify(hook), /\d+\s*(ms|milliseconds?|seconds?|minutes?|hours?|attempts?|retries|times)\b/i);
});

test('buildEnvelope produces exactly the Envelope schema: same keys, all required', async () => {
  const schema = contract().components.schemas.Envelope;
  const types = [];
  for (const kind of await enumValues('notification_kind')) {
    const body = JSON.parse(buildEnvelope(sampleNotificationRow({ kind })));
    assert.deepEqual(sorted(Object.keys(body)), sorted(Object.keys(schema.properties)));
    types.push(body.type);
  }
  assert.deepEqual(sorted(schema.required), sorted(Object.keys(schema.properties)));
  assert.equal(schema.additionalProperties, false);
  // One wire type per notification_kind in the database, and no other.
  assert.deepEqual(sorted(schema.properties.type.enum), sorted(types));
});

test('buildRecord produces exactly the PayoutRecord schema: same keys, at both levels', () => {
  const schema = contract().components.schemas.PayoutRecord;
  const record = buildRecord(samplePayoutRow(), [sampleNotificationRow()]);
  assert.deepEqual(sorted(Object.keys(record)), sorted(Object.keys(schema.properties)));
  assert.deepEqual(sorted(schema.required), sorted(Object.keys(schema.properties)));
  assert.equal(schema.additionalProperties, false);

  const item = schema.properties.notifications.items;
  assert.deepEqual(sorted(Object.keys(record.notifications[0])), sorted(Object.keys(item.properties)));
  assert.deepEqual(sorted(item.required), sorted(Object.keys(item.properties)));
  assert.equal(item.additionalProperties, false);
});

test('buildRecord reads its whitelist and nothing else the row carries', () => {
  const record = buildRecord(samplePayoutRow(), [sampleNotificationRow()]);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(LEAK));
});

test('NUMERIC stays the text pg handed over, and the contract types it as a string', () => {
  const schema = contract().components.schemas.PayoutRecord;
  const record = buildRecord(samplePayoutRow(), []);
  assert.strictEqual(record.amount, '12345678901.25');
  assert.strictEqual(record.payoutPercentage, '25.00');
  assert.equal(schema.properties.amount.type, 'string');
  assert.equal(schema.properties.payoutPercentage.type, 'string');
});

test('approvedAt may be NULL (a row older than migration 035) and the contract says so', () => {
  const schema = contract().components.schemas.PayoutRecord;
  assert.strictEqual(buildRecord(samplePayoutRow({ approved_at: null }), []).approvedAt, null);
  assert.equal(schema.properties.approvedAt.nullable, true);
});

test('a row carrying a dead eft_* status is refused by the builder, not published', async () => {
  const dead = (await enumValues('payout_event_status')).filter((v) => /^eft_/.test(v));
  assert.ok(dead.length > 0, 'the dead values are still in the enum; if they are gone, drop this test');
  for (const status of dead) {
    assert.throws(() => buildRecord(samplePayoutRow({ status }), []), /status that is not published/);
  }
});

test('the contract enums are the ones the database and schema.sql hold', async () => {
  const c = contract();
  const record = c.components.schemas.PayoutRecord.properties;
  const notNull = (values) => values.filter((v) => v !== null);

  assert.deepEqual(sorted(notNull(record.recipientRole.enum)), sorted(checkList('payout_events_recipient_known')));
  assert.deepEqual(sorted(record.recordKind.enum), sorted(checkList('payout_events_record_kind_known')));

  const liveStatuses = (await enumValues('payout_event_status')).filter((v) => !/^eft_/.test(v));
  assert.deepEqual(sorted(record.status.enum), sorted(liveStatuses));
  // Every status the contract publishes is one the builder accepts.
  for (const status of record.status.enum) buildRecord(samplePayoutRow({ status }), []);

  const notification = record.notifications.items.properties;
  assert.deepEqual(sorted(notification.status.enum), sorted(await enumValues('notification_status')));
  assert.deepEqual(sorted(notification.type.enum), sorted(c.components.schemas.Envelope.properties.type.enum));
  for (const kind of await enumValues('notification_kind')) {
    const built = buildRecord(samplePayoutRow(), [sampleNotificationRow({ kind })]).notifications[0].type;
    assert.equal(built, JSON.parse(buildEnvelope(sampleNotificationRow({ kind }))).type);
  }

  // The list endpoint's filters accept the same values the record publishes.
  const params = Object.fromEntries(c.paths['/api/v1/payouts'].get.parameters.map((p) => [p.name, p]));
  assert.deepEqual(sorted(params.status.schema.enum), sorted(record.status.enum));
  assert.deepEqual(sorted(params.recordKind.schema.enum), sorted(record.recordKind.enum));
});

// --- the policy record ------------------------------------

// A policy row, coverage row and event row as the route's queries return
// them, PLUS columns the record must never carry, each holding the marker.
const samplePolicyRow = (overrides = {}) => ({
  id: '55555555-5555-4555-8555-555555555555',
  status: 'active',
  default_state: 'none',
  start_date: '2026-09-01',
  end_date: '2027-03-31',
  term_start: new Date('2026-09-01T09:00:00.000Z'),
  expiry: new Date('2027-03-31T09:00:00.000Z'),
  coverage_began_at: new Date('2026-09-02T00:00:00.000Z'),
  daml_contract_id: 'contract-test-cid',
  insurer_id: LEAK,
  policyholder_id: LEAK,
  insured_policyholder_id: LEAK,
  mortgagee_policyholder_id: LEAK,
  beneficiary_policyholder_id: LEAK,
  document_hash: LEAK,
  premium_amount: LEAK,
  canton_party_id: LEAK,
  oracle_operator_party: LEAK,
  ...overrides,
});
const sampleCoverageRow = (overrides = {}) => ({
  coverage_code: 'TEST-COVERAGE',
  product_code: 'TEST-PRODUCT',
  peril_type: 'TEST-PERIL',
  sum_insured: '12345678901.25',
  remaining_limit: '10000.00',
  cell_ids: ['metno:41.0082,28.9784'],
  id: LEAK,
  policy_id: LEAK,
  payout_tiers_snapshot: LEAK,
  payout_destination: LEAK,
  mortgagee_claim_amount: LEAK,
  ...overrides,
});
const sampleEventRow = (overrides = {}) => ({
  id: '66666666-6666-4666-8666-666666666666',
  event_type: 'activation',
  status: 'done',
  created_at: new Date('2026-09-18T09:00:00.000Z'),
  processed_at: new Date('2026-09-18T09:00:05.000Z'),
  error: null,
  policy_no: LEAK,
  payload: { bankReference: LEAK, failureReason: LEAK, note: LEAK, textSalt: LEAK },
  resulting_contract_id: LEAK,
  source_contract_id: LEAK,
  expected_version: LEAK,
  reading_id: LEAK,
  trigger_window_id: LEAK,
  ...overrides,
});

test('buildPolicyRecord produces exactly the PolicyRecord schema: same keys, at every level', () => {
  const schema = contract().components.schemas.PolicyRecord;
  const record = buildPolicyRecord(
    samplePolicyRow(), [sampleCoverageRow()], [sampleEventRow({ status: 'failed', error: 'x' })], false
  );
  for (const [built, s] of [
    [record, schema],
    [record.coverages[0], schema.properties.coverages.items],
    [record.events[0], schema.properties.events.items],
    [record.events[0].failure, schema.properties.events.items.properties.failure],
  ]) {
    assert.deepEqual(sorted(Object.keys(built)), sorted(Object.keys(s.properties)));
    assert.deepEqual(sorted(s.required), sorted(Object.keys(s.properties)));
    assert.equal(s.additionalProperties, false);
  }
});

test('buildPolicyRecord reads its whitelist and nothing else the rows carry', () => {
  const record = buildPolicyRecord(
    samplePolicyRow({ unknown_new_column: LEAK }),
    [sampleCoverageRow({ unknown_new_column: LEAK })],
    [sampleEventRow({ unknown_new_column: LEAK }), sampleEventRow({ status: 'failed', error: `${LEAK} party::1220ab` })],
    false
  );
  assert.doesNotMatch(JSON.stringify(record), new RegExp(LEAK));
  assert.doesNotMatch(JSON.stringify(record), /1220ab/);
});

test('a failed event carries a reason code and a fixed message, never its error text', () => {
  const failed = (error) => buildPolicyRecord(samplePolicyRow(), [], [sampleEventRow({ status: 'failed', error })], false)
    .events[0].failure;
  const oracle = failed(
    'no oracle operator party configured for insurer 7777 (policy 8888): insurers.oracle_operator_party is empty'
  );
  assert.equal(oracle.code, 'oracle_party_not_configured');
  assert.doesNotMatch(oracle.message, /7777|8888|oracle_operator_party/);
  assert.equal(failed('no grace period configured for policy 8888: set ...').code, 'grace_period_not_configured');
  assert.equal(
    failed('m. 1458 retroactive-cover check REFUSED the mint for policy 8888. reading 9999').code,
    'retroactive_cover_check_refused'
  );
  assert.equal(
    failed('{"code":"DAML_INTERPRETATION_ERROR","cause":"cover has not begun on this policy (m. 1421) -- x","party":"p::1220ab"}').code,
    'cover_not_begun'
  );
  assert.equal(failed('insurer has no allocated Canton party').code, 'insurer_party_not_allocated');
  assert.equal(
    failed('insurer 7777 (policy 8888) has its own Canton party as insurers.oracle_operator_party party::1220ab').code,
    'oracle_party_is_insurer'
  );
  assert.equal(
    failed('grace period of 5 day(s) configured for policy 8888 is below the statutory minimum').code,
    'grace_period_below_statutory_minimum'
  );
  assert.equal(
    failed('policy 8888 is backdated but names no cells, so the m. 1458 check has nothing to search').code,
    'retroactive_cover_check_no_cells'
  );
  assert.equal(
    failed('policy 8888 names a mortgagee but no continuation window is configured: set one for the insurer').code,
    'mortgagee_continuation_not_configured'
  );
  assert.equal(
    failed('no first-premium withdrawal window configured for policy 8888').code,
    'first_premium_withdrawal_window_not_configured'
  );
  // The pattern is anchored: the same words later in an unrelated message do not classify it.
  assert.equal(failed('ledger said: no grace period configured for policy 8888').code, 'internal_or_ledger_error');
  for (const error of [null, '', 'ECONNREFUSED 127.0.0.1:3975', 'policy not found']) {
    assert.equal(failed(error).code, 'internal_or_ledger_error');
  }
  const done = buildPolicyRecord(samplePolicyRow(), [], [sampleEventRow({ error: 'x' })], false).events[0];
  assert.strictEqual(done.failure, null, 'only a failed event has a failure');
});

test('the contract lists every failure code the builder can produce, and no other', () => {
  const failure = contract().components.schemas.PolicyRecord.properties.events.items.properties.failure;
  assert.deepEqual(sorted(failure.properties.code.enum), sorted(FAILURE_CODES));
});

test('the policy record\'s NUMERIC stays text, and a NULL term and contract read as null', () => {
  const unminted = buildPolicyRecord(
    samplePolicyRow({ term_start: null, expiry: null, coverage_began_at: null, daml_contract_id: null }),
    [sampleCoverageRow()], [], false
  );
  assert.strictEqual(unminted.coverages[0].sumInsured, '12345678901.25');
  assert.strictEqual(unminted.termStart, null);
  assert.strictEqual(unminted.coverageBegun, false);
  assert.strictEqual(unminted.onLedger, false);
  assert.strictEqual(unminted.ledgerContractId, null);
  const schema = contract().components.schemas.PolicyRecord;
  assert.equal(schema.properties.coverages.items.properties.sumInsured.type, 'string');
  assert.equal(schema.properties.ledgerContractId.nullable, true);
});

test('the policy path is in the contract, authenticated, with its responses', () => {
  const op = contract().paths['/api/v1/policies/{policyId}'].get;
  assert.deepEqual(op.parameters.map((p) => p.name), ['policyId']);
  assert.deepEqual(sorted(Object.keys(op.responses)), ['200', '400', '401', '404']);
  assert.deepEqual(op.security, [{ ApiKeyAuth: [] }]);
  assert.deepEqual(op.responses['200'].content['application/json'].schema, { $ref: '#/components/schemas/PolicyRecord' });
});

test('the policy record\'s enums are the ones the database holds', async () => {
  const record = contract().components.schemas.PolicyRecord.properties;
  const event = record.events.items.properties;
  assert.deepEqual(sorted(record.status.enum), sorted(await enumValues('policy_status')));
  assert.deepEqual(sorted(record.defaultState.enum), sorted(await enumValues('default_state')));
  assert.deepEqual(sorted(event.eventType.enum), sorted(await enumValues('event_type')));
  assert.deepEqual(sorted(event.status.enum), sorted(await enumValues('outbox_status')));
  for (const status of event.status.enum) buildPolicyRecord(samplePolicyRow(), [], [sampleEventRow({ status })], false);
});

// --- the policy list (GET /api/v1/policies) -----------------------------------

test('buildPolicySummary produces exactly the PolicySummary schema: same keys, at every level', () => {
  const schema = contract().components.schemas.PolicySummary;
  const summary = buildPolicySummary(
    samplePolicyRow({ currency: 'TRY' }), [sampleCoverageRow()], sampleEventRow({ status: 'failed', error: 'x' })
  );
  for (const [built, s] of [
    [summary, schema],
    [summary.coverages[0], schema.properties.coverages.items],
    [summary.lastEvent, schema.properties.lastEvent],
    [summary.lastEvent.failure, schema.properties.lastEvent.properties.failure],
  ]) {
    assert.deepEqual(sorted(Object.keys(built)), sorted(Object.keys(s.properties)));
    assert.deepEqual(sorted(s.required), sorted(Object.keys(s.properties)));
    assert.equal(s.additionalProperties, false);
  }
  assert.strictEqual(buildPolicySummary(samplePolicyRow({ currency: 'TRY' }), [], null).lastEvent, null);
  assert.equal(schema.properties.lastEvent.nullable, true);
});

test('buildPolicySummary reads its whitelist and nothing else the rows carry, and no cell id', () => {
  const summary = buildPolicySummary(
    samplePolicyRow({ currency: 'TRY', unknown_new_column: LEAK }),
    [sampleCoverageRow({ unknown_new_column: LEAK })],
    sampleEventRow({ status: 'failed', error: `${LEAK} party::1220ab`, unknown_new_column: LEAK })
  );
  const text = JSON.stringify(summary);
  assert.doesNotMatch(text, new RegExp(LEAK));
  assert.doesNotMatch(text, /1220ab/);
  assert.doesNotMatch(text, /metno:|cellIds/, 'the list carries no cell id');
});

test('a summary\'s lastEvent is built as the record\'s event, and the contract describes it the same way', () => {
  const c = contract().components.schemas;
  const eventRow = sampleEventRow({ status: 'failed', error: 'no grace period configured for policy 8888: set ...' });
  const summary = buildPolicySummary(samplePolicyRow({ currency: 'TRY' }), [], eventRow);
  const record = buildPolicyRecord(samplePolicyRow(), [], [eventRow], false);
  assert.deepEqual(summary.lastEvent, record.events[0]);
  const { nullable: _nullable, description: _description, ...lastEvent } = c.PolicySummary.properties.lastEvent;
  assert.deepEqual(lastEvent, { type: 'object', ...c.PolicyRecord.properties.events.items });
});

test('the policy list path is in the contract, authenticated, with its responses, and shares the record\'s enums', async () => {
  const c = contract();
  const op = c.paths['/api/v1/policies'].get;
  assert.deepEqual(sorted(op.parameters.map((p) => p.name)), ['after', 'limit']);
  assert.deepEqual(sorted(Object.keys(op.responses)), ['200', '400', '401']);
  assert.deepEqual(op.security, [{ ApiKeyAuth: [] }]);
  assert.deepEqual(op.responses['200'].content['application/json'].schema, { $ref: '#/components/schemas/PolicyPage' });
  assert.deepEqual(
    c.components.schemas.PolicyPage.properties.items.items, { $ref: '#/components/schemas/PolicySummary' }
  );
  const summary = c.components.schemas.PolicySummary.properties;
  assert.deepEqual(sorted(summary.status.enum), sorted(await enumValues('policy_status')));
  assert.deepEqual(sorted(summary.defaultState.enum), sorted(await enumValues('default_state')));
  assert.deepEqual(
    summary.coverages.items.properties,
    Object.fromEntries(Object.entries(c.components.schemas.PolicyRecord.properties.coverages.items.properties)
      .filter(([name]) => name !== 'cellIds'))
  );
});

test('no field anywhere is named like account data', () => {
  const ACCOUNT_LIKE = /iban|account|bank|eft|card|swift/i;
  const record = buildRecord(samplePayoutRow(), [sampleNotificationRow()]);
  const envelope = JSON.parse(buildEnvelope(sampleNotificationRow()));
  const names = [
    ...namesIn(contract()),
    ...Object.keys(record),
    ...Object.keys(record.notifications[0]),
    ...Object.keys(envelope),
  ];
  assert.ok(names.length > 30, 'not vacuous: the contract and both builders were walked');
  assert.deepEqual(names.filter((n) => ACCOUNT_LIKE.test(n)), []);
});

test('the envelope names nothing about the payout beyond its id', () => {
  const PAYOUT_DETAIL = /amount|recipient|role|customer|policy|coverage/i;
  const names = [
    ...Object.keys(contract().components.schemas.Envelope.properties),
    ...Object.keys(JSON.parse(buildEnvelope(sampleNotificationRow()))),
  ];
  assert.deepEqual(names.filter((n) => PAYOUT_DETAIL.test(n)), []);
});
