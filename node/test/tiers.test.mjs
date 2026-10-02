// src/dispatch/tiers.js against the cases the Daml tests pin for
// Types.daml's evaluateAgainstTiers (daml-tests/daml/InsuranceTests.daml):
// The payout basis, the linear tiers, and the rule that "0.00 after the cap is no
// match". The module is pure, so these run with no database, no ledger, no
// network and no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateAgainstTiers, matchTier, basisFor, toNumeric, numericToString, validateTierSet } from '../src/dispatch/tiers.js';

// InsuranceTests.daml's frostTiers and linearTier, as the ledger's JSON
// carries them (a None end percentage is an absent key).
const frostTiers = [
  { tierOrder: 1, label: 'Mild frost (-2C to 0C)', minValue: '-2.0', maxValue: '0.0', payoutPct: '25.0', shape: 'TS_Step' },
  { tierOrder: 2, label: 'Severe frost (below -4C)', minValue: null, maxValue: '-4.0', payoutPct: '100.0', shape: 'TS_Step' },
];
const linearTier = {
  tierOrder: 1, label: 'Linear frost (-10C to -2C)', minValue: '-10.0', maxValue: '-2.0',
  payoutPct: '100.0', shape: 'TS_Linear', pctAtMin: '100.0', pctAtMax: '20.0',
};
const SUM = '100000.0';

const pay = (tiers, basis, remaining, observed) =>
  evaluateAgainstTiers(tiers, basisFor(basis, { sumInsured: SUM, remainingLimit: remaining }), remaining, observed);

test('under PB_SumInsured a second event in the same tier pays the same, and the remaining limit caps it', () => {
  const first = pay(frostTiers, 'PB_SumInsured', '100000.0', '-2.0');
  assert.equal(first.payoutAmount, '25000');
  const second = pay(frostTiers, 'PB_SumInsured', '75000.0', '-2.0');
  assert.equal(second.payoutAmount, '25000');
  assert.equal(second.payoutPct, '25');
  const third = pay(frostTiers, 'PB_SumInsured', '50000.0', '-5.0');
  assert.equal(third.payoutAmount, '50000');
  assert.equal(third.isFullSettlement, true);
});

test('PB_RemainingLimit pays the percentage of what the first event left', () => {
  assert.equal(pay(frostTiers, 'PB_RemainingLimit', '100000.0', '-2.0').payoutAmount, '25000');
  assert.equal(pay(frostTiers, 'PB_RemainingLimit', '75000.0', '-2.0').payoutAmount, '18750');
});

test('a linear tier interpolates between its end percentages; floor to 2 dp as on the ledger', () => {
  const atMax = pay([linearTier], 'PB_RemainingLimit', SUM, '-2.0');
  assert.deepEqual([atMax.payoutPct, atMax.payoutAmount], ['20', '20000']);
  const mid = pay([linearTier], 'PB_RemainingLimit', SUM, '-6.0');
  assert.deepEqual([mid.payoutPct, mid.payoutAmount], ['60', '60000']);
  const atMin = pay([linearTier], 'PB_RemainingLimit', SUM, '-10.0');
  assert.deepEqual([atMin.payoutPct, atMin.payoutAmount, atMin.isFullSettlement], ['100', '100000', true]);
  assert.equal(pay([linearTier], 'PB_RemainingLimit', SUM, '-1.0').matched, false);
  // 100 + (-2.000003 - -10) * -10 = 20.00003 %, of 100000 = 20000.03
  assert.equal(pay([linearTier], 'PB_RemainingLimit', SUM, '-2.000003').payoutAmount, '20000.03');
});

test('the basis applies to the interpolated percentage, and the remaining limit caps it', () => {
  assert.equal(pay([linearTier], 'PB_SumInsured', SUM, '-6.0').payoutAmount, '60000');
  const second = pay([linearTier], 'PB_SumInsured', '40000.0', '-6.0');
  assert.equal(second.payoutAmount, '40000');
  assert.equal(second.isFullSettlement, true);
});

test('a linear tier whose computed amount is 0.00 is no match -- a 0 percentage, or one that floors to 0.00', () => {
  const zeroAtMax = { ...linearTier, pctAtMin: '100.0', pctAtMax: '0.0', payoutPct: '100.0' };
  const atZero = pay([zeroAtMax], 'PB_RemainingLimit', SUM, '-2.0');
  assert.deepEqual(atZero, { matched: false, matchedTierLabel: null, payoutPct: '0', payoutAmount: '0', isFullSettlement: false });
  // 100 - 12.5 * 7.9999999 = 0.00000125 %, of 100000 = 0.00125 -> 0.00
  assert.equal(pay([zeroAtMax], 'PB_RemainingLimit', SUM, '-2.0000001').matched, false);
  // control: inside the tier with a positive amount it pays
  assert.equal(pay([zeroAtMax], 'PB_RemainingLimit', SUM, '-6.0').payoutAmount, '50000');
});

test('on an exhausted coverage a value the tiers match is no match, for a step and a linear tier, under both bases', () => {
  for (const basis of ['PB_SumInsured', 'PB_RemainingLimit']) {
    assert.equal(pay(frostTiers, basis, '0.0', '-1.0').matched, false, `step, ${basis}`);
    assert.equal(pay([linearTier], basis, '0.0', '-6.0').matched, false, `linear, ${basis}`);
  }
});

test('the FIRST tier in range decides: a 0.00 there does not fall through to a later tier', () => {
  const zeroAtMax = { ...linearTier, pctAtMin: '100.0', pctAtMax: '0.0', payoutPct: '100.0' };
  const catchAll = { tierOrder: 2, label: 'later', minValue: null, maxValue: '0.0', payoutPct: '25.0', shape: 'TS_Step' };
  assert.equal(matchTier([zeroAtMax, catchAll], '-2.0').label, zeroAtMax.label);
  assert.equal(pay([zeroAtMax, catchAll], 'PB_RemainingLimit', SUM, '-2.0').matched, false);
});

test('both bounds are inclusive and a missing bound is unbounded, as inRange', () => {
  assert.equal(matchTier(frostTiers, '0.0').label, frostTiers[0].label);
  assert.equal(matchTier(frostTiers, '-2.0').label, frostTiers[0].label);
  assert.equal(matchTier(frostTiers, '-4.0').label, frostTiers[1].label);
  assert.equal(matchTier(frostTiers, '-400').label, frostTiers[1].label);
  assert.equal(matchTier(frostTiers, '-3.0'), undefined);
  assert.equal(matchTier(frostTiers, '0.0000000001'), undefined);
});

test('what the ledger cannot hold is refused, not guessed: no basis, an unknown shape, more than ten decimals', () => {
  assert.throws(() => basisFor(undefined, { sumInsured: SUM, remainingLimit: SUM }), /neither PB_RemainingLimit nor PB_SumInsured/);
  const noShape = { ...frostTiers[0], shape: undefined };
  assert.throws(() => pay([noShape], 'PB_RemainingLimit', SUM, '-1.0'), /neither TS_Step nor TS_Linear/);
  assert.throws(() => toNumeric('-1.00000000001'), /more than ten decimal places/);
  assert.equal(numericToString(toNumeric('-2.50')), '-2.5');
});

// validateTierSet: the set-level rules an insurer's tier set
// is held to before it is written.
const step = (tierOrder, minValue, maxValue, payoutPct = '25.00', label = `Tier ${tierOrder}`) => ({
  tierOrder, label, minValue, maxValue, payoutPct, shape: 'TS_Step', pctAtMin: null, pctAtMax: null,
});
const linear = (over = {}) => ({
  tierOrder: 1, label: 'Linear', minValue: '-10.0000', maxValue: '-2.0000',
  payoutPct: '100.00', shape: 'TS_Linear', pctAtMin: '100.00', pctAtMax: '20.00', ...over,
});

test('validateTierSet: the FROST-STANDARD gap set is accepted, its one inner gap listed, every probe matching as recorded', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('../test-support/frostStandardGapSetFixture.json', import.meta.url), 'utf8'));
  assert.equal(fixture.expectAccepted, true);
  const { tiers, gaps } = validateTierSet(fixture.tiers);
  assert.deepEqual(tiers.map((t) => t.tierOrder), [1, 2]);
  // (c1): only the open interval between two tiers; nothing above 0, nothing
  // for the open lower end.
  assert.equal(gaps.length, 1);
  assert.equal(toNumeric(gaps[0].from), toNumeric('-4'));
  assert.equal(toNumeric(gaps[0].to), toNumeric('-2'));
  for (const probe of fixture.probes) {
    assert.equal(matchTier(tiers, probe.observed)?.tierOrder ?? null, probe.tierOrder, `probe ${probe.observed}`);
  }
});

test('validateTierSet: an unsorted valid set comes back sorted by tierOrder, and a Turkish label is accepted', () => {
  const input = [
    step(3, '1.0000', '2.0000', '50.00', 'Şiddetli don (-4 °C altı)'),
    step(1, '-2.0000', '0.0000', '25.00', 'Hafif don: 0/-2 °C, %25'),
    linear({ tierOrder: 2, label: 'Çok ağır ığ ÜĞİŞÇÖ', minValue: '-10', maxValue: '-4' }),
  ];
  const { tiers, gaps } = validateTierSet(input);
  assert.deepEqual(tiers.map((t) => t.tierOrder), [1, 2, 3]);
  assert.deepEqual(input.map((t) => t.tierOrder), [3, 1, 2], 'the input array is not reordered');
  assert.deepEqual(gaps.map((g) => [g.from, g.to]), [['-4', '-2.0000'], ['0.0000', '1.0000']]);
});

test('validateTierSet: each refusal throws, naming the rule', () => {
  const refused = [
    ['an empty set', [], /non-empty array/],
    ['a non-array', { tiers: [] }, /non-empty array/],
    ['a duplicate tierOrder', [step(1, '-2', '0'), step(1, '1', '2')], /tierOrder 1 .*repeated/],
    ['a shared endpoint', [step(1, '-2', '0'), step(2, '0', '1')], /tiers 1 and 2 overlap/],
    ['two tiers unbounded below', [step(1, null, '-4'), step(2, null, '-10')], /overlap/],
    ['a step tier with pctAtMin', [{ ...step(1, '-2', '0'), pctAtMin: '10.00' }], /TS_Step .*pctAtMin/],
    ['a step payoutPct of 0', [step(1, '-2', '0', '0')], /tier 1 .*payoutPct .*\(0, 100\]/],
    ['a step payoutPct of 150', [step(1, '-2', '0', '150')], /tier 1 .*payoutPct .*\(0, 100\]/],
    ['a step tier with min > max', [step(1, '0', '-2')], /tier 1 .*minValue above its maxValue/],
    ['a linear tier with lo >= hi', [linear({ minValue: '-2', maxValue: '-2' })], /TS_Linear .*minValue below maxValue/],
    ['a linear payoutPct not the max of its ends', [linear({ payoutPct: '60.00' })], /larger end percentage/],
    ['a linear end pct of 101', [linear({ pctAtMin: '101', payoutPct: '101' })], /pctAtMin and pctAtMax in \[0, 100\]/],
    ['a threshold of -2.00001', [step(1, '-2.00001', '0')], /tier 1 minValue .*4 decimal places/],
    ['a threshold of 123456789.0', [step(1, '-2', '123456789.0')], /tier 1 maxValue .*8 integer digits/],
    ['a payoutPct of 25.001', [step(1, '-2', '0', '25.001')], /tier 1 payoutPct .*2 decimal places/],
    ['an 81-character label', [step(1, '-2', '0', '25', 'a'.repeat(81))], /tier 1 label .*80 characters/],
    ["a label with '<'", [step(1, '-2', '0', '25', 'Don <script>')], /tier 1 label .*characters/],
    ['a label with a newline', [step(1, '-2', '0', '25', 'Don\nikinci satır')], /tier 1 label .*characters/],
    ['a label with an 11-digit run', [step(1, '-2', '0', '25', 'Don 12345678901')], /tier 1 label .*11 digits/],
    ['an empty label', [step(1, '-2', '0', '25', '')], /tier 1 label .*empty/],
    ['a label of spaces only', [step(1, '-2', '0', '25', '   ')], /tier 1 label .*empty/],
  ];
  for (const [name, input, rule] of refused) {
    assert.throws(() => validateTierSet(input), rule, name);
  }
});

test('validateTierSet: a tierOrder outside the PostgreSQL INTEGER range is refused; its two ends are accepted', () => {
  for (const tierOrder of [2147483648, -2147483649, 3000000000]) {
    assert.throws(() => validateTierSet([step(tierOrder, '-2', '0')]), /tierOrder .*INTEGER/, String(tierOrder));
  }
  for (const tierOrder of [2147483647, -2147483648]) {
    assert.deepEqual(validateTierSet([step(tierOrder, '-2', '0')]).tiers.map((t) => t.tierOrder), [tierOrder]);
  }
});

test('validateTierSet: a refused label is never echoed back', () => {
  for (const label of ['Ahmet Yılmaz <x>', 'Don 12345678901', 'x'.repeat(81), '   ']) {
    assert.throws(() => validateTierSet([step(1, '-2', '0', '25', label)]), (err) => !err.message.includes(label));
  }
});
