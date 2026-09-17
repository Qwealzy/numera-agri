import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import cron from 'node-cron';
import axios from 'axios';
import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { resolveFrozenWindowRule, windowFor, isClosed, aggregate } from './eventWindow.js';

// --- the external data boundary -------------------------------------------
//
// STAND-IN, and labelled as one on purpose. MET Norway's Locationforecast is
// here because it needs no API key and its terms are unambiguous, NOT because
// it has been chosen as the data source. Two things about it are wrong for a
// real product and must not be quietly inherited:
//
//   1. It is a FORECAST. `air_temperature` in the first timeseries entry is
//      model output for the top of the current hour, not an observation from
//      an instrument. That distinction matters for what the data is worth,
//      so it is named here rather than blurred.
//   2. Its identity is a coordinate pair, not a station or a registry cell.
//      `cell_id` therefore looks like "metno:41.0082,28.9784" -- a STAND-IN
//      format. This run does NOT settle the cell_id convention; that decision
//      is still open.
//
// Licence, checked 2026-09-12 at https://api.met.no/doc/TermsOfService:
// "All open data require attribution as specified in the CC BY 4.0 license",
// with no non-commercial restriction, and every request "must (if possible)
// include an identifying User Agent-string (UA) ... with the application/
// domain name" plus contact details. That UA is configuration
// (CLIMATE_API_USER_AGENT) and has no default: a provider that requires
// identification and is given none gets no request at all.
//
// The rest of the pipeline still only depends on getting back
// { metric, value, measuredAt, source }.
const CELL_PREFIX = 'metno:';

// "metno:<lat>,<lon>". MET Norway returns 403 for coordinates with five or
// more decimals on newer products, so that limit is enforced here rather than
// discovered as a failed fetch in production.
function parseStandInCellId(cellId) {
  if (typeof cellId !== 'string' || !cellId.startsWith(CELL_PREFIX)) {
    throw new Error(
      `cell id ${JSON.stringify(cellId)} is not in the stand-in format "${CELL_PREFIX}<lat>,<lon>"`
    );
  }
  const parts = cellId.slice(CELL_PREFIX.length).split(',');
  if (parts.length !== 2) {
    throw new Error(`cell id ${cellId} must carry exactly one latitude and one longitude`);
  }
  const [lat, lon] = parts.map((p) => p.trim());
  for (const [name, raw] of [['latitude', lat], ['longitude', lon]]) {
    if (!/^-?\d+(\.\d{1,4})?$/.test(raw)) {
      throw new Error(
        `cell id ${cellId}: ${name} ${JSON.stringify(raw)} is not a number with at most 4 decimals ` +
          `(MET Norway refuses 5 or more)`
      );
    }
  }
  const latN = Number(lat);
  const lonN = Number(lon);
  if (latN < -90 || latN > 90) throw new Error(`cell id ${cellId}: latitude ${lat} is out of range`);
  if (lonN < -180 || lonN > 180) throw new Error(`cell id ${cellId}: longitude ${lon} is out of range`);
  return { lat, lon };
}

// Fail closed at the boundary. This function used to invent
// what the provider had not sent -- a missing `metric` became 'TEMPERATURE_C',
// a missing `measuredAt` became the current time, and `value` went through
// Number() with no finite check, so a malformed response could put a NaN into
// oracle_readings and queue a trigger on it. None of that is a default any
// more. A field that is missing or unusable REJECTS the reading; the caller
// logs the reason and moves on, and nothing is written.
//
// This is deliberately provider-agnostic: it checks the shape the pipeline
// depends on, so it keeps working when the stand-in above is replaced.
function assertUsableReading(reading, cellId) {
  const reject = (why) => {
    throw new Error(`reading for cell ${cellId} rejected (nothing recorded): ${why}`);
  };
  if (typeof reading.metric !== 'string' || reading.metric.trim() === '') {
    reject(`metric is missing or not a string (got ${JSON.stringify(reading.metric)})`);
  }
  if (typeof reading.value !== 'number' || !Number.isFinite(reading.value)) {
    reject(`value is not a finite number (got ${JSON.stringify(reading.value)})`);
  }
  if (typeof reading.measuredAt !== 'string' || Number.isNaN(Date.parse(reading.measuredAt))) {
    reject(`measuredAt is missing or unparseable (got ${JSON.stringify(reading.measuredAt)})`);
  }
  if (typeof reading.source !== 'string' || reading.source.trim() === '') {
    reject(`source is missing or not a string (got ${JSON.stringify(reading.source)})`);
  }
  return reading;
}

async function fetchExternalReading(cellId) {
  if (!config.oracle.climateApiUrl) {
    throw new Error('CLIMATE_API_URL not configured');
  }
  if (!config.oracle.climateApiUserAgent) {
    throw new Error(
      'CLIMATE_API_USER_AGENT not configured -- MET Norway requires an identifying User-Agent ' +
        'with contact details and there is no default to fall back on'
    );
  }
  const { lat, lon } = parseStandInCellId(cellId);

  // The provider does not give the same answer twice for the same moment
  // (seen in the first run against the real provider), so the response actually received is the
  // evidence. Its bytes are taken BEFORE anything parses them, hashed, and kept
  // with the request that produced them (migration 031).
  const requestUrl = `${config.oracle.climateApiUrl}/weatherapi/locationforecast/2.0/compact`;
  const requestParams = { lat, lon };
  const response = await axios.get(requestUrl, {
    params: requestParams,
    headers: { 'User-Agent': config.oracle.climateApiUserAgent },
    timeout: 10000,
    responseType: 'arraybuffer',
  });
  const fetchedAt = new Date().toISOString();
  const body = Buffer.from(response.data);
  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error(`provider response for cell ${cellId} is not JSON -- nothing recorded`);
  }

  // The unit is read from the response, never assumed. The provider states it
  // in properties.meta.units, and a response that says anything other than
  // celsius is refused rather than relabelled as TEMPERATURE_C.
  const declaredUnit = data?.properties?.meta?.units?.air_temperature;
  if (declaredUnit !== 'celsius') {
    throw new Error(
      `provider declares air_temperature in ${JSON.stringify(declaredUnit)}, not "celsius" -- ` +
        `refusing rather than recording it as TEMPERATURE_C`
    );
  }

  // The nearest entry is the top of the current hour in UTC, which is not the
  // instant of the call: `time` here and `updated_at` below are different
  // clocks and both are recorded, so the gap stays visible downstream.
  const entry = data?.properties?.timeseries?.[0];
  const observed = entry?.data?.instant?.details?.air_temperature;

  const reading = assertUsableReading(
    {
      cellId,
      metric: 'TEMPERATURE_C',
      value: observed,
      measuredAt: entry?.time,
      source:
        `met.no/locationforecast/2.0/compact model_run=${data?.properties?.meta?.updated_at} ` +
        `grid=${JSON.stringify(data?.geometry?.coordinates)} STAND-IN(forecast,not-observation)`,
    },
    cellId
  );
  // provider_updated_at is recorded as the provider stated it, and as null
  // where it stated nothing -- an absence, not a value filled in.
  reading.raw = {
    requestUrl,
    requestParams,
    httpStatus: response.status,
    body,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    providerUpdatedAt: data?.properties?.meta?.updated_at ?? null,
    fetchedAt,
  };
  return reading;
}

// Stage 2 Part 2: cell_ids live on each coverage now, not the policy --
// a package policy's coverages can watch entirely different cells (or
// none). This fetches every coverage on the policy and loops
// coverage-by-coverage, cell-by-cell within it, rather than the single
// flat cell_ids loop this had when a policy could only have one coverage.
//
// Stage 2 Part 1 had this function fetch a reading, record it, and insert
// one 'trigger' outbox row for it, keyed on reading_id. That was the defect
// migration 030 closes: one event produced as many triggers as it had
// readings, so a frost night polled every 15 minutes paid out once per poll.
// The first half is unchanged -- this still only fetches and records, and
// still exercises nothing itself -- but it no longer queues a trigger at all.
// queueClosedWindows below does, once per (coverage, cell, window), and only
// after the window is over.
async function evaluateOnePolicy(policy) {
  const { rows: coverages } = await pool.query(
    `SELECT * FROM policy_coverages WHERE policy_id = $1`,
    [policy.id]
  );

  for (const coverage of coverages) {
    for (const cellId of coverage.cell_ids) {
      let reading;
      try {
        reading = await fetchExternalReading(cellId);
      } catch (err) {
        console.error(
          `[oracleBot] failed to fetch reading for cell ${cellId} (coverage ${coverage.coverage_code}):`,
          err.message
        );
        continue;
      }

      // The response and the reading are written together or not at all, so no
      // recorded reading is ever missing the evidence it was taken from. The
      // table re-checks the hash against the bytes on insert.
      await withTransaction(async (tx) => {
        const { rows: [raw] } = await tx.query(
          `INSERT INTO oracle_raw_responses
             (request_url, request_params, http_status, body, sha256, provider_updated_at, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            reading.raw.requestUrl,
            JSON.stringify(reading.raw.requestParams),
            reading.raw.httpStatus,
            reading.raw.body,
            reading.raw.sha256,
            reading.raw.providerUpdatedAt,
            reading.raw.fetchedAt,
          ]
        );
        await tx.query(
          `INSERT INTO oracle_readings
             (policy_id, coverage_code, cell_id, metric, value, measured_at, source, raw_response_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            policy.id,
            coverage.coverage_code,
            cellId,
            reading.metric,
            reading.value,
            reading.measuredAt,
            reading.source,
            raw.id,
          ]
        );
      });
    }
  }
}

// The attestation a windowed trigger carries onto the ledger (migration 031):
// enough for a third party holding the stored responses to check the payout
// without asking the provider again, which would not return the same answer.
// Compact JSON with a fixed key order, so the same inputs always produce the
// same string.
//
// For min and max one reading decided the value, and the attestation names
// that reading and carries its response's hash, the provider's own update
// time, the request, and when it was fetched. A mean has no deciding reading:
// it carries one SHA-256 over the sorted per-response hashes, how many it
// combines, and the RANGES of update and fetch times -- a single time would
// be a choice this code has no basis for, and the provider has been seen to
// report update times that go backwards between calls.
//
// A reading written without a stored response (tests, verify scripts, readings
// recorded before 031) cannot be attested, and the attestation says
// "absent" in terms rather than leaving a field quietly empty.
function buildAttestation(window, rule, inWindow, determiningReadingId) {
  const evidenceOf = (r) =>
    r.raw_response_id
      ? {
          sha256: r.sha256,
          providerUpdatedAt: r.provider_updated_at,
          fetchedAt: new Date(r.fetched_at).toISOString(),
          request: { url: r.request_url, params: r.request_params },
        }
      : null;

  let evidence;
  if (determiningReadingId) {
    evidence = evidenceOf(inWindow.find((r) => r.id === determiningReadingId)) ?? 'absent';
  } else {
    const all = inWindow.map(evidenceOf);
    if (all.some((e) => e === null)) {
      evidence = 'absent';
    } else {
      const hashes = all.map((e) => e.sha256).sort();
      const updated = all.map((e) => e.providerUpdatedAt).filter((u) => u !== null).sort();
      const fetched = all.map((e) => e.fetchedAt).sort();
      evidence = {
        sha256: crypto.createHash('sha256').update(hashes.join('\n')).digest('hex'),
        combines: hashes.length,
        providerUpdatedAt: updated.length ? { earliest: updated[0], latest: updated[updated.length - 1] } : null,
        fetchedAt: { first: fetched[0], last: fetched[fetched.length - 1] },
        request: all[0].request,
      };
    }
  }

  return JSON.stringify({
    v: 1,
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      timezone: rule.timezone,
      startHour: rule.startHour,
      aggregation: rule.aggregation,
      readings: inWindow.length,
    },
    reading: determiningReadingId,
    evidence,
  });
}

// Folds one (coverage, cell)'s readings into windows and queues exactly one
// trigger per window that has CLOSED and has not been queued before.
//
// Only readings at or after the end of the last window already recorded for
// this key are considered, so a run looks at new data rather than the whole
// history. The consequence is stated rather than hidden: a reading that
// arrives late -- measured inside a window that has already been evaluated --
// is recorded but never folded in. The window is evaluated once, on what was
// known when it closed.
async function queueCellWindows(policy, coverageCode, cellId, rule, now) {
  const { rows: [{ boundary }] } = await pool.query(
    `SELECT max(window_end) AS boundary FROM trigger_windows
      WHERE policy_id = $1 AND coverage_code = $2 AND cell_id = $3`,
    [policy.id, coverageCode, cellId]
  );
  const { rows: readings } = await pool.query(
    `SELECT r.id, r.metric, r.value, r.measured_at, r.raw_response_id,
            rr.sha256, rr.provider_updated_at, rr.fetched_at, rr.request_url, rr.request_params
       FROM oracle_readings r
       LEFT JOIN oracle_raw_responses rr ON rr.id = r.raw_response_id
      WHERE r.policy_id = $1 AND r.coverage_code = $2 AND r.cell_id = $3
        AND ($4::timestamptz IS NULL OR r.measured_at >= $4)
      ORDER BY r.measured_at, r.id`,
    [policy.id, coverageCode, cellId, boundary]
  );

  const groups = new Map();
  for (const r of readings) {
    const window = windowFor(r.measured_at, rule);
    const key = window.start.toISOString();
    if (!groups.has(key)) groups.set(key, { window, readings: [] });
    groups.get(key).readings.push(r);
  }

  for (const { window, readings: inWindow } of groups.values()) {
    // The day's minimum is not known until the day is over.
    if (!isClosed(window, now)) continue;

    // A coverage declares cells and tiers but no metric, so a window that mixes
    // metrics has no single value to evaluate. Refused, not guessed.
    const metrics = [...new Set(inWindow.map((r) => r.metric))];
    if (metrics.length !== 1) {
      console.error(
        `[oracleBot] no trigger for policy ${policy.id} coverage ${coverageCode} cell ${cellId} window ` +
          `${window.start.toISOString()}: readings carry ${metrics.length} metrics (${metrics.join(', ')}), ` +
          `so there is no single value to aggregate`
      );
      continue;
    }

    const { value, determiningReadingId } = aggregate(
      inWindow.map((r) => ({ id: r.id, value: r.value, measuredAt: r.measured_at })),
      rule.aggregation
    );
    const attestationRef = buildAttestation(window, rule, inWindow, determiningReadingId);
    if (JSON.parse(attestationRef).evidence === 'absent') {
      console.error(
        `[oracleBot] window ${window.start.toISOString()} for policy ${policy.id} coverage ${coverageCode} ` +
          `cell ${cellId}: at least one reading has no stored provider response, so the attestation ` +
          `records the evidence as absent`
      );
    }

    await withTransaction(async (tx) => {
      // ON CONFLICT on the window key: if another run got here first, this one
      // queues nothing. The partial unique index on policy_events backs the
      // same guarantee from the outbox side.
      const { rows: [win] } = await tx.query(
        `INSERT INTO trigger_windows
           (policy_id, coverage_code, cell_id, window_start, window_end, timezone, start_hour,
            aggregation, metric, aggregated_value, determining_reading_id, reading_ids, attestation_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT ON CONSTRAINT trigger_windows_key DO NOTHING
         RETURNING id, aggregated_value`,
        [
          policy.id,
          coverageCode,
          cellId,
          window.start.toISOString(),
          window.end.toISOString(),
          rule.timezone,
          rule.startHour,
          rule.aggregation,
          metrics[0],
          value,
          determiningReadingId,
          inWindow.map((r) => r.id),
          attestationRef,
        ]
      );
      if (!win) return;

      // observedValue is read back from the row, not taken from the JS value, so
      // what the ledger evaluates and what trigger_windows records are the same
      // number at the column's own precision. expected_version stays
      // informational, as it always was for this event type.
      await tx.query(
        `INSERT INTO policy_events (policy_no, event_type, expected_version, trigger_window_id, payload)
         VALUES ($1, 'trigger', $2, $3, $4)`,
        [
          policy.id,
          policy.current_version,
          win.id,
          JSON.stringify({
            observedValue: Number(win.aggregated_value),
            metric: metrics[0],
            coverageCode,
          }),
        ]
      );
      console.log(
        `[oracleBot] window ${window.start.toISOString()}..${window.end.toISOString()} closed for policy ` +
          `${policy.id} coverage ${coverageCode} cell ${cellId}: ${rule.aggregation} of ${inWindow.length} ` +
          `reading(s) = ${win.aggregated_value}, one trigger queued`
      );
    });
  }
}

// The only place a 'trigger' outbox row is produced in production. `now` is a
// parameter so tests can close a window without waiting for a day to pass;
// production passes nothing and it is the real clock.
export async function queueClosedWindows({ insurerIds, now = new Date() } = {}) {
  const { rows: policies } = await pool.query(
    `SELECT p.* FROM policies p
     WHERE p.status IN ('active', 'partially_paid')` +
      (insurerIds === undefined ? '' : ' AND p.insurer_id = ANY($1)'),
    insurerIds === undefined ? undefined : [insurerIds]
  );
  for (const policy of policies) {
    const { rule, reason } = resolveFrozenWindowRule(policy);
    if (!rule) {
      console.error(`[oracleBot] no trigger for policy ${policy.id}: ${reason}`);
      continue;
    }
    const { rows: coverages } = await pool.query(
      `SELECT coverage_code, cell_ids FROM policy_coverages WHERE policy_id = $1`,
      [policy.id]
    );
    for (const coverage of coverages) {
      for (const cellId of coverage.cell_ids) {
        await queueCellWindows(policy, coverage.coverage_code, cellId, rule, now);
      }
    }
  }
}

async function runOnce({ insurerIds } = {}) {
  // insurerIds is for tests, which pass their own fixture insurers. Production
  // passes nothing, and the query is then exactly what it always was.
  const { rows: policies } = await pool.query(
    `SELECT p.*, i.oracle_operator_party
     FROM policies p
     JOIN insurers i ON i.id = p.insurer_id
     WHERE p.status IN ('active', 'partially_paid')` +
      (insurerIds === undefined ? '' : ' AND p.insurer_id = ANY($1)'),
    insurerIds === undefined ? undefined : [insurerIds]
  );
  console.log(`[oracleBot] evaluating ${policies.length} active polic${policies.length === 1 ? 'y' : 'ies'}`);
  for (const policy of policies) {
    if (!policy.oracle_operator_party) {
      console.error(`[oracleBot] policy ${policy.id}'s insurer has no oracle_operator_party set, skipping`);
      continue;
    }
    await evaluateOnePolicy(policy);
  }
  // Recording first, closing second, so any reading this tick that falls
  // inside a window that has just ended is folded in before that window is
  // evaluated.
  await queueClosedWindows({ insurerIds });
}

export function startOracleBot({ insurerIds } = {}) {
  console.log(`[oracleBot] scheduled with cron "${config.oracle.pollCron}"`);
  cron.schedule(config.oracle.pollCron, () => {
    runOnce({ insurerIds }).catch((err) => console.error('[oracleBot] run failed:', err));
  });
}

// Cross-platform-safe entry-point check -- string-concatenating
// `file://${process.argv[1]}` breaks on Windows (backslashes, missing the
// drive-letter slash), silently making this branch dead code there.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startOracleBot();
  runOnce().catch((err) => console.error('[oracleBot] initial run failed:', err));
}
