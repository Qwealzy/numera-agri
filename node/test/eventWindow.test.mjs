// The event window rule, in isolation: no database, no ledger, no clock of its
// own. oracleWindow.test.mjs covers the same rule end to end against LocalNet;
// this file covers the arithmetic it depends on, including the boundaries and
// a DST day, which a live run would only ever hit by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGGREGATIONS,
  resolveFrozenWindowRule,
  windowFor,
  isClosed,
  aggregate,
} from '../src/oracle/eventWindow.js';

const ISTANBUL_CALENDAR_DAY = { timezone: 'Europe/Istanbul', startHour: 0 };

test('a calendar day in Istanbul runs from local midnight to local midnight', () => {
  // 00:30 local on the 13th is 21:30Z on the 12th.
  const w = windowFor('2026-09-12T21:30:00Z', ISTANBUL_CALENDAR_DAY);
  assert.equal(w.start.toISOString(), '2026-09-12T21:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-09-13T21:00:00.000Z');
});

test('a reading exactly at a window start belongs to that window, one exactly at its end to the next', () => {
  const atStart = windowFor('2026-09-12T21:00:00Z', ISTANBUL_CALENDAR_DAY);
  assert.equal(atStart.start.toISOString(), '2026-09-12T21:00:00.000Z');
  const atEnd = windowFor('2026-09-13T21:00:00Z', ISTANBUL_CALENDAR_DAY);
  assert.equal(atEnd.start.toISOString(), '2026-09-13T21:00:00.000Z');
});

test('readings at different hours of the same local day share one window', () => {
  const a = windowFor('2026-09-01T01:00:00+03:00', ISTANBUL_CALENDAR_DAY);
  const b = windowFor('2026-09-01T12:00:00+03:00', ISTANBUL_CALENDAR_DAY);
  const c = windowFor('2026-09-01T23:59:59+03:00', ISTANBUL_CALENDAR_DAY);
  assert.equal(a.start.toISOString(), b.start.toISOString());
  assert.equal(b.start.toISOString(), c.start.toISOString());
});

test('a day that starts at another hour puts the early hours in the previous day', () => {
  const rule = { timezone: 'Europe/Istanbul', startHour: 6 };
  const early = windowFor('2026-09-12T04:00:00+03:00', rule);
  assert.equal(early.start.toISOString(), '2026-09-11T03:00:00.000Z'); // 06:00 local on the 11th
  const late = windowFor('2026-09-12T07:00:00+03:00', rule);
  assert.equal(late.start.toISOString(), '2026-09-12T03:00:00.000Z'); // 06:00 local on the 12th
});

test('on a DST day the window is one LOCAL day long, and windows stay contiguous', () => {
  // Berlin moves 02:00 -> 03:00 on 2026-03-29, so that local day is 23 hours.
  const rule = { timezone: 'Europe/Berlin', startHour: 0 };
  const dstDay = windowFor('2026-03-29T12:00:00+02:00', rule);
  assert.equal(dstDay.end.getTime() - dstDay.start.getTime(), 23 * 3600 * 1000);
  const next = windowFor(dstDay.end, rule);
  assert.equal(next.start.getTime(), dstDay.end.getTime(), 'no gap and no overlap between windows');
});

test('a window is closed only once its end has passed', () => {
  const w = windowFor('2026-09-01T12:00:00+03:00', ISTANBUL_CALENDAR_DAY);
  assert.equal(isClosed(w, new Date(w.end.getTime() - 1)), false);
  assert.equal(isClosed(w, w.end), true);
});

const readings = [
  { id: 'r-b', value: '-1.5', measuredAt: '2026-09-01T03:00:00+03:00' },
  { id: 'r-a', value: '-1.0', measuredAt: '2026-09-01T01:00:00+03:00' },
  { id: 'r-c', value: '-0.5', measuredAt: '2026-09-01T05:00:00+03:00' },
];

test('min returns the lowest value and the reading that decided it', () => {
  assert.deepEqual(aggregate(readings, 'min'), { value: -1.5, determiningReadingId: 'r-b' });
});

test('max returns the highest value and the reading that decided it', () => {
  assert.deepEqual(aggregate(readings, 'max'), { value: -0.5, determiningReadingId: 'r-c' });
});

test('mean has no deciding reading', () => {
  assert.deepEqual(aggregate(readings, 'mean'), { value: -1.0, determiningReadingId: null });
});

test('a tie goes to the earliest measurement, whatever order the rows came in', () => {
  const tied = [
    { id: 'late', value: '-2', measuredAt: '2026-09-01T05:00:00Z' },
    { id: 'early', value: '-2', measuredAt: '2026-09-01T01:00:00Z' },
  ];
  assert.equal(aggregate(tied, 'min').determiningReadingId, 'early');
  assert.equal(aggregate([...tied].reverse(), 'min').determiningReadingId, 'early');
});

test('an empty window, an unknown aggregation and a non-finite value are refused', () => {
  assert.throws(() => aggregate([], 'min'), /no readings/);
  assert.throws(() => aggregate(readings, 'median'), /unknown aggregation/);
  assert.throws(() => aggregate([{ id: 'x', value: 'NaN', measuredAt: '2026-09-01T00:00:00Z' }], 'min'), /finite/);
});

test('the aggregation vocabulary is exactly min, max and mean', () => {
  assert.deepEqual([...AGGREGATIONS], ['min', 'max', 'mean']);
});

test('no rule frozen onto the policy is a refusal that names what is missing, never a default', () => {
  const r = resolveFrozenWindowRule({ id: 'p1', event_window_timezone: null, event_window_start_hour: 0, event_aggregation: null });
  assert.equal(r.rule, undefined);
  assert.match(r.reason, /event_window_timezone/);
  assert.match(r.reason, /event_aggregation/);
  assert.doesNotMatch(r.reason, /event_window_start_hour/);
});

test('an invalid zone, hour or aggregation is refused', () => {
  const base = { id: 'p1', event_window_timezone: 'Europe/Istanbul', event_window_start_hour: 0, event_aggregation: 'min' };
  assert.match(resolveFrozenWindowRule({ ...base, event_window_timezone: 'Mars/Olympus' }).reason, /IANA/);
  assert.match(resolveFrozenWindowRule({ ...base, event_window_start_hour: 24 }).reason, /0-23/);
  assert.match(resolveFrozenWindowRule({ ...base, event_aggregation: 'median' }).reason, /not one of/);
});

test('a complete frozen rule resolves, including start hour 0', () => {
  const r = resolveFrozenWindowRule({
    id: 'p1', event_window_timezone: 'Europe/Istanbul', event_window_start_hour: 0, event_aggregation: 'min',
  });
  assert.deepEqual(r.rule, { timezone: 'Europe/Istanbul', startHour: 0, aggregation: 'min' });
});
