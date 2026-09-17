// The event window: the rule that turns many readings into one evaluation.
//
// Before this existed every reading produced its own `trigger` outbox row,
// keyed only on reading_id, and nothing stopped the same event from being
// paid twice: the oracle bot polls every 15 minutes, so a single frost night
// that yields eight readings under the threshold produced eight triggers and
// eight payouts. Now readings are folded into a window, and a coverage is
// evaluated ONCE per window, with the window's aggregated value.
//
// Pure on purpose -- no database, no network, no clock of its own -- so the
// rule can be tested and mutation-tested in isolation.
//
// WHAT IS NOT DECIDED HERE. Which window (a calendar day, or a meteorological
// day starting at some other hour, in which time zone) and which aggregation
// (the day's minimum for a frost cover, its maximum for heat, its mean) are
// PRODUCT decisions, not engineering ones, so none of them has a default
// anywhere. They are configuration in the grace_period_days shape: an
// insurer default, a policy override, resolved and frozen onto the policy at
// activation. A policy with no rule frozen onto it is never triggered, and
// the reason is logged -- see resolveFrozenWindowRule.
//
// A window is always ONE local day long, starting at `startHour` local time:
// startHour 0 is a calendar day; any other hour is a day that begins then. A
// window of some other length would be a product change, not a setting.

export const AGGREGATIONS = Object.freeze(['min', 'max', 'mean']);

// Fail closed. Reads ONLY what was frozen onto the policy at activation, never
// the insurer's current default: a default changed after a policy was issued
// must not retroactively arm, disarm or alter that policy's evaluation (the
// same snapshot-at-issue principle as payout_tiers and grace_period_days).
// Returns { rule } or { reason } -- never a guessed value.
export function resolveFrozenWindowRule(policy) {
  const missing = [];
  if (policy.event_window_timezone == null) missing.push('event_window_timezone');
  if (policy.event_window_start_hour == null) missing.push('event_window_start_hour');
  if (policy.event_aggregation == null) missing.push('event_aggregation');
  if (missing.length > 0) {
    return {
      reason:
        `policy ${policy.id} has no event window frozen onto it (${missing.join(', ')} unset) -- ` +
        `set insurers.default_event_* or policies.event_* BEFORE activation; refusing to trigger ` +
        `rather than assume a window or an aggregation rule`,
    };
  }
  const timezone = policy.event_window_timezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return { reason: `policy ${policy.id}: event_window_timezone ${JSON.stringify(timezone)} is not an IANA zone` };
  }
  const startHour = Number(policy.event_window_start_hour);
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    return { reason: `policy ${policy.id}: event_window_start_hour ${policy.event_window_start_hour} is not 0-23` };
  }
  if (!AGGREGATIONS.includes(policy.event_aggregation)) {
    return {
      reason:
        `policy ${policy.id}: event_aggregation ${JSON.stringify(policy.event_aggregation)} is not one of ` +
        `${AGGREGATIONS.join(', ')}`,
    };
  }
  return { rule: { timezone, startHour, aggregation: policy.event_aggregation } };
}

// Local wall-clock components of an instant in a zone.
function zonedParts(instantMillis, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(instantMillis))
      .map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// The UTC instant of a local wall-clock time. Same Intl technique as
// dispatcher.js's policyTermInstant, with a second correction pass so it
// also lands right on a DST transition day, which a single pass does not
// guarantee for zones that have one.
function localToInstant(year, month, day, hour, timezone) {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offsetAt = (t) => {
    const z = zonedParts(t, timezone);
    return Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

// Calendar arithmetic on a local date, with no zone involved at all.
function addLocalDays(year, month, day, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// The window [start, end) that contains `instant`. A reading measured exactly
// at a window's start belongs to that window; one measured exactly at its end
// belongs to the next.
export function windowFor(instant, { timezone, startHour }) {
  const millis = new Date(instant).getTime();
  if (Number.isNaN(millis)) throw new Error(`windowFor: ${JSON.stringify(instant)} is not a valid instant`);
  const local = zonedParts(millis, timezone);
  let startDay = { year: local.year, month: local.month, day: local.day };
  let start = localToInstant(startDay.year, startDay.month, startDay.day, startHour, timezone);
  if (millis < start) {
    startDay = addLocalDays(startDay.year, startDay.month, startDay.day, -1);
    start = localToInstant(startDay.year, startDay.month, startDay.day, startHour, timezone);
  }
  const endDay = addLocalDays(startDay.year, startDay.month, startDay.day, 1);
  const end = localToInstant(endDay.year, endDay.month, endDay.day, startHour, timezone);
  return { start: new Date(start), end: new Date(end) };
}

// A window can only be evaluated once it is over: the day's minimum is not
// known until the day has ended.
export function isClosed(window, now) {
  return new Date(now).getTime() >= window.end.getTime();
}

// Folds a window's readings into one value. For min and max there is exactly
// one reading that decided the value, and it is returned so the payout can
// point straight at it; ties go to the earliest measurement, then the lowest
// id, so the answer never depends on row order. A mean has no deciding
// reading, and says so with null.
export function aggregate(readings, aggregation) {
  if (!Array.isArray(readings) || readings.length === 0) {
    throw new Error('aggregate: a window with no readings cannot be evaluated');
  }
  if (!AGGREGATIONS.includes(aggregation)) {
    throw new Error(`aggregate: unknown aggregation ${JSON.stringify(aggregation)}`);
  }
  const values = readings.map((r) => Number(r.value));
  if (values.some((v) => !Number.isFinite(v))) {
    throw new Error('aggregate: every reading in a window must carry a finite value');
  }
  if (aggregation === 'mean') {
    return { value: values.reduce((a, b) => a + b, 0) / values.length, determiningReadingId: null };
  }
  const ordered = [...readings].sort((a, b) => {
    const t = new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime();
    return t !== 0 ? t : String(a.id).localeCompare(String(b.id));
  });
  let best = ordered[0];
  for (const r of ordered) {
    const better = aggregation === 'min' ? Number(r.value) < Number(best.value) : Number(r.value) > Number(best.value);
    if (better) best = r;
  }
  return { value: Number(best.value), determiningReadingId: best.id };
}
