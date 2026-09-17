// Every test file that writes loads this as its FIRST import, and the
// first-import meta-test in `npm run test:db` fails any that does not. It
// checks TEST_DATABASE_URL with the guard, then points DATABASE_URL at it;
// config.js's own dotenv load does not override a variable already set.
//
// There is no top-level await here, and that is the point. ESM goes on to
// evaluate the modules imported after an async module while that module is
// still suspended, so a guard that awaited would let src/db.js build its pool
// against the working database before the guard had finished -- observed,
// not supposed. This module stays synchronous: the checks run in a child
// process (checkTestDb.mjs) through execFileSync, so nothing imported after
// this line starts until they have passed.
//
// DATABASE_URL changes only after the child exits 0, and to exactly the value
// the child checked, which is handed to it on stdin rather than re-read from
// .env. A non-zero exit, a child that cannot start, or one that runs past the
// timeout stops the file here with the child's stderr, and DATABASE_URL is
// left as it was.
//
// It imports neither config.js nor db.js. There is no switch to skip it: the
// test files that do not load it are named, one by one, in the meta-test.
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHECK = fileURLToPath(new URL('./checkTestDb.mjs', import.meta.url));
// Well above a normal run (Node start-up plus three local connections, well
// under two seconds), and below the operating system's own connect timeout,
// so a guard stuck on an unreachable host fails in bounded time instead of
// hanging the test file.
const TIMEOUT_MS = 15000;

const testUrl = process.env.TEST_DATABASE_URL;
const workingUrl = process.env.DATABASE_URL;

try {
  execFileSync(process.execPath, [CHECK], {
    input: JSON.stringify({ testUrl, workingUrl }),
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
} catch (err) {
  const why =
    err.code === 'ETIMEDOUT' || err.signal
      ? `did not finish within ${TIMEOUT_MS} ms`
      : typeof err.status === 'number'
        ? `exited with code ${err.status}`
        : `could not be started (${err.code ?? err.message})`;
  throw new Error(`test-database guard ${why}; DATABASE_URL was not changed.\n${String(err.stderr ?? '').trim()}`);
}

process.env.DATABASE_URL = testUrl;
