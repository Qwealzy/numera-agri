// Where an oracle submission goes, and the two retries of a trigger this system has.
//
// Two participants are a configuration, not a rewrite: with
// DAML_JSON_API_URL_ORACLE empty every call goes where it always went, and
// with it set the oracle's submissions -- and only those -- go to the second
// participant. Both halves are checked here, in one process, because the two
// behaviours have to be compared against each other and the difference
// between them is one config value.
//
// Nothing here needs LocalNet or a database. The wire half runs against two
// stub ledgers on two loopback ports, the same pattern commandId.test.mjs
// uses, so what is checked is what actually goes onto the wire and to WHICH
// port -- not only what a function returns. The stub can be told to refuse a
// submission with 404 CONTRACT_NOT_FOUND, which is the race
// a two-participant measurement script kept outside this repository measured against a real second
// participant and could only measure intermittently there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let config;
let exerciseChoice;
let insurerEndpoint;
let oracleEndpoint;
let oracleIsOnItsOwnParticipant;
let exerciseTriggerWithVisibilityRetry;
let exerciseTriggerWithUnendedRetry;
let startDispatcher;

let insurerNode;
let oracleNode;

// Per stub: every submission body it received, and how many of the next ones
// it must refuse -- with CONTRACT_NOT_FOUND, or with `refuseWith` when that is
// set -- before answering normally.
function stub() {
  const state = { received: [], refuseNext: 0, refuseWith: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      state.received.push(parsed);
      res.setHeader('content-type', 'application/json');
      if (state.refuseNext > 0) {
        state.refuseNext -= 1;
        // The shape a Canton participant answers with, which damlClient.js's
        // interceptor reads: the code is in `code` and the sentence in `cause`.
        const { status, body: refusalBody } = state.refuseWith ?? {
          status: 404,
          body: { code: 'CONTRACT_NOT_FOUND', cause: 'Contract could not be found with id ...' },
        };
        res.statusCode = status;
        res.end(JSON.stringify(refusalBody));
        return;
      }
      res.end(
        JSON.stringify({
          transaction: {
            commandId: parsed.commands?.commandId,
            events: [{ CreatedEvent: { contractId: 'stub-cid', templateId: 'stub:Mod:Thing' } }],
          },
        })
      );
    });
  });
  return { state, server, url: () => `http://127.0.0.1:${server.address().port}` };
}

before(async () => {
  insurerNode = stub();
  oracleNode = stub();
  await new Promise((r) => insurerNode.server.listen(0, '127.0.0.1', r));
  await new Promise((r) => oracleNode.server.listen(0, '127.0.0.1', r));
  // Set before src/config.js is loaded: dotenv does not override a variable
  // that is already present.
  process.env.DAML_JSON_API_URL = insurerNode.url();
  process.env.DAML_LEDGER_TOKEN = 'stub-token';
  // Deliberately NOT set here. The single-participant cases below run with it
  // unset, which is what a deployment has today, and the two-participant cases
  // set config.daml.jsonApiUrlOracle themselves -- see withOracleNode.
  process.env.DAML_JSON_API_URL_ORACLE = '';
  ({ config } = await import('../src/config.js'));
  ({ exerciseChoice, insurerEndpoint, oracleEndpoint, oracleIsOnItsOwnParticipant } = await import(
    '../src/damlClient.js'
  ));
  ({ exerciseTriggerWithVisibilityRetry, exerciseTriggerWithUnendedRetry, startDispatcher } = await import(
    '../src/dispatch/dispatcher.js'
  ));
});

after(async () => {
  await new Promise((r) => insurerNode.server.close(r));
  await new Promise((r) => oracleNode.server.close(r));
});

// The env key is read once, at config load, so a test that needs the second
// participant sets the value config.js would have put there and puts it back
// afterwards. Nothing else in the process reads it.
async function withOracleNode(fn) {
  const before_ = config.daml.jsonApiUrlOracle;
  config.daml.jsonApiUrlOracle = oracleNode.url();
  try {
    return await fn();
  } finally {
    config.daml.jsonApiUrlOracle = before_;
  }
}

// A refusal shaped the way damlClient.js's response interceptor leaves one:
// the structured body on err.response, and the code and cause folded into the
// message, which is the text that ends up in the failed outbox row.
const refusal = (status, code, cause) => {
  const err = new Error(`Request failed with status code ${status} -- ${code}: ${cause}`);
  err.response = { status, data: { code, cause } };
  return err;
};
const notFound = () => refusal(404, 'CONTRACT_NOT_FOUND', 'Contract could not be found');

// --- the key unset: nothing about today's behaviour moves -------------------

test('with the key unset the oracle shares the insurer\'s participant', () => {
  assert.equal(config.daml.jsonApiUrlOracle, undefined);
  assert.equal(oracleEndpoint(), insurerEndpoint());
  assert.equal(oracleIsOnItsOwnParticipant(), false);
});

test('with the key unset an oracle submission still goes to the one participant', async () => {
  insurerNode.state.received.length = 0;
  oracleNode.state.received.length = 0;
  await exerciseChoice({
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: 'cid-1',
    choice: 'PolicyToken_EvaluateTrigger',
    argument: {},
    actAs: ['oracle-party'],
    endpoint: oracleEndpoint(),
    commandSeed: 'event-single-node',
  });
  assert.equal(insurerNode.state.received.length, 1, 'it went to the insurer participant, as it always has');
  assert.equal(oracleNode.state.received.length, 0, 'and nowhere else');
});

test('with the key unset a CONTRACT_NOT_FOUND is NOT retried: it fails at once, as it always has', async () => {
  let calls = 0;
  await assert.rejects(
    exerciseTriggerWithVisibilityRetry({
      submit: async () => {
        calls += 1;
        throw notFound();
      },
      submittedContractId: 'cid-1',
      currentContractId: async () => 'cid-1',
      schedule: config.oracleTrigger.retryScheduleMs,
      sleep: async () => assert.fail('it must not sleep in the single-participant configuration'),
    }),
    /CONTRACT_NOT_FOUND/
  );
  assert.equal(calls, 1, 'one attempt, no schedule');
});

// --- the key set: the second participant, and the narrow retry --------------

test('with the key set the two endpoints differ, and only the oracle call goes to the second one', () =>
  withOracleNode(async () => {
    assert.notEqual(oracleEndpoint(), insurerEndpoint());
    assert.equal(oracleIsOnItsOwnParticipant(), true);
    insurerNode.state.received.length = 0;
    oracleNode.state.received.length = 0;
    // The trigger, as handleTrigger submits it.
    await exerciseChoice({
      moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', contractId: 'cid-1',
      choice: 'PolicyToken_EvaluateTrigger', argument: {}, actAs: ['oracle-party'],
      endpoint: oracleEndpoint(), commandSeed: 'event-trigger',
    });
    // Any other choice, as every other handler submits it: no endpoint named.
    await exerciseChoice({
      moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', contractId: 'cid-1',
      choice: 'PolicyToken_ServeNotice', argument: {}, actAs: ['insurer-party'],
      commandSeed: 'event-notice',
    });
    assert.deepEqual(
      oracleNode.state.received.map((r) => r.commands.commandId), ['exercise-event-trigger'],
      'the oracle participant got the trigger and nothing else'
    );
    assert.deepEqual(
      insurerNode.state.received.map((r) => r.commands.commandId), ['exercise-event-notice'],
      'the insurer participant got everything else'
    );
  }));

test('a trigger refused because the token is not visible yet is retried on the schedule, under one command id', () =>
  withOracleNode(async () => {
    oracleNode.state.received.length = 0;
    oracleNode.state.refuseNext = 2;
    const slept = [];
    const response = await exerciseTriggerWithVisibilityRetry({
      submit: () => exerciseChoice({
        moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', contractId: 'cid-1',
        choice: 'PolicyToken_EvaluateTrigger', argument: {}, actAs: ['oracle-party'],
        endpoint: oracleEndpoint(), commandId: 'exercise-event-race',
      }),
      submittedContractId: 'cid-1',
      currentContractId: async () => 'cid-1',
      schedule: [500, 1000, 2000, 4000],
      sleep: async (ms) => slept.push(ms),
    });
    assert.equal(response.transaction.commandId, 'exercise-event-race');
    assert.deepEqual(slept, [500, 1000], 'the schedule, in order, one delay per refusal');
    assert.equal(oracleNode.state.received.length, 3, 'two refused attempts and the one that was accepted');
    assert.deepEqual(
      [...new Set(oracleNode.state.received.map((r) => r.commands.commandId))], ['exercise-event-race'],
      'every attempt carries the SAME command id, which is what makes re-submitting one command and not three'
    );
  }));

test('when the schedule runs out the row fails, and the error says how many attempts were made', () =>
  withOracleNode(async () => {
    oracleNode.state.received.length = 0;
    oracleNode.state.refuseNext = 99;
    const slept = [];
    await assert.rejects(
      exerciseTriggerWithVisibilityRetry({
        submit: () => exerciseChoice({
          moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', contractId: 'cid-1',
          choice: 'PolicyToken_EvaluateTrigger', argument: {}, actAs: ['oracle-party'],
          endpoint: oracleEndpoint(), commandId: 'exercise-event-exhausted',
        }),
        submittedContractId: 'cid-1',
        currentContractId: async () => 'cid-1',
        schedule: [500, 1000],
        sleep: async (ms) => slept.push(ms),
      }),
      (err) => {
        assert.match(err.message, /CONTRACT_NOT_FOUND/);
        assert.match(err.message, /after 3 attempts over 1500ms \(ORACLE_TRIGGER_RETRY_SCHEDULE_MS\)/);
        return true;
      }
    );
    assert.deepEqual(slept, [500, 1000]);
    assert.equal(oracleNode.state.received.length, 3, 'one more attempt than the schedule has delays');
    oracleNode.state.refuseNext = 0;
  }));

test('a contract id that moved on in SQL is stale, not a race: it fails at once', () =>
  withOracleNode(async () => {
    let calls = 0;
    await assert.rejects(
      exerciseTriggerWithVisibilityRetry({
        submit: async () => { calls += 1; throw notFound(); },
        submittedContractId: 'cid-1',
        // Something else re-minted the token while this was in flight.
        currentContractId: async () => 'cid-2',
        schedule: [500, 1000],
        sleep: async () => assert.fail('a stale contract id must not be retried'),
      }),
      /CONTRACT_NOT_FOUND/
    );
    assert.equal(calls, 1);
  }));

test('any refusal that is not CONTRACT_NOT_FOUND is not retried', () =>
  withOracleNode(async () => {
    let calls = 0;
    const other = refusal(400, 'DAML_AUTHORIZATION_ERROR', 'requires authorizers ...');
    await assert.rejects(
      exerciseTriggerWithVisibilityRetry({
        submit: async () => { calls += 1; throw other; },
        submittedContractId: 'cid-1',
        currentContractId: async () => 'cid-1',
        schedule: [500, 1000],
        sleep: async () => assert.fail('only the visibility race is retried'),
      }),
      /DAML_AUTHORIZATION_ERROR/
    );
    assert.equal(calls, 1);
  }));

test('the retry schedule is read from its own key, in the webhook schedule\'s format', () => {
  assert.ok(Array.isArray(config.oracleTrigger.retryScheduleMs));
  assert.ok(config.oracleTrigger.retryScheduleMs.length > 0);
  for (const d of config.oracleTrigger.retryScheduleMs) {
    assert.ok(Number.isInteger(d) && d > 0, `${d} is not a positive integer of milliseconds`);
  }
});

// --- the event that has not ended yet on the ledger's clock ----------------

// PolicyToken_EvaluateTrigger's own refusal of an eventEnd after the ledger
// time, in the body shape a Canton participant answered with for another
// assertion of this package: DAML_FAILURE, and the
// assertion's sentence at the end of `cause`.
const NOT_ENDED_CAUSE =
  'Interpretation error: Error: User failure: UNHANDLED_EXCEPTION/DA.Exception.AssertionFailed:AssertionFailed ' +
  "(error category 9): the event has not ended yet -- eventEnd is after this transaction's ledger time, " +
  'and an unfinished window is not evaluated';
const notEnded = () => refusal(400, 'DAML_FAILURE', NOT_ENDED_CAUSE);

test('a trigger refused only because its event has not ended yet is retried on its own schedule, under one command id, with one participant', async () => {
  assert.equal(oracleIsOnItsOwnParticipant(), false, 'the single-participant configuration');
  insurerNode.state.received.length = 0;
  insurerNode.state.refuseNext = 2;
  insurerNode.state.refuseWith = { status: 400, body: { code: 'DAML_FAILURE', cause: NOT_ENDED_CAUSE } };
  const slept = [];
  try {
    const response = await exerciseTriggerWithUnendedRetry({
      submit: () => exerciseChoice({
        moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', contractId: 'cid-1',
        choice: 'PolicyToken_EvaluateTrigger', argument: {}, actAs: ['oracle-party'],
        endpoint: oracleEndpoint(), commandId: 'exercise-event-unended',
      }),
      submittedContractId: 'cid-1',
      currentContractId: async () => 'cid-1',
      schedule: [500, 1000, 2000, 4000],
      sleep: async (ms) => slept.push(ms),
    });
    assert.equal(response.transaction.commandId, 'exercise-event-unended');
    assert.deepEqual(slept, [500, 1000], 'the schedule, in order, one delay per refusal');
    assert.equal(insurerNode.state.received.length, 3, 'two refused attempts and the one that was accepted');
    assert.deepEqual(
      [...new Set(insurerNode.state.received.map((r) => r.commands.commandId))], ['exercise-event-unended'],
      'every attempt carries the SAME command id'
    );
  } finally {
    insurerNode.state.refuseNext = 0;
    insurerNode.state.refuseWith = null;
  }
});

test('when the not-ended schedule runs out the row fails, and the error names the attempts and the key', async () => {
  insurerNode.state.received.length = 0;
  insurerNode.state.refuseNext = 99;
  insurerNode.state.refuseWith = { status: 400, body: { code: 'DAML_FAILURE', cause: NOT_ENDED_CAUSE } };
  const slept = [];
  try {
    await assert.rejects(
      exerciseTriggerWithUnendedRetry({
        submit: () => exerciseChoice({
          moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', contractId: 'cid-1',
          choice: 'PolicyToken_EvaluateTrigger', argument: {}, actAs: ['oracle-party'],
          endpoint: oracleEndpoint(), commandId: 'exercise-event-unended-exhausted',
        }),
        submittedContractId: 'cid-1',
        currentContractId: async () => 'cid-1',
        schedule: [500, 1000],
        sleep: async (ms) => slept.push(ms),
      }),
      (err) => {
        assert.match(err.message, /the event has not ended yet/);
        assert.match(err.message, /after 3 attempts over 1500ms \(ORACLE_TRIGGER_UNENDED_RETRY_SCHEDULE_MS\)/);
        return true;
      }
    );
    assert.deepEqual(slept, [500, 1000]);
    assert.equal(insurerNode.state.received.length, 3, 'one more attempt than the schedule has delays');
  } finally {
    insurerNode.state.refuseNext = 0;
    insurerNode.state.refuseWith = null;
  }
});

test('a not-ended refusal on a contract id that moved on in SQL is stale: it fails at once', async () => {
  let calls = 0;
  await assert.rejects(
    exerciseTriggerWithUnendedRetry({
      submit: async () => { calls += 1; throw notEnded(); },
      submittedContractId: 'cid-1',
      currentContractId: async () => 'cid-2',
      schedule: [500, 1000],
      sleep: async () => assert.fail('a stale contract id must not be retried'),
    }),
    /the event has not ended yet/
  );
  assert.equal(calls, 1);
});

test('no other refusal is retried by the not-ended retry, another "has not ended yet" and CONTRACT_NOT_FOUND included', async () => {
  for (const other of [
    refusal(400, 'DAML_FAILURE', 'Interpretation error: ... AssertionFailed (error category 9): the term has not ended yet on the ledger clock'),
    refusal(400, 'DAML_FAILURE', 'Interpretation error: ... AssertionFailed (error category 9): the event ends after coverageValidThrough'),
    // The sentence under any code but DAML_FAILURE.
    refusal(400, 'DAML_INTERPRETATION_ERROR', NOT_ENDED_CAUSE),
    notFound(),
  ]) {
    let calls = 0;
    await assert.rejects(
      exerciseTriggerWithUnendedRetry({
        submit: async () => { calls += 1; throw other; },
        submittedContractId: 'cid-1',
        currentContractId: async () => 'cid-1',
        schedule: [500, 1000],
        sleep: async () => assert.fail(`only the not-ended refusal is retried here, not: ${other.message}`),
      }),
      (err) => err === other
    );
    assert.equal(calls, 1);
  }
});

test('composed as handleTrigger composes them: a token not visible yet, then an event not ended yet, then accepted', () =>
  withOracleNode(async () => {
    const answers = [notFound(), notEnded(), null];
    const slept = [];
    let calls = 0;
    const response = await exerciseTriggerWithVisibilityRetry({
      submit: () =>
        exerciseTriggerWithUnendedRetry({
          submit: async () => {
            calls += 1;
            const answer = answers.shift();
            if (answer) throw answer;
            return { transaction: { commandId: 'exercise-event-both' } };
          },
          submittedContractId: 'cid-1',
          currentContractId: async () => 'cid-1',
          schedule: [300],
          sleep: async (ms) => slept.push(`not ended ${ms}`),
        }),
      submittedContractId: 'cid-1',
      currentContractId: async () => 'cid-1',
      schedule: [500],
      sleep: async (ms) => slept.push(`not visible ${ms}`),
    });
    assert.equal(response.transaction.commandId, 'exercise-event-both');
    assert.equal(calls, 3);
    assert.deepEqual(slept, ['not visible 500', 'not ended 300'], 'each refusal waited on its own schedule');
  }));

test('the not-ended retry schedule is read from its own key, in the same format', () => {
  assert.ok(Array.isArray(config.oracleTrigger.unendedRetryScheduleMs));
  assert.ok(config.oracleTrigger.unendedRetryScheduleMs.length > 0);
  for (const d of config.oracleTrigger.unendedRetryScheduleMs) {
    assert.ok(Number.isInteger(d) && d > 0, `${d} is not a positive integer of milliseconds`);
  }
});

// --- the dispatcher's poll: one run at a time ------------------------------

// setInterval does not wait for the previous run to finish. The fake run below
// stays open across three ticks, as a run held up by a slow ledger or a busy
// advisory lock would; no tick may start a second run beside it, and the tick
// after it ends -- resolved or rejected -- starts the next one.
test('a poll tick while the previous run is still going is skipped: at most one run at a time', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const pending = [];
  const run = () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise((resolve, reject) => pending.push({ resolve, reject })).finally(() => {
      active -= 1;
    });
  };
  const settle = () => new Promise((r) => setImmediate(r));
  startDispatcher({ run });

  for (let i = 0; i < 3; i += 1) t.mock.timers.tick(config.mintWatcher.pollMs);
  assert.equal(maxActive, 1, 'no second run while the first is still going');
  assert.equal(calls, 1, 'the two ticks during the open run were skipped');

  pending.shift().resolve();
  await settle();
  t.mock.timers.tick(config.mintWatcher.pollMs);
  assert.equal(calls, 2, 'the tick after a run resolved starts the next one');

  pending.shift().reject(new Error('fake run failure'));
  await settle();
  t.mock.timers.tick(config.mintWatcher.pollMs);
  assert.equal(calls, 3, 'the tick after a run rejected starts the next one');
  assert.equal(maxActive, 1);

  pending.shift().resolve();
  await settle();
});
