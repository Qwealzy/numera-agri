// The /health handler, in a module of its own so a test can drive it without
// importing server.js, which listens and starts every loop. Both probes are
// injected for the same reason: the test passes fakes and touches neither the
// database nor the ledger.
//
// THE STATUS CODE STAYS 200 WHEN A DEPENDENCY IS DOWN. A supervisor reads a
// non-200 as "restart me", and a restart cannot reach a database or a
// participant that is down -- it would only put a restart loop around a
// process that is alive and that goes back to work by itself when the outage
// ends. So `ok` here means LIVENESS, not readiness: this process is up and
// answering. What is usable is in `dependencies`, by name.
//
// Only the names and their state are reported. A probe's own error text
// carries hosts, ports and driver internals, and this endpoint has no
// authentication -- the same reason errorHandler.js keeps a 5xx body fixed.
// A failed probe is the answer here, not an error to log: /health is polled,
// and a real outage is logged by the dispatcher, which is the part that
// stops working -- a ledger outage once when it starts and then every five
// minutes (noteLedgerUnreachable), and only while a pending row makes runOnce
// probe the ledger at all; a database outage on every poll it lasts,
// because runOnce's first query fails and startDispatcher logs each failure.

// Short, because /health is polled and must stay cheap: a hung dependency is
// reported down rather than holding the response open.
const PROBE_TIMEOUT_MS = 1500;

async function stateOf(probe) {
  let timer;
  try {
    await Promise.race([
      probe(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

// processDegraded is optional: a getter that returns null while the process
// has seen no unhandled rejection, and what it counted once it has. Only then
// does the body carry `degraded`, and the status code stays 200 regardless --
// the process is still alive and answering.
export function healthHandler({ probeDatabase, probeLedger, processDegraded }) {
  return async (_req, res) => {
    const [database, ledger] = await Promise.all([stateOf(probeDatabase), stateOf(probeLedger)]);
    const degraded = processDegraded?.();
    res.status(200).json({ ok: true, dependencies: { database, ledger }, ...(degraded ? { degraded } : {}) });
  };
}
