// Replay of recorded provider responses through the oracle's own parse-and-
// store path.
//
// What it does: takes the responses scripts/recordProviderResponses.mjs wrote
// to disk for one cell, over one range of hours, and stores each of them
// against one policy's coverage exactly as the oracle stores a live response
// -- readingFromResponse, then storeReading, both from
// node/src/oracle/oracleBot.js. Then it calls that file's queueClosedWindows
// once, for this policy's insurer only, and prints what was queued.
//
// What it does not touch: the recording files (read only), the ledger (read,
// never written), and the event window. It evaluates no window and writes no
// trigger itself; queueClosedWindows decides what has closed, and the running
// dispatcher takes it from there. The ledger read is queueClosedWindows's:
// it queues a window only for a policy whose PolicyToken is active for its
// insurer (livePolicyNos in oracleBot.js), so the ledger JSON API has to
// answer. A policy it skips, or a read that fails, is named only on
// oracleBot's own stderr line; this script's summary then counts 0 window(s)
// closed.
//
// Recorded times are kept. The bytes, fetched_at and measured_at are written
// as recorded, and nothing is moved to "now". So the policy's cover period,
// [coverage_began_at, expiry), has to contain the recorded hours: a reading
// outside it is stored but never folded into a window, as for a live one.
// Every replayed reading's source ends in " REPLAY(recorded <fetchedAt>)", so
// it is never taken for a live reading.
//
// Before anything is written, it stops if: the policy is missing or not
// active, the coverage does not name the cell, a recording in the range does
// not hash to its record (the recorder's own --verify), an hour in the range
// has no recording (unless --allow-gaps), or a recording does not parse. An
// hour the policy already has a reading for, on that coverage and cell, is
// skipped and named, so a second replay adds nothing.
//
// Run it from node/, where config.js finds .env. Every argument is required;
// --from and --to are UTC instants bounding timeseries[0].time, inclusive.
//
//   node ../scripts/replayRecordedResponses.mjs --dir ../recordings --cell metno:<lat>,<lon> \
//     --from 2026-09-19T10:00:00Z --to 2026-09-19T12:00:00Z --policy <policyId> --coverage <coverageCode> \
//     [--allow-gaps]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from '../node/src/db.js';
import { readingFromResponse, storeReading, queueClosedWindows } from '../node/src/oracle/oracleBot.js';
import { fileStem, verifyDir } from './recordProviderResponses.mjs';

const HOUR_MS = 60 * 60 * 1000;
const hourName = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

export async function replay({ dir, cell, from, to, policyId, coverageCode, allowGaps = false }, log = console.log) {
  for (const [name, value] of Object.entries({ dir, cell, from, to, policy: policyId, coverage: coverageCode })) {
    if (value === undefined || value === null || value === '') throw new Error(`--${name} is required -- there is no default`);
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs)) throw new Error(`--from ${JSON.stringify(from)} is not an instant`);
  if (Number.isNaN(toMs)) throw new Error(`--to ${JSON.stringify(to)} is not an instant`);
  if (toMs < fromMs) throw new Error(`--to ${to} is before --from ${from}`);

  // --- checks; nothing is written until all of them have passed ------------

  const { rows: [policy] } = await pool.query('SELECT id, status, insurer_id FROM policies WHERE id = $1', [policyId]);
  if (!policy) throw new Error(`policy ${policyId} does not exist`);
  if (policy.status !== 'active') throw new Error(`policy ${policyId} is ${policy.status}, not active`);
  const { rows: [coverage] } = await pool.query(
    'SELECT cell_ids FROM policy_coverages WHERE policy_id = $1 AND coverage_code = $2',
    [policyId, coverageCode]
  );
  if (!coverage) throw new Error(`policy ${policyId} has no coverage ${coverageCode}`);
  if (!coverage.cell_ids.includes(cell)) {
    throw new Error(`coverage ${coverageCode} of policy ${policyId} does not name cell ${cell} (it names ${JSON.stringify(coverage.cell_ids)})`);
  }

  const hours = [];
  for (let t = Math.ceil(fromMs / HOUR_MS) * HOUR_MS; t <= toMs; t += HOUR_MS) hours.push(hourName(t));
  const present = hours.filter((h) => fs.existsSync(path.join(dir, `${fileStem(cell, h)}.raw`)));
  if (present.length === 0) throw new Error(`no recording for ${cell} between ${from} and ${to}`);

  const verified = verifyDir(dir);
  const stems = new Set(present.map((h) => fileStem(cell, h)));
  const mismatches = verified.mismatches.filter((m) => stems.has(m.stem));
  const orphans = verified.orphans.filter((o) => stems.has(o.replace(/\.(raw|json)$/, '')));
  if (mismatches.length || orphans.length) {
    for (const m of mismatches) log(`HASH MISMATCH ${m.stem}: recorded ${m.recorded}, file ${m.actual}`);
    for (const o of orphans) log(`WITHOUT ITS PAIR ${o}`);
    throw new Error(`${mismatches.length} recording(s) do not hash to their record, ${orphans.length} lack their pair -- nothing written`);
  }

  const gaps = hours.filter((h) => !present.includes(h));
  for (const h of gaps) {
    const reason = verified.missing.find((m) => m.cellId === cell && m.hour === h)?.reason;
    log(`MISSING HOUR ${cell} ${h}${reason ? ` -- ${reason}` : ''}`);
  }
  if (gaps.length && !allowGaps) {
    throw new Error(`${gaps.length} hour(s) in the range have no recording -- nothing written; pass --allow-gaps to replay the rest`);
  }

  // Every recording is parsed before the first is stored, so one that the
  // oracle would refuse stops the whole replay with nothing written.
  const prepared = [];
  for (const h of present) {
    const stem = fileStem(cell, h);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${stem}.json`), 'utf8'));
    const body = fs.readFileSync(path.join(dir, `${stem}.raw`));
    if (meta.cellId !== cell) throw new Error(`${stem}.json names cell ${meta.cellId}, not ${cell} -- nothing written`);
    const reading = readingFromResponse(cell, {
      requestUrl: meta.requestUrl,
      requestParams: meta.requestParams,
      httpStatus: meta.httpStatus,
      body,
      fetchedAt: meta.fetchedAt,
    });
    // The bytes stored are the bytes verified above, and the hour they say is
    // the hour they are filed under.
    if (reading.raw.sha256 !== meta.sha256) throw new Error(`${stem}.raw changed after it was verified -- nothing written`);
    if (Date.parse(reading.measuredAt) !== Date.parse(h)) {
      throw new Error(`${stem}.raw has timeseries[0].time ${reading.measuredAt}, not ${h} -- nothing written`);
    }
    reading.source = `${reading.source} REPLAY(recorded ${meta.fetchedAt})`;
    prepared.push({ hour: h, reading });
  }

  const { rows: existing } = await pool.query(
    `SELECT measured_at FROM oracle_readings
      WHERE policy_id = $1 AND coverage_code = $2 AND cell_id = $3 AND measured_at = ANY($4::timestamptz[])`,
    [policyId, coverageCode, cell, present]
  );
  const already = new Set(existing.map((r) => new Date(r.measured_at).getTime()));

  // --- writes ---------------------------------------------------------------

  const { rows: windowsBefore } = await pool.query('SELECT id FROM trigger_windows WHERE policy_id = $1', [policyId]);
  const before = new Set(windowsBefore.map((w) => w.id));

  let written = 0;
  let skipped = 0;
  for (const { hour, reading } of prepared) {
    if (already.has(Date.parse(hour))) {
      log(`skipped ${hour}: policy ${policyId} already has a reading for ${coverageCode} ${cell} measured then`);
      skipped += 1;
      continue;
    }
    await storeReading(policyId, coverageCode, cell, reading);
    log(`stored  ${hour}: ${reading.metric} ${reading.value}, fetched ${reading.raw.fetchedAt}, sha256 ${reading.raw.sha256}`);
    written += 1;
  }

  await queueClosedWindows({ insurerIds: [policy.insurer_id] });

  const { rows: windows } = await pool.query(
    `SELECT tw.id, tw.cell_id, tw.coverage_code, tw.window_start, tw.window_end, tw.aggregation,
            tw.aggregated_value, cardinality(tw.reading_ids) AS readings, pe.id AS trigger_id, pe.status AS trigger_status
       FROM trigger_windows tw
       LEFT JOIN policy_events pe ON pe.trigger_window_id = tw.id AND pe.event_type = 'trigger'
      WHERE tw.policy_id = $1
      ORDER BY tw.window_start`,
    [policyId]
  );
  const closed = windows.filter((w) => !before.has(w.id));
  for (const w of closed) {
    log(
      `window ${new Date(w.window_start).toISOString()}..${new Date(w.window_end).toISOString()} ` +
        `${w.coverage_code} ${w.cell_id}: ${w.aggregation} of ${w.readings} reading(s) = ${w.aggregated_value}; ` +
        (w.trigger_id ? `trigger ${w.trigger_id} queued (${w.trigger_status})` : 'no trigger row')
    );
  }
  const queued = closed.filter((w) => w.trigger_id).length;
  log(
    `${written} reading(s) written, ${skipped} skipped as already present; ${closed.length} window(s) closed ` +
      `for policy ${policyId} since this replay began, ${queued} trigger(s) queued`
  );
  log('the running dispatcher takes a queued trigger from here; see /debug/story (DEBUG_ROUTES_ENABLED=true)');
  return { written, skipped, gaps, windowsClosed: closed.length, triggersQueued: queued };
}

function parseArgs(argv) {
  const args = {};
  const keys = { '--dir': 'dir', '--cell': 'cell', '--from': 'from', '--to': 'to', '--policy': 'policyId', '--coverage': 'coverageCode' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-gaps') args.allowGaps = true;
    else if (keys[a]) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`);
      args[keys[a]] = argv[++i];
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await replay(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`[replay] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
