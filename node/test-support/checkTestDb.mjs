// The child process that setup-test-db.mjs runs through execFileSync. It
// checks the two URLs it is handed on stdin -- it never reads .env, so it
// checks exactly the value the parent will then put into DATABASE_URL -- and
// exits 0 only if the guard passes. Otherwise it writes the reason to stderr
// and exits 1. Top-level await is fine here: this is a process of its own,
// never imported by a test file.
import fs from 'node:fs';
import { assertTestDatabase } from './testDbGuard.mjs';

try {
  const { testUrl, workingUrl } = JSON.parse(fs.readFileSync(0, 'utf8'));
  await assertTestDatabase({ testUrl, workingUrl });
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
