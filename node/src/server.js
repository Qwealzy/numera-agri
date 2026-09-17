import { config } from './config.js';
import { createApp } from './app.js';
import { startDispatcher } from './dispatch/dispatcher.js';
import { startOracleBot } from './oracle/oracleBot.js';
import { startPayoutListener } from './listeners/payoutListener.js';
import { startExpirySweeper } from './sweepers/expirySweeper.js';
import { startGraceSweeper } from './sweepers/graceSweeper.js';
import { startFirstPremiumSweeper } from './sweepers/firstPremiumSweeper.js';
import { startTwoNoticeSweeper } from './sweepers/twoNoticeSweeper.js';
import { pool } from './db.js';
import { getLedgerEnd } from './damlClient.js';
import { installProcessHandlers } from './processHandlers.js';

// Surfaced by a real incident: the process exited with code 1 after
// running fine for hours, with nothing printed to explain why. Node exits
// silently on an unhandled rejection/exception in some configurations --
// log the full error before that happens so a repeat is diagnosable.
const processDegraded = installProcessHandlers();

// The two dependencies this process has. Each probe is the cheapest call
// that proves the thing answers; health.js bounds both and never lets either
// change the status code.
const app = createApp({
  probeDatabase: () => pool.query('SELECT 1'),
  probeLedger: () => getLedgerEnd(),
  processDegraded,
});

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
  // Convenience: run all background loops in-process alongside the API.
  // For real load, run each one as a separate process instead -- every
  // loop below supports standalone execution via the `import.meta.url`
  // guard at its own file's bottom. See package.json's scripts for the
  // commands; this list is not repeated here so it cannot go stale when
  // a loop is added.
  startDispatcher();
  startOracleBot();
  startPayoutListener();
  startExpirySweeper();
  startGraceSweeper();
  startFirstPremiumSweeper();
  startTwoNoticeSweeper();
});
