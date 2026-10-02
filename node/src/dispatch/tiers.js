// The ledger's tier evaluation, off the ledger: Types.daml's inRange,
// matchTier, tierPct, floorTo2dp and evaluateAgainstTiers, step for step, so
// that what Node calls a payout (the m. 1458 check in dispatcher.js) is what
// PolicyToken_EvaluateTrigger would pay. Pure; imports nothing.
//
// Daml's Decimal is Numeric 10: ten decimal places, addition and subtraction
// exact, and a product or a quotient rounded to ten places, half to even. A
// JavaScript float is not that, and at a tier's edge the difference is a
// payout or none -- so the arithmetic here is on integers scaled by 10^10,
// in the order the Daml writes it.

const SCALE = 10n ** 10n;

// "-2.0", "25.00", -1 (a number from a test) -> scaled BigInt. More than ten
// decimals is refused, as the ledger refuses such a Decimal.
export function toNumeric(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^-?\d+(\.\d+)?$/.test(text.trim())) {
    throw new Error(`not a decimal number: ${JSON.stringify(value)}`);
  }
  const [intPart, frac = ''] = text.trim().replace(/^-/, '').split('.');
  if (frac.length > 10) {
    throw new Error(`${text} has more than ten decimal places, which a Daml Decimal cannot hold`);
  }
  const magnitude = BigInt(intPart) * SCALE + BigInt(frac.padEnd(10, '0'));
  return text.trim().startsWith('-') ? -magnitude : magnitude;
}

// Scaled BigInt -> the shortest decimal string: "20000.03", "60", "-2.5".
export function numericToString(n) {
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const frac = String(abs % SCALE).padStart(10, '0').replace(/0+$/, '');
  return `${sign}${abs / SCALE}${frac ? `.${frac}` : ''}`;
}

// num / den, rounded to an integer half to even.
function divHalfEven(num, den) {
  if (den === 0n) throw new Error('division by zero');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  let q = num / den;
  let r = num % den;
  // BigInt division truncates toward zero; move to floor first.
  if (r < 0n) {
    q -= 1n;
    r += den;
  }
  const twice = 2n * r;
  if (twice > den || (twice === den && q % 2n !== 0n)) q += 1n;
  return q;
}

const mul = (a, b) => divHalfEven(a * b, SCALE);
const div = (a, b) => divHalfEven(a * SCALE, b);

// floor toward minus infinity, as Daml's `floor` on a Decimal.
function floorToInt(n) {
  const q = n / SCALE;
  return n < 0n && n % SCALE !== 0n ? q - 1n : q;
}

const bound = (v) => (v === null || v === undefined ? null : toNumeric(v));

// Types.daml's inRange: both bounds inclusive, a missing bound unbounded.
function inRange(observed, tier) {
  const lo = bound(tier.minValue);
  const hi = bound(tier.maxValue);
  return (lo === null || observed >= lo) && (hi === null || observed <= hi);
}

// Types.daml's matchTier: the FIRST tier whose range holds the value. Tiers
// arrive sorted by tier_order, as everywhere else.
export function matchTier(tiers, observed) {
  const x = toNumeric(observed);
  return (tiers ?? []).find((t) => inRange(x, t));
}

// The rules a whole tier set is held to before it is written: validTier's and
// the payout_tiers CHECKs' per-tier rules, plus what neither checks -- a
// unique integer tierOrder, no overlap (ends inclusive, so a shared end point
// overlaps), no more precision than NUMERIC(12,4) and NUMERIC(5,2) would keep
// rather than silently round, and the tier-label rule. A gap is accepted and
// listed: only the open interval between two tiers, never an open end.
// Returns { tiers, gaps }, tiers sorted by tierOrder; a refusal throws, naming
// the tier by its tierOrder and never echoing a label.
const LABEL_MAX_CHARS = 80;
// A PostgreSQL INTEGER's range, the type of payout_tiers.tier_order and of the
// insurer's period columns: beyond it the write fails in the database as a 500.
export const PG_INTEGER_MIN = -2147483648;
export const PG_INTEGER_MAX = 2147483647;
const LABEL_CHARS = /^[A-Za-zÇĞİÖŞÜçğıöşü0-9 ()\-.,%°/:]+$/u;

function decimalField(tier, field, intDigits, fracDigits) {
  let n;
  try {
    n = toNumeric(tier[field]);
  } catch {
    throw new Error(`tier ${tier.tierOrder} ${field} is not a decimal number of at most ten decimal places`);
  }
  const abs = n < 0n ? -n : n;
  const column = `NUMERIC(${intDigits + fracDigits},${fracDigits})`;
  if (abs / SCALE >= 10n ** BigInt(intDigits)) {
    throw new Error(`tier ${tier.tierOrder} ${field} has more than ${intDigits} integer digits, beyond ${column}`);
  }
  if (abs % 10n ** BigInt(10 - fracDigits) !== 0n) {
    throw new Error(`tier ${tier.tierOrder} ${field} has more than ${fracDigits} decimal places, which ${column} would round`);
  }
  return n;
}

const optional = (tier, field, intDigits, fracDigits) =>
  tier[field] === null || tier[field] === undefined ? null : decimalField(tier, field, intDigits, fracDigits);

function checkLabel(tier) {
  const { label } = tier;
  if (typeof label !== 'string') throw new Error(`tier ${tier.tierOrder} label is not a string`);
  if (label.trim().length === 0) throw new Error(`tier ${tier.tierOrder} label is empty or only spaces`);
  if ([...label].length > LABEL_MAX_CHARS) {
    throw new Error(`tier ${tier.tierOrder} label is longer than ${LABEL_MAX_CHARS} characters`);
  }
  if (!LABEL_CHARS.test(label)) {
    throw new Error(
      `tier ${tier.tierOrder} label contains characters outside letters, digits, space and ( ) - . , % ° / :`
    );
  }
  if (/\d{11}/.test(label)) {
    throw new Error(`tier ${tier.tierOrder} label contains 11 digits in a row, the form of a T.C. kimlik numarası`);
  }
}

export function validateTierSet(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) throw new Error('a tier set must be a non-empty array');
  const orders = new Set();
  const ranges = tiers.map((tier, i) => {
    if (tier === null || typeof tier !== 'object') throw new Error(`the tier at position ${i} is not an object`);
    if (!Number.isInteger(tier.tierOrder)) throw new Error(`the tier at position ${i} has a tierOrder that is not an integer`);
    if (tier.tierOrder < PG_INTEGER_MIN || tier.tierOrder > PG_INTEGER_MAX) {
      throw new Error(`the tier at position ${i} has a tierOrder outside the INTEGER range ${PG_INTEGER_MIN} to ${PG_INTEGER_MAX}`);
    }
    if (orders.has(tier.tierOrder)) throw new Error(`tierOrder ${tier.tierOrder} is repeated`);
    orders.add(tier.tierOrder);
    checkLabel(tier);
    if (tier.shape !== 'TS_Step' && tier.shape !== 'TS_Linear') {
      throw new Error(`tier ${tier.tierOrder} has a shape that is neither TS_Step nor TS_Linear`);
    }
    const lo = optional(tier, 'minValue', 8, 4);
    const hi = optional(tier, 'maxValue', 8, 4);
    const pct = decimalField(tier, 'payoutPct', 3, 2);
    const pLo = optional(tier, 'pctAtMin', 3, 2);
    const pHi = optional(tier, 'pctAtMax', 3, 2);
    const hundred = toNumeric('100');
    if (tier.shape === 'TS_Step') {
      if (pLo !== null || pHi !== null) throw new Error(`tier ${tier.tierOrder} is TS_Step and carries pctAtMin or pctAtMax`);
      if (!(pct > 0n && pct <= hundred)) throw new Error(`tier ${tier.tierOrder} is TS_Step and its payoutPct must be in (0, 100]`);
      if (lo !== null && hi !== null && lo > hi) throw new Error(`tier ${tier.tierOrder} has its minValue above its maxValue`);
    } else {
      if (lo === null || hi === null || !(lo < hi)) {
        throw new Error(`tier ${tier.tierOrder} is TS_Linear and needs both bounds, minValue below maxValue`);
      }
      if (pLo === null || pHi === null || pLo < 0n || pLo > hundred || pHi < 0n || pHi > hundred) {
        throw new Error(`tier ${tier.tierOrder} is TS_Linear and needs pctAtMin and pctAtMax in [0, 100]`);
      }
      if (pct !== (pLo > pHi ? pLo : pHi)) {
        throw new Error(`tier ${tier.tierOrder} is TS_Linear and its payoutPct must equal the larger end percentage`);
      }
    }
    return { tier, lo, hi };
  });
  // Sorted by lower bound, a missing one first: with no overlap between
  // neighbours there is none anywhere, and each neighbour pair leaves a gap.
  ranges.sort((a, b) => (a.lo === b.lo ? 0 : a.lo === null ? -1 : b.lo === null ? 1 : a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
  const gaps = [];
  for (let i = 1; i < ranges.length; i += 1) {
    const [a, b] = [ranges[i - 1], ranges[i]];
    if (a.hi === null || b.lo === null || b.lo <= a.hi) {
      throw new Error(`tiers ${a.tier.tierOrder} and ${b.tier.tierOrder} overlap (ends inclusive)`);
    }
    gaps.push({ from: String(a.tier.maxValue), to: String(b.tier.minValue), betweenTiers: [a.tier.tierOrder, b.tier.tierOrder] });
  }
  return { tiers: [...tiers].sort((a, b) => a.tierOrder - b.tierOrder), gaps };
}

// Types.daml's tierPct. A step tier pays payoutPct. A linear tier
// interpolates pLo + (x - lo) * (pHi - pLo) / (hi - lo); a malformed one,
// which validTier keeps off the ledger, pays 0 rather than a guess. A shape
// that is neither is refused: the ledger has no third one.
function tierPct(tier, x) {
  if (tier.shape === 'TS_Step') return toNumeric(tier.payoutPct);
  if (tier.shape !== 'TS_Linear') {
    throw new Error(`tier "${tier.label}" has shape ${JSON.stringify(tier.shape)}, neither TS_Step nor TS_Linear`);
  }
  const lo = bound(tier.minValue);
  const hi = bound(tier.maxValue);
  const pLo = bound(tier.pctAtMin);
  const pHi = bound(tier.pctAtMax);
  if (lo === null || hi === null || pLo === null || pHi === null || !(lo < hi)) return 0n;
  return pLo + div(mul(x - lo, pHi - pLo), hi - lo);
}

// Types.daml's floorTo2dp: intToDecimal (floor (x * 100.0)) / 100.0.
function floorTo2dp(n) {
  return div(floorToInt(mul(n, toNumeric('100'))) * SCALE, toNumeric('100'));
}

// Types.daml's evaluateAgainstTiers. `basis` is the coverage's remaining
// limit or its sum insured, as its payout basis says; the amount is capped at
// the remaining limit under either; an amount of 0.00 after the cap is NO
// MATCH, for every tier shape, exactly as the ledger returns it.
export function evaluateAgainstTiers(tiers, basis, remainingLimit, observed) {
  const noMatch = { matched: false, matchedTierLabel: null, payoutPct: '0', payoutAmount: '0', isFullSettlement: false };
  const tier = matchTier(tiers, observed);
  if (!tier) return noMatch;
  const x = toNumeric(observed);
  const limit = toNumeric(remainingLimit);
  const pct = tierPct(tier, x);
  const raw = div(mul(toNumeric(basis), pct), toNumeric('100'));
  const floored = floorTo2dp(raw);
  const amount = floored < limit ? floored : limit;
  if (amount === 0n) return noMatch;
  return {
    matched: true,
    matchedTierLabel: tier.label,
    payoutPct: numericToString(pct),
    payoutAmount: numericToString(amount),
    isFullSettlement: pct >= toNumeric('100') || amount >= limit,
  };
}

// The basis a coverage's payout_basis names. No default: a coverage without
// one is refused, as the ledger refuses to mint it.
export function basisFor(payoutBasis, { sumInsured, remainingLimit }) {
  if (payoutBasis === 'PB_RemainingLimit') return remainingLimit;
  if (payoutBasis === 'PB_SumInsured') return sumInsured;
  throw new Error(`payout basis ${JSON.stringify(payoutBasis)} is neither PB_RemainingLimit nor PB_SumInsured`);
}
