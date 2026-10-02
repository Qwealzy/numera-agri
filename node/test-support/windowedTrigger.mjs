// A trigger as the oracle leaves one, written directly, for the test files and
// scripts that fire a trigger without waiting a day for a window to close.
//
// Since v22 the dispatcher refuses a 'trigger' row that names no window, or
// whose window records its evidence as absent: the ledger takes no trigger
// without the window's event interval, the committed cell and an evidence
// digest (dispatcher.js, handleTrigger). Before v22 a fixture wrote a bare
// outbox row with a reading id; that row is now refused, and this writes what
// the oracle writes instead (oracleBot.js, queueCellWindows):
//   - a stored provider response, whose sha256 the table checks against the
//     bytes -- a fixture body, labelled as one, never a provider's;
//   - the reading taken from it;
//   - the trigger_windows row: a min window over that one reading, its
//     attestation in the shape buildAttestation gives such a window, and the
//     event interval the trigger will send;
//   - the 'trigger' outbox row naming the window.
// Nothing here chooses a product value. The value, the coverage, the cell and
// the interval are the caller's; the window rule written on the row
// (Europe/Istanbul, start hour 0, min) only describes how this one row was
// made, as the oracle records the rule on every row it writes.
//
// The window's start and end default to the event interval: a fixture window
// that was not clipped. Pass windowStart/windowEnd to write a clipped one.
import crypto from 'node:crypto';

const iso = (t) => new Date(t).toISOString();

export async function insertWindowedTrigger(db, {
  policyId, coverageCode, cellId, value, eventStart, eventEnd,
  windowStart = eventStart, windowEnd = eventEnd, metric = 'TEMPERATURE_C', expectedVersion = 1,
  measuredAt = eventStart,
}) {
  const body = Buffer.from(JSON.stringify({
    fixture: 'test-support/windowedTrigger.mjs -- not a provider response',
    cellId, value: String(value), measuredAt: iso(measuredAt), nonce: crypto.randomUUID(),
  }), 'utf8');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const request = { url: 'fixture://test-support/windowedTrigger', params: { cellId } };
  const fetchedAt = iso(measuredAt);
  const { rows: [raw] } = await db.query(
    `INSERT INTO oracle_raw_responses (request_url, request_params, http_status, body, sha256, provider_updated_at, fetched_at)
     VALUES ($1,$2,200,$3,$4,NULL,$5) RETURNING id`,
    [request.url, JSON.stringify(request.params), body, sha256, fetchedAt]
  );
  const { rows: [reading] } = await db.query(
    `INSERT INTO oracle_readings (policy_id, coverage_code, cell_id, metric, value, measured_at, source, raw_response_id)
     VALUES ($1,$2,$3,$4,$5,$6,'test-fixture',$7) RETURNING id`,
    [policyId, coverageCode, cellId, metric, value, iso(measuredAt), raw.id]
  );
  const attestationRef = JSON.stringify({
    v: 1,
    window: {
      start: iso(windowStart), end: iso(windowEnd), timezone: 'Europe/Istanbul', startHour: 0, aggregation: 'min',
      readings: 1,
    },
    reading: reading.id,
    evidence: { sha256, providerUpdatedAt: null, fetchedAt, request },
  });
  const { rows: [win] } = await db.query(
    `INSERT INTO trigger_windows
       (policy_id, coverage_code, cell_id, window_start, window_end, timezone, start_hour, aggregation, metric,
        aggregated_value, determining_reading_id, reading_ids, attestation_ref, event_start, event_end)
     VALUES ($1,$2,$3,$4,$5,'Europe/Istanbul',0,'min',$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, aggregated_value`,
    [policyId, coverageCode, cellId, iso(windowStart), iso(windowEnd), metric, value, reading.id, [reading.id],
      attestationRef, iso(eventStart), iso(eventEnd)]
  );
  const { rows: [event] } = await db.query(
    `INSERT INTO policy_events (policy_no, event_type, expected_version, trigger_window_id, payload)
     VALUES ($1,'trigger',$2,$3,$4) RETURNING id`,
    [policyId, expectedVersion, win.id,
      JSON.stringify({ observedValue: Number(win.aggregated_value), metric, coverageCode })]
  );
  return { readingId: reading.id, rawResponseId: raw.id, windowId: win.id, eventId: event.id, evidenceDigest: `sha256:${sha256}` };
}

// Removes what insertWindowedTrigger -- and the dispatcher, from it -- wrote
// for these policies: windows, readings, the evidence rows holding the stored
// responses, and the responses. Call it AFTER the policies' payout_events and
// policy_events rows are gone (both name a window), and before the policies.
// attested_evidence gives up a row only in a database marked as a test
// database (migration 032). The verify scripts also write this fixture to the
// working database, where the resulting attested_evidence row is not
// deletable by this cleanup function.
export async function deleteWindowedTriggerRows(db, policyIds) {
  if (!policyIds.length) return;
  await db.query('DELETE FROM trigger_windows WHERE policy_id = ANY($1::uuid[])', [policyIds]);
  const raws = (await db.query(
    'SELECT raw_response_id FROM oracle_readings WHERE policy_id = ANY($1::uuid[]) AND raw_response_id IS NOT NULL',
    [policyIds]
  )).rows.map((r) => r.raw_response_id);
  await db.query('DELETE FROM oracle_readings WHERE policy_id = ANY($1::uuid[])', [policyIds]);
  await db.query(
    'DELETE FROM attested_evidence WHERE policy_id = ANY($1::uuid[]) OR raw_response_id = ANY($2::uuid[])',
    [policyIds, raws]
  );
  if (raws.length) await db.query('DELETE FROM oracle_raw_responses WHERE id = ANY($1::uuid[])', [raws]);
}
