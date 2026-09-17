import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import { pool } from '../db.js';
import { config } from '../config.js';

// The premium-default sweeper. Same shape as expirySweeper.js in every
// respect: it never touches the ledger, it only observes state and writes
// outbox rows for dispatch/dispatcher.js to act on.
//
// Stage 4 replaced what it does. It used to queue a 'suspension' row, which
// moved coverageValidThrough back and left the contract alive in a suspended
// state. TTK 6102 m. 1434(3) terminates the contract at the end of the
// notice period instead -- `feshedilmiş olur` -- and m. 1452(3) makes that
// non-derogable against the insured, so suspension was not something the
// general conditions could have introduced either. It now sweeps two
// distinct phases; see runOnce.
//
// The query is a STATE test, not a moment test -- "notice service date plus
// this policy's own grace period is already in the past, AND the policy is
// still sitting in the grace_period default state" -- so a missed run
// (downtime, a crashed process, days of no cron firing) is fully
// recoverable by simply running again; nothing about correctness depends on
// the schedule firing on time. Interval arithmetic is done in SQL rather
// than JS so the comparison happens against the same `now()` the row is
// read at.
//
// Stage 3 Part 3: this filters on `default_state`, NOT on `status`. That
// change is the point of splitting the two axes. While both lived in one
// column, a payout during the grace period overwrote it with
// 'partially_paid' and this query stopped matching the policy entirely --
// so a policy that suffered a loss while in default was never acted on,
// however long the premium went unpaid. Filtering on the axis that
// actually holds the default state means a partially-paid policy in its
// grace period is still found and still swept, which is exactly the
// combination that used to be lost.
//
// grace_period_days is read off `policies` alone here, never falling back
// to the insurer default: dispatcher.js's handleActivation already froze
// the resolved value onto the row at activation (and refused to activate at
// all if neither was configured), so any policy that reached the
// grace_period state necessarily has it set. A NULL here would mean an
// activation path bypassed that resolution, and the IS NOT NULL below makes
// such a policy visibly unswept rather than silently terminated on a guessed
// deadline.
async function runOnce({ insurerIds } = {}) {
  // insurerIds is for tests, which pass their own fixture insurers. Production
  // passes nothing, and both queries are then exactly what they always were.
  const scopeValues = insurerIds === undefined ? undefined : [insurerIds];

  // PHASE ONE -- the notice period has elapsed unpaid, so the contract is
  // terminated (TTK 6102 m. 1434(3)). The sweeper does not DECIDE this; it
  // observes that the period elapsed and writes it down. The termination
  // instant itself was fixed the moment notice was served, and is computed
  // from the service date in handleTermination -- so a sweeper that runs
  // three days late records exactly the instant it would have recorded on
  // time. That is the whole reason this stays a state test.
  //
  // THE FREEZE (m. 1431(4)). A substituted policy is excluded, and what that
  // rests on is the incompatibility of two phrases: m. 1431(4) says that on
  // the sigortali's undertaking "sozlesme bu kisilerle DEVAM EDER", while
  // m. 1434(3) says that at the end of the notice period "sozlesme
  // FESHEDILMIS olur". A contract cannot both continue and have been
  // terminated. No article says the clock stops, resets or runs on, and this
  // asserts none of those -- default_state stays grace_period, the notice
  // facts stay exactly where they were, and the premium is as unpaid as it
  // was. Only the one outcome the two phrases cannot share is refused.
  // PolicyToken_Terminate refuses it on the ledger too, which is the line
  // that cannot be bypassed.
  const { rows: elapsed } = await pool.query(
    `SELECT id FROM policies
     WHERE default_state = 'grace_period'
       AND notice_service_date IS NOT NULL
       AND grace_period_days IS NOT NULL
       AND substituted_at IS NULL
       AND notice_service_date + (grace_period_days * INTERVAL '1 day') < now()` +
      (insurerIds === undefined ? '' : ' AND insurer_id = ANY($1)'),
    scopeValues
  );
  console.log(
    `[graceSweeper] ${elapsed.length} polic${elapsed.length === 1 ? 'y' : 'ies'} whose notice period has elapsed`
  );
  for (const policy of elapsed) {
    await pool.query(
      `INSERT INTO policy_events (policy_no, event_type) VALUES ($1, 'termination')
       ON CONFLICT (policy_no) WHERE event_type = 'termination' AND status IN ('pending', 'processing')
       DO NOTHING`,
      [policy.id]
    );
  }

  // PHASE TWO -- a terminated policy whose token is still live because a
  // payout raised on it was still open. Termination ends the CONTRACT; the
  // token is burned only once every obligation raised on it has reached a
  // terminal state, so that termination never orphans a payout or breaks
  // the chain from a payout back to its policy.
  //
  // Also a state test, and idempotent: a policy that has no unresolved
  // payouts stays in this result set until the archive actually happens.
  const { rows: burnable } = await pool.query(
    `SELECT p.id FROM policies p
     WHERE p.default_state = 'terminated'
       AND p.daml_contract_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM payout_events pe
         WHERE pe.policy_id = p.id AND pe.resolved_at IS NULL
       )` + (insurerIds === undefined ? '' : ' AND p.insurer_id = ANY($1)'),
    scopeValues
  );
  console.log(
    `[graceSweeper] ${burnable.length} terminated polic${burnable.length === 1 ? 'y' : 'ies'} with all payouts resolved`
  );
  for (const policy of burnable) {
    await pool.query(
      `INSERT INTO policy_events (policy_no, event_type) VALUES ($1, 'termination_archive')
       ON CONFLICT (policy_no) WHERE event_type = 'termination_archive' AND status IN ('pending', 'processing')
       DO NOTHING`,
      [policy.id]
    );
  }
}

export function startGraceSweeper({ insurerIds } = {}) {
  console.log(`[graceSweeper] scheduled with cron "${config.graceSweeper.cron}" (Europe/Istanbul)`);
  // As with expirySweeper.js, the zone here only decides when the
  // convenience-clock fires -- it has no bearing on which policies the
  // query above finds, which compares each policy's own stored notice
  // service date against the database's own now().
  cron.schedule(
    config.graceSweeper.cron,
    () => {
      runOnce({ insurerIds }).catch((err) => console.error('[graceSweeper] run failed:', err));
    },
    { timezone: 'Europe/Istanbul' }
  );
}

export { runOnce };

// See oracleBot.js for why pathToFileURL is used here instead of manual
// string concatenation (Windows path-format mismatch made that dead code).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGraceSweeper();
  runOnce().catch((err) => console.error('[graceSweeper] initial run failed:', err));
}
