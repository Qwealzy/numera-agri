// Recorder for the weather provider's responses, hour by hour, to disk.
//
// Why it exists: the demo will replay REAL provider responses through the
// real pipeline, and the oracle reads only timeseries[0] -- the current hour
// -- on every call (node/src/oracle/oracleBot.js, fetchExternalReading). One
// night therefore needs one recorded response per hour, and a sub-zero night
// cannot be ordered in advance, so recording has to run on real nights.
//
// What it does: once per hour, shortly after the hour, it makes ONE request
// per cell to the same endpoint, with the same parameters and the same
// User-Agent as fetchExternalReading, and writes the body bytes exactly as
// received (<stem>.raw) next to a record of the request that produced them
// (<stem>.json). The bytes are the evidence; the temperature in the .json is
// only there to be read by a person.
//
// What it does not touch: the database, the ledger, .env, and every file
// outside the output directory. It schedules nothing outside its own
// process; stopping the process (Ctrl+C) stops the recording.
//
// Run it from node/, where config.js finds .env (it needs CLIMATE_API_URL and
// CLIMATE_API_USER_AGENT, and config.js itself refuses to load without its
// required keys). Cells are in the oracle's own "metno:<lat>,<lon>" format;
// there is no default cell.
//
//   node ../scripts/recordProviderResponses.mjs --out ../recordings <cell> [<cell> ...]
//   node ../scripts/recordProviderResponses.mjs --once --out ../recordings <cell> [...]
//   node ../scripts/recordProviderResponses.mjs --forecast --timezone <IANA> --start-hour <0-23> <cell> [...]
//   node ../scripts/recordProviderResponses.mjs --verify ../recordings
//
// --forecast writes nothing: one request per cell, and the minimum
// air_temperature in each window of the given rule (the event window's own
// windowFor), printed and not interpreted. --verify re-hashes every .raw
// against its .json and lists the hours that are missing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Files. A recording is named by its cell and by the provider's own
// timeseries[0].time, never by the local clock, and is never overwritten.
// ---------------------------------------------------------------------------

// "metno:41.1111,42.7022" + "2026-09-19T21:00:00Z"
//   -> "metno_41.1111_42.7022__2026-09-19T21-00-00Z"
// ':' is not allowed in a Windows file name, so it becomes '-' in the time
// and '_' in the cell.
export function fileStem(cellId, timeseriesTime) {
  if (Number.isNaN(Date.parse(timeseriesTime))) {
    throw new Error(`timeseries time ${JSON.stringify(timeseriesTime)} is not an instant`);
  }
  return `${cellId.replace(/[:,]/g, '_')}__${timeseriesTime.replace(/:/g, '-')}`;
}

// Writes <stem>.raw (the bytes as received) and then <stem>.json. 'wx' makes
// the no-overwrite rule the file system's, not a check-then-write race.
export function writeRecording(dir, { cellId, body, meta }) {
  const stem = fileStem(cellId, meta.timeseriesTime);
  const rawPath = path.join(dir, `${stem}.raw`);
  if (fs.existsSync(rawPath)) {
    return { written: false, stem };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(rawPath, body, { flag: 'wx' });
  fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' });
  return { written: true, stem };
}

// An hour with no recording, and why. Named by the hour it was due for.
export function writeMissed(dir, { cellId, hour, reason, attemptedAt }) {
  const stem = fileStem(cellId, hour);
  const missedPath = path.join(dir, `${stem}.missed.json`);
  if (fs.existsSync(missedPath) || fs.existsSync(path.join(dir, `${stem}.raw`))) {
    return { written: false, stem };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(missedPath, JSON.stringify({ cellId, hour, reason, attemptedAt }, null, 2) + '\n', { flag: 'wx' });
  return { written: true, stem };
}

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Every .raw against its .json, and the hours between each cell's first and
// last recording that have no .raw. ok is false on any hash mismatch or any
// half of a pair without the other; a missing hour is listed, not failed.
export function verifyDir(dir) {
  const names = fs.readdirSync(dir);
  const mismatches = [];
  const orphans = [];
  const byCell = new Map();
  const missedReasons = new Map();

  for (const name of names) {
    if (name.endsWith('.missed.json')) {
      const m = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      missedReasons.set(name.slice(0, -'.missed.json'.length), m.reason);
    }
  }
  for (const name of names) {
    let stem;
    if (name.endsWith('.raw')) stem = name.slice(0, -'.raw'.length);
    else if (name.endsWith('.json') && !name.endsWith('.missed.json')) stem = name.slice(0, -'.json'.length);
    else continue;
    const rawPath = path.join(dir, `${stem}.raw`);
    const metaPath = path.join(dir, `${stem}.json`);
    if (!fs.existsSync(rawPath) || !fs.existsSync(metaPath)) {
      orphans.push(name);
      continue;
    }
    if (!name.endsWith('.raw')) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const actual = sha256(fs.readFileSync(rawPath));
    if (actual !== meta.sha256) mismatches.push({ stem, recorded: meta.sha256, actual });
    const cell = meta.cellId;
    if (!byCell.has(cell)) byCell.set(cell, new Set());
    byCell.get(cell).add(Date.parse(meta.timeseriesTime));
  }

  const missing = [];
  let checked = 0;
  for (const [cell, times] of byCell) {
    checked += times.size;
    const sorted = [...times].sort((a, b) => a - b);
    for (let t = sorted[0] + HOUR_MS; t < sorted[sorted.length - 1]; t += HOUR_MS) {
      if (times.has(t)) continue;
      const hour = new Date(t).toISOString().replace('.000Z', 'Z');
      missing.push({ cellId: cell, hour, reason: missedReasons.get(fileStem(cell, hour)) ?? null });
    }
  }
  // A missed hour before a cell's first recording or after its last one is
  // outside the range above; its marker still says it is missing.
  for (const [stem, reason] of missedReasons) {
    if (fs.existsSync(path.join(dir, `${stem}.raw`))) continue;
    const m = JSON.parse(fs.readFileSync(path.join(dir, `${stem}.missed.json`), 'utf8'));
    if (!missing.some((x) => x.cellId === m.cellId && x.hour === m.hour)) {
      missing.push({ cellId: m.cellId, hour: m.hour, reason });
    }
  }
  return { ok: mismatches.length === 0 && orphans.length === 0, checked, mismatches, orphans, missing };
}

// ---------------------------------------------------------------------------
// The request. Everything that talks to the network or reads config is
// imported lazily, so the functions above load with nothing configured.
// ---------------------------------------------------------------------------

async function loadProvider() {
  const { config } = await import(pathToFileURL(path.join(ROOT, 'node', 'src', 'config.js')).href);
  const { parseStandInCellId } = await import(
    pathToFileURL(path.join(ROOT, 'node', 'src', 'oracle', 'oracleBot.js')).href
  );
  const axios = createRequire(path.join(ROOT, 'node', 'package.json'))('axios');
  if (!config.oracle.climateApiUrl) {
    throw new Error('CLIMATE_API_URL not configured -- there is no default');
  }
  let climateApiProtocol;
  try {
    climateApiProtocol = new URL(config.oracle.climateApiUrl).protocol;
  } catch {
    climateApiProtocol = null;
  }
  if (climateApiProtocol !== 'http:' && climateApiProtocol !== 'https:') {
    throw new Error(
      `CLIMATE_API_URL ${JSON.stringify(config.oracle.climateApiUrl)} is not an http or https URL -- every round would fail`
    );
  }
  if (!config.oracle.climateApiUserAgent) {
    throw new Error('CLIMATE_API_USER_AGENT not configured -- MET Norway requires one and there is no default');
  }
  return { config, parseStandInCellId, axios };
}

// The same request fetchExternalReading makes. ifModifiedSince, when given,
// is the previous response's own Last-Modified, as the provider asks.
async function request({ config, parseStandInCellId, axios }, cellId, ifModifiedSince) {
  const { lat, lon } = parseStandInCellId(cellId);
  const requestUrl = `${config.oracle.climateApiUrl}/weatherapi/locationforecast/2.0/compact`;
  const requestParams = { lat, lon };
  const headers = { 'User-Agent': config.oracle.climateApiUserAgent };
  if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince;
  const response = await axios.get(requestUrl, {
    params: requestParams,
    headers,
    timeout: 10000,
    responseType: 'arraybuffer',
    validateStatus: (s) => (s >= 200 && s < 300) || s === 304,
  });
  return {
    requestUrl,
    requestParams,
    fetchedAt: new Date().toISOString(),
    status: response.status,
    body: Buffer.from(response.data ?? []),
    expires: response.headers['expires'] ?? null,
    lastModified: response.headers['last-modified'] ?? null,
  };
}

function parseBody(body, cellId) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error(`response for cell ${cellId} is not JSON`);
  }
}

// ---------------------------------------------------------------------------
// Recording loop.
// ---------------------------------------------------------------------------

function topOfHour(ms) {
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().replace('.000Z', 'Z');
}

// Per cell: the provider's last Expires and Last-Modified, for the rule
// "don't repeat requests until the time indicated in the Expires header".
const cacheState = new Map();

async function recordCell(provider, dir, cellId, hour) {
  const log = (msg) => console.log(`[recorder] ${new Date().toISOString()} ${cellId} ${msg}`);
  const missed = (reason) => {
    console.error(`[recorder] ${new Date().toISOString()} ${cellId} hour ${hour} MISSED: ${reason}`);
    writeMissed(dir, { cellId, hour, reason, attemptedAt: new Date().toISOString() });
  };
  const state = cacheState.get(cellId) ?? {};

  // Expires not reached yet: wait for it if it falls inside this hour, and
  // otherwise make no request and record the hour as missed.
  const expiresAt = state.expires ? Date.parse(state.expires) : NaN;
  if (!Number.isNaN(expiresAt) && Date.now() < expiresAt) {
    if (expiresAt >= Date.parse(hour) + HOUR_MS) {
      return missed(`not requested: provider's Expires ${state.expires} is after this hour`);
    }
    log(`waiting for provider's Expires ${state.expires}`);
    await new Promise((r) => setTimeout(r, expiresAt - Date.now() + 1000));
  }

  let res;
  try {
    res = await request(provider, cellId, state.lastModified);
  } catch (err) {
    return missed(`request failed: ${err.message}`);
  }
  cacheState.set(cellId, { expires: res.expires, lastModified: res.lastModified ?? state.lastModified });

  if (res.status === 304) {
    return missed(
      `304 Not Modified since ${state.lastModified}: the bytes last recorded for this cell are still the provider's answer`
    );
  }
  if (res.status !== 200) log(`provider answered HTTP ${res.status} (recorded as received)`);

  let data;
  try {
    data = parseBody(res.body, cellId);
  } catch (err) {
    return missed(`${err.message} (HTTP ${res.status}, ${res.body.length} bytes, not kept)`);
  }
  const entry = data?.properties?.timeseries?.[0];
  if (typeof entry?.time !== 'string' || Number.isNaN(Date.parse(entry.time))) {
    return missed(`timeseries[0].time missing or unparseable (HTTP ${res.status}, not kept)`);
  }

  const meta = {
    cellId,
    requestUrl: res.requestUrl,
    requestParams: res.requestParams,
    httpStatus: res.status,
    sha256: sha256(res.body),
    bytes: res.body.length,
    fetchedAt: res.fetchedAt,
    providerUpdatedAt: data?.properties?.meta?.updated_at ?? null,
    timeseriesTime: entry.time,
    // For a person reading the file only; the evidence is the .raw bytes.
    airTemperature: entry?.data?.instant?.details?.air_temperature ?? null,
    airTemperatureUnit: data?.properties?.meta?.units?.air_temperature ?? null,
    responseHeaders: { expires: res.expires, lastModified: res.lastModified },
  };
  const { written, stem } = writeRecording(dir, { cellId, body: res.body, meta });
  if (written) {
    log(`recorded ${stem} (timeseries[0] ${entry.time}, air_temperature ${meta.airTemperature})`);
  } else {
    log(`NOT overwritten: ${stem}.raw already exists (timeseries[0] ${entry.time}); this response discarded`);
  }
  if (entry.time !== hour) log(`note: timeseries[0] is ${entry.time}, the round was for ${hour}`);
}

async function recordRound(provider, dir, cells) {
  const hour = topOfHour(Date.now());
  for (const cellId of cells) {
    try {
      await recordCell(provider, dir, cellId, hour);
    } catch (err) {
      // A failure to write the recording itself: logged, and the process lives.
      console.error(`[recorder] ${new Date().toISOString()} ${cellId} hour ${hour} FAILED: ${err.message}`);
    }
  }
}

// Shortly after the next hour, plus a random minute or so: the provider asks
// callers not to schedule requests all at the same moment.
function msUntilNextRound() {
  const next = (Math.floor(Date.now() / HOUR_MS) + 1) * HOUR_MS;
  return next - Date.now() + 60_000 + Math.floor(Math.random() * 4 * 60_000);
}

async function record(dir, cells, { once }) {
  const provider = await loadProvider();
  for (const c of cells) provider.parseStandInCellId(c);
  console.log(`[recorder] ${cells.length} cell(s) -> ${path.resolve(dir)}${once ? ' (one round)' : ''}`);
  await recordRound(provider, dir, cells);
  if (once) return;
  const loop = () => {
    const wait = msUntilNextRound();
    console.log(`[recorder] next round at ${new Date(Date.now() + wait).toISOString()}`);
    setTimeout(() => recordRound(provider, dir, cells).finally(loop), wait);
  };
  loop();
  process.on('SIGINT', () => {
    console.log('[recorder] stopped');
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// --forecast: the minimum air_temperature per window, printed, not judged.
// ---------------------------------------------------------------------------

async function forecast(cells, rule) {
  const provider = await loadProvider();
  const { windowFor } = await import(pathToFileURL(path.join(ROOT, 'node', 'src', 'oracle', 'eventWindow.js')).href);
  for (const c of cells) provider.parseStandInCellId(c);
  console.log(`window rule: timezone ${rule.timezone}, start hour ${rule.startHour}`);
  console.log(['cell', 'window start (UTC)', 'window end (UTC)', 'min air_temperature', 'at (UTC)', 'entries'].join('\t'));
  for (const cellId of cells) {
    let res;
    try {
      res = await request(provider, cellId, null);
    } catch (err) {
      console.error(`${cellId}\trequest failed: ${err.message}`);
      continue;
    }
    const data = parseBody(res.body, cellId);
    const unit = data?.properties?.meta?.units?.air_temperature;
    const windows = new Map();
    for (const e of data?.properties?.timeseries ?? []) {
      const v = e?.data?.instant?.details?.air_temperature;
      if (typeof v !== 'number') continue;
      const w = windowFor(e.time, rule);
      const key = w.start.toISOString();
      const cur = windows.get(key) ?? { w, min: Infinity, at: null, n: 0 };
      cur.n += 1;
      if (v < cur.min) Object.assign(cur, { min: v, at: e.time });
      windows.set(key, cur);
    }
    for (const { w, min, at, n } of windows.values()) {
      console.log([cellId, w.start.toISOString(), w.end.toISOString(), `${min} ${unit}`, at, n].join('\t'));
    }
  }
  console.log('(forecast model output, not observations; entries = timeseries steps in the window, which thin out further ahead)');
}

// ---------------------------------------------------------------------------
// Command line.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { cells: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--verify') args.verify = argv[++i];
    else if (a === '--forecast') args.forecast = true;
    else if (a === '--once') args.once = true;
    else if (a === '--timezone') args.timezone = argv[++i];
    else if (a === '--start-hour') args.startHour = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else args.cells.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.verify) {
    const r = verifyDir(args.verify);
    console.log(`checked ${r.checked} recording(s) in ${path.resolve(args.verify)}`);
    for (const m of r.mismatches) console.log(`HASH MISMATCH ${m.stem}: recorded ${m.recorded}, file ${m.actual}`);
    for (const o of r.orphans) console.log(`WITHOUT ITS PAIR ${o}`);
    for (const m of r.missing) console.log(`MISSING HOUR ${m.cellId} ${m.hour}${m.reason ? ` -- ${m.reason}` : ''}`);
    console.log(`${r.mismatches.length} mismatch(es), ${r.orphans.length} orphan(s), ${r.missing.length} missing hour(s)`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (args.cells.length === 0) throw new Error('no cells given -- there is no default cell');
  if (args.forecast) {
    if (!args.timezone || args.startHour === undefined) {
      throw new Error('--forecast needs --timezone and --start-hour -- there is no default window rule');
    }
    const startHour = Number(args.startHour);
    if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
      throw new Error(`--start-hour ${JSON.stringify(args.startHour)} is not an integer 0-23`);
    }
    await forecast(args.cells, { timezone: args.timezone, startHour });
    return;
  }
  if (!args.out) throw new Error('--out <dir> is required -- there is no default output directory');
  await record(args.out, args.cells, { once: Boolean(args.once) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[recorder] ${err.message}`);
    process.exit(1);
  });
}
