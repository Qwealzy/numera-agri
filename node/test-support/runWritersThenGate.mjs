// `npm test`'s second half. It runs the tests that write in one `node --test`
// process, and then the leak gate (test/leakGate.test.mjs) in another, started
// only after the first has exited, whatever its outcome -- passed, failed, or
// never started at all.
//
// The gate cannot be the last file of the first run: node --test sorts the
// files it is given (createTestFileList returns them through
// ArrayPrototypeSort) whatever order the command line names them in, and its
// documentation promises no order at all. Here the order comes from spawnSync,
// which does not return until its process has exited. Nor can package.json
// chain the two with &&: the gate would not run after a failing test, and a
// failing test is the likeliest to have skipped its cleanup.
//
// A part fails when its process exits non-zero, is ended by a signal (status
// null), or cannot be started (error set). Either part failing makes this exit
// 1, and its last line says which part failed and how.
//
// It connects to no database and imports neither config.js nor db.js; the
// guard runs inside each test file, as its first import. It is not a .test.mjs
// file, so neither node --test nor the first-import meta-test collects it.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const NODE_DIR = path.resolve(import.meta.dirname, '..');
const WRITERS = [
  'test/api.test.mjs', 'test/dispatcher.test.mjs', 'test/expirySweeper.test.mjs', 'test/graceSweeper.test.mjs',
  'test/oracleWindow.test.mjs', 'test/notificationQueue.test.mjs', 'test/notificationSender.test.mjs',
  'test/replayRecorded.test.mjs', 'test/verifyTeardown.test.mjs', 'test/onboardInsurer.test.mjs',
  // Skips itself unless TEST_DAML_JSON_API_URL_ORACLE names a second participant.
  'test/twoParticipants.test.mjs',
];
const GATE = 'test/leakGate.test.mjs';

// Why the part failed, or null if it exited 0.
function run(args) {
  const r = spawnSync(process.execPath, args, { cwd: NODE_DIR, stdio: 'inherit' });
  if (r.error) return `could not be started (${r.error.code ?? r.error.message})`;
  if (r.status === null) return `was ended by signal ${r.signal}`;
  if (r.status !== 0) return `exited with code ${r.status}`;
  return null;
}

const writers = run(['--test', '--test-concurrency=1', ...WRITERS]);
const gate = run(['--test', GATE]);

const outcome = (part, why) => `${part} ${why ? `FAILED (${why})` : 'passed (exited with code 0)'}`;
const code = writers || gate ? 1 : 0;
console.log(`npm test half 2: ${outcome('the tests that write', writers)}; ${outcome('the leak gate', gate)}. Exit code ${code}.`);
process.exitCode = code;
