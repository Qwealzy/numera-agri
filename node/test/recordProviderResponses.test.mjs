// The provider recorder's file handling, with no network, no database and no
// config: how a recording is named, that one is never overwritten, and that
// --verify catches a single changed byte and a missing hour. The request
// itself is not tested here; it is the same request fetchExternalReading
// makes, and a real one is only ever made by running the script.
// The last tests run the script in child processes with a configuration it refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  fileStem,
  writeRecording,
  writeMissed,
  verifyDir,
  sha256,
} from '../../scripts/recordProviderResponses.mjs';

const CELL = 'metno:41.1111,42.7022';

// Each test removes its own directory once it ends, pass or fail.
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recording(time, text) {
  const body = Buffer.from(text, 'utf8');
  return {
    cellId: CELL,
    body,
    meta: { cellId: CELL, sha256: sha256(body), timeseriesTime: time },
  };
}

test('a recording is named by its cell and the provider timeseries time, with nothing Windows refuses', () => {
  const stem = fileStem(CELL, '2026-09-19T21:00:00Z');
  assert.equal(stem, 'metno_41.1111_42.7022__2026-09-19T21-00-00Z');
  assert.doesNotMatch(stem, /[:,<>"/\\|?*]/);
  assert.throws(() => fileStem(CELL, 'not a time'), /not an instant/);
});

test('the raw bytes are written exactly as given, next to their record', (t) => {
  const dir = tmpDir(t);
  const r = recording('2026-09-19T21:00:00Z', '{"a": 1,  "b":2}');
  const { written, stem } = writeRecording(dir, r);
  assert.equal(written, true);
  assert.deepEqual(fs.readFileSync(path.join(dir, `${stem}.raw`)), r.body);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${stem}.json`), 'utf8')).sha256, r.meta.sha256);
});

test('a second response for the same cell and hour does not overwrite the first', (t) => {
  const dir = tmpDir(t);
  const first = recording('2026-09-19T21:00:00Z', 'first');
  const second = recording('2026-09-19T21:00:00Z', 'second');
  writeRecording(dir, first);
  const { written, stem } = writeRecording(dir, second);
  assert.equal(written, false);
  assert.equal(fs.readFileSync(path.join(dir, `${stem}.raw`), 'utf8'), 'first');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${stem}.json`), 'utf8')).sha256, first.meta.sha256);
});

test('--verify passes intact recordings and catches one changed byte', (t) => {
  const dir = tmpDir(t);
  writeRecording(dir, recording('2026-09-19T21:00:00Z', 'hour one'));
  const { stem } = writeRecording(dir, recording('2026-09-19T22:00:00Z', 'hour two'));
  assert.equal(verifyDir(dir).ok, true);

  const rawPath = path.join(dir, `${stem}.raw`);
  const bytes = fs.readFileSync(rawPath);
  bytes[0] ^= 0x01;
  fs.writeFileSync(rawPath, bytes);

  const r = verifyDir(dir);
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches.map((m) => m.stem), [stem]);
});

test('--verify lists a missing hour, with the reason its marker gives', (t) => {
  const dir = tmpDir(t);
  writeRecording(dir, recording('2026-09-19T21:00:00Z', 'a'));
  writeRecording(dir, recording('2026-09-20T00:00:00Z', 'd'));
  writeMissed(dir, { cellId: CELL, hour: '2026-09-19T22:00:00Z', reason: 'request failed: test', attemptedAt: 'x' });
  const r = verifyDir(dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, [
    { cellId: CELL, hour: '2026-09-19T22:00:00Z', reason: 'request failed: test' },
    { cellId: CELL, hour: '2026-09-19T23:00:00Z', reason: null },
  ]);
});

// The script itself, in a child process, with a configuration it must refuse
// before any request and before writing anything. The URLs point at port 1 on
// loopback, so nothing here could reach a real database or ledger.
const SCRIPT = fileURLToPath(new URL('../../scripts/recordProviderResponses.mjs', import.meta.url));

function runRefused(t, climateApiUrl, userAgent) {
  const cwd = tmpDir(t);
  const out = path.join(cwd, 'out');
  const r = spawnSync(process.execPath, [SCRIPT, '--once', '--out', out, CELL], {
    cwd,
    timeout: 20000,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      DAML_JSON_API_URL: 'http://127.0.0.1:1',
      DAML_PACKAGE_ID: 'placeholder-package-id',
      CLIMATE_API_URL: climateApiUrl,
      CLIMATE_API_USER_AGENT: userAgent,
    },
  });
  assert.equal(r.status, 1, `exit status ${r.status}, stderr: ${r.stderr}`);
  assert.equal(fs.existsSync(out), false);
  return r.stderr;
}

test('the recorder refuses a placeholder CLIMATE_API_URL at start, before any request or write', (t) => {
  assert.match(runRefused(t, '...', 'recorder-test'), /CLIMATE_API_URL/);
});

test('the recorder refuses a CLIMATE_API_URL that is not http or https at start', (t) => {
  assert.match(runRefused(t, 'api.met.no:443', 'recorder-test'), /CLIMATE_API_URL/);
});

test('the recorder refuses an empty CLIMATE_API_USER_AGENT at start', (t) => {
  assert.match(runRefused(t, 'http://127.0.0.1:9', ''), /CLIMATE_API_USER_AGENT/);
});
