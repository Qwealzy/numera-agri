// The process-level handlers, in a module of their own so a test can install
// them in a child process without importing server.js, which needs a database
// and a ledger and starts every loop. It imports nothing.
//
// An uncaught exception is logged and the process exits non-zero: this process
// is meant to run under a supervisor, and restarting it is the supervisor's
// job. An unhandled rejection is logged and counted, and the process carries
// on; the count reaches /health through the getter returned here. Neither
// handler recovers or retries anything -- a row the dispatcher held in
// `processing` when the process exited stays there.

export function installProcessHandlers() {
  let unhandledRejections = 0;
  let lastUnhandledRejectionAt = null;
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason);
    unhandledRejections += 1;
    lastUnhandledRejectionAt = new Date().toISOString();
  });
  // null until the first rejection, so /health says nothing about it until
  // there is something to say.
  return () => (unhandledRejections === 0 ? null : { unhandledRejections, lastUnhandledRejectionAt });
}
