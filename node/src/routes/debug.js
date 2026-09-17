import { Router } from 'express';
import { pool } from '../db.js';
import { getLedgerEnd, queryActiveContracts } from '../damlClient.js';

export const debugRouter = Router();

// Dev-only live view: what's actually active on the ledger right now, plus
// the current SQL mirror, side by side. Not part of the 4-module business
// API -- purely so a human can watch the system work in real time instead
// of trusting log lines.
//
// Strictly READ-ONLY. Every query in this file is a SELECT; nothing here
// mutates a table, touches the ledger, or exposes a control that could.
//
// Loopback-only as a floor, not a real access-control policy: this router
// exposes party ids and full contract payloads with zero authentication.
// Delete this whole file (and its mount in server.js) before any
// deployment that isn't literally your own machine's LocalNet.
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
debugRouter.use((req, res, next) => {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'debug routes are loopback-only' });
  }
  next();
});

debugRouter.get('/contracts', async (_req, res) => {
  try {
    const { rows: insurers } = await pool.query(
      "SELECT * FROM insurers WHERE canton_party_status = 'ALLOCATED'"
    );

    const ledgerEnd = await getLedgerEnd();

    const perInsurer = [];
    for (const insurer of insurers) {
      const [policies, payouts] = await Promise.all([
        queryActiveContracts({
          moduleName: 'Insurance.PolicyToken',
          entityName: 'PolicyToken',
          parties: [insurer.canton_party_id],
        }),
        queryActiveContracts({
          moduleName: 'Insurance.PayoutBridge',
          entityName: 'PayoutApproved',
          parties: [insurer.canton_party_id],
        }),
      ]);
      perInsurer.push({
        insurer: insurer.legal_name,
        insurerParty: insurer.canton_party_id,
        activePolicyTokens: policies.map((e) => {
          const c = e.contractEntry.JsActiveContract.createdEvent;
          return { contractId: c.contractId, ...c.createArgument };
        }),
        activePayoutApproved: payouts.map((e) => {
          const c = e.contractEntry.JsActiveContract.createdEvent;
          return { contractId: c.contractId, ...c.createArgument };
        }),
      });
    }

    // No LIMIT here (unlike payoutEvents below) -- the reconciliation
    // dashboard needs every policy row to compare against the ledger, and
    // a capped result silently made it look complete when it wasn't (it
    // undercounted real orphans by only checking the most-recently-
    // touched 20 rows).
    // sum_insured/remaining_limit moved to policy_coverages (Stage 2 Part
    // 2, one row per coverage) -- these are policy-level totals across
    // every coverage, derived here for this debug view only, never
    // stored, same principle as the Daml token itself never storing one.
    //
    // Stage 3 Part 3/4 additions, all read-only:
    //   default_state           -- the premium-default axis, INDEPENDENT of
    //                              status; never merge the two into one
    //                              derived label, they mean different things
    //   grace_ends_at           -- notice service date + this policy's own
    //                              grace_period_days. The number a human
    //                              actually needs while a policy is in
    //                              grace. Computed here for display only;
    //                              graceSweeper.js does its own equivalent
    //                              arithmetic against now() and is the
    //                              authority on when a policy is swept.
    //                              Once terminated, terminated_at is the
    //                              recorded fact and this is only the
    //                              prediction it was derived from.
    //
    // Stage 4 additions, all read-only:
    //   terminated_at/unrun_days -- the recorded consequence of the notice
    //                              period elapsing (m. 1434(3)) and the
    //                              facts a refund is computed from (m.
    //                              1419). No refund AMOUNT is shown because
    //                              none is computed anywhere.
    //   notice_count            -- m. 1434(4), notices in this insurance
    //                              period. Read off p.notice_count, which
    //                              mirrors the token, NOT counted from the
    //                              outbox: a notice served before the
    //                              dispatcher existed still counts.
    //   mortgagee_*             -- m. 1456(4)/(5) reported facts. Nothing
    //                              acts on any of them.
    //   token_live_after_termination -- a terminated contract whose token is
    //                              still live, i.e. sitting in phase two
    //                              waiting on an open payout. The state the
    //                              two-phase design exists to make legible.
    //   predecessor/successor   -- the renewal chain, both directions
    //   chain_gap_days          -- days between a predecessor's term end and
    //                              its successor's term start. 0 =
    //                              contiguous; > 0 = an UNCOVERED window;
    //                              < 0 = an overlap. Nothing in this system
    //                              enforces contiguity, so this exists to
    //                              make a gap visible, not to prevent one.
    //   default_cycle counts    -- so a policy that defaulted and recovered
    //                              does not look identical to one that never
    //                              defaulted
    const sql = await pool.query(
      `SELECT p.id, p.status, p.default_state, p.daml_contract_id, p.updated_at,
              p.start_date, p.end_date, p.expiry,
              p.notice_service_date, p.notice_recorded_at, p.grace_period_days,
              p.notice_count, p.term_start, p.terminated_at, p.unrun_days,
              -- m. 1421. NULL coverage_began_at means cover has not begun:
              -- the contract exists, the insurer's liability does not. A
              -- policy in that state about which nothing has been reported is
              -- INERT -- it cannot be swept (the text gives no basis to end a
              -- contract merely because cover has not started, and inventing
              -- a period is forbidden), so it is surfaced instead, the way the
              -- renewal gap is: visible, flagged, not acted on.
              p.coverage_began_at, p.coverage_start_basis, p.first_premium_paid_at,
              (p.coverage_began_at IS NULL
                 AND p.status NOT IN ('expired', 'cancelled', 'claimed_and_closed'))
                AS cover_not_begun,
              (p.coverage_began_at IS NULL
                 AND p.premium_due_date IS NULL
                 AND p.status NOT IN ('expired', 'cancelled', 'claimed_and_closed'))
                AS inert,
              p.mortgagee_notified_at, p.mortgagee_continuation_ends_at,
              p.mortgagee_election, p.mortgagee_election_at,
              (p.default_state = 'terminated' AND p.daml_contract_id IS NOT NULL)
                AS token_live_after_termination,
              p.last_amendment_reason,
              p.predecessor_policy_id, p.renewed_by_policy_id,
              CASE WHEN p.notice_service_date IS NOT NULL AND p.grace_period_days IS NOT NULL
                   THEN p.notice_service_date + (p.grace_period_days * INTERVAL '1 day')
              END AS grace_ends_at,
              pred.end_date AS predecessor_end_date,
              CASE WHEN pred.end_date IS NOT NULL
                   THEN (p.start_date - pred.end_date)::int - 1
              END AS chain_gap_days,
              COALESCE(h.termination_count, 0)   AS termination_count,
              COALESCE(h.reinstatement_count, 0) AS reinstatement_count,
              h.last_reinstated_at,
              COALESCE(c.sum_insured_total, 0) AS sum_insured,
              COALESCE(c.remaining_limit_total, 0) AS remaining_limit,
              COALESCE(c.coverage_count, 0) AS coverage_count
       FROM policies p
       LEFT JOIN policies pred ON pred.id = p.predecessor_policy_id
       LEFT JOIN (
         SELECT policy_id, SUM(sum_insured) AS sum_insured_total,
                SUM(remaining_limit) AS remaining_limit_total,
                count(*) AS coverage_count
         FROM policy_coverages GROUP BY policy_id
       ) c ON c.policy_id = p.id
       LEFT JOIN (
         SELECT policy_no,
                count(*) FILTER (WHERE event_type = 'termination'   AND status = 'done') AS termination_count,
                count(*) FILTER (WHERE event_type = 'reinstatement' AND status = 'done') AS reinstatement_count,
                max(processed_at) FILTER (WHERE event_type = 'reinstatement' AND status = 'done')
                  AS last_reinstated_at
         FROM policy_events GROUP BY policy_no
       ) h ON h.policy_no = p.id
       ORDER BY p.updated_at DESC`
    );

    // Uncapped, deliberately: the counts below come from their own
    // COUNT(*), so a re-introduced cap would show as a mismatch on screen
    // rather than silently under-reporting.
    // Stage 4: a payout now has a real end, so the interesting set is the
    // UNRESOLVED ones -- still awaiting the insurer's report, or sitting as
    // a review item that has not been closed either way. Ordered oldest
    // first: the age of the oldest open item is the number that matters.
    //
    // age_seconds is elapsed time, nothing more. No default interest, no
    // statutory deadline, no conclusion about lateness is computed, stored,
    // or returned -- the system records timestamps; interpreting them is a
    // lawyer's job.
    const payoutEvents = await pool.query(
      `SELECT id, policy_id, coverage_code, tier_label, payout_amount, currency,
              status, daml_contract_id, review_contract_id,
              bank_reference, settled_at, paid_role, unpaid_reason, resolution_note,
              created_at, resolved_at, updated_at,
              EXTRACT(EPOCH FROM (now() - created_at))::bigint AS age_seconds,
              CASE WHEN resolved_at IS NOT NULL
                   THEN EXTRACT(EPOCH FROM (resolved_at - created_at))::bigint
              END AS resolution_seconds
       FROM payout_events
       ORDER BY (resolved_at IS NULL) DESC, created_at ASC`
    );
    const payoutCounts = await pool.query(
      `SELECT status, count(*)::int AS n FROM payout_events GROUP BY status`
    );
    // Independent COUNT(*)s, not derived from the arrays above. If a list
    // ever gets capped again these stay honest -- the dashboard renders
    // these as the authoritative totals and flags any disagreement.
    const totals = await pool.query(
      `SELECT (SELECT count(*)::int FROM policies)       AS policies,
              (SELECT count(*)::int FROM payout_events)  AS payout_events`
    );

    res.json({
      checkedAt: new Date().toISOString(),
      ledgerEndOffset: ledgerEnd,
      ledger: perInsurer,
      sqlPolicies: sql.rows,
      sqlPayoutEvents: payoutEvents.rows,
      payoutCountsByStatus: Object.fromEntries(payoutCounts.rows.map((r) => [r.status, r.n])),
      sqlTotals: totals.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
