import '../test-support/setup-test-db.mjs'; // must stay first: guards the database before src/db.js builds its pool
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// src/scripts/onboardInsurer.js allocates two parties and only then writes the
// insurers row, so an input that row refuses has to be refused before the
// first ledger call, or it costs two parties and two user rights.
//
// Run the way an operator runs it, in a process of its own. Both ledger
// endpoints are a stub on a loopback port that records every request and
// refuses each one, so nothing is allocated anywhere, and the token is a
// stand-in, so no real one is minted or printed. The child inherits the
// DATABASE_URL this file's guard set, the test database; no run here reaches
// the INSERT.

const ONBOARD = fileURLToPath(new URL('../src/scripts/onboardInsurer.js', import.meta.url));
const NODE_DIR = fileURLToPath(new URL('..', import.meta.url));
const NAME = 'Test Insurer Ltd (onboard fixture, fake)';

const received = [];
let ledger;
let ledgerUrl;

before(async () => {
  ledger = http.createServer((req, res) => {
    received.push(req.url);
    req.resume();
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 'STUB_LEDGER', cause: 'onboardInsurer.test.mjs refuses every request' }));
  });
  await new Promise((r) => ledger.listen(0, '127.0.0.1', r));
  ledgerUrl = `http://127.0.0.1:${ledger.address().port}`;
});

after(() => ledger.close());

function onboard(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ONBOARD, ...args], {
      cwd: NODE_DIR,
      env: {
        ...process.env,
        DAML_JSON_API_URL: ledgerUrl,
        DAML_JSON_API_URL_ORACLE: ledgerUrl,
        DAML_LEDGER_TOKEN: 'stub-token',
      },
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

test('a blank legal name or a commission outside 0..10000 whole basis points is refused before any ledger call', async () => {
  const refused = [
    [[], /usage/],
    [[''], /usage/],
    [['   '], /usage/],
    [[NAME, 'abc'], /commissionBps must be a whole number of basis points from 0 to 10000/],
    [[NAME, ''], /commissionBps must be/],
    [[NAME, '-1'], /commissionBps must be/],
    [[NAME, '12.5'], /commissionBps must be/],
    [[NAME, '10001'], /commissionBps must be/],
  ];
  for (const [args, message] of refused) {
    const before = received.length;
    const { status, stderr } = await onboard(args);
    assert.equal(status, 1, `${JSON.stringify(args)}: ${stderr}`);
    assert.match(stderr, message, JSON.stringify(args));
    assert.deepEqual(received.slice(before), [], `${JSON.stringify(args)} reached the ledger`);
  }
});

// Not vacuous: an accepted input does reach the stub, whose refusal of the
// first allocation stops the script before the second and before the INSERT.
test('commission 0 (the default), 0 and 10000 go on to the first party allocation', async () => {
  for (const args of [[NAME], [NAME, '0'], [NAME, '10000']]) {
    const before = received.length;
    const { status } = await onboard(args);
    assert.equal(status, 1, JSON.stringify(args));
    assert.deepEqual(received.slice(before), ['/v2/parties'], JSON.stringify(args));
  }
});
