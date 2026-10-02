// The oracle's parse half, readingFromResponse, on a response given as bytes:
// no network, no database. The body is a small synthetic response in the SHAPE
// of MET Norway's Locationforecast compact answer (recordings/ is not in git),
// with made-up values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readingFromResponse } from '../src/oracle/oracleBot.js';

const CELL = 'metno:41.1111,42.7022';

function response() {
  const doc = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [42.7022, 41.1111, 1800] },
    properties: {
      meta: { updated_at: '2026-09-01T21:18:04Z', units: { air_pressure_at_sea_level: 'hPa', air_temperature: 'celsius' } },
      timeseries: [
        { time: '2026-09-01T22:00:00Z', data: { instant: { details: { air_pressure_at_sea_level: 1012.3, air_temperature: -1.7 } } } },
        { time: '2026-09-01T23:00:00Z', data: { instant: { details: { air_pressure_at_sea_level: 1012.1, air_temperature: -2.4 } } } },
      ],
    },
  };
  return {
    requestUrl: 'https://api.met.no/weatherapi/locationforecast/2.0/compact',
    requestParams: { lat: '41.1111', lon: '42.7022' },
    httpStatus: 200,
    body: Buffer.from(JSON.stringify(doc), 'utf8'),
    fetchedAt: '2026-09-01T22:04:58.085Z',
  };
}

test('a response gives the reading the oracle has always built: timeseries[0], its time, and the stand-in label', () => {
  const res = response();
  const reading = readingFromResponse(CELL, res);
  assert.deepEqual(reading, {
    cellId: CELL,
    metric: 'TEMPERATURE_C',
    value: -1.7,
    measuredAt: '2026-09-01T22:00:00Z',
    source:
      'met.no/locationforecast/2.0/compact model_run=2026-09-01T21:18:04Z grid=[42.7022,41.1111,1800] ' +
      'STAND-IN(forecast,not-observation)',
    raw: {
      requestUrl: res.requestUrl,
      requestParams: res.requestParams,
      httpStatus: 200,
      body: res.body,
      sha256: crypto.createHash('sha256').update(res.body).digest('hex'),
      providerUpdatedAt: '2026-09-01T21:18:04Z',
      fetchedAt: '2026-09-01T22:04:58.085Z',
    },
  });
});

test('the hash is of the bytes as given, not of a re-serialisation', () => {
  const res = response();
  const spaced = Buffer.from(JSON.stringify(JSON.parse(res.body.toString('utf8')), null, 2), 'utf8');
  const a = readingFromResponse(CELL, res);
  const b = readingFromResponse(CELL, { ...res, body: spaced });
  assert.equal(b.value, a.value, 'the same document parses to the same reading');
  assert.equal(b.raw.sha256, crypto.createHash('sha256').update(spaced).digest('hex'));
  assert.notEqual(b.raw.sha256, a.raw.sha256, 'different bytes, different hash');
  assert.equal(b.raw.body, spaced);
});

test('a unit other than celsius is refused, not relabelled', () => {
  const res = response();
  const doc = JSON.parse(res.body.toString('utf8'));
  doc.properties.meta.units.air_temperature = 'fahrenheit';
  assert.throws(
    () => readingFromResponse(CELL, { ...res, body: Buffer.from(JSON.stringify(doc)) }),
    /declares air_temperature in "fahrenheit", not "celsius"/
  );
});

test('an empty timeseries is refused and nothing is made up', () => {
  const res = response();
  const doc = JSON.parse(res.body.toString('utf8'));
  doc.properties.timeseries = [];
  assert.throws(
    () => readingFromResponse(CELL, { ...res, body: Buffer.from(JSON.stringify(doc)) }),
    /rejected \(nothing recorded\): value is not a finite number/
  );
});

test('a body that is not JSON is refused', () => {
  assert.throws(() => readingFromResponse(CELL, { ...response(), body: Buffer.from('<html>') }), /is not JSON/);
});
