import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import { pool } from '../db.js';
import { config } from '../config.js';

// The m. 1434(4) sweeper: the elected termination taking effect.
//
// A SEPARATE file from graceSweeper.js and firstPremiumSweeper.js, for the
// same reason those two are separate from each other. m. 1434(2) is
// withdrawal, m. 1434(3) is automatic termination at the end of a notice
// period, and this is the THIRD way a contract ends for non-payment:
// discretionary -- "sigortacı ... sözleşmeyi feshedebilir" -- with a DEFERRED
// effect, "sigorta döneminin sonunda hüküm doğurmak üzere". Folding it into a
// phase of another file would be the first step toward treating three
// distinct mechanisms as variants of one.
//
// What it observes: that the frozen effective instant has passed. The sweeper
// does not DECIDE the termination -- the insurer already did that when it
// elected, and the paragraph fixes when the decision lands. This is the same
// division as the m. 1434(3) sweeper, where the termination instant was fixed
// the moment notice was served.
//
// A STATE test, not a moment test: "an election is pending and its effective
// instant has passed". A missed run -- downtime, a crashed process, days of
// no cron firing -- is fully recoverable by running again, and the instant
// itself is read from the policy's own frozen field rather than from a clock,
// so a sweep three days late records exactly the instant it would have
// recorded on time.
//
// The period is never derived here. It was supplied by the insurer at
// election and frozen onto the row then; m. 1411 ties the insurance period to
// how the premium is CALCULATED, and this platform holds no calculation
// basis.
//
// WHAT THIS DOES NOT DO: it does not touch a policy whose token has already
// been archived. Where a policy's own term ends at the same instant as the
// insurance period, the contract ends by its own term -- expiry -- and there
// is nothing left for m. 1434(4) to terminate. Both facts stay recorded: the
// claim axis says `expired`, the default axis keeps `two_notice_elected` with
// its election date and effective instant intact, and the pair reads as
// "elected, overtaken by expiry". Nothing is collapsed into the other.
async function runOnce({ insurerIds } = {}) {
  // insurerIds is for tests, which pass their own fixture insurers. Production
  // passes nothing, and the query is then exactly what it always was.
  const { rows: due } = await pool.query(
    `SELECT id FROM policies
     WHERE default_state = 'two_notice_elected'
       AND two_notice_effective_at IS NOT NULL
       AND two_notice_effective_at <= now()
       -- The token must still be live. A policy already burned by expiry or
       -- by a claim has no contract left to terminate.
       AND status IN ('active', 'partially_paid')
       AND daml_contract_id IS NOT NULL` +
      (insurerIds === undefined ? '' : ' AND insurer_id = ANY($1)'),
    insurerIds === undefined ? undefined : [insurerIds]
  );
  console.log(
    `[twoNoticeSweeper] ${due.length} polic${due.length === 1 ? 'y' : 'ies'} ` +
      `whose elected m. 1434(4) termination has reached the end of its insurance period`
  );
  for (const policy of due) {
    await pool.query(
      `INSERT INTO policy_events (policy_no, event_type) VALUES ($1, 'two_notice_termination')
       ON CONFLICT (policy_no)
         WHERE event_type = 'two_notice_termination' AND status IN ('pending', 'processing')
       DO NOTHING`,
      [policy.id]
    );
  }
}

export function startTwoNoticeSweeper({ insurerIds } = {}) {
  console.log(
    `[twoNoticeSweeper] scheduled with cron "${config.twoNoticeSweeper.cron}" (Europe/Istanbul)`
  );
  // As with the other sweepers, the zone decides only when the
  // convenience-clock fires. It has no bearing on which policies the query
  // finds, which compares each policy's own frozen effective instant against
  // the database's own now().
  cron.schedule(
    config.twoNoticeSweeper.cron,
    () => {
      runOnce({ insurerIds }).catch((err) => console.error('[twoNoticeSweeper] run failed:', err));
    },
    { timezone: 'Europe/Istanbul' }
  );
}

export { runOnce };

// See oracleBot.js for why pathToFileURL is used here instead of manual
// string concatenation (Windows path-format mismatch made that dead code).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startTwoNoticeSweeper();
  runOnce().catch((err) => console.error('[twoNoticeSweeper] initial run failed:', err));
}
