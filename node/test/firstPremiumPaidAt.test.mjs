// When setupDemo reports the first premium paid (scripts/lib/firstPremiumPaidAt.mjs).
// The module is pure: every instant is passed in, so these run with no
// database, no ledger, no network and no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKDATED_FLAG, PaidAtRefused, resolvePaidAt } from '../../scripts/lib/firstPremiumPaidAt.mjs';

// One rehearsal's shape: a term that started at noon Istanbul, a policy made
// about twelve hours later, and "now" just after that.
const TERM_START = '2026-09-19T09:00:00.000Z';
const CREATED = '2026-09-19T21:05:00.000Z';
const NOW = '2026-09-19T21:06:00.000Z';
const base = { now: NOW, policyCreatedAt: CREATED, termStart: TERM_START };

test('no --paid-at at all is refused: there is no default, and the refusal names the open legal question', () => {
  for (const paidAtArg of [undefined, '']) {
    assert.throws(
      () => resolvePaidAt({ ...base, paidAtArg }),
      (err) => err instanceof PaidAtRefused && /--paid-at is required and has no default/.test(err.message)
        && /an open legal question/.test(err.message)
    );
  }
});

test('"now" is the instant the step is sent, and nothing is noted about it', () => {
  const { paidAt, notes } = resolvePaidAt({ ...base, paidAtArg: 'now' });
  assert.equal(paidAt, NOW);
  assert.deepEqual(notes, []);
});

test('an ISO instant is passed through, normalised', () => {
  // Between the policy's creation and now: since v22 an instant after now is
  // refused (the test below), so the pass-through is shown on a past one.
  const { paidAt } = resolvePaidAt({ ...base, paidAtArg: '2026-09-19T21:05:30Z' });
  assert.equal(paidAt, '2026-09-19T21:05:30.000Z');
});

test('a value that is neither "now" nor a readable date is refused', () => {
  for (const paidAtArg of ['yesterday', 'NOW', '2026-13-45', 'now()']) {
    assert.throws(
      () => resolvePaidAt({ ...base, paidAtArg }),
      (err) => err instanceof PaidAtRefused && /neither "now" nor a date this platform can read/.test(err.message),
      `${paidAtArg} is refused`
    );
  }
});

// The rule this task exists for.
test('a payment dated before the policy was made stops the run, naming the open legal question', () => {
  assert.throws(
    () => resolvePaidAt({ ...base, paidAtArg: TERM_START }),
    (err) => err instanceof PaidAtRefused
      && /BEFORE the policy was made in this system/.test(err.message)
      && /an open legal question: the m\. 1458/.test(err.message)
      && /Nothing was sent/.test(err.message)
      && err.message.includes(BACKDATED_FLAG)
  );
});

test('the same payment goes through with the flag, and says it was sent knowingly', () => {
  const { paidAt, notes } = resolvePaidAt({ ...base, paidAtArg: TERM_START, allowBackdated: true });
  assert.equal(paidAt, TERM_START);
  assert.ok(notes.some((n) => /BEFORE the policy was made/.test(n) && n.includes(`Sent anyway: ${BACKDATED_FLAG}`)));
});

test('an instant exactly at the policy\'s creation is not backdated', () => {
  const { paidAt, notes } = resolvePaidAt({ ...base, paidAtArg: CREATED });
  assert.equal(paidAt, CREATED);
  assert.ok(!notes.some((n) => /BEFORE the policy was made/.test(n)));
});

// Reported, never refused: no rule in this system bounds this case, and the
// notes say so rather than implying one exists.
test('before the term start is a note, not a refusal, and says nothing refuses it', () => {
  const madeEarly = { ...base, policyCreatedAt: '2026-09-19T00:00:00.000Z' };
  const { paidAt, notes } = resolvePaidAt({ ...madeEarly, paidAtArg: '2026-09-19T06:00:00.000Z' });
  assert.equal(paidAt, '2026-09-19T06:00:00.000Z');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /before the term's own start/);
  assert.match(notes[0], /Nothing in this system refuses that/);
});

// v22: the route and the ledger refuse a future paidAt with no margin,
// so the script refuses it before calling the route.
test('a future instant is refused, and nothing is sent', () => {
  assert.throws(
    () => resolvePaidAt({ ...base, paidAtArg: '2026-09-20T12:00:00.000Z' }),
    (err) => err instanceof PaidAtRefused && /is in the future/.test(err.message) && /Nothing was sent/.test(err.message)
  );
  assert.throws(
    () => resolvePaidAt({ ...base, paidAtArg: new Date(new Date(NOW).getTime() + 1).toISOString() }),
    PaidAtRefused,
    'one millisecond after now is refused: zero margin'
  );
  assert.doesNotThrow(() => resolvePaidAt({ ...base, paidAtArg: NOW }), 'now itself is not in the future');
});

test('an unknown creation instant refuses nothing: the comparison is skipped, not guessed', () => {
  for (const policyCreatedAt of [null, undefined]) {
    const { paidAt, notes } = resolvePaidAt({ ...base, policyCreatedAt, paidAtArg: TERM_START });
    assert.equal(paidAt, TERM_START);
    assert.ok(!notes.some((n) => /BEFORE the policy was made/.test(n)));
  }
});
