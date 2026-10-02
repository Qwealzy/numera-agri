import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import { pool } from '../db.js';
import { config } from '../config.js';

// The m. 1434(2) sweeper: withdrawal by operation of law.
//
// A SEPARATE file from graceSweeper.js on purpose. That one implements
// m. 1434(3) -- ihtar, ten days, fesih -- and this implements m. 1434(2) --
// no notice, three months from the due date, cayma. They are different
// mechanisms with different consequences, and folding this into a third phase
// of that file would be the first step toward treating them as variants of
// one thing.
//
// What it observes: m. 1434(2)'s second sentence, "Prim alacağının,
// muacceliyet gününden itibaren üç ay içinde dava veya takip yoluyla
// istenmemiş olması hâlinde, sözleşmeden cayılmış olunur." Withdrawal follows
// from INACTION. Nobody exercises anything; the sweeper's job is to observe
// that the period elapsed with no suit or enforcement reported, and write it
// down -- the same shape as the termination sweeper, and for the same reason.
//
// The query is a STATE test, not a moment test: "still in first-premium
// default, a due date was reported, the window has elapsed, and no
// enforcement has been reported." A missed run -- downtime, a crashed
// process, days of no cron firing -- is fully recoverable by running again,
// and the withdrawal instant is derived from the reported due date rather
// than from a clock, so a late run records the instant it would have recorded
// on time.
//
// It reads the window off the POLICY: like the grace period, handleActivation
// freezes it onto the row (migration 037), so a later change to the insurer's
// value never moves an activated policy's window. resolveFirstPremiumWindow
// enforces the three-month ceiling when the withdrawal is dispatched -- a
// policy frozen with a longer window fails loudly at dispatch rather than
// being swept on a period the Code would not allow.
async function runOnce({ insurerIds } = {}) {
  // insurerIds is for tests, which pass their own fixture insurers. Production
  // passes nothing, and the query is then exactly what it always was.
  const { rows: elapsed } = await pool.query(
    `SELECT p.id FROM policies p
     WHERE p.default_state = 'first_premium_unpaid'
       AND p.premium_due_date IS NOT NULL
       -- The whole point of the second sentence: it applies only where the
       -- claim was NOT pursued.
       AND p.enforcement_commenced_at IS NULL
       AND p.first_premium_withdrawal_days IS NOT NULL
       AND p.premium_due_date + (p.first_premium_withdrawal_days * INTERVAL '1 day') < now()` +
      (insurerIds === undefined ? '' : ' AND p.insurer_id = ANY($1)'),
    insurerIds === undefined ? undefined : [insurerIds]
  );
  console.log(
    `[firstPremiumSweeper] ${elapsed.length} polic${elapsed.length === 1 ? 'y' : 'ies'} ` +
      `whose first-premium window elapsed with no suit or enforcement reported`
  );
  for (const policy of elapsed) {
    await pool.query(
      `INSERT INTO policy_events (policy_no, event_type) VALUES ($1, 'first_premium_deemed_withdrawal')
       ON CONFLICT (policy_no)
         WHERE event_type = 'first_premium_deemed_withdrawal' AND status IN ('pending', 'processing')
       DO NOTHING`,
      [policy.id]
    );
  }
}

export function startFirstPremiumSweeper({ insurerIds } = {}) {
  console.log(
    `[firstPremiumSweeper] scheduled with cron "${config.firstPremiumSweeper.cron}" (Europe/Istanbul)`
  );
  // As with the other sweepers, the zone decides only when the
  // convenience-clock fires. It has no bearing on which policies the query
  // finds, which compares each policy's own reported due date against the
  // database's own now().
  cron.schedule(
    config.firstPremiumSweeper.cron,
    () => {
      runOnce({ insurerIds }).catch((err) => console.error('[firstPremiumSweeper] run failed:', err));
    },
    { timezone: 'Europe/Istanbul' }
  );
}

export { runOnce };

// See oracleBot.js for why pathToFileURL is used here instead of manual
// string concatenation (Windows path-format mismatch made that dead code).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFirstPremiumSweeper();
  runOnce().catch((err) => console.error('[firstPremiumSweeper] initial run failed:', err));
}
