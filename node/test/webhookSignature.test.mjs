// The webhook's envelope and signature, as pure functions. What is under test
// is the shape of what leaves this platform: the envelope carries exactly five
// fields and nothing a regulator would call the content of the payout
// (a standing rule -- the webhook
// carries a thin envelope, everything else moves to an authenticated GET).
//
// Needs no database and no LocalNet. The known vectors below were computed
// with .NET's HMACSHA256, not with node:crypto, so they check the formula
// rather than restating the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope } from '../src/notifications/envelope.js';
import { deriveSecret, sign } from '../src/notifications/signature.js';

const INSURER = '00000000-0000-4000-8000-000000000001';

// A queue row as the sender reads it, plus columns the envelope must never
// pick up even if a caller hands them over.
const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  payout_event_id: '22222222-2222-4222-8222-222222222222',
  insurer_id: INSURER,
  kind: 'payout_approved',
  status: 'processing',
  attempt_count: 0,
  created_at: new Date('2026-09-18T10:00:00.000Z'),
  payout_amount: '100.00',
  recipient: 'PDR_MortgageeCreditor',
  external_ref: 'CUSTOMER-42',
};

test('deriveSecret is deterministic', () => {
  assert.equal(deriveSecret('test-master-key', INSURER, 1), deriveSecret('test-master-key', INSURER, 1));
});

test('deriveSecret matches the known vector and changes with the version', () => {
  assert.equal(deriveSecret('test-master-key', INSURER, 1), '28dc9096ea3a2ae1bf059dc6ca5545ee7da4079a7ce7328c31ef67dab0a08f97');
  assert.equal(deriveSecret('test-master-key', INSURER, 2), '14c552c1e00c77d12b8d73392d1e8fccd54194b51e6792509d7961eee64c5d44');
});

test('deriveSecret refuses an empty master key', () => {
  assert.throws(() => deriveSecret('', INSURER, 1), /master key/);
  assert.throws(() => deriveSecret(undefined, INSURER, 1), /master key/);
});

test('sign matches the known vector over "<timestamp>.<raw body>"', () => {
  assert.equal(sign('test-secret', 1700000000, '{"id":"x"}'), 'bcadb3a3ee7633fd9db6910d1ec0801c2ad9c7d064479c5e574c5fffccd4b39f');
});

test('the envelope has exactly the five fields, from the row', () => {
  const body = buildEnvelope(ROW);
  assert.equal(typeof body, 'string', 'the envelope is serialized once, by buildEnvelope');
  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed).sort(), ['apiVersion', 'createdAt', 'id', 'payoutId', 'type']);
  assert.deepEqual(parsed, {
    id: ROW.id,
    type: 'payout.approved',
    payoutId: ROW.payout_event_id,
    createdAt: '2026-09-18T10:00:00.000Z',
    apiVersion: 1,
  });
});

test('review_required maps to payout.review_required', () => {
  assert.equal(JSON.parse(buildEnvelope({ ...ROW, kind: 'review_required' })).type, 'payout.review_required');
});

test('an unknown kind is refused, not sent under a guessed type', () => {
  assert.throws(() => buildEnvelope({ ...ROW, kind: 'something_else' }), /unknown notification kind/);
});

test('no envelope key names payout content or account data', () => {
  const forbidden = /amount|recipient|role|customer|policy|coverage|iban|account|bank/i;
  for (const kind of ['payout_approved', 'review_required']) {
    for (const key of Object.keys(JSON.parse(buildEnvelope({ ...ROW, kind })))) {
      assert.doesNotMatch(key, forbidden, `envelope key ${key}`);
    }
  }
});
