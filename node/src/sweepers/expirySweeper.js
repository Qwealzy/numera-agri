import { pathToFileURL } from 'node:url';
import cron from 'node-cron';
import { pool } from '../db.js';
import { config } from '../config.js';
import { resolveFrozenWindowRule, windowFor, isClosed } from '../oracle/eventWindow.js';
import { livePolicyNos, tokenNotLive } from '../oracle/oracleBot.js';

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
//
// A policy past its expiry is not yet expired while a loss inside its term
// can still be evaluated. The last window that can hold an in-cover reading is
// the one containing the instant just before `expiry`, under the rule frozen
// onto the policy; the 'expiry' row waits until that window has closed, every
// (coverage, cell) with an in-cover reading in it has its trigger_windows row,
// and no 'trigger' row of the policy is still pending or processing. A last
// window with no in-cover reading gets no row by design, so it holds nothing
// up once it has closed. A policy with no rule frozen onto it is never
// triggered, and is expired exactly as before. How long the wait is follows
// from the policy's own window rule and nothing else. Each deferral is logged
// with its reason, and the next run looks again -- still a state test.
// A last window whose readings mix metrics is refused by the oracle and so
// never gets its row, and holds expiry up until someone looks: a window that
// cannot be evaluated is not closed quietly.
//
// v22. Exported, with the contract's end as a parameter, for
// graceSweeper.js: a terminated contract's token is not archived before its
// last window -- the one containing the instant just before terminated_at --
// has been evaluated, by the same test. `end` defaults to the expiry, so this
// file's own call is unchanged.
export async function lastWindowPending(policy, end = policy.expiry) {
  const { rule } = resolveFrozenWindowRule(policy);
  if (!rule) return null;
  const window = windowFor(new Date(new Date(end).getTime() - 1), rule);
  const span = `${window.start.toISOString()}..${window.end.toISOString()}`;
  // swept_at is the same SQL now() the candidate query compared expiry with,
  // so the window is judged on the database's clock, not this process's.
  if (!isClosed(window, policy.swept_at)) return `its last window ${span} is still open`;
  // Only the (coverage, cell) pairs queueClosedWindows walks, from the same
  // policy_coverages.cell_ids: a reading on a cell the oracle never evaluates
  // would otherwise hold expiry up for good.
  const { rows: unevaluated } = await pool.query(
    `SELECT DISTINCT r.coverage_code, r.cell_id FROM oracle_readings r
      JOIN policy_coverages c
        ON c.policy_id = r.policy_id AND c.coverage_code = r.coverage_code AND c.cell_ids @> to_jsonb(r.cell_id)
      WHERE r.policy_id = $1
        AND r.measured_at >= $2 AND r.measured_at < $3
        AND r.measured_at >= $4::timestamptz AND r.measured_at < $5::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM trigger_windows w
           WHERE w.policy_id = r.policy_id AND w.coverage_code = r.coverage_code
             AND w.cell_id = r.cell_id AND w.window_start = $2)
      ORDER BY r.coverage_code, r.cell_id`,
    [policy.id, window.start, window.end, policy.coverage_began_at, end]
  );
  if (unevaluated.length > 0) {
    return (
      `its last window ${span} is closed but not yet evaluated for ` +
      unevaluated.map((u) => `${u.coverage_code}/${u.cell_id}`).join(', ')
    );
  }
  const { rows: [{ n }] } = await pool.query(
    `SELECT count(*)::int AS n FROM policy_events
      WHERE policy_no = $1 AND event_type = 'trigger' AND status IN ('pending', 'processing')`,
    [policy.id]
  );
  if (n > 0) return `its last window ${span} is evaluated but ${n} trigger row(s) are still pending or processing`;
  return null;
}

async function runOnce({ insurerIds, activeTokens = livePolicyNos } = {}) {
  // insurerIds is for tests, which pass their own fixture insurers. Production
  // passes nothing, and the query is then exactly what it always was.
  const { rows: expired } = await pool.query(
    `SELECT id, insurer_id, daml_contract_id, expiry, coverage_began_at, event_window_timezone, event_window_start_hour,
            event_aggregation, now() AS swept_at
       FROM policies WHERE expiry < now() AND status IN ('active', 'partially_paid')` +
      (insurerIds === undefined ? '' : ' AND insurer_id = ANY($1)'),
    insurerIds === undefined ? undefined : [insurerIds]
  );
  console.log(`[expirySweeper] found ${expired.length} expired, still-open polic${expired.length === 1 ? 'y' : 'ies'}`);
  // A ledger READ, never a submission: a policy with no active token gets no
  // 'expiry' row, which handleExpiry could only fail on.
  const live = await activeTokens([...new Set(expired.map((p) => p.insurer_id))]);
  for (const policy of expired) {
    const notLive = tokenNotLive(policy, live);
    if (notLive) {
      console.error(
        `[expirySweeper] policy ${policy.id} past expiry ${new Date(policy.expiry).toISOString()} not queued for ` +
          `expiry: ${notLive.why}` +
          (notLive.known ? ' -- its SQL row is left as it is' : ' -- looked at again on the next run')
      );
      continue;
    }
    const pending = await lastWindowPending(policy);
    if (pending) {
      console.log(`[expirySweeper] policy ${policy.id} past expiry ${new Date(policy.expiry).toISOString()} not expired yet: ${pending}`);
      continue;
    }
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
