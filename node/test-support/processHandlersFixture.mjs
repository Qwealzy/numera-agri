// Fixture for test/processHandlers.test.mjs, which runs it as a child process:
// an exit can only be observed from outside the process it ends. It installs
// src/processHandlers.js the way server.js does and serves /health from
// src/health.js with both probes faked, so it needs no database and no ledger.
//
// Not a test file of its own: it sits outside test/ and has no .test.mjs
// suffix, so neither `npm test` nor the first-import meta-test picks it up.
//
// argv[2] is the mode:
//   uncaught -- throw from a timer while the listening server keeps the
//               process alive, so only the handler can end it
//   reject   -- leave two rejections unhandled
//   (none)   -- serve, and nothing else
import express from 'express';
import { installProcessHandlers } from '../src/processHandlers.js';
import { healthHandler } from '../src/health.js';

const mode = process.argv[2];
const processDegraded = installProcessHandlers();

const app = express();
app.get('/health', healthHandler({
  probeDatabase: async () => {},
  probeLedger: async () => {},
  processDegraded,
}));
const server = app.listen(0, '127.0.0.1', () => {
  if (mode === 'uncaught') {
    setTimeout(() => {
      throw new Error('fixture uncaught exception');
    }, 0);
  }
  if (mode === 'reject') {
    Promise.reject(new Error('fixture rejection one'));
    Promise.reject(new Error('fixture rejection two'));
  }
  // An immediate runs after the rejections above have been reported, so the
  // parent reads the port only once both have reached the handler.
  setImmediate(() => console.log(`PROCESS_HANDLERS_FIXTURE port=${server.address().port}`));
});
