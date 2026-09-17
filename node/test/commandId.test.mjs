// The command id is what the ledger deduplicates on, so how it is built is a
// correctness property, not a formatting detail. Before this test existed the
// generator used a module-level counter starting at 0 in every process, and
// two dispatchers in lockstep produced the same id in the same millisecond --
// the participant then rejected one submission with 409
// SUBMISSION_ALREADY_IN_FLIGHT and the outbox row failed. Measured in
// the project's own measurements: every parallel run lost events, no single-worker run
// did.
//
// Needs no database and no LocalNet. The wiring half runs against a stub
// ledger on a loopback port, so it checks what actually goes onto the wire
// rather than only what the generator returns.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let commandIdFor;
let createContract;
let exerciseChoice;
let server;
let received;

before(async () => {
  received = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      received.push(parsed);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          transaction: {
            commandId: parsed.commands.commandId,
            events: [{ CreatedEvent: { contractId: 'stub-cid', templateId: 'stub:Mod:Thing' } }],
          },
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Set before src/config.js is loaded: dotenv does not override a variable
  // that is already present, so the dynamic import below picks these up.
  process.env.DAML_JSON_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.DAML_LEDGER_TOKEN = 'stub-token';
  ({ commandIdFor, createContract, exerciseChoice } = await import('../src/damlClient.js'));
});

after(() => new Promise((resolve) => server.close(resolve)));

test('the same event id always produces the same command id', () => {
  const a = commandIdFor('exercise', 'a3f1c2d4-0000-4000-8000-000000000001');
  const b = commandIdFor('exercise', 'a3f1c2d4-0000-4000-8000-000000000001');
  assert.equal(a, b);
});

test('different event ids produce different command ids', () => {
  const a = commandIdFor('exercise', 'a3f1c2d4-0000-4000-8000-000000000001');
  const b = commandIdFor('exercise', 'a3f1c2d4-0000-4000-8000-000000000002');
  assert.notEqual(a, b);
});

test('the command id carries the seed, so two processes cannot collide on it', () => {
  const seed = 'a3f1c2d4-0000-4000-8000-00000000000f';
  assert.ok(
    commandIdFor('create', seed).includes(seed),
    'the seed has to be part of the id -- that is what makes it unique across processes'
  );
});

// The regression the old generator could not pass. A per-process counter and
// a millisecond clock are the two things that made two processes collide:
// neither may decide the id on its own any more.
test('neither a call counter nor the clock decides the id on its own', async () => {
  const seed = 'a3f1c2d4-0000-4000-8000-0000000000ff';
  const first = commandIdFor('exercise', seed);
  // Many calls in between: a counter-based id would have moved on.
  for (let i = 0; i < 50; i += 1) commandIdFor('exercise', `filler-${i}`);
  assert.equal(commandIdFor('exercise', seed), first, 'a call counter must not affect the id');

  // A different millisecond: a clock-based id would have changed.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(commandIdFor('exercise', seed), first, 'the clock must not affect the id');
});

test('two ids generated with no seed still differ', () => {
  assert.notEqual(commandIdFor('create'), commandIdFor('create'));
});

test('createContract puts the seed on the wire', async () => {
  received.length = 0;
  await createContract({
    moduleName: 'Mod',
    entityName: 'Thing',
    payload: {},
    actAs: ['party-a'],
    commandSeed: 'event-1111',
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].commands.commandId, 'create-event-1111');
});

test('exerciseChoice puts the seed on the wire', async () => {
  received.length = 0;
  await exerciseChoice({
    moduleName: 'Mod',
    entityName: 'Thing',
    contractId: 'cid-1',
    choice: 'DoIt',
    argument: {},
    actAs: ['party-a'],
    commandSeed: 'event-2222',
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].commands.commandId, 'exercise-event-2222');
});

test('a caller with no outbox row behind it still gets a unique id', async () => {
  received.length = 0;
  await exerciseChoice({
    moduleName: 'Mod',
    entityName: 'Thing',
    contractId: 'cid-1',
    choice: 'DoIt',
    argument: {},
    actAs: ['party-a'],
  });
  await exerciseChoice({
    moduleName: 'Mod',
    entityName: 'Thing',
    contractId: 'cid-2',
    choice: 'DoIt',
    argument: {},
    actAs: ['party-a'],
  });
  assert.equal(received.length, 2);
  assert.notEqual(received[0].commands.commandId, received[1].commands.commandId);
});
