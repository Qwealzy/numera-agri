import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import { pool } from '../db.js';
import { config } from '../config.js';

// Stage 3 Part 1: policies are born and can be triggered, but nothing ever
// ends them naturally -- this closes that gap. Like oracleBot.js and
// payoutListener.js, this file never touches the ledger itself; it only
// finds policies whose term has passed and writes one 'expiry' outbox row
// per policy for dispatch/dispatcher.js's handleExpiry to actually exercise
// PolicyToken_ArchiveForExpiry against.
//
// The query is written as "expired AND still open" (policies.expiry in the
// past, status still 'active' or 'partially_paid'), never as "expires at
// this exact tick" -- every run re-evaluates the full set of currently-
// qualifying policies from scratch, so a missed run (downtime, a crashed
// process, three days of no cron firing) is recoverable simply by running
// again; nothing about correctness depends on the schedule actually firing
// on time. `idx_policy_events_expiry_key` (migration 008) keys the outbox
// insert on (policy_no) alone for event_type = 'expiry' -- a policy expires
// once, so re-running this query after a policy already has an 'expiry' row
// is a safe, cheap no-op via ON CONFLICT DO NOTHING, not a second row.
async function runOnce({ insurerIds } = {}) {
  // insurerIds is for tests, which pass their own fixture insurers. Production
  // passes nothing, and the query is then exactly what it always was.
  const { rows: expired } = await pool.query(
    `SELECT id FROM policies WHERE expiry < now() AND status IN ('active', 'partially_paid')` +
      (insurerIds === undefined ? '' : ' AND insurer_id = ANY($1)'),
    insurerIds === undefined ? undefined : [insurerIds]
  );
  console.log(`[expirySweeper] found ${expired.length} expired, still-open polic${expired.length === 1 ? 'y' : 'ies'}`);
  for (const policy of expired) {
    await pool.query(
      `INSERT INTO policy_events (policy_no, event_type) VALUES ($1, 'expiry')
       ON CONFLICT (policy_no) WHERE event_type = 'expiry' DO NOTHING`,
      [policy.id]
    );
  }
}

export function startExpirySweeper({ insurerIds } = {}) {
  console.log(`[expirySweeper] scheduled with cron "${config.expirySweeper.cron}" (Europe/Istanbul)`);
  // The Europe/Istanbul zone here only decides when the convenience-clock
  // fires -- it has no bearing on which policies the query above finds,
  // which compares against each policy's own stored `expiry` instant
  // regardless of what zone or time this job happens to run in.
  cron.schedule(config.expirySweeper.cron, () => {
    runOnce({ insurerIds }).catch((err) => console.error('[expirySweeper] run failed:', err));
  }, { timezone: 'Europe/Istanbul' });
}

export { runOnce };

// See oracleBot.js for why pathToFileURL is used here instead of manual
// string concatenation (Windows path-format mismatch made that dead code).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startExpirySweeper();
  runOnce().catch((err) => console.error('[expirySweeper] initial run failed:', err));
}
