import { Router } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { config } from '../config.js';
import { matchTier } from '../dispatch/tiers.js';
import {
  commandIdFor, exerciseChoice, getLedgerEnd, grantReadAs, listUserRights, queryActiveContracts, revokeUserRights,
} from '../damlClient.js';

export const debugRouter = Router();

// Dev-only live view: what's actually active on the ledger right now, plus
// the current SQL mirror, side by side. Not part of the 4-module business
// API -- purely so a human can watch the system work in real time instead
// of trusting log lines.
//
// Every query in this file is a SELECT; nothing here mutates a table. Two
// routes touch the ledger: /roles-data grants the platform's ledger user a
// temporary read-as right for a role party and revokes it within the request,
// and /roles/try-insurer-trigger submits one command the ledger is expected to
// refuse.
//
// Loopback-only as a floor, not a real access-control policy: this router
// exposes party ids and full contract payloads with zero authentication.
// Delete this whole file (and its mount in app.js) before any
// deployment that isn't literally your own machine's LocalNet.
// It is mounted only when DEBUG_ROUTES_ENABLED is 'true'; unset, it is off.
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
    // needs every policy row to compare against the ledger, and
    // a capped result silently made it look complete when it wasn't (it
    // undercounted real orphans by only checking the most-recently-
    // touched 20 rows).
    // sum_insured/remaining_limit live in policy_coverages (one row per
    // coverage) -- these are policy-level totals across
    // every coverage, derived here for this debug view only, never
    // stored, same principle as the Daml token itself never storing one.
    //
    // Premium-default and renewal fields, all read-only:
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
    // Termination and mortgagee fields, all read-only:
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
    // A payout has a real end, so the interesting set is the
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
    // ever gets capped again these stay honest -- they are the
    // authoritative totals a reader compares the lists against.
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

// The story page's data (public/story.html, served on /debug/story): the last
// 20 payout_events rows, newest first, each with the steps behind it --
// reading, raw response, window, approval, notification, closure -- joined
// from the tables that already hold them. SELECTs only, like everything above.
//
// Built from an explicit whitelist, never a SELECT * spread: no api_key_hash,
// webhook_url, webhook_secret_version, party id, bank_reference, free-text
// field or last_error leaves this handler. attestation_ref carries the
// provider's request URL, so only its evidence hash is passed on. A step with
// nothing recorded is 'not yet' with a null time -- nothing is inferred.
const NETWORK_LABEL = 'Canton LocalNet (local test network)';
// Read off oracleBot.js's own source label at request time, never typed in
// here: while the bot labels its readings STAND-IN, so does the page.
const ORACLE_BOT_SOURCE = new URL('../oracle/oracleBot.js', import.meta.url);
const STAND_IN_MARKER = 'STAND-IN(forecast,not-observation)';
const INTERIM_LABEL = 'interim data source: a forecast service, not a measurement';
// How many evaluated windows the second list shows, matched or not.
const EVALUATED_WINDOW_LIMIT = 10;

const iso = (t) => (t ? new Date(t).toISOString() : null);
// Every step carries what its time IS, not just that a time exists: the
// reading step shows when the value was MEASURED and the evidence step when
// the response was FETCHED, which is why the two can look out of order (a
// forecast is measured for an hour that the fetch then follows). timeKind is
// the column each time was read from, named in plain words.
const step = (key, timeKind, at) => ({ key, timeKind, state: at ? 'done' : 'not yet', at: iso(at) });

// What has to be true for the page to say a payout ran with no human in it:
// every one of the six steps recorded, and no review item or manual-review
// status anywhere. A payout still short of that is 'in progress', and the
// steps still missing are named so the page can say which.
const STEP_MISSING_REASON = {
  reading: 'no reading is recorded',
  evidence: 'no raw response is stored',
  window: 'no event window is recorded',
  approved: 'the ledger has not approved it',
  notified: 'no notification has been delivered',
  settled: 'the insurer has not reported it settled',
};

// A notification's three distinguishable states, as the tables hold them --
// 'pending' means two different things and reading them as one is what made a
// waiting row look identical to a queued one. sender.js's claimNext never
// claims a row whose insurer has no webhook_url, so such a row is not waiting
// its turn: there is nowhere to send it.
function deliveryState(status, insurerHasAddress) {
  if (status === 'delivered') return 'delivered';
  if (status === 'failed') return 'failed';
  if (status === 'processing') return 'sending';
  return insurerHasAddress ? 'queued' : 'no address configured';
}

// sender.js raises attempt_count ONLY on the failure paths; the delivered
// branch never touches it. So the number counts FAILED attempts, and a row
// delivered first time carries 0. The counter is right for what it counts;
// the page says which number it is.
const FAILED_ATTEMPTS_LABEL = 'failed attempts';

// eventWindow.js's aggregate(): min and max have exactly one reading that
// decided the value, and ties are broken by the earliest measurement, then the
// lowest id; a mean has no such reading and says so with null.
const TIE_RULE = 'ties go to the earliest measurement, then the lowest reading id';

// policy_events.error is free text and may name a party or a contract, so it
// is never passed on. Only a code-shaped token is, and 'unclassified' when the
// text holds none.
function refusalCode(error) {
  const m = /\b[A-Z][A-Z0-9_]{3,}\b/.exec(String(error ?? ''));
  return m ? m[0] : 'unclassified';
}

// Which of three things a failed trigger row is, read off the
// shape of its error text and never off its words beyond these markers.
// damlClient.js's interceptor writes the ledger's own answer as "Request
// failed with status code N -- CODE: cause"; the dispatcher's refusals that
// contain "nothing was sent" are filed as not sent, and a pre-submission
// refusal without that phrase falls to the neutral 'failed'; the dispatcher's
// write-back fallback starts "ledger succeeded (...) but write-back failed".
// Any other text (a timeout,
// a fault after the ledger answered) says only that the row failed, since
// whether the ledger saw the command is not recorded in it.
function failedTriggerOutcome(error) {
  const text = String(error ?? '');
  if (/^Request failed with status code \d{3} -- /.test(text)) return 'refused';
  if (/^ledger succeeded \([^)]*\) but write-back failed: /.test(text)) return 'accepted, not recorded';
  if (/\bnothing was sent\b/i.test(text)) return 'not sent';
  return 'failed';
}

function attestationSummary(ref) {
  if (!ref) return null;
  let evidenceSha256 = null;
  try {
    const sha = JSON.parse(ref)?.evidence?.sha256;
    if (typeof sha === 'string') evidenceSha256 = sha;
  } catch { /* not JSON: recorded, with no evidence hash to show */ }
  return { recorded: true, evidenceSha256 };
}

debugRouter.get('/story-data', async (_req, res) => {
  try {
    const interim = fs.readFileSync(ORACLE_BOT_SOURCE, 'utf8').includes(STAND_IN_MARKER);

    const { rows } = await pool.query(
      `SELECT pe.id, pe.record_kind, pe.status, pe.coverage_code,
              left(pe.policy_id::text, 8) AS policy_id_prefix,
              pc.product_code, pc.peril_type,
              COALESCE(tw.cell_id, r.cell_id) AS cell,
              r.value AS reading_value, r.metric AS reading_metric,
              r.measured_at AS reading_measured_at, r.source AS reading_source,
              raw.sha256 AS raw_sha256, raw.fetched_at AS raw_fetched_at,
              tw.window_start, tw.window_end, tw.aggregation, tw.attestation_ref,
              tw.created_at AS window_recorded_at,
              (tw.determining_reading_id IS NOT NULL) AS has_determining_reading,
              cardinality(tw.reading_ids) AS window_reading_count,
              pe.tier_label, pe.payout_percentage, pe.payout_amount, pe.currency, pe.recipient,
              left(pe.daml_contract_id, 12) AS contract_id_prefix, pe.approved_at,
              pe.settled_at, pe.resolved_at, pe.paid_role,
              (pe.review_contract_id IS NOT NULL) AS has_review,
              -- The pipeline's own time: from the instant this payout's window
              -- CLOSED (trigger_windows.window_end) to the approval, as the
              -- ledger stamped it and SQL read it back (approved_at).
              -- NULL where either end is missing; nothing is inferred.
              EXTRACT(EPOCH FROM (pe.approved_at - tw.window_end))::bigint AS pipeline_seconds
       FROM payout_events pe
       LEFT JOIN policy_coverages pc
         ON pc.policy_id = pe.policy_id AND pc.coverage_code = pe.coverage_code
       LEFT JOIN trigger_windows tw ON tw.id = pe.trigger_window_id
       LEFT JOIN oracle_readings r ON r.id = COALESCE(pe.oracle_reading_id, tw.determining_reading_id)
       LEFT JOIN oracle_raw_responses raw ON raw.id = r.raw_response_id
       ORDER BY pe.created_at DESC, pe.id DESC
       LIMIT 20`
    );
    // i.webhook_url is read for its PRESENCE only -- the address itself never
    // leaves this handler -- so a row that has nowhere to go can be told apart
    // from one that is waiting its turn.
    const { rows: notes } = await pool.query(
      `SELECT n.payout_event_id, n.kind, n.status, n.attempt_count, n.delivered_at, n.last_status_code,
              (i.webhook_url IS NOT NULL) AS insurer_has_address
       FROM payout_notifications n
       JOIN insurers i ON i.id = n.insurer_id
       WHERE n.payout_event_id = ANY($1)
       ORDER BY n.created_at, n.id`,
      [rows.map((r) => r.id)]
    );

    const payouts = rows.map((r) => {
      const notifications = notes
        .filter((n) => n.payout_event_id === r.id)
        .map((n) => ({
          kind: n.kind, status: n.status, attemptCount: n.attempt_count,
          attemptCountMeans: FAILED_ATTEMPTS_LABEL,
          delivery: deliveryState(n.status, n.insurer_has_address),
          deliveredAt: iso(n.delivered_at), lastStatusCode: n.last_status_code,
        }));
      const delivered = notifications.map((n) => n.deliveredAt).filter(Boolean).sort();
      const steps = [
        step('reading', 'measured', r.reading_measured_at),
        step('evidence', 'fetched', r.raw_fetched_at),
        step('window', 'window recorded', r.window_recorded_at),
        step('approved', 'approved', r.approved_at),
        step('notified', 'notified', delivered[0] ?? null),
        step('settled', 'closed', r.resolved_at),
      ];
      const human = r.status === 'manual_review' || r.record_kind !== 'payout' || r.has_review
        || notifications.some((n) => n.kind === 'review_required');
      const path = human ? 'human' : steps.every((s) => s.state === 'done') ? 'automatic' : 'in progress';
      const missing = steps.filter((s) => s.state !== 'done').map((s) => STEP_MISSING_REASON[s.key]);
      const pathReason = path === 'automatic'
        ? 'every step is recorded and no human decision was asked for'
        : path === 'human'
          ? 'a human decision was asked for on this record'
          : `not every step is recorded yet: ${missing.join('; ')}`;
      return {
        recordKind: r.record_kind,
        status: r.status,
        policy: {
          idPrefix: r.policy_id_prefix, productCode: r.product_code, perilType: r.peril_type,
          coverageCode: r.coverage_code, cell: r.cell,
        },
        reading: {
          state: steps[0].state, value: r.reading_value, metric: r.reading_metric,
          measuredAt: iso(r.reading_measured_at), sourceLabel: r.reading_source,
          // Why there is no single reading to show, when there is none: a mean
          // has no deciding reading at all (eventWindow.js returns null for
          // one), which is a different thing from a payout that has not read
          // anything yet.
          kind: r.has_determining_reading ? 'determining'
            : r.aggregation === 'mean' ? 'none for a mean' : 'absent',
          note: r.has_determining_reading || r.aggregation !== 'mean' ? null
            : `mean of ${r.window_reading_count} readings; no single determining reading`,
        },
        evidence: { state: steps[1].state, sha256: r.raw_sha256, fetchedAt: iso(r.raw_fetched_at) },
        window: {
          state: steps[2].state, start: iso(r.window_start), end: iso(r.window_end),
          aggregation: r.aggregation, attestation: attestationSummary(r.attestation_ref),
          readingCount: r.window_reading_count, tieRule: r.aggregation === 'mean' ? null : TIE_RULE,
        },
        approval: {
          state: steps[3].state, tierLabel: r.tier_label, percentage: r.payout_percentage,
          amount: r.payout_amount, currency: r.currency, recipientRole: r.recipient,
          contractIdPrefix: r.contract_id_prefix, approvedAt: iso(r.approved_at),
        },
        notifications,
        closure: {
          state: steps[5].state, status: r.status, settledAt: iso(r.settled_at),
          resolvedAt: iso(r.resolved_at), paidRole: r.paid_role,
        },
        steps,
        path,
        pathReason,
        pipelineSeconds: r.pipeline_seconds === null || r.pipeline_seconds === undefined
          ? null : Number(r.pipeline_seconds),
      };
    });

    // The evaluations nothing came of. payout_events holds only the windows
    // that PAID, so a window evaluated to no match -- the ordinary case, and
    // the one a demo otherwise cannot show -- was invisible on this page.
    // Same whitelist discipline: no party id, no address, no free text; a
    // refusal is passed on as a code shape only (refusalCode).
    const { rows: evaluated } = await pool.query(
      `SELECT left(tw.policy_id::text, 8) AS policy_id_prefix, tw.coverage_code,
              tw.window_start, tw.window_end, tw.aggregation, tw.metric,
              tw.aggregated_value, cardinality(tw.reading_ids) AS reading_count,
              tw.created_at AS window_recorded_at,
              ev.status::text AS outbox_status, ev.error AS outbox_error,
              paid.legs, paid.tier_label
         FROM trigger_windows tw
         LEFT JOIN policy_events ev
           ON ev.trigger_window_id = tw.id AND ev.event_type = 'trigger'
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS legs, min(pe.tier_label) AS tier_label
             FROM payout_events pe WHERE pe.trigger_window_id = tw.id
         ) paid ON TRUE
        ORDER BY tw.created_at DESC
        LIMIT $1`,
      [EVALUATED_WINDOW_LIMIT]
    );
    const evaluations = evaluated.map((e) => {
      const outcome = e.legs > 0 ? 'matched'
        : e.outbox_status === 'failed' ? failedTriggerOutcome(e.outbox_error)
          : e.outbox_status === 'done' ? 'no tier matched'
            : e.outbox_status ? 'not evaluated yet' : 'no trigger queued';
      return {
        policyIdPrefix: e.policy_id_prefix,
        coverageCode: e.coverage_code,
        windowStart: iso(e.window_start), windowEnd: iso(e.window_end),
        recordedAt: iso(e.window_recorded_at),
        aggregation: e.aggregation, metric: e.metric, value: e.aggregated_value,
        readingCount: e.reading_count,
        outcome,
        tierLabel: outcome === 'matched' ? e.tier_label : null,
        payoutLegs: e.legs,
        refusalCode: outcome === 'refused' ? refusalCode(e.outbox_error) : null,
      };
    });

    res.json({
      checkedAt: new Date().toISOString(),
      header: {
        network: NETWORK_LABEL,
        packageIdPrefix: config.daml.packageId.slice(0, 12),
        dataSource: { interim, label: interim ? INTERIM_LABEL : null },
      },
      payouts,
      evaluations,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The roles page's data (public/roles.html, served on /debug/roles):
// one policy as the LEDGER returns it to four parties -- the
// insurer, the policyholder, the mortgagee, and another insurer that has
// nothing to do with it. Each column is a query sent as that party and counted
// off what came back; nothing here says who should see what, the participant
// does.
//
// The platform's ledger user holds no read right for a role party (see
// allocateParty in damlClient.js), so each read that needs one grants a
// CanReadAs for that party, reads, and revokes it in a finally, whether the
// read succeeded or not. Only what the grant NEWLY added is revoked: a right
// held before the request stays held. The count of the user's rights is read
// before and after and both are returned; if they differ, the response and the
// log say so. One request at a time -- two at once would revoke each other's
// grants mid-read -- so a second request is turned away, not queued.
//
// Party ids never leave in full: a hint prefix only. createArgument is never
// spread: each template's summary is an explicit whitelist.
const ROLE_TEMPLATES = [
  ['Insurance.PolicyToken', 'PolicyToken', 'policyNo'],
  ['Insurance.PayoutBridge', 'PayoutApproved', 'policyId'],
  ['Insurance.PayoutBridge', 'ManualReviewRequired', 'policyId'],
  // v22: the records a settlement or a close-unpaid leaves.
  ['Insurance.PayoutBridge', 'PayoutSettled', 'policyId'],
  ['Insurance.PayoutBridge', 'PayoutClosedUnpaid', 'policyId'],
];
const RIGHTS_RECOVERY = 'a maintenance script kept outside this repository';

const partyPrefix = (p) => `${String(p).split('::')[0].slice(0, 20)}::…`;
const shortenParties = (text) =>
  String(text).replace(/([A-Za-z0-9_.-]*)::[0-9a-f]{16,}/g, (_m, hint) => `${hint.slice(0, 20)}::…`);

// The fixed kind of a review item's reason. The reason itself is either the
// salted digest ('sha256:...') of the free text the insurer supplied when
// marking a payout failed, or a sentence the Daml writes; neither is passed on.
// The prefixes below are the Daml sentences' text, so a reworded sentence (a
// new package) lands in 'marked_failed'; the other places matched on text are
// listed above FAILURE_REASONS in notifications/policyRecord.js.
function reviewReasonKind(reason) {
  if (reason.startsWith('m. 1456 and m. 1457 both bite')) return 'competing_claims';
  if (reason.startsWith('m. 1456(2):')) return 'mortgagee_surplus';
  return 'marked_failed';
}

function contractSummary(entityName, c) {
  const a = c.createArgument;
  const base = { template: entityName, contractIdPrefix: c.contractId.slice(0, 12) };
  if (entityName === 'PolicyToken') {
    return {
      ...base,
      status: a.status,
      defaultState: a.defaultState,
      expiry: a.expiry,
      coverages: (a.coverages ?? []).map((cv) => ({ coverageCode: cv.coverageCode, remainingLimit: cv.remainingLimit })),
    };
  }
  if (entityName === 'PayoutApproved') {
    return { ...base, amount: a.amount, currency: a.currency, recipientRole: a.recipient, approvedAt: a.approvedAt };
  }
  // The two records carry digests, not the bank reference or the note; the
  // digests are not passed on either.
  if (entityName === 'PayoutSettled') {
    return { ...base, amount: a.amount, currency: a.currency, recipientRole: a.recipient, settledAt: a.settledAt, recordedAt: a.recordedAt };
  }
  if (entityName === 'PayoutClosedUnpaid') {
    return { ...base, amount: a.amount, currency: a.currency, recipientRole: a.recipient ?? null, unpaidReason: a.unpaidReason, closedAt: a.closedAt, recordedAt: a.recordedAt };
  }
  return { ...base, amount: a.amount, currency: a.currency, reasonKind: reviewReasonKind(a.reason ?? '') };
}

const listMaxReached = (err) =>
  err.response?.status === 413 || /JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED/.test(err.message);

// Reads the policy's contracts as one party. A grant can take a moment to reach
// the participant's authorization check, so a 403 is retried; nothing else is.
async function readAs(party, policyId, query) {
  const queries = [];
  const contracts = [];
  for (const [moduleName, entityName, field] of ROLE_TEMPLATES) {
    let entries;
    for (let attempt = 1; ; attempt += 1) {
      try {
        entries = await query({ moduleName, entityName, parties: [party] });
        break;
      } catch (err) {
        if (err.response?.status !== 403 || attempt >= 10) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const mine = entries
      .map((e) => e.contractEntry.JsActiveContract.createdEvent)
      .filter((c) => c.createArgument?.[field] === policyId);
    queries.push({ template: entityName, returned: mine.length });
    contracts.push(...mine.map((c) => contractSummary(entityName, c)));
  }
  return { queries, contracts };
}

const rightParty = (r) => r.kind?.CanActAs?.value?.party ?? r.kind?.CanReadAs?.value?.party;
const rightKind = (r) => Object.keys(r.kind ?? {})[0];

// Exported for the test that makes a read fail after its grant, to show the
// grant is still taken back. The route below is the only other caller.
export async function readPolicyAsRoles(policyId, { query = queryActiveContracts } = {}) {
  const user = config.daml.unsafeJwtSub;
  const { rows: [policy] } = await pool.query(
    `SELECT p.id, p.insurer_id, i.canton_party_id AS insurer_party,
            ph.canton_party_id AS holder_party, mg.canton_party_id AS mortgagee_party
       FROM policies p
       JOIN insurers i ON i.id = p.insurer_id
       JOIN policyholders ph ON ph.id = p.policyholder_id
       LEFT JOIN policyholders mg ON mg.id = p.mortgagee_policyholder_id
      WHERE p.id = $1`,
    [policyId]
  );
  if (!policy) return null;
  // An insurer whose legal name contains "Outsider" is preferred -- the one
  // onboarded to play this column -- and any other the fallback, as before.
  const { rows: [outsider] } = await pool.query(
    `SELECT canton_party_id FROM insurers
      WHERE id <> $1 AND canton_party_status = 'ALLOCATED' AND canton_party_id IS NOT NULL
        AND canton_party_id <> $2
      ORDER BY (legal_name LIKE '%Outsider%') DESC, created_at, id LIMIT 1`,
    [policy.insurer_id, policy.insurer_party ?? '']
  );

  const roles = [
    { role: 'issuer', label: 'Insurer', party: policy.insurer_party, absent: 'this insurer holds no party yet' },
    { role: 'holder', label: 'Policyholder', party: policy.holder_party, absent: 'the policyholder holds no party yet (the policy is not minted)' },
    { role: 'observer', label: 'Mortgagee', party: policy.mortgagee_party, absent: 'no mortgagee on this policy' },
    { role: 'outsider', label: 'Another insurer', party: outsider?.canton_party_id, absent: 'no other insurer onboarded' },
  ];

  const held = await listUserRights(user);
  const rightsBefore = held.length;
  const out = [];
  const revokeFailures = [];
  for (const r of roles) {
    const column = { role: r.role, label: r.label };
    out.push(column);
    if (!r.party) {
      Object.assign(column, { partyIdPrefix: null, absent: r.absent, contracts: [], queries: [], readAccess: null });
      continue;
    }
    column.partyIdPrefix = partyPrefix(r.party);
    const already = held.find((h) => rightParty(h) === r.party);
    column.readAccess = { granted: false, heldBefore: already ? rightKind(already) : null, revoked: false };
    let granted = [];
    try {
      if (!already) {
        try {
          granted = await grantReadAs(user, r.party);
        } catch (err) {
          column.contracts = [];
          column.queries = [];
          column.error = /TOO_MANY_USER_RIGHTS/.test(err.message)
            ? 'the ledger refused a temporary read right: the platform\'s ledger user is at its rights cap (TOO_MANY_USER_RIGHTS); nothing was read as this party'
            : `the ledger refused a temporary read right (${err.response?.status ?? 'no status'} ${err.response?.data?.code ?? ''}); nothing was read as this party`;
          continue;
        }
        column.readAccess.granted = granted.length > 0;
      }
      const { queries, contracts } = await readAs(r.party, policyId, query);
      Object.assign(column, { queries, contracts });
    } catch (err) {
      column.contracts = [];
      column.queries = column.queries ?? [];
      column.error = listMaxReached(err)
        ? 'the participant refused this read: this party has more active contracts than one read may return (its list limit); this column cannot be shown'
        : `the read as this party failed: ${shortenParties(err.message).slice(0, 300)}`;
    } finally {
      if (granted.length > 0) {
        try {
          const revoked = await revokeUserRights(user, granted);
          column.readAccess.revoked = revoked.length === granted.length;
          if (!column.readAccess.revoked) revokeFailures.push(`${r.role}: asked to revoke ${granted.length}, the ledger revoked ${revoked.length}`);
        } catch (err) {
          revokeFailures.push(`${r.role}: ${shortenParties(err.message).slice(0, 300)}`);
        }
      }
    }
  }
  const rightsAfter = (await listUserRights(user)).length;

  let rightsWarning = null;
  if (rightsAfter !== rightsBefore || revokeFailures.length) {
    rightsWarning =
      `RIGHTS NOT RESTORED: the platform's ledger user held ${rightsBefore} rights before this read and ${rightsAfter} after` +
      (revokeFailures.length ? `; revoke failed for ${revokeFailures.join('; ')}` : '') +
      `. Another process granting or revoking at the same time also changes the count. Recovery: ${RIGHTS_RECOVERY}.`;
    console.error(`[debug/roles-data] ${rightsWarning}`);
  }

  return {
    checkedAt: new Date().toISOString(),
    policyIdPrefix: policyId.slice(0, 8),
    rightsBefore,
    rightsAfter,
    rightsWarning,
    roles: out,
  };
}

let rolesReadInProgress = false;

debugRouter.get('/roles-data', async (req, res) => {
  const policyId = req.query.policyId;
  if (!policyId) {
    try {
      const { rows } = await pool.query(
        `SELECT p.id AS "policyId", p.status, (p.mortgagee_policyholder_id IS NOT NULL) AS "hasMortgagee",
                p.updated_at AS "updatedAt"
           FROM policies p
          WHERE p.daml_contract_id IS NOT NULL
          ORDER BY p.updated_at DESC
          LIMIT 20`
      );
      return res.json({ policies: rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(policyId)) {
    return res.status(400).json({ error: 'policyId must be a UUID' });
  }
  if (rolesReadInProgress) {
    return res.status(409).json({ error: 'another roles read is in progress' });
  }
  rolesReadInProgress = true;
  try {
    const result = await readPolicyAsRoles(policyId);
    if (!result) return res.status(404).json({ error: 'no such policy' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: shortenParties(err.message) });
  } finally {
    rolesReadInProgress = false;
  }
});

// The insurer tries to evaluate its own policy's trigger. The ledger is
// expected to refuse it: PolicyToken_EvaluateTrigger's controller is the
// oracle operator. Same choice, same argument shape as handleTrigger in
// dispatcher.js, submitted as the insurer.
//
// Guards, all before anything is sent: the value is one that no frozen tier on
// the token matches, so even an accepted command would evaluate to no match
// and create nothing; if no such value exists, nothing is sent. Nothing is
// written to SQL -- no outbox row, no reading, no evidence row. The command id
// carries a "debug-" prefix.
//
// v22. Whether a candidate matches is decided by tiers.js's matchTier -- the
// ledger's own inRange, in its Decimal arithmetic -- on the exact string that
// is sent, so the guard cannot disagree with the ledger at a tier's edge.
function unmatchedValue(coverages) {
  const tiers = coverages.flatMap((c) => c.payoutTiers ?? []);
  const bound = (v) => (v === null || v === undefined ? null : Number(v));
  const edges = [...new Set(tiers.flatMap((t) => [bound(t.minValue), bound(t.maxValue)]).filter((v) => v !== null))]
    .sort((a, b) => a - b);
  const candidates = edges.length
    ? [edges[0] - 1, edges[edges.length - 1] + 1, ...edges.slice(1).map((e, i) => (edges[i] + e) / 2)]
    : [0];
  return candidates.find((x) => Number.isFinite(x) && !matchTier(tiers, x.toFixed(4))) ?? null;
}

const PROBE_ATTESTATION = 'debug: the insurer tries its own trigger; not an attestation';

debugRouter.post('/roles/try-insurer-trigger', async (req, res) => {
  const policyId = req.body?.policyId;
  if (typeof policyId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(policyId)) {
    return res.status(400).json({ error: 'policyId must be a UUID' });
  }
  try {
    const { rows: [policy] } = await pool.query(
      `SELECT p.currency, i.canton_party_id AS insurer_party
         FROM policies p JOIN insurers i ON i.id = p.insurer_id WHERE p.id = $1`,
      [policyId]
    );
    if (!policy) return res.status(404).json({ error: 'no such policy' });
    if (!policy.insurer_party) return res.status(409).json({ sent: false, reason: 'the insurer holds no party' });

    const tokens = (await queryActiveContracts({
      moduleName: 'Insurance.PolicyToken', entityName: 'PolicyToken', parties: [policy.insurer_party],
    }))
      .map((e) => e.contractEntry.JsActiveContract.createdEvent)
      .filter((c) => c.createArgument?.policyNo === policyId);
    if (tokens.length !== 1) {
      return res.status(409).json({ sent: false, reason: `the ledger holds ${tokens.length} current tokens for this policy as the insurer sees it; exactly one is needed` });
    }
    const token = tokens[0];
    const coverages = token.createArgument.coverages ?? [];
    const value = unmatchedValue(coverages);
    const oracleOperatorDistinctFromInsurer = token.createArgument.oracleOperator !== policy.insurer_party;
    if (value === null || !coverages.length) {
      return res.json({
        sent: false,
        reason: 'no value lies outside every frozen tier on this token, so no command was sent',
        oracleOperatorDistinctFromInsurer,
      });
    }

    try {
      await exerciseChoice({
        commandId: commandIdFor('debug'),
        moduleName: 'Insurance.PolicyToken',
        entityName: 'PolicyToken',
        contractId: token.contractId,
        choice: 'PolicyToken_EvaluateTrigger',
        actAs: [policy.insurer_party],
        // v22. The trigger's v22 arguments, each well formed and taken from the
        // token where the token has it -- the coverage's own metric and cell
        // commitment, a digest of this probe's own text, an hour that has
        // ended -- so that the insurer's signature is the refusal's only
        // cause. The metric used to be a marker (DEBUG_INSURER_ATTEMPT); since
        // v22 the choice refuses a metric other than the coverage's, which
        // would be a second cause.
        argument: {
          selfContractId: token.contractId,
          coverageCode: coverages[0].coverageCode,
          observedValue: value.toFixed(4),
          metric: coverages[0].metric,
          attestationRef: PROBE_ATTESTATION,
          currency: policy.currency,
          eventStart: new Date(Date.now() - 3600000).toISOString(),
          eventEnd: new Date(Date.now() - 1000).toISOString(),
          cellCommitment: coverages[0].cellCommitment,
          evidenceDigest: `sha256:${crypto.createHash('sha256').update(PROBE_ATTESTATION).digest('hex')}`,
        },
      });
    } catch (err) {
      const body = err.response?.data;
      return res.json({
        sent: true,
        refused: true,
        ledgerStatus: err.response?.status ?? null,
        ledgerCode: body?.code ?? null,
        message: shortenParties(body?.cause ?? err.message).slice(0, 500),
        observedValueSent: value.toFixed(4),
        oracleOperatorDistinctFromInsurer,
      });
    }
    console.error(`[debug/roles] the ledger ACCEPTED PolicyToken_EvaluateTrigger submitted as the insurer for policy ${policyId.slice(0, 8)}: the insurer is acting as its own oracle`);
    res.json({ sent: true, refused: false, observedValueSent: value.toFixed(4), oracleOperatorDistinctFromInsurer });
  } catch (err) {
    res.status(500).json({ error: shortenParties(err.message) });
  }
});
