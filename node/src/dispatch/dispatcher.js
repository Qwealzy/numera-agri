import { pathToFileURL } from 'node:url';
import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { allocateParty, commandIdFor, createContract, exerciseChoice, getLedgerEnd } from '../damlClient.js';
import { enqueuePayoutNotification } from '../notifications/enqueue.js';

// ---------------------------------------------------------------------------
// Every ledger-changing action in this system enters through the
// `policy_events` outbox and is processed here. No other code path may
// submit a command to the ledger -- oracleBot.js and payoutListener.js
// (Stage 2 Part 1) only read the ledger and write outbox rows now. This
// map is the single place that says which event type does which ledger
// action -- read top to bottom to see the whole system's write surface:
//
//   activation  -> create PolicyToken                                    [implemented]
//   trigger     -> PolicyToken_EvaluateTrigger                           [implemented]
//   settlement  -> PayoutApproved_MarkFailed (every payout, in this stage) [implemented]
//   expiry      -> PolicyToken_ArchiveForExpiry (archive, no re-mint)      [implemented]
//   notice        -> PolicyToken_ServeNotice (-> grace period)             [implemented]
//   termination         -> PolicyToken_Terminate (notice period elapsed ->
//                          contract TERMINATED, TTK 1434(3))              [implemented]
//   termination_archive -> PolicyToken_ArchiveForNonPayment (token burned
//                          once every payout on it is resolved)           [implemented]
//   mortgagee_notice    -> PolicyToken_RecordMortgageeNotice (m. 1456(4))  [implemented]
//   mortgagee_election  -> PolicyToken_RecordMortgageeElection (m.1456(5)) [implemented]
//   reinstatement -> PolicyToken_Reinstate (payment arrived -> resumes)    [implemented]
//   endorsement   -> PolicyToken_Amend (terms change, version++, reason)   [implemented]
//   renewal       -> mint a NEW policy w/ predecessorRef; predecessor untouched [implemented]
//   release     -> evidence only, no ledger action                        [not implemented]
//
// The outbox row is a REQUEST, never permission -- what actually
// authorizes a ledger change is the `insurer` (or `oracleOperator`) Party
// signing the create/exercise on the ledger itself. Nothing here weakens
// or bypasses that; the Daml signatory/controller check is the last line
// of defence and holds even if this dispatcher (or SQL) is wrong.
//
// Each handler returns { contractId, commandId, writeBack }: contractId
// and commandId identify what actually happened on the ledger (needed
// even on write-back failure, so a human can find and reconcile the real
// state); writeBack(txClient) is the handler's own SQL mutation, run
// inside processEvent's single write-back transaction -- handlers don't
// share one update shape, because they don't touch the same tables
// (activation/trigger mutate `policies`; settlement only mutates
// `payout_events`).
// ---------------------------------------------------------------------------
export const EVENT_HANDLERS = {
  activation: handleActivation,
  trigger: handleTrigger,
  settlement: handleSettlement,
  expiry: handleExpiry,
  notice: handleNotice,
  termination: handleTermination,
  termination_archive: handleTerminationArchive,
  mortgagee_notice: handleMortgageeNotice,
  mortgagee_election: handleMortgageeElection,
  // m. 1434(2), the FIRST-premium mechanism. Separate entries from the
  // notice/termination ones above on purpose: different article, different
  // consequence, different vocabulary.
  premium_due_date: handlePremiumDueDate,
  enforcement_commenced: handleEnforcementCommenced,
  // m. 1431(4). Three types, because they are three distinct acts with three
  // distinct consequences and none may be inferred from another.
  // m. 1456(6). The request is the mortgagee's act as reported by the
  // insurer; the response is the insurer's own. Two types, because they are
  // two acts and the gap between them is the state worth surfacing.
  // m. 1434(4). The election is an act the insurer reports; the landing is a
  // consequence a sweeper observes, exactly like the m. 1434(3) termination.
  // m. 1457. Two acts, both reported -- the platform cannot observe an icra
  // file.
  attachment: handleAttachment,
  attachment_lifted: handleAttachmentLifted,
  two_notice_election: handleTwoNoticeElection,
  two_notice_termination: handleTwoNoticeTermination,
  mortgagee_info_request: handleMortgageeInfoRequest,
  mortgagee_info_provided: handleMortgageeInfoProvided,
  enforcement_fruitless: handleEnforcementFruitless,
  substitution_notice: handleSubstitutionNotice,
  substitution: handleSubstitution,
  first_premium_paid: handleFirstPremiumPaid,
  first_premium_withdrawal: makeWithdrawalHandler('WP_InsurerWithdrew'),
  first_premium_deemed_withdrawal: makeWithdrawalHandler('WP_DeemedNoEnforcement'),
  reinstatement: handleReinstatement,
  endorsement: handleEndorsement,
  renewal: handleRenewal,
  release: notImplemented,
  // migration 013 removed suspension; the enum value cannot be dropped, so a row of this type is refused explicitly rather than crashing on an undefined handler (2026-09-17)
  suspension: notImplemented,
};

async function notImplemented(event) {
  throw new Error(`event type '${event.event_type}' is not implemented in stage 1`);
}

// Daml's PolicyStatus constructors -> SQL's policy_status enum values. The
// two vocabularies are kept in sync by hand (there is no shared
// definition); this map is the one place that translation happens, so a
// status added on one side without the other shows up as a loud
// unrecognized-status error rather than a silent mismatch. Only the states
// a re-mint can actually land in are listed -- the burn states
// (expired/cancelled/claimed_and_closed) never appear on a re-minted
// token, since those paths archive without creating one.
const DAML_STATUS_TO_SQL = {
  PS_Active: 'active',
  PS_PartiallyPaid: 'partially_paid',
  PS_ManualReview: 'manual_review',
};

// The second, orthogonal axis (Stage 3 Part 3). PS_GracePeriod/PS_Suspended
// used to sit in the map above; they are DefaultState constructors now, not
// PolicyStatus ones, and translate through here instead. Keeping the two
// maps separate is what makes a status accidentally written to the wrong
// axis an unrecognized-value error rather than a silent mis-write.
const DAML_DEFAULT_STATE_TO_SQL = {
  DS_None: 'none',
  DS_GracePeriod: 'grace_period',
  DS_Terminated: 'terminated',
  // m. 1434(2). Its own vocabulary, not folded into the two above.
  DS_FirstPremiumUnpaid: 'first_premium_unpaid',
  DS_WithdrawnForFirstPremium: 'withdrawn_for_first_premium',
};

// Which predecessor statuses a renewal may be built on (Stage 3 Part 4).
// 'expired' is in the list on purpose and is in fact the NORMAL case -- a
// policy that ran its full term and lapsed is the ordinary thing to renew.
// 'claimed_and_closed' is deliberately absent: its limits were exhausted by
// payout and the period is finished. The premium-default axis is checked
// separately (a policy in grace or terminated for non-payment cannot be
// renewed at all, whatever its claim status).
const RENEWABLE_STATUSES = new Set(['active', 'partially_paid', 'expired']);

// Daml's EndorsementReason constructors -> SQL's endorsement_reason enum
// (Stage 3 Part 3). Same hand-kept-in-sync arrangement as the two maps
// above; an unmapped reason surfaces as a loud failure in
// handleEndorsement rather than a NULL written into the column.
const DAML_REASON_TO_SQL = {
  ER_SumInsuredIncrease: 'sum_insured_increase',
  ER_SumInsuredReduction: 'sum_insured_reduction',
  ER_InsuredObjectChange: 'insured_object_change',
  ER_TierChange: 'tier_change',
  ER_Correction: 'correction',
};

// Shared by every handler whose choice archives-and-re-mints and returns
// the new ContractId directly (ServeNotice/Terminate/Reinstate/the two
// mortgagee recorders --
// EvaluateTrigger's richer result shape needs its own handling, and
// ArchiveForExpiry re-mints nothing at all). Pulls the new contract id out
// of the exercise result and the new version off that same contract's own
// CreatedEvent in the same flat events array -- never by incrementing the
// old SQL value blind, which is exactly the SQL-vs-ledger drift Stage 2
// Part 1 existed to fix.
function readReMintResult(responseData, choiceName, event) {
  const commandId = responseData?.transaction?.commandId;
  const events = responseData?.transaction?.events ?? [];
  const exercised = events.find((e) => e.ExercisedEvent?.choice === choiceName);
  const newContractId = exercised?.ExercisedEvent?.exerciseResult;
  if (!newContractId) {
    throw new Error(`no exerciseResult (new contract id) found for ${choiceName} on event ${event.id}`);
  }
  const newPayload = events.find(
    (e) => e.CreatedEvent?.contractId === newContractId && e.CreatedEvent?.templateId?.endsWith(':PolicyToken')
  )?.CreatedEvent?.createArgument;
  return {
    commandId,
    newContractId,
    newVersion: newPayload ? Number(newPayload.version) : null,
    newPayload,
  };
}

// One Party per policyholder (never per policy), reused across every
// policy that policyholder ever has. FOR UPDATE holds a row lock for the
// duration of the allocation so two concurrent activations for the same
// policyholder can't both observe "no party yet" and both allocate one.
// Serves every role, not only the policyholder: mortgagee and beneficiary
// are rows in the same `policyholders` registry, so a bank named on four
// hundred policies allocates ONE party and reuses it, and a person holding
// two roles on one policy gets ONE party. That reuse is what keeps this off
// the participant's 1000-rights ceiling.
//
// The party hint stays `ph-<uuid>` for every role. It is opaque on purpose:
// party ids are visible to every participant that observes the contract, so
// the hint carries no name, no national id or its hash, no institution, no
// policy number -- and deliberately not the role either.
async function ensurePolicyholderParty(policyholderId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM policyholders WHERE id = $1 FOR UPDATE', [
      policyholderId,
    ]);
    const policyholder = rows[0];
    if (policyholder.canton_party_id) {
      return policyholder.canton_party_id;
    }
    const partyId = await allocateParty(`policyholder:${policyholderId}`, `ph-${policyholderId}`);
    await client.query(
      `UPDATE policyholders SET canton_party_id = $1, canton_party_status = 'ALLOCATED' WHERE id = $2`,
      [partyId, policyholderId]
    );
    return partyId;
  });
}

// Turkish market convention (confirmed, not an engineering default): a
// policy's term runs from noon local time on startDate to noon local time
// on endDate, Europe/Istanbul -- so a policy's last covered night runs
// through to noon on its end date, not midnight. This is the single place
// the API's date input (a plain YYYY-MM-DD) becomes the token's absolute
// `expiry`/`coverageValidThrough` instant; both are derived from the same
// source value (policy.end_date) so they cannot disagree about which
// calendar day a night-time event falls on.
//
// Uses the IANA zone name rather than a hardcoded +03:00 offset, so this
// stays correct if Turkey's DST rules are ever revised again (they have
// changed more than once historically, even though the zone has been
// fixed UTC+3 with no DST since 2016).
const POLICY_TERM_ZONE = 'Europe/Istanbul';
const POLICY_TERM_LOCAL_HOUR = 12;

// pg's default DATE parser builds the JS Date from LOCAL calendar
// components, not UTC ones -- reading it back with the UTC getters (e.g.
// `.toISOString().slice(0, 10)`, what this file used before this fix)
// silently shifts the date by a day on any machine not already running in
// UTC. The local getters used here are the exact inverse of how the value
// was constructed, so they recover the true stored date regardless of the
// process's own timezone.
export function pgDateToDateString(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Date.UTC reads a year from 0 to 99 as 1900 + year, so a term dated 0026 was
// minted as an instant in 1926. setUTCFullYear takes the year as given.
function utcMillis(year, monthIndex, day, hour, minute, second) {
  const t = new Date(0);
  t.setUTCFullYear(year, monthIndex, day);
  return t.setUTCHours(hour, minute, second, 0);
}

// Converts a local wall-clock time (given as calendar components, in
// POLICY_TERM_ZONE) into the absolute UTC instant it represents. Standard
// Intl-only technique: format a first-guess UTC instant back into the
// target zone, measure how far off the wall-clock result is, and correct
// by that difference -- converges in one step for any zone that isn't
// mid-DST-transition at this exact moment, which Europe/Istanbul never is.
export function policyTermInstant(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const guessUtcMillis = utcMillis(year, month - 1, day, POLICY_TERM_LOCAL_HOUR, 0, 0);
  const zonedParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: POLICY_TERM_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(guessUtcMillis))
      .map((p) => [p.type, p.value])
  );
  const zonedAsUtcMillis = utcMillis(
    Number(zonedParts.year),
    Number(zonedParts.month) - 1,
    Number(zonedParts.day),
    Number(zonedParts.hour),
    Number(zonedParts.minute),
    Number(zonedParts.second)
  );
  const offsetMillis = zonedAsUtcMillis - guessUtcMillis;
  return new Date(guessUtcMillis - offsetMillis).toISOString();
}

// Stage 3 Part 2 (Change D): the grace period is configuration, never a
// literal. A policy's own grace_period_days wins; the insurer's
// default_grace_period_days is the fallback; if NEITHER is set this throws
// rather than assuming a number -- the statutory minimum is a legally
// constrained value that has been revised more than once, so guessing it
// in code would be inventing a legal figure. Resolved once, at activation,
// and frozen onto the policy row, so a later change to the insurer default
// never retroactively moves an already-activated policy's deadline (same
// snapshot-at-mint principle as payout_tiers).
// TTK 6102 m. 1434(3) fixes the notice period at TEN DAYS. m. 1452(3) makes
// m. 1434 non-derogable to the DETRIMENT of the sigorta ettiren, sigortalı
// or lehtar -- so a longer period is a permissible variation in their
// favour, and a shorter one is not: it would simply not apply, and the
// Code's ten days would govern instead.
//
// The configured value is therefore still configuration (never a literal
// default anywhere, never assumed if unset) but it has a FLOOR, and a value
// below it is rejected rather than silently applied. Ten appears here only
// as that floor, with the article that sets it.
const STATUTORY_MIN_GRACE_PERIOD_DAYS = 10;

function resolveGracePeriodDays(policy) {
  const days = policy.grace_period_days ?? policy.insurer_default_grace_period_days;
  if (days === null || days === undefined) {
    throw new Error(
      `no grace period configured for policy ${policy.id}: set policies.grace_period_days or ` +
        `insurers.default_grace_period_days -- refusing to assume a statutory value`
    );
  }
  if (days < STATUTORY_MIN_GRACE_PERIOD_DAYS) {
    throw new Error(
      `grace period of ${days} day(s) configured for policy ${policy.id} is below the ` +
        `${STATUTORY_MIN_GRACE_PERIOD_DAYS}-day notice period TTK 6102 m. 1434(3) requires. A shorter ` +
        `period is a variation to the detriment of the sigorta ettiren/sigortalı/lehtar, which ` +
        `m. 1452(3) does not permit -- it would not apply, and the Code's period would govern. ` +
        `Configure ${STATUTORY_MIN_GRACE_PERIOD_DAYS} or more`
    );
  }
  return days;
}

// The event window rule (migration 030), frozen onto the policy at activation
// the way grace_period_days is: the policy's own value wins, the insurer's
// default is the fallback, and the result is written back so a later change to
// that default never alters how an already-issued policy is evaluated.
//
// Unlike resolveGracePeriodDays this does NOT throw when nothing is set. An
// unset window refuses the TRIGGER, not the activation: oracleBot.js reads
// only these frozen columns, and a policy frozen with NULLs is never
// triggered, with the reason logged each time a window would have closed.
function frozenEventWindow(policy) {
  return {
    timezone: policy.event_window_timezone ?? policy.insurer_default_event_window_timezone ?? null,
    startHour: policy.event_window_start_hour ?? policy.insurer_default_event_window_start_hour ?? null,
    aggregation: policy.event_aggregation ?? policy.insurer_default_event_aggregation ?? null,
  };
}

// m. 1421: why the insurer's liability began. Only the agreed basis is ever
// accepted from the API -- the payment basis is set by the handler that
// records the payment, never supplied by a caller.
const COVERAGE_START_BASES = new Set(['CSB_PremiumPaid', 'CSB_AgreedWithoutPayment']);

// Daml MortgageeElection constructors accepted from the API (m. 1456(5)).
const MORTGAGEE_ELECTIONS = new Set(['ME_Continue', 'ME_Decline']);

// ---------------------------------------------------------------------------
// m. 1458 -- the retroactive-cover check.
// ---------------------------------------------------------------------------
//
// m. 1458(1) sentence 1 makes backdating cover expressly lawful, and it stays
// possible. Sentence 2 is what this guards: the contract is VOID where the
// riziko's occurrence was already known at formation by all three of the
// sigortacı, the sigorta ettiren and (if aware of the insurance) the
// sigortalı. m. 1486(1) names that sentence specifically, so it cannot be
// agreed around.
//
// WHAT THIS IS NOT. It does not decide whether anyone knew anything, and
// nothing it records may be read that way. m. 1458's test is the knowledge of
// three persons at a moment; a row in a database nobody read is not obviously
// that, and it is a lawyer's question. This performs a mechanical check of
// the platform's OWN data and records what that check saw.

// The same predicate the ledger uses -- Types.daml's `inRange` and
// `matchTier`, mirrored here so the check and the payout agree about what a
// riziko IS. A reading that matches no tier pays nothing on the trigger path,
// so it is not an occurrence here either. First matching tier wins; tiers
// arrive pre-sorted by tier_order, as everywhere else.
function matchTier(tiers, observed) {
  return (tiers ?? []).find((t) => {
    const aboveMin = t.minValue === null || t.minValue === undefined || observed >= Number(t.minValue);
    const belowMax = t.maxValue === null || t.maxValue === undefined || observed <= Number(t.maxValue);
    return aboveMin && belowMax;
  });
}

// Runs at mint, inside the advisory lock, before the ledger call.
//
// Returns null where the policy is not backdated -- there is no window and so
// nothing to check. Otherwise returns { checkedAt, status, detail }, or throws
// to refuse the mint.
async function checkRetroactiveCover(policy, coverageRows) {
  // Backdated means cover begins before the CONTRACT WAS MADE, not before
  // now. m. 1458 fixes knowledge at "sözleşmenin yapılması sırasında", so a
  // reading measured after formation could not have been known then and is
  // out of scope -- it is an ordinary claim in a covered window.
  //
  // policies.created_at is the closest thing this system records to that
  // moment: POST /policies is where the terms are agreed, and minting is a
  // separate, later act. It is a recorded approximation of a legal fact, not
  // an observation of it.
  if (!policy.coverage_began_at) return null;
  const coverStart = new Date(policy.coverage_began_at);
  const contractMadeAt = new Date(policy.created_at);
  if (coverStart >= contractMadeAt) return null;   // forward-dated: nothing to check

  // Readings join to coverages by CELL, never by policy: a brand-new
  // backdated policy has no readings of its own, so the ones that matter
  // belong to other policies covering the same ground.
  const cellIds = [...new Set(coverageRows.flatMap((c) => c.cell_ids ?? []))];
  if (cellIds.length === 0) {
    throw new Error(
      `policy ${policy.id} is backdated but names no cells, so the m. 1458 check has nothing to ` +
        `search -- refusing rather than passing vacuously`
    );
  }

  const { rows: readings } = await pool.query(
    `SELECT id, cell_id, metric, value, measured_at, source
     FROM oracle_readings
     WHERE cell_id = ANY($1::text[]) AND measured_at >= $2 AND measured_at <= $3
     ORDER BY measured_at ASC`,
    [cellIds, coverStart.toISOString(), contractMadeAt.toISOString()]
  );

  // Per-cell counts, so a vacuous pass is legible afterwards. A cell the
  // platform has never observed yields zero, and a pass over it verified
  // NOTHING -- which must never read later as "we confirmed there was no
  // frost".
  const perCell = Object.fromEntries(cellIds.map((c) => [c, 0]));
  for (const r of readings) perCell[r.cell_id] = (perCell[r.cell_id] ?? 0) + 1;
  const cellsWithNoData = cellIds.filter((c) => perCell[c] === 0);

  // Evaluate every reading against the tiers of the coverage(s) whose cells
  // it falls in.
  //
  // Metric is recorded but NOT filtered on: a coverage declares cells and
  // tiers but no metric, so there is nothing to filter against. A reading of
  // another metric whose value happens to fall in a tier's range therefore
  // refuses the mint. That is the conservative direction, and it is a real
  // limitation rather than a design choice -- noted here so it is not
  // mistaken for one.
  for (const reading of readings) {
    for (const coverage of coverageRows) {
      if (!(coverage.cell_ids ?? []).includes(reading.cell_id)) continue;
      const tier = matchTier(coverage.payout_tiers_snapshot, Number(reading.value));
      if (!tier) continue;
      throw new Error(
        `m. 1458 retroactive-cover check REFUSED the mint for policy ${policy.id}. ` +
          `The platform's own recorded data contains a tier-matching reading inside the requested ` +
          `backdated window: reading ${reading.id} on cell ${reading.cell_id} measured ` +
          `${new Date(reading.measured_at).toISOString()} (metric ${reading.metric}, value ` +
          `${reading.value}, source ${reading.source}) falls in tier "${tier.label}" of coverage ` +
          `${coverage.coverage_code}. The window searched was ${coverStart.toISOString()} to ` +
          `${contractMadeAt.toISOString()} -- cover start to contract formation. ` +
          `THIS IS THE PLATFORM'S OWN RULE, not a legal conclusion: it does NOT assert that the ` +
          `contract is void, that the sigortacı, sigorta ettiren or sigortalı knew anything, or ` +
          `that a riziko legally occurred. m. 1458 turns on the knowledge of those three persons ` +
          `at formation, which this platform cannot establish. Correct the cover start, or take ` +
          `the question to someone who can answer it`
      );
    }
  }

  return {
    checkedAt: new Date(),
    // The distinction the whole column exists for. Never collapse these.
    status: cellsWithNoData.length > 0 ? 'RC_PassedNoDataForCells' : 'RC_PassedWithData',
    detail: {
      windowFrom: coverStart.toISOString(),
      windowTo: contractMadeAt.toISOString(),
      windowMeaning: 'cover start to contract formation (m. 1458: knowledge is fixed at formation)',
      cellsChecked: cellIds,
      readingsHeldPerCell: perCell,
      cellsWithNoReadings: cellsWithNoData,
      readingsExamined: readings.length,
      // Said in words, because a JSON blob read in two years will not
      // reconstruct this on its own.
      caveat:
        cellsWithNoData.length > 0
          ? 'VACUOUS FOR SOME CELLS: the platform held no readings at all for ' +
            cellsWithNoData.join(', ') +
            ' in this window, so the check verified nothing about them. This is not evidence that ' +
            'no riziko occurred there.'
          : 'Every cell had readings in the window and none matched a tier. This is what the ' +
            "platform's own data shows, and is not a finding about what anyone knew.",
    },
  };
}

// Returns { contractId, commandId, writeBack } on success, or throws
// (handled uniformly by the caller -- a version conflict and a ledger
// rejection both just fail the row with a clear message).
async function handleActivation(event, policy) {
  // Activation only ever makes sense against a fresh policy (no token,
  // version 0) -- any mismatch, whether the event's own expected_version
  // is wrong or the policy has moved on since, is the same kind of
  // conflict and gets the same treatment: fail the row, don't rebase.
  if (event.expected_version !== 0 || policy.current_version !== 0 || policy.daml_contract_id) {
    throw new Error(
      `expected_version conflict: activation requires expected_version=0 and an unactivated policy, got ` +
        `expected_version=${event.expected_version}, policy current_version=${policy.current_version}` +
        (policy.daml_contract_id ? `, existing contract ${policy.daml_contract_id}` : '')
    );
  }

  // Resolved BEFORE the ledger call, not after: a policy with no grace
  // period configured anywhere must fail activation outright rather than
  // minting a token that no later notice could ever compute a deadline
  // for.
  const gracePeriodDays = resolveGracePeriodDays(policy);

  const partyId = await ensurePolicyholderParty(policy.policyholder_id);
  const termStartInstant = policyTermInstant(pgDateToDateString(policy.start_date));
  const termEndInstant = policyTermInstant(pgDateToDateString(policy.end_date));
  // insured is a real intake field as of v15. It still DEFAULTS to the
  // policyholder's party -- the common case, and what the statute assumes
  // where nothing else is said -- but a distinct sigortalı can now exist,
  // which is the precondition both m. 1454 and m. 1431(4) need. Neither is
  // implemented here; this is intake only, and no behaviour that depends on
  // the distinction changes.
  //
  // mortgagee and beneficiary DO have one now. Both resolve through the same
  // registry as the policyholder, so if the same person holds two roles on
  // one policy they resolve to the same row and therefore the same party --
  // one allocation, not two.
  const insuredParty = policy.insured_policyholder_id
    ? await ensurePolicyholderParty(policy.insured_policyholder_id)
    : partyId;
  const mortgageeParty = policy.mortgagee_policyholder_id
    ? await ensurePolicyholderParty(policy.mortgagee_policyholder_id)
    : null;
  const beneficiaryParty = policy.beneficiary_policyholder_id
    ? await ensurePolicyholderParty(policy.beneficiary_policyholder_id)
    : null;

  // Stage 2 Part 2: each coverage was already fully resolved (tiers
  // snapshotted, payoutDestination derived) at creation time in
  // policies.js -- this just carries policy_coverages rows into the
  // token's coverages list as-is. Ordered by creation so the list is
  // stable and deterministic, not because order is semantically
  // meaningful (coverageCode, not list position, is a coverage's identity
  // -- see the ensure clause in PolicyToken.daml).
  const { rows: coverageRows } = await pool.query(
    `SELECT * FROM policy_coverages WHERE policy_id = $1 ORDER BY created_at ASC`,
    [policy.id]
  );
  // m. 1458. Runs BEFORE the ledger call and inside the advisory lock: a
  // refusal must prevent the mint, not follow it. Returns null on a
  // forward-dated policy, where there is no window to search.
  const retroCheck = await checkRetroactiveCover(policy, coverageRows);

  const coverages = coverageRows.map((c) => ({
    coverageCode: c.coverage_code,
    sumInsured: String(c.sum_insured),
    remainingLimit: String(c.remaining_limit),
    payoutTiers: c.payout_tiers_snapshot,
    payoutDestination: c.payout_destination,
    mortgageeClaimAmount: c.mortgagee_claim_amount === null ? null : String(c.mortgagee_claim_amount),
    // m. 1457. Carried through from SQL rather than defaulted, so a re-mint
    // keeps an attachment. A fresh policy -- including a renewal, which is a
    // new contract with its own coverage rows -- has neither set.
    attachedAt: c.attached_at ? new Date(c.attached_at).toISOString() : null,
    attachmentLiftedAt: c.attachment_lifted_at ? new Date(c.attachment_lifted_at).toISOString() : null,
  }));

  const { contractId, commandId } = await createContract({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    actAs: [policy.insurer_canton_party_id],
    payload: {
      policyNo: policy.id,
      version: 1,
      predecessorRef: null,
      insurer: policy.insurer_canton_party_id,
      policyholder: partyId,
      insured: insuredParty,
      // m. 1421: minting records that the CONTRACT EXISTS. It does NOT mean
      // the policy is live. Both fields are null unless the parties agreed
      // cover starts without payment, in which case creation recorded the
      // agreed date and its basis and they are carried through here. Nothing
      // else sets them at mint -- cover otherwise begins at the instant the
      // insurer reports having received the first premium.
      coverageBeganAt: policy.coverage_began_at
        ? new Date(policy.coverage_began_at).toISOString()
        : null,
      coverageStartBasis: policy.coverage_start_basis ?? null,
      // m. 1458: the timestamp only. What was searched and found is
      // off-ledger in policies.retroactive_cover_check_result -- a passing
      // check records that it ran, not the whole search.
      retroactiveCoverCheckedAt: retroCheck ? retroCheck.checkedAt.toISOString() : null,
      beneficiary: beneficiaryParty,
      // Mutually exclusive with beneficiaryParty, enforced by the token's
      // own ensure clause, by a CHECK constraint, and at the API. m. 1494(2)
      // gives "no beneficiary named" its own consequence, so the ledger has
      // to distinguish that from "described but not named".
      beneficiaryDescriptorHash: policy.beneficiary_descriptor_hash ?? null,
      mortgagee: mortgageeParty,
      oracleOperator: policy.oracle_operator_party ?? policy.insurer_canton_party_id,
      coverages,
      // Stage 4: the term START, added so a refund under m. 1419 has the
      // facts it needs on-ledger. Same noon-Europe/Istanbul conversion as
      // the term end.
      termStart: termStartInstant,
      expiry: termEndInstant,
      coverageValidThrough: termEndInstant,
      // Both None at mint -- no notice has been served on a policy that is
      // only now being activated. Set together, once, by handleNotice.
      noticeServiceDate: null,
      noticeRecordedAt: null,
      // m. 1434(4) counts notices within one insurance period. A renewal is
      // a new period, so a renewed token starts at zero too -- the count is
      // per-token and never carried across.
      noticeCount: 0,
      // m. 1434(4). A fresh policy has served no notices, so the list is
      // empty and the election fields are absent. noticeServiceDates is NOT
      // optional -- a list has an empty value rather than a missing one, and
      // omitting it fails preprocessing outright.
      noticeServiceDates: [],
      twoNoticeElectionAt: null,
      twoNoticeEffectiveAt: null,
      // m. 1434(2): all four None at mint. A due date is REPORTED later, if
      // the first premium goes unpaid; nothing here derives one.
      premiumDueDate: null,
      enforcementCommencedAt: null,
      withdrawnAt: null,
      withdrawalPath: null,
      terminationInstant: null,
      unrunDays: null,
      mortgageeNotifiedAt: null,
      mortgageeContinuationEndsAt: null,
      mortgageeElection: null,
      status: 'PS_Active',
      // Second axis (Stage 3 Part 3) -- every policy mints with no premium
      // default outstanding.
      defaultState: 'DS_None',
      documentHash: policy.document_hash ?? null,
      amendmentReason: null,
    },
  });

  return {
    contractId,
    commandId,
    writeBack: async (txClient) => {
      // expiry mirrors the same termEndInstant just minted onto the token,
      // so expirySweeper.js can query it directly in SQL instead of
      // recomputing the noon-Europe/Istanbul conversion a second time
      // there (see migration 008).
      // grace_period_days is frozen onto the row here (resolved above from
      // the policy's own value or the insurer's default) so a later change
      // to the insurer default never moves an already-activated policy's
      // deadline.
      await txClient.query(
        `UPDATE policies SET status = 'active', current_version = 1, daml_contract_id = $1,
           expiry = $2, term_start = $5, grace_period_days = $3,
           retroactive_cover_checked_at = $6, retroactive_cover_check_status = $7,
           retroactive_cover_check_result = $8,
           event_window_timezone = $9, event_window_start_hour = $10, event_aggregation = $11
         WHERE id = $4`,
        [
          contractId,
          termEndInstant,
          gracePeriodDays,
          policy.id,
          termStartInstant,
          retroCheck ? retroCheck.checkedAt.toISOString() : null,
          retroCheck ? retroCheck.status : null,
          retroCheck ? JSON.stringify(retroCheck.detail) : null,
          frozenEventWindow(policy).timezone,
          frozenEventWindow(policy).startHour,
          frozenEventWindow(policy).aggregation,
        ]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,'active',$4,$5,$6)`,
        [policy.id, event.event_type, policy.status, policy.daml_contract_id, contractId, `${event.event_type} via policy_events outbox`]
      );
    },
  };
}

// Exercises PolicyToken_EvaluateTrigger for one 'trigger' outbox row.
// oracleBot.js no longer exercises anything itself (Stage 2 Part 1) -- it
// only fetches a reading, writes it to oracle_readings, and inserts this
// row; observedValue/metric/coverageCode travel in `payload`, keyed for
// idempotency on `reading_id` (see migration 006 for why expected_version
// can't serve that role for this event type). No version-conflict
// precondition here by design: two different readings against the same
// policy version are both meant to fire, in sequence, each against
// whatever the ledger currently holds -- the contract id comes from
// `policy.daml_contract_id`, read fresh under the advisory lock by
// processEvent below, same as every other event type. Which coverage is
// named is the choice's own job to validate (assertMsg "unknown coverage"
// in PolicyToken.daml) -- not duplicated here.
async function handleTrigger(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token to evaluate a trigger against`);
  }
  const { observedValue, metric, coverageCode } = event.payload ?? {};
  if (observedValue === undefined || observedValue === null || !metric || !coverageCode) {
    throw new Error(`trigger event ${event.id} is missing observedValue/metric/coverageCode in its payload`);
  }

  // What this trigger attests to, and which reading caused it (migration 031).
  // A windowed trigger reads both from its trigger_windows row -- the single
  // source, so the attestation on the ledger and the one in SQL are the same
  // string -- and refuses to evaluate if the row carries none: a payout the
  // ledger cannot tie back to its evidence is exactly what this exists to
  // prevent. The direct-SQL trigger rows tests and verify scripts write carry
  // no window, and keep their reading id for both.
  let attestationRef = event.reading_id;
  let causingReadingId = event.reading_id;
  // Computed once: the evidence rows below record it, and the exercise is
  // submitted under it.
  const exerciseCommandId = commandIdFor('exercise', event.id);
  if (event.trigger_window_id) {
    const { rows: windowRows } = await pool.query(
      `SELECT attestation_ref, determining_reading_id FROM trigger_windows WHERE id = $1`,
      [event.trigger_window_id]
    );
    if (!windowRows[0]?.attestation_ref) {
      throw new Error(
        `trigger event ${event.id}: window ${event.trigger_window_id} carries no attestation -- ` +
          `refusing to evaluate a trigger that cannot be tied to its evidence`
      );
    }
    attestationRef = windowRows[0].attestation_ref;
    // null for a mean, which has no single deciding reading; the window id
    // below is what names every reading of it.
    causingReadingId = windowRows[0].determining_reading_id;

    // The bytes behind the hash are held before the ledger sees it (migration
    // 032), in a statement of their own that commits here: a call that fails,
    // a call that never returns, and a call that succeeds with a write-back
    // that fails all leave them held. A min or max hashes the deciding
    // reading's response, a mean every response in the window. All or
    // nothing: if they are not all still stored, none is held and the hash
    // does not go out.
    const { evidence } = JSON.parse(attestationRef);
    if (evidence !== 'absent') {
      const expected = causingReadingId ? 1 : evidence.combines;
      const { rowCount } = await pool.query(
        `WITH held AS (
           SELECT rr.id, rr.sha256, w.policy_id, w.attestation_ref
             FROM trigger_windows w
             JOIN oracle_readings r
               ON CASE WHEN w.aggregation = 'mean' THEN r.id = ANY (w.reading_ids)
                       ELSE r.id = w.determining_reading_id END
             JOIN oracle_raw_responses rr ON rr.id = r.raw_response_id
            WHERE w.id = $1
         )
         INSERT INTO attested_evidence
           (policy_event_id, raw_response_id, sha256, trigger_window_id, policy_id, command_id, attestation_ref)
         SELECT $2, id, sha256, $1, policy_id, $3, attestation_ref FROM held
          WHERE (SELECT count(*) FROM held) = $4`,
        [event.trigger_window_id, event.id, exerciseCommandId, expected]
      );
      if (rowCount !== expected) {
        throw new Error(
          `trigger event ${event.id}: window ${event.trigger_window_id} attests ${expected} stored response(s), ` +
            `but they are not all still stored -- refusing to put a hash on the ledger without the bytes behind it`
        );
      }
    }
  }

  // One value, used twice: the choice stamps it onto PayoutApproved.approvedAt
  // and the write-back mirrors it into payout_events.approved_at. Reading the
  // clock a second time for the SQL row would put a different instant in SQL
  // than the one on the ledger, and m. 1427 runs maturity from the approval.
  const approvedAt = new Date().toISOString();

  const responseData = await exerciseChoice({
    commandId: exerciseCommandId,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_EvaluateTrigger',
    actAs: [policy.oracle_operator_party],
    argument: {
      // Supplied because `show self` renders a redacted placeholder on this
      // participant -- recorded onto PayoutApproved.sourcePolicyContractId,
      // which never carried a usable value before Stage 4.
      selfContractId: policy.daml_contract_id,
      coverageCode,
      observedValue: String(observedValue),
      metric,
      attestationRef,
      currency: policy.currency,
      now: approvedAt,
    },
  });

  const commandId = responseData?.transaction?.commandId;
  const events = responseData?.transaction?.events ?? [];
  const exercised = events.find((e) => e.ExercisedEvent?.choice === 'PolicyToken_EvaluateTrigger');
  const result = exercised?.ExercisedEvent?.exerciseResult;
  if (!result) {
    throw new Error(`no exerciseResult found for trigger event ${event.id}`);
  }

  if (!result.trigger?.matched) {
    return {
      contractId: policy.daml_contract_id,
      commandId,
      writeBack: async () => {}, // nothing matched -- nothing changed on-ledger to mirror
    };
  }

  const newPolicyCid = result.newPolicyCid ?? null;
  // m. 1456: one leg per recipient, not one payout with two line items.
  // Today that is at most one leg -- the mortgagee's where the coverage is
  // charged, the insured's where it is not -- but the shape is a list because
  // m. 1427 runs maturity and default per claim and each recipient has to be
  // separately settleable. A matched trigger with NO legs is legitimate: it
  // means the charge is exhausted and the whole indemnity is unrouted.
  const legs = result.payouts ?? [];
  const remainder = result.unroutedRemainder ?? null;
  if (legs.length === 0 && !remainder) {
    throw new Error(
      `trigger event ${event.id} matched but returned neither a payout leg nor an unrouted remainder`
    );
  }

  // The new PolicyToken's own CreatedEvent (absent when the policy closed
  // entirely -- there is no re-mint then) is where the real new `version`
  // and the triggered coverage's real new remainingLimit come from.
  // Reading it here, instead of incrementing the old SQL value blind, is
  // what closes the SQL-says-1/ledger-says-2 gap Stage 2 Part 1 exists to
  // fix. Every other coverage in that same CreatedEvent is byte-for-byte
  // what it already was -- nothing here touches their SQL rows at all.
  const newTokenPayload = newPolicyCid
    ? events.find(
        (e) => e.CreatedEvent?.contractId === newPolicyCid && e.CreatedEvent?.templateId?.endsWith(':PolicyToken')
      )?.CreatedEvent?.createArgument
    : null;
  const newVersion = newTokenPayload ? Number(newTokenPayload.version) : null;

  // Whether the POLICY closed is `!newPolicyCid` -- Daml's own
  // `allExhausted` decision (every coverage exhausted, not just this one)
  // is exactly what determined whether PolicyToken.daml re-minted or not.
  // `result.trigger.isFullSettlement` is a different, narrower thing --
  // "this one coverage's own tier paid out 100% of what was left on
  // it" -- and using it here would be wrong: a coverage can individually
  // hit its own 100% tier while other coverages keep the policy open,
  // exactly the case this dispatcher must not confuse with policy-wide
  // closure. When the policy did close there is, by construction, no
  // re-mint to read the triggered coverage's new limit from -- but
  // allExhausted being true necessarily means this coverage's own new
  // remainingLimit is also <= 0, and the payout amount is always capped
  // at the coverage's remainingLimit, so it's exactly 0, not a value that
  // needs deriving from anything else.
  const policyClosed = !newPolicyCid;
  const newStatus = policyClosed ? 'claimed_and_closed' : 'partially_paid';
  const newCoverageRemainingLimit = policyClosed
    ? 0
    : newTokenPayload?.coverages?.find((c) => c.coverageCode === coverageCode)?.remainingLimit;

  // The triggered coverage's new mortgagee claim, read off the re-minted
  // token rather than recomputed here -- same principle as remainingLimit
  // above. Absent from the JSON when it is None, present-and-null never:
  // a None inside a nested record comes back with the key MISSING, which is
  // why this reads `?? null` off an already-optional chain rather than
  // testing for null.
  const newCoverageClaim = policyClosed
    ? null
    : newTokenPayload?.coverages?.find((c) => c.coverageCode === coverageCode)
        ?.mortgageeClaimAmount ?? null;

  return {
    contractId: newPolicyCid ?? legs[0]?.cid ?? remainder?.reviewCid,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET status = $1, daml_contract_id = $2,
           current_version = COALESCE($3, current_version) WHERE id = $4`,
        [newStatus, newPolicyCid, newVersion, policy.id]
      );
      await txClient.query(
        `UPDATE policy_coverages SET remaining_limit = $1, mortgagee_claim_amount = $2
          WHERE policy_id = $3 AND coverage_code = $4`,
        [newCoverageRemainingLimit, newCoverageClaim, policy.id, coverageCode]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          policy.id,
          event.event_type,
          policy.status,
          newStatus,
          policy.daml_contract_id,
          newPolicyCid,
          'payout tier matched via policy_events outbox',
        ]
      );
      // One row per leg. Each carries its OWN recipient's gross amount --
      // never result.trigger.payoutAmount, which is the whole indemnity and
      // is what a leg is a share of.
      for (const leg of legs) {
        const { rows: [inserted] } = await txClient.query(
          `INSERT INTO payout_events
             (policy_id, coverage_code, tier_label, payout_percentage, payout_amount, currency,
              is_full_settlement, status, daml_contract_id, recipient, record_kind,
              oracle_reading_id, trigger_window_id, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',$8,$9,'payout',$10,$11,$12)
           ON CONFLICT (daml_contract_id) DO NOTHING
           RETURNING id`,
          [
            policy.id,
            coverageCode,
            result.trigger.matchedTierLabel,
            Number(result.trigger.payoutPct),
            Number(leg.amount),
            policy.currency,
            policyClosed,
            leg.cid,
            leg.recipient,
            causingReadingId,
            event.trigger_window_id ?? null,
            approvedAt,
          ]
        );
        // Only when the INSERT actually added the row. ON CONFLICT means the
        // payout was already recorded, and its notification was queued with it.
        if (inserted) {
          await enqueuePayoutNotification(txClient, {
            payoutEventId: inserted.id,
            insurerId: policy.insurer_id,
            kind: 'payout_approved',
          });
        }
      }
      // Two situations reach this row and they stay distinct, because they
      // have different reasons and different resolutions:
      //
      //   m. 1456(2)  the excess over the mortgagee's remaining claim, which
      //               the paragraph forbids paying the sigortalı without izin;
      //   m. 1457     the charge and an attachment both biting on one
      //               coverage, where the Code supplies no priority rule and
      //               NOTHING was routed at all.
      //
      // recipient is NULL either way: nobody has decided who it goes to. Both
      // resolve through the same paths a failed payout does.
      if (remainder) {
        const { rows: [insertedRemainder] } = await txClient.query(
          `INSERT INTO payout_events
             (policy_id, coverage_code, tier_label, payout_percentage, payout_amount, currency,
              is_full_settlement, status, daml_contract_id, recipient, record_kind,
              review_contract_id, oracle_reading_id, trigger_window_id, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'manual_review',NULL,NULL,$9,$8,$10,$11,$12)
           RETURNING id`,
          [
            policy.id,
            coverageCode,
            result.trigger.matchedTierLabel,
            Number(result.trigger.payoutPct),
            Number(remainder.amount),
            policy.currency,
            policyClosed,
            remainder.reviewCid,
            remainder.reason === 'UNR_CompetingClaims'
              ? 'unrouted_competing_claims'
              : 'unrouted_remainder',
            causingReadingId,
            event.trigger_window_id ?? null,
            approvedAt,
          ]
        );
        // Both remainder kinds are one notification kind: what the insurer is
        // being told is that a human has to work this, not who is owed what.
        await enqueuePayoutNotification(txClient, {
          payoutEventId: insertedRemainder.id,
          insurerId: policy.insurer_id,
          kind: 'review_required',
        });
      }
      // Stage 4: this used to queue a `settlement` row here, which the
      // dispatcher processed by unconditionally exercising MarkFailed --
      // that is precisely how every payout landed in manual_review
      // automatically, and why the queue only ever grew. A payout now stays
      // `approved` until the INSURER reports what happened to it. Nothing
      // queues a settlement on the platform's own initiative, on a timer,
      // or by inference.
      //
      // [2026-09-18] Still true of SETTLEMENT, which is what this comment is
      // about: nothing here queues one. What it no longer says in full is that
      // nothing at all is queued -- each payout_events INSERT above now queues
      // a payout_notifications row in this same transaction. That row changes
      // no ledger state and instructs no payment; it only records that the
      // insurer is owed a notification (migration 035).
    },
  };
}

// Stage 4: the settlement path, and the only way a payout ever ends.
//
// THE PLATFORM NEVER MOVES MONEY. The insurer settles the indemnity through
// its own banking systems and then REPORTS that fact here; this handler
// records the report on the ledger and closes the payout. No account number
// is held, no transfer is instructed, no banking API is called. That is a
// design rule, not a gap awaiting an integration.
//
// Four actions arrive through this one event type, distinguished by
// `payload.action`, because they are four ways the same object reaches a
// terminal state:
//
//   settle          -> PayoutApproved_ConfirmSettlement          (normal path)
//   fail            -> PayoutApproved_MarkFailed                 (exception)
//   resolve_settled -> ManualReviewRequired_ResolveSettled       (review exit 1)
//   resolve_unpaid  -> ManualReviewRequired_ResolveUnpaid        (review exit 2)
//
// Every one is initiated by the insurer through the API. NOTHING here fires
// on a timer, on a poll, or by inference -- before Stage 4 this handler
// unconditionally exercised MarkFailed on every payout the moment it
// existed, which is why the manual-review queue only grew. That automatic
// routing is gone: handleTrigger no longer queues a settlement row, and
// payoutListener.js no longer writes one either.
const SETTLEMENT_ACTIONS = new Set(['settle', 'fail', 'resolve_settled', 'resolve_unpaid']);

// Daml PayoutDestinationRole constructors <-> what the API accepts. Same
// hand-kept-in-sync arrangement as every other shared vocabulary here.
// m. 1457 added a fourth. It is never DESIGNATED on a coverage -- see the
// exemption in PayoutBridge.daml -- but it is very much a role an insurer can
// report having paid, and omitting it here refused every enforcement-office
// settlement while the ledger was ready to accept one.
const PAID_ROLES = new Set(['PDR_Insured', 'PDR_Mortgagee', 'PDR_Beneficiary', 'PDR_EnforcementOffice']);
const UNPAID_REASONS = new Set(['UR_Waived', 'UR_Disputed', 'UR_Litigation', 'UR_Other']);

// m. 1457: a payout approved BEFORE an attachment was recorded.
//
// The check sits here, off-ledger, because a PayoutApproved cannot know about
// an attachment recorded after it -- the contract was created with its
// recipient fixed, and nothing on it changes when the coverage is later
// attached.
//
// What the text says: the officer's ihtar binds "diğer bir bildirime kadar"
// and the insurer is discharged "ANCAK icra müdürlüğüne ödenilmesiyle". That
// governs PAYMENT, and an approved-but-unpaid payout has not been paid -- so
// settling it to its original recipient would not discharge.
//
// So the report is REFUSED rather than the obligation rewritten. Refusing
// asserts nothing; it declines to record as a discharge something the text
// says is not one. Redirecting an approved obligation would be the system
// deciding, which it is not equipped to do here.
//
// THE RULE, and it is the whole of the rule: this refusal guards PAYMENT, not
// the recording of non-payment. Both of m. 1457's sentences turn on odemek --
// "odeyerek borcundan kurtulur", "ancak icra mudurlugune odenilmesiyle
// borctan kurtulacagini" -- so the article speaks only to what discharges. A
// failure report or an unpaid closure asserts that no payment was made and
// therefore no discharge; the article has nothing to say about either, and
// blocking them would leave an obligation with no legible outcome at all.
//
// Applied to `settle` and `resolve_settled`. NOT to `fail` or
// `resolve_unpaid`.
async function refuseIfCoverageAttached(event, payout, paidRole) {
  if (payout.record_kind !== 'payout' || paidRole === 'PDR_EnforcementOffice') return;
  const { rows } = await pool.query(
    `SELECT attached_at, attachment_lifted_at FROM policy_coverages
      WHERE policy_id = $1 AND coverage_code = $2`,
    [payout.policy_id, payout.coverage_code]
  );
  const c = rows[0];
  if (!c || !c.attached_at) return;
  const attachedNow =
    !c.attachment_lifted_at || new Date(c.attachment_lifted_at) < new Date(c.attached_at);
  if (!attachedNow) return;
  throw new Error(
    `settlement event ${event.id}: coverage ${payout.coverage_code} on policy ` +
      `${payout.policy_id} is under attachment (m. 1457, recorded ` +
      `${new Date(c.attached_at).toISOString()}), so a payment to ${paidRole} does not discharge ` +
      `-- the officer's ihtar binds "diger bir bildirime kadar" and the insurer is freed ANCAK by ` +
      `paying the icra mudurlugu. This payout was approved before the attachment was recorded and ` +
      `its recipient is NOT rewritten: the report is refused, not redirected. Resolve it as a ` +
      `review item, or record the attachment lifted if it has been.`
  );
}

async function handleSettlement(event, policy) {
  const contractId = event.source_contract_id;
  const { action, bankReference, settledAt, paidRole, failureReason, unpaidReason, note } =
    event.payload ?? {};

  if (!SETTLEMENT_ACTIONS.has(action)) {
    throw new Error(
      `settlement event ${event.id} has an unrecognized action '${action}' -- expected one of ` +
        `${[...SETTLEMENT_ACTIONS].join(', ')}`
    );
  }

  // The payout row this event is about. Located by whichever contract id it
  // currently sits behind: the original PayoutApproved for settle/fail, or
  // the ManualReviewRequired that superseded it for the two review exits.
  const { rows: payoutRows } = await pool.query(
    `SELECT * FROM payout_events WHERE daml_contract_id = $1 OR review_contract_id = $1`,
    [contractId]
  );
  const payout = payoutRows[0];
  if (!payout) {
    throw new Error(`settlement event ${event.id}: no payout_events row for contract ${contractId}`);
  }
  if (payout.resolved_at) {
    throw new Error(
      `settlement event ${event.id}: payout ${payout.id} was already resolved at ` +
        `${payout.resolved_at.toISOString()} (status '${payout.status}') -- a payout ends once`
    );
  }

  const settlingActions = action === 'settle' || action === 'resolve_settled';
  let settledAtInstant = null;
  if (settlingActions) {
    if (!bankReference) {
      throw new Error(`settlement event ${event.id}: bankReference is required to report a settlement`);
    }
    if (!settledAt) {
      throw new Error(
        `settlement event ${event.id}: settledAt is required -- the settlement date is the insurer's ` +
          `reported fact and is never taken from a system clock`
      );
    }
    settledAtInstant = new Date(settledAt);
    if (Number.isNaN(settledAtInstant.getTime())) {
      throw new Error(`settlement event ${event.id} has an unparseable settledAt: ${settledAt}`);
    }
    if (!PAID_ROLES.has(paidRole)) {
      throw new Error(
        `settlement event ${event.id}: paidRole must be one of ${[...PAID_ROLES].join(', ')}, got '${paidRole}'`
      );
    }
    // m. 1457, and driven off settlingActions rather than off one branch:
    // BOTH `settle` and `resolve_settled` record a discharge, and the
    // article's constraint is about payment. Checked BEFORE the ledger call,
    // so a settlement that would not discharge never reaches it.
    //
    // It was guarded on `settle` alone when first written, which left the
    // review exit open -- the same money, the same coverage, the same
    // assertion that the insurer paid, reached through
    // ManualReviewRequired_ResolveSettled instead.
    await refuseIfCoverageAttached(event, payout, paidRole);
    // The ledger enforces this too, on the normal path, against the
    // destination snapshotted onto PayoutApproved. It cannot on the review
    // exit -- that contract's creation archived the PayoutApproved carrying
    // the destination -- so the check is made here against the coverage's
    // SQL mirror, which is the same value. Rejecting a role the policy never
    // designated is the point: the ledger cannot verify money moved, but it
    // can refuse an assertion that contradicts the policy.
    const { rows: covRows } = await pool.query(
      `SELECT payout_destination FROM policy_coverages WHERE policy_id = $1 AND coverage_code = $2`,
      [payout.policy_id, payout.coverage_code]
    );
    const destination = covRows[0]?.payout_destination;
    if (!Array.isArray(destination) || destination.length === 0) {
      throw new Error(
        `settlement event ${event.id}: coverage ${payout.coverage_code} has no payout_destination to check against`
      );
    }
    // m. 1457's recipient is exempt, exactly as in the ledger's own check and
    // for the same reason: payout_destination records what the policy
    // DESIGNATED, and nobody designates an icra mudurlugu.
    if (paidRole !== 'PDR_EnforcementOffice' && !destination.includes(paidRole)) {
      throw new Error(
        `settlement event ${event.id}: reports paying ${paidRole}, which is not among coverage ` +
          `${payout.coverage_code}'s payoutDestination (${destination.join(', ')})`
      );
    }
  }

  const actAs = [policy.insurer_canton_party_id];
  let responseData;
  let newStatus;
  let reviewContractId = null;

  if (action === 'settle') {
    responseData = await exerciseChoice({
      commandSeed: event.id,
      moduleName: 'Insurance.PayoutBridge',
      entityName: 'PayoutApproved',
      contractId,
      choice: 'PayoutApproved_ConfirmSettlement',
      actAs,
      argument: { bankReference, settledAt: settledAtInstant.toISOString(), paidRole },
    });
    newStatus = 'settled';
  } else if (action === 'fail') {
    if (!failureReason) {
      throw new Error(
        `settlement event ${event.id}: failureReason is required -- MarkFailed is the exception path ` +
          `and fires only on a reported failure, never automatically`
      );
    }
    responseData = await exerciseChoice({
      commandSeed: event.id,
      moduleName: 'Insurance.PayoutBridge',
      entityName: 'PayoutApproved',
      contractId,
      choice: 'PayoutApproved_MarkFailed',
      actAs,
      // The contract id is supplied rather than derived: `show self` inside
      // the choice renders "<contract-id>" on this participant, not an id.
      argument: {
        failureReason,
        now: new Date().toISOString(),
        sourcePayoutContractId: contractId,
      },
    });
    // MarkFailed returns the new ManualReviewRequired's contract id.
    const events = responseData?.transaction?.events ?? [];
    reviewContractId = events.find(
      (e) => e.ExercisedEvent?.choice === 'PayoutApproved_MarkFailed'
    )?.ExercisedEvent?.exerciseResult;
    if (!reviewContractId) {
      throw new Error(`settlement event ${event.id}: MarkFailed returned no ManualReviewRequired contract id`);
    }
    newStatus = 'manual_review';
  } else if (action === 'resolve_settled') {
    responseData = await exerciseChoice({
      commandSeed: event.id,
      moduleName: 'Insurance.PayoutBridge',
      entityName: 'ManualReviewRequired',
      contractId,
      choice: 'ManualReviewRequired_ResolveSettled',
      actAs,
      argument: { bankReference, settledAt: settledAtInstant.toISOString(), paidRole },
    });
    newStatus = 'settled';
  } else {
    if (!UNPAID_REASONS.has(unpaidReason)) {
      throw new Error(
        `settlement event ${event.id}: unpaidReason must be one of ${[...UNPAID_REASONS].join(', ')}, ` +
          `got '${unpaidReason}'`
      );
    }
    if (!note) {
      throw new Error(
        `settlement event ${event.id}: a note is required when closing a review item unpaid -- the ` +
          `enum alone cannot carry the circumstances`
      );
    }
    responseData = await exerciseChoice({
      commandSeed: event.id,
      moduleName: 'Insurance.PayoutBridge',
      entityName: 'ManualReviewRequired',
      contractId,
      choice: 'ManualReviewRequired_ResolveUnpaid',
      actAs,
      argument: { unpaidReason, note },
    });
    newStatus = 'closed_unpaid';
  }

  // 'fail' supersedes rather than resolves: the payout is not finished, it
  // has moved to a review item that still has to end somewhere. Only the
  // three terminal actions stamp resolved_at, which is what the dashboards
  // and the unresolved index key off.
  const resolvesNow = action !== 'fail';

  return {
    contractId: reviewContractId ?? contractId,
    commandId: responseData?.transaction?.commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE payout_events SET
           status = $1,
           bank_reference  = COALESCE($2, bank_reference),
           settled_at      = COALESCE($3, settled_at),
           paid_role       = COALESCE($4, paid_role),
           unpaid_reason   = COALESCE($5, unpaid_reason),
           resolution_note = COALESCE($6, resolution_note),
           -- The supersession link: daml_contract_id keeps pointing at the
           -- PayoutApproved that started the chain, and the review item that
           -- replaced it lands here rather than overwriting it.
           review_contract_id = COALESCE($7, review_contract_id),
           resolved_at     = CASE WHEN $8::boolean THEN now() ELSE resolved_at END
         WHERE id = $9`,
        [
          newStatus,
          settlingActions ? bankReference : null,
          settledAtInstant ? settledAtInstant.toISOString() : null,
          settlingActions ? paidRole : null,
          action === 'resolve_unpaid' ? unpaidReason : null,
          action === 'resolve_unpaid' ? note : null,
          reviewContractId,
          resolvesNow,
          payout.id,
        ]
      );
    },
  };
}


// Exercises PolicyToken_ArchiveForExpiry for one 'expiry' outbox row.
// expirySweeper.js only ever inserts this row for a policy it already
// found past its term and still open (see idx_policies_expiry_open) -- it
// never calls the ledger itself, so this is the first and only ledger
// action for the whole expiry path, same as every other event type.
//
// Always archives regardless of any coverage's remaining_limit -- there is
// no branch here for "still has limit left" vs. "already exhausted": a
// policy reaching its term end expires either way, and whatever limit
// remained simply lapses along with the archived token, since there is no
// re-mint for it to survive into.
async function handleExpiry(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token to archive for expiry`);
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_ArchiveForExpiry',
    actAs: [policy.insurer_canton_party_id],
    argument: {
      archivedAt: new Date().toISOString(),
      reason: 'policy term expired',
    },
  });

  return {
    contractId: policy.daml_contract_id,
    commandId: responseData?.transaction?.commandId,
    writeBack: async (txClient) => {
      await txClient.query(`UPDATE policies SET status = 'expired', daml_contract_id = NULL WHERE id = $1`, [
        policy.id,
      ]);
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,'expired',$4,NULL,$5)`,
        [policy.id, event.event_type, policy.status, policy.daml_contract_id, 'policy term expired via policy_events outbox']
      );
    },
  };
}

// Stage 3 Part 2, step 1 of 3: exercises PolicyToken_ServeNotice for one
// 'notice' outbox row. Coverage CONTINUES through the grace period -- this
// only records the notice and moves the policy to grace_period status;
// coverageValidThrough is deliberately untouched (see PolicyToken.daml).
//
// The service date is REQUIRED in the payload and never inferred,
// defaulted, or backfilled: statutory time runs from when the notice was
// actually served on the policyholder, which this system cannot observe --
// only the insurer knows it. recordedAt (when the platform was told) is
// generated here, and is a genuinely different fact; both go on the token
// so a gap between them stays visible on-ledger.
async function handleNotice(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token to serve notice against`);
  }
  const { serviceDate } = event.payload ?? {};
  if (!serviceDate) {
    throw new Error(
      `notice event ${event.id} is missing serviceDate in its payload -- ` +
        `a notice's service date must be supplied by the insurer, never inferred or defaulted`
    );
  }
  const serviceDateInstant = new Date(serviceDate);
  if (Number.isNaN(serviceDateInstant.getTime())) {
    throw new Error(`notice event ${event.id} has an unparseable serviceDate: ${serviceDate}`);
  }
  const recordedAt = new Date().toISOString();

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_ServeNotice',
    actAs: [policy.insurer_canton_party_id],
    argument: {
      noticeServiceDate: serviceDateInstant.toISOString(),
      noticeRecordedAt: recordedAt,
    },
  });

  const { commandId, newContractId, newVersion, newPayload } = readReMintResult(
    responseData,
    'PolicyToken_ServeNotice',
    event
  );
  // m. 1434(4): mirrored off the re-minted token, never incremented blind
  // in SQL -- the ledger owns the count, this is a mirror of it.
  const noticeCount = newPayload?.noticeCount;
  if (noticeCount === null || noticeCount === undefined) {
    throw new Error(`no noticeCount on the token re-minted by PolicyToken_ServeNotice for event ${event.id}`);
  }

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      // Stage 3 Part 3: moves the DEFAULT axis only. `status` is
      // deliberately absent from this UPDATE -- a partially-paid policy
      // stays partially paid while also entering its grace period.
      await txClient.query(
        `UPDATE policies SET default_state = 'grace_period', daml_contract_id = $1,
           current_version = COALESCE($2, current_version),
           notice_service_date = $3, notice_recorded_at = $4, notice_count = $6,
           -- m. 1434(4)'s one touch to this handler: the same append the
           -- token makes, mirrored. The CHECK constraint keeps the array and
           -- the count from drifting, so omitting this would fail the write
           -- rather than pass silently.
           notice_service_dates = notice_service_dates || $3::timestamptz
         WHERE id = $5`,
        [newContractId, newVersion, serviceDateInstant.toISOString(), recordedAt, policy.id, noticeCount]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_default_state, new_default_state,
            old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,$3,$4,'grace_period',$5,$6,$7)`,
        [
          policy.id,
          event.event_type,
          policy.status,          // unchanged -- recorded as both old and new
          policy.default_state,
          policy.daml_contract_id,
          newContractId,
          `premium default notice served ${serviceDateInstant.toISOString()} via policy_events ` +
            `outbox (notice ${noticeCount} of this insurance period)`,
        ]
      );
    },
  };
}

// Stage 4, PHASE ONE of termination. Exercises PolicyToken_Terminate for one
// 'termination' outbox row, written only by sweepers/graceSweeper.js, which
// never calls the ledger itself.
//
// TTK 6102 m. 1434(3): at the end of the notice period the contract is
// `feshedilmiş olur` -- deemed terminated. This is a RECORDED CONSEQUENCE,
// not a discretionary act. The sweeper's job is to observe that the period
// elapsed and write it down; nothing here decides whether to terminate.
//
// The termination instant is NOT a clock reading. It is the externally
// supplied notice service date plus this policy's own grace period -- fixed
// the moment notice was served, and merely computed here. A sweeper that
// runs late therefore records the same instant it would have recorded on
// time, which is the whole reason the sweeper's query is a state test.
//
// This replaced handleSuspension, which moved coverageValidThrough back and
// left the contract alive in a suspended state. That model conflicted with
// 1434(3) and m. 1452(3) made it unfixable by the general conditions;
// it stays an open legal question.
async function handleTermination(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token to terminate`);
  }
  if (!policy.notice_service_date) {
    throw new Error(
      `policy ${policy.id} has no notice_service_date -- a contract cannot be terminated for ` +
        `non-payment without a notice having been served`
    );
  }
  const gracePeriodDays = resolveGracePeriodDays(policy);
  const terminationInstant = new Date(
    new Date(policy.notice_service_date).getTime() + gracePeriodDays * 24 * 60 * 60 * 1000
  );

  // m. 1419: premium for the unrun days is returned on termination. The
  // FACTS are recorded -- term start, termination instant, unrun days -- and
  // the arithmetic is not. No premium amount is read, stored, or multiplied
  // anywhere: the insurer holds the premium and computes the refund, exactly
  // as it does the set-off under m. 1431(5).
  const expiry = policy.expiry ? new Date(policy.expiry) : null;
  const unrunDays = expiry
    ? Math.max(0, Math.floor((expiry.getTime() - terminationInstant.getTime()) / 86400000))
    : 0;

  // m. 1456(5) opens a continuation window for a known real-right holder at
  // termination. Only meaningful when the policy names a mortgagee; its
  // length is per-insurer configuration and is never a literal here. A
  // policy WITH a mortgagee and no configured window fails loudly rather
  // than assuming a statutory number -- same rule as the grace period.
  let mortgageeContinuationEndsAt = null;
  if (policy.mortgagee_policyholder_id) {
    const days = policy.insurer_mortgagee_continuation_days;
    if (days === null || days === undefined) {
      throw new Error(
        `policy ${policy.id} names a mortgagee but no continuation window is configured: set ` +
          `insurers.mortgagee_continuation_days -- refusing to assume a statutory value`
      );
    }
    mortgageeContinuationEndsAt = new Date(
      terminationInstant.getTime() + days * 24 * 60 * 60 * 1000
    ).toISOString();
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_Terminate',
    actAs: [policy.insurer_canton_party_id],
    argument: {
      terminationInstant: terminationInstant.toISOString(),
      unrunDays,
      mortgageeContinuationEndsAt,
    },
  });

  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_Terminate',
    event
  );

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      // Default axis only, same as every other premium-default handler.
      // The token is deliberately NOT archived here -- see
      // handleTerminationArchive for phase two and why.
      await txClient.query(
        `UPDATE policies SET default_state = 'terminated', daml_contract_id = $1,
           current_version = COALESCE($2, current_version),
           terminated_at = $3, unrun_days = $4,
           mortgagee_continuation_ends_at = COALESCE($5, mortgagee_continuation_ends_at)
         WHERE id = $6`,
        [
          newContractId,
          newVersion,
          terminationInstant.toISOString(),
          unrunDays,
          mortgageeContinuationEndsAt,
          policy.id,
        ]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_default_state, new_default_state,
            old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,$3,$4,'terminated',$5,$6,$7)`,
        [
          policy.id,
          event.event_type,
          policy.status,
          policy.default_state,
          policy.daml_contract_id,
          newContractId,
          `notice period elapsed ${terminationInstant.toISOString()}; contract terminated ` +
            `(TTK 1434(3)); ${unrunDays} unrun day(s) recorded`,
        ]
      );
    },
  };
}

// Stage 4, PHASE TWO of termination. Exercises PolicyToken_ArchiveForNonPayment
// -- the choice that has existed, compiled and been tested since Stage 1 and
// was called by nothing until now.
//
// Termination ends the CONTRACT; this ends the TOKEN, and the two are
// deliberately separate events. A loss during the notice period is payable,
// and the PayoutApproved it raises is an obligation that survives the
// contract -- archiving the policy while a payout is still open would orphan
// that obligation and break the chain from a payout back to its policy. So
// the token stays live, terminated and with coverage already ended, until
// every payout raised on it has reached a terminal state.
//
// The "all payouts resolved" condition is checked off-ledger, here and in
// the sweeper's query: PayoutApproved contracts are separate contracts the
// PolicyToken template cannot see. The ledger enforces the part it can --
// that the policy is terminated (see the choice's own assertMsg).
async function handleTerminationArchive(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no live token to archive`);
  }
  if (policy.default_state !== 'terminated') {
    throw new Error(
      `policy ${policy.id} is not terminated (default_state='${policy.default_state}') -- only a ` +
        `terminated contract's token is archived for non-payment`
    );
  }
  // Re-checked here, fresh and under the advisory lock, not just in the
  // sweeper: a payout could have been raised or reopened between the sweep
  // and this handler running.
  const { rows: openRows } = await pool.query(
    `SELECT count(*)::int AS n FROM payout_events WHERE policy_id = $1 AND resolved_at IS NULL`,
    [policy.id]
  );
  if (openRows[0].n > 0) {
    throw new Error(
      `policy ${policy.id} still has ${openRows[0].n} unresolved payout(s) -- the token is not ` +
        `archived while an obligation raised on it is still open`
    );
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_ArchiveForNonPayment',
    actAs: [policy.insurer_canton_party_id],
    argument: {
      archivedAt: new Date().toISOString(),
      reason: 'premium unpaid; notice period elapsed and all payouts resolved',
    },
  });

  return {
    contractId: policy.daml_contract_id,
    commandId: responseData?.transaction?.commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET status = 'cancelled', daml_contract_id = NULL WHERE id = $1`,
        [policy.id]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_default_state, new_default_state,
            old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,'cancelled',$4,$4,$5,NULL,$6)`,
        [
          policy.id,
          event.event_type,
          policy.status,
          policy.default_state,
          policy.daml_contract_id,
          'all payouts resolved; token burned for non-payment (phase two of termination)',
        ]
      );
    },
  };
}

// Stage 4, m. 1456(4): records that the insurer says it notified a known
// real-right holder of the policyholder's default and of the notice served.
// The date is the insurer's REPORTED date, like the service date -- this
// system generates and sends nothing, and cannot observe a notification.
async function handleMortgageeNotice(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  const { notifiedAt } = event.payload ?? {};
  if (!notifiedAt) {
    throw new Error(
      `mortgagee notice event ${event.id} is missing notifiedAt -- the notification date is the ` +
        `insurer's reported fact, never inferred`
    );
  }
  const instant = new Date(notifiedAt);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`mortgagee notice event ${event.id} has an unparseable notifiedAt: ${notifiedAt}`);
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_RecordMortgageeNotice',
    actAs: [policy.insurer_canton_party_id],
    argument: { notifiedAt: instant.toISOString() },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_RecordMortgageeNotice',
    event
  );

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version),
           mortgagee_notified_at = $3 WHERE id = $4`,
        [newContractId, newVersion, instant.toISOString(), policy.id]
      );
    },
  };
}

// Stage 4, m. 1456(5): the real-right holder's election within the
// continuation window, recorded if one is reported. RECORDED ONLY -- the
// takeover itself is deliberately not implemented, and nothing in this
// system acts on ME_Continue.
async function handleMortgageeElection(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  const { election } = event.payload ?? {};
  if (!MORTGAGEE_ELECTIONS.has(election)) {
    throw new Error(
      `mortgagee election event ${event.id}: election must be one of ` +
        `${[...MORTGAGEE_ELECTIONS].join(', ')}, got '${election}'`
    );
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_RecordMortgageeElection',
    actAs: [policy.insurer_canton_party_id],
    argument: { election },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_RecordMortgageeElection',
    event
  );

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version),
           mortgagee_election = $3, mortgagee_election_at = now() WHERE id = $4`,
        [newContractId, newVersion, election, policy.id]
      );
    },
  };
}

// Stage 3 Part 2, step 3 of 3: exercises PolicyToken_Reinstate for one
// 'reinstatement' outbox row. The SAME policy resumes -- no new policyNo,
// no new token identity beyond the usual re-mint, no extension of expiry
// or the term (the Daml choice restores coverageValidThrough to `expiry`
// itself, which never moved).
//
// Stage 4 narrowed this to the grace period ONLY. It used to be reachable
// from a suspended policy as well, on the theory that payment could arrive
// after the period elapsed and revive the cover. Under TTK 6102 m. 1434(3)
// there is nothing left to revive: the contract is `feshedilmiş olur` at
// the end of the period, and a later payment does not undo a termination.
// The Daml choice now refuses a terminated policy outright.
//
// Nothing was ever suspended in this model, so nothing has to be
// backfilled: coverage ran in full throughout the notice period and a loss
// during it is payable.
//
// Stage 3 Part 3: this now clears the DEFAULT axis only and leaves `status`
// exactly as it was. Part 2's version had to reconstruct whether the policy
// came back as active or partially_paid, because the default states were
// packed into the same field; with the axes split there is nothing to
// reconstruct -- a policy that was partially paid before it defaulted is
// still partially paid after reinstatement, untouched throughout.
//
// Reinstatement is also the ONLY exit from default. Nothing else may clear
// it -- in particular a claim payout must not, however large: this system
// cannot observe a premium payment, and per TTK 1431/3 any set-off of the
// outstanding premium against the indemnity is the insurer's own
// arithmetic in its own system. The insurer knows, and says so by queueing
// this event.
async function handleReinstatement(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token to reinstate`);
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_Reinstate',
    actAs: [policy.insurer_canton_party_id],
    argument: {},
  });

  const { commandId, newContractId, newVersion, newPayload } = readReMintResult(
    responseData,
    'PolicyToken_Reinstate',
    event
  );
  // Read the default axis back off the re-minted token rather than assuming
  // 'none' -- same principle as every other value this dispatcher mirrors.
  const newDefaultState = DAML_DEFAULT_STATE_TO_SQL[newPayload?.defaultState];
  if (!newDefaultState) {
    throw new Error(
      `reinstatement event ${event.id}: re-minted token has an unrecognized defaultState ` +
        `'${newPayload?.defaultState}'`
    );
  }

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET default_state = $1, daml_contract_id = $2,
           current_version = COALESCE($3, current_version) WHERE id = $4`,
        [newDefaultState, newContractId, newVersion, policy.id]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_default_state, new_default_state,
            old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8)`,
        [
          policy.id,
          event.event_type,
          policy.status,          // unchanged by reinstatement
          policy.default_state,
          newDefaultState,
          policy.daml_contract_id,
          newContractId,
          'premium paid; coverage reinstated via policy_events outbox',
        ]
      );
    },
  };
}

// Stage 3 Part 3, Part B: exercises PolicyToken_Amend for one 'endorsement'
// outbox row -- the third lifecycle mechanism, alongside the claim path
// (trigger) and the premium-default path (notice/suspension/reinstatement).
//
// Every field of the endorsement comes from the insurer through the API and
// is passed straight to the choice. Nothing is computed or defaulted here:
// which coverages change, by how much, what the new term is, and the reason
// code are all the insurer's decisions. The choice itself enforces every
// invariant that matters (remainingLimit moves by the sum-insured delta
// rather than resetting, a paid-out coverage cannot be removed, the result
// cannot be empty or contain duplicate codes, and a terminated policy
// cannot be amended at all) -- deliberately NOT re-implemented here, so there is
// exactly one place those rules live and SQL can never disagree with the
// ledger about them.
//
// The coverage rows are re-mirrored wholesale from the re-minted token
// rather than patched field-by-field, because an endorsement can add and
// remove coverages, not just change them -- reconciling that incrementally
// would be a second implementation of the same delta logic.
async function handleEndorsement(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token to amend`);
  }
  const {
    reason,
    sumInsuredChanges = [],
    coveragesToAdd = [],
    coverageCodesToRemove = [],
    newExpiry = null,
    newBeneficiary,
    newMortgagee,
    newDocumentHash = null,
  } = event.payload ?? {};
  if (!reason) {
    throw new Error(
      `endorsement event ${event.id} is missing a reason in its payload -- ` +
        `every endorsement must record why it happened`
    );
  }
  if (!DAML_REASON_TO_SQL[reason]) {
    throw new Error(
      `endorsement event ${event.id} has an unrecognized reason '${reason}' -- ` +
        `expected one of ${Object.keys(DAML_REASON_TO_SQL).join(', ')}`
    );
  }
  // An added coverage needs product_code/peril_type/cell_ids for its SQL
  // row (tier lookup and oracle cell-reading both key off them), but the
  // Daml Coverage record carries none of the three -- the ledger never
  // needed them. The API supplies them alongside the ledger fields and
  // they are split apart here rather than invented.
  for (const c of coveragesToAdd) {
    if (!c.coverageCode || !c.productCode || !c.perilType || !Array.isArray(c.cellIds)) {
      throw new Error(
        `endorsement event ${event.id}: added coverage ${c.coverageCode ?? '(no code)'} is missing ` +
          `productCode, perilType, or cellIds -- required for its SQL row, never defaulted`
      );
    }
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_Amend',
    actAs: [policy.insurer_canton_party_id],
    argument: {
      reason,
      // Daml tuples cross the JSON API as 2-element objects keyed _1/_2.
      sumInsuredChanges: sumInsuredChanges.map((c) => ({
        _1: c.coverageCode,
        _2: String(c.sumInsured),
      })),
      // Only the fields the Daml Coverage record actually has -- the SQL
      // metadata above is deliberately not sent to the ledger.
      coveragesToAdd: coveragesToAdd.map((c) => ({
        coverageCode: c.coverageCode,
        sumInsured: String(c.sumInsured),
        remainingLimit: String(c.remainingLimit ?? c.sumInsured),
        payoutTiers: c.payoutTiers,
        payoutDestination: c.payoutDestination,
        mortgageeClaimAmount: c.mortgageeClaimAmount ?? null,
      })),
      coverageCodesToRemove,
      newExpiry,
      // Tri-state as an explicit flag + value (see the choice's own
      // comment): the payload carries {value} only when the insurer asked
      // for a change, and omits the key entirely otherwise.
      changeBeneficiary: newBeneficiary !== undefined && newBeneficiary !== null,
      newBeneficiary: newBeneficiary?.value ?? null,
      changeMortgagee: newMortgagee !== undefined && newMortgagee !== null,
      newMortgagee: newMortgagee?.value ?? null,
      newDocumentHash,
    },
  });

  const { commandId, newContractId, newVersion, newPayload } = readReMintResult(
    responseData,
    'PolicyToken_Amend',
    event
  );
  const newCoverages = newPayload?.coverages;
  if (!Array.isArray(newCoverages)) {
    throw new Error(`endorsement event ${event.id}: re-minted token carries no coverages array`);
  }

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      // document_hash moves only when the endorsement carried a new document
      // hash; without one the token keeps its hash, and so does this row.
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version),
           expiry = COALESCE($3, expiry), last_amendment_reason = $4,
           document_hash = COALESCE($6, document_hash)
         WHERE id = $5`,
        [newContractId, newVersion, newPayload?.expiry ?? null, DAML_REASON_TO_SQL[reason], policy.id, newDocumentHash]
      );

      // Mirror the token's coverage list exactly. Deliberately NOT an
      // upsert: product_code/peril_type/cell_ids are NOT NULL and have no
      // counterpart on the token, so an existing coverage must keep the
      // ones it already has while a newly added one takes them from the
      // endorsement's own input. An `ON CONFLICT DO UPDATE` cannot express
      // that -- Postgres validates the proposed row's NOT NULL constraints
      // before it ever considers the conflict, so the existing-row case
      // fails on a null product_code that the DO UPDATE would never have
      // written. Splitting update from insert keeps each path honest.
      const existing = new Set(
        (
          await txClient.query('SELECT coverage_code FROM policy_coverages WHERE policy_id = $1', [policy.id])
        ).rows.map((r) => r.coverage_code)
      );
      const addedMetadata = new Map(coveragesToAdd.map((c) => [c.coverageCode, c]));
      for (const c of newCoverages) {
        if (existing.has(c.coverageCode)) {
          await txClient.query(
            `UPDATE policy_coverages SET sum_insured = $1, remaining_limit = $2,
               payout_tiers_snapshot = $3, payout_destination = $4, mortgagee_claim_amount = $5
             WHERE policy_id = $6 AND coverage_code = $7`,
            [
              c.sumInsured,
              c.remainingLimit,
              JSON.stringify(c.payoutTiers),
              JSON.stringify(c.payoutDestination),
              // `?? null`, not a bare read: a None Optional INSIDE a nested
              // record comes back from the JSON API with the key ABSENT
              // entirely, not as null -- unlike a None at template level,
              // which is present and null. Found by the v13 wire check. pg
              // happens to coerce undefined to NULL, but relying on that is
              // relying on two libraries agreeing by accident.
              c.mortgageeClaimAmount ?? null,
              policy.id,
              c.coverageCode,
            ]
          );
          continue;
        }
        // New coverage. handleEndorsement already refused the event above
        // if any added coverage lacked this metadata, so it is present.
        const added = addedMetadata.get(c.coverageCode);
        await txClient.query(
          `INSERT INTO policy_coverages
             (policy_id, coverage_code, product_code, peril_type, cell_ids,
              sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, mortgagee_claim_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            policy.id,
            c.coverageCode,
            added.productCode,
            added.perilType,
            JSON.stringify(added.cellIds),
            c.sumInsured,
            c.remainingLimit,
            JSON.stringify(c.payoutTiers),
            JSON.stringify(c.payoutDestination),
            c.mortgageeClaimAmount ?? null,   // see the note above
          ]
        );
      }
      await txClient.query(
        `DELETE FROM policy_coverages WHERE policy_id = $1 AND coverage_code <> ALL($2::text[])`,
        [policy.id, newCoverages.map((c) => c.coverageCode)]
      );

      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,$3,$4,$5,$6)`,
        [
          policy.id,
          event.event_type,
          policy.status,   // an endorsement moves neither axis
          policy.daml_contract_id,
          newContractId,
          `endorsement (${reason}) applied via policy_events outbox`,
        ]
      );
    },
  };
}

// Stage 3 Part 4: renewal (tecditname) -- the last lifecycle mechanism, and
// the only one that does NOT archive-and-re-mint the policy it acts on.
//
// A renewal opens a NEW risk period as a NEW policy (new policyNo, new
// token, version 1) carrying `predecessorRef` back to the period it
// succeeds. The predecessor is deliberately left completely alone: it keeps
// its live token, runs to its own term end, and is closed by
// expirySweeper.js like any other policy. Both tokens are therefore live at
// once during the overlap between the two terms, which is correct and is
// not treated as an error anywhere.
//
// WHY THIS IS A PLAIN `create` AND NOT A CHOICE ON THE PREDECESSOR. Every
// other handler here exercises a choice, and a nonconsuming choice on the
// predecessor would let the ledger itself enforce "not in default". It
// cannot be used, for two reasons that both follow from the rules above:
//   1. The normal renewal case is renewing a policy that has already
//      EXPIRED -- and an expired policy has no live token at all (the
//      expiry sweeper archived it and cleared daml_contract_id). There is
//      nothing to exercise a choice against.
//   2. The predecessor must not be modified, so the ledger has nowhere to
//      record "this period has been succeeded" even when a token does
//      exist.
// A mixed model (choice when live, create when expired) would put the most
// common path on the unenforced branch anyway, so the preconditions are
// checked uniformly here instead, against the SQL mirror, under the
// advisory lock on the predecessor. `policies.renewed_by_policy_id` is the
// once-only guard, backed by a unique index so it holds even if two
// dispatchers somehow raced past the lock.
async function handleRenewal(event, predecessor) {
  const { newPolicyId } = event.payload ?? {};
  if (!newPolicyId) {
    throw new Error(
      `renewal event ${event.id} is missing newPolicyId in its payload -- the successor policy row ` +
        `is created by POST /policies/:id/renew before this event is queued`
    );
  }

  // Every check reads the predecessor fresh, under the lock (processEvent
  // re-selected it), never from whatever was true when the row was queued.
  if (predecessor.default_state !== 'none') {
    throw new Error(
      `cannot renew policy ${predecessor.id}: it is in premium default (default_state=` +
        `'${predecessor.default_state}'). The prior period's premium debt must be cleared and the ` +
        `default ended -- reinstate it first -- before a new risk period is underwritten`
    );
  }
  if (predecessor.status === 'claimed_and_closed') {
    throw new Error(
      `cannot renew policy ${predecessor.id}: it is claimed_and_closed -- its limits were exhausted ` +
        `by payout and the period is finished, not renewable`
    );
  }
  if (!RENEWABLE_STATUSES.has(predecessor.status)) {
    throw new Error(
      `cannot renew policy ${predecessor.id}: status '${predecessor.status}' is not renewable ` +
        `(expected one of ${[...RENEWABLE_STATUSES].join(', ')})`
    );
  }
  if (predecessor.renewed_by_policy_id) {
    throw new Error(
      `cannot renew policy ${predecessor.id}: it has already been renewed by ` +
        `${predecessor.renewed_by_policy_id} -- a period is succeeded exactly once`
    );
  }

  const { rows: successorRows } = await pool.query(
    `SELECT p.*, i.canton_party_id AS insurer_canton_party_id, i.oracle_operator_party,
            i.default_grace_period_days AS insurer_default_grace_period_days,
            i.mortgagee_continuation_days AS insurer_mortgagee_continuation_days,
            i.first_premium_withdrawal_days AS insurer_first_premium_withdrawal_days,
            i.default_event_window_timezone AS insurer_default_event_window_timezone,
            i.default_event_window_start_hour AS insurer_default_event_window_start_hour,
            i.default_event_aggregation AS insurer_default_event_aggregation
     FROM policies p JOIN insurers i ON i.id = p.insurer_id WHERE p.id = $1`,
    [newPolicyId]
  );
  const successor = successorRows[0];
  if (!successor) {
    throw new Error(`renewal event ${event.id}: successor policy ${newPolicyId} not found`);
  }
  if (successor.daml_contract_id || successor.current_version !== 0) {
    throw new Error(
      `renewal event ${event.id}: successor policy ${newPolicyId} has already been minted ` +
        `(contract ${successor.daml_contract_id}, version ${successor.current_version})`
    );
  }
  if (successor.policyholder_id !== predecessor.policyholder_id) {
    throw new Error(
      `renewal event ${event.id}: successor ${newPolicyId} belongs to a different policyholder than ` +
        `predecessor ${predecessor.id} -- a renewal carries the customer identity over unchanged`
    );
  }

  // Same resolution as activation: fail before the ledger call if no grace
  // period is configured anywhere, rather than minting a token no later
  // notice could compute a deadline for.
  const gracePeriodDays = resolveGracePeriodDays(successor);

  // The party is REUSED, never reallocated -- ensurePolicyholderParty
  // returns the existing one without a ledger call when the policyholder
  // already has one, and this policyholder necessarily does (the
  // predecessor was activated under it). Called rather than read straight
  // off the row so the one-party-per-policyholder invariant stays in a
  // single place.
  const partyId = await ensurePolicyholderParty(successor.policyholder_id);
  const termStartInstant = policyTermInstant(pgDateToDateString(successor.start_date));
  const termEndInstant = policyTermInstant(pgDateToDateString(successor.end_date));
  // Carried through from the successor row, which the renewal route copies
  // from the predecessor. Same registry, so the same bank keeps the same
  // party across every period of every policy it is named on.
  // Carried through with the customer identity, like every other role.
  const insuredParty = successor.insured_policyholder_id
    ? await ensurePolicyholderParty(successor.insured_policyholder_id)
    : partyId;
  const mortgageeParty = successor.mortgagee_policyholder_id
    ? await ensurePolicyholderParty(successor.mortgagee_policyholder_id)
    : null;
  const beneficiaryParty = successor.beneficiary_policyholder_id
    ? await ensurePolicyholderParty(successor.beneficiary_policyholder_id)
    : null;

  const { rows: coverageRows } = await pool.query(
    `SELECT * FROM policy_coverages WHERE policy_id = $1 ORDER BY created_at ASC`,
    [successor.id]
  );
  if (coverageRows.length === 0) {
    throw new Error(`renewal event ${event.id}: successor policy ${newPolicyId} has no coverages`);
  }

  // LIMITS RESET -- deliberately the exact INVERSE of PolicyToken_Amend.
  //
  // An endorsement moves remainingLimit BY THE DELTA of a sum-insured
  // change, precisely so a drawn-down limit is never silently restored. A
  // renewal does the opposite on purpose: the new period starts at its full
  // limit regardless of what the old period consumed, because it is a
  // different period of cover, not a continuation of the old one. A policy
  // that exhausted 90% of its limit last year is insured for the full new
  // sum insured this year.
  //
  // Nothing in this path reads, subtracts, or otherwise consults the
  // predecessor's remainingLimit -- not here, not in the SQL that built
  // these rows. If you are here to "fix" one of these two behaviours to
  // match the other, they are meant to differ; see the Amend-versus-renewal
  // contrast before changing either.
  const coverages = coverageRows.map((c) => ({
    coverageCode: c.coverage_code,
    sumInsured: String(c.sum_insured),
    remainingLimit: String(c.sum_insured),
    payoutTiers: c.payout_tiers_snapshot,
    payoutDestination: c.payout_destination,
    mortgageeClaimAmount: c.mortgagee_claim_amount === null ? null : String(c.mortgagee_claim_amount),
    // m. 1457. Carried through from SQL rather than defaulted, so a re-mint
    // keeps an attachment. A fresh policy -- including a renewal, which is a
    // new contract with its own coverage rows -- has neither set.
    attachedAt: c.attached_at ? new Date(c.attached_at).toISOString() : null,
    attachmentLiftedAt: c.attachment_lifted_at ? new Date(c.attachment_lifted_at).toISOString() : null,
  }));

  const { contractId, commandId } = await createContract({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    actAs: [successor.insurer_canton_party_id],
    payload: {
      policyNo: successor.id,
      version: 1,
      // The only field that makes this token a renewal rather than a first
      // policy. The predecessor's own token is untouched by this create.
      predecessorRef: predecessor.id,
      insurer: successor.insurer_canton_party_id,
      policyholder: partyId,
      insured: insuredParty,
      // m. 1421: minting records that the CONTRACT EXISTS. It does NOT mean
      // the policy is live. Both fields are null unless the parties agreed
      // cover starts without payment, in which case creation recorded the
      // agreed date and its basis and they are carried through here. Nothing
      // else sets them at mint -- cover otherwise begins at the instant the
      // insurer reports having received the first premium.
      coverageBeganAt: successor.coverage_began_at
        ? new Date(successor.coverage_began_at).toISOString()
        : null,
      coverageStartBasis: successor.coverage_start_basis ?? null,
      // m. 1458. A renewal's successor is created with no cover start (see
      // the renewal route), so it is never backdated at mint and there is no
      // window to check. If a successor is ever given a backdated start, the
      // check belongs here too.
      retroactiveCoverCheckedAt: null,
      beneficiary: beneficiaryParty,
      // Mutually exclusive with beneficiaryParty, enforced by the token's
      // own ensure clause, by a CHECK constraint, and at the API. m. 1494(2)
      // gives "no beneficiary named" its own consequence, so the ledger has
      // to distinguish that from "described but not named".
      beneficiaryDescriptorHash: successor.beneficiary_descriptor_hash ?? null,
      mortgagee: mortgageeParty,
      oracleOperator: successor.oracle_operator_party ?? successor.insurer_canton_party_id,
      coverages,
      // Stage 4: the term START, added so a refund under m. 1419 has the
      // facts it needs on-ledger. Same noon-Europe/Istanbul conversion as
      // the term end.
      termStart: termStartInstant,
      expiry: termEndInstant,
      coverageValidThrough: termEndInstant,
      noticeServiceDate: null,
      noticeRecordedAt: null,
      // m. 1434(4) counts notices within one insurance period. A renewal is
      // a new period, so a renewed token starts at zero too -- the count is
      // per-token and never carried across.
      noticeCount: 0,
      // m. 1434(4). A fresh policy has served no notices, so the list is
      // empty and the election fields are absent. noticeServiceDates is NOT
      // optional -- a list has an empty value rather than a missing one, and
      // omitting it fails preprocessing outright.
      noticeServiceDates: [],
      twoNoticeElectionAt: null,
      twoNoticeEffectiveAt: null,
      // m. 1434(2): all four None at mint. A due date is REPORTED later, if
      // the first premium goes unpaid; nothing here derives one.
      premiumDueDate: null,
      enforcementCommencedAt: null,
      withdrawnAt: null,
      withdrawalPath: null,
      terminationInstant: null,
      unrunDays: null,
      mortgageeNotifiedAt: null,
      mortgageeContinuationEndsAt: null,
      mortgageeElection: null,
      status: 'PS_Active',
      // A new period starts out of default even if the predecessor spent
      // time in one -- the predecessor's debt had to be cleared before this
      // renewal was allowed at all (checked above).
      defaultState: 'DS_None',
      documentHash: successor.document_hash ?? null,
      amendmentReason: null,
    },
  });

  return {
    contractId,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET status = 'active', current_version = 1, daml_contract_id = $1,
           expiry = $2, term_start = $6, grace_period_days = $3, predecessor_policy_id = $4,
           event_window_timezone = $7, event_window_start_hour = $8, event_aggregation = $9
         WHERE id = $5`,
        [
          contractId,
          termEndInstant,
          gracePeriodDays,
          predecessor.id,
          successor.id,
          termStartInstant,
          frozenEventWindow(successor).timezone,
          frozenEventWindow(successor).startHour,
          frozenEventWindow(successor).aggregation,
        ]
      );
      // The forward link on the predecessor, so the chain is navigable both
      // ways without walking the ledger -- and the once-only guard the next
      // renewal attempt will hit. The predecessor's status/default_state and
      // its live token are deliberately NOT touched: it keeps running to its
      // own term end.
      await txClient.query(`UPDATE policies SET renewed_by_policy_id = $1 WHERE id = $2`, [
        successor.id,
        predecessor.id,
      ]);

      // Two history rows: the successor's own activation, and the
      // predecessor's record that it was succeeded. The predecessor's row
      // restates its status unchanged on both sides, the same shape the
      // premium-default events use for an event that moves no axis.
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,'pending_mint','active',NULL,$3,$4)`,
        [successor.id, event.event_type, contractId, `renewal of policy ${predecessor.id} via policy_events outbox`]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,$3,$4,$4,$5)`,
        [
          predecessor.id,
          event.event_type,
          predecessor.status,
          predecessor.daml_contract_id,
          `renewed by policy ${successor.id}; this period continues to its own term end`,
        ]
      );
    },
  };
}

async function markFailed(eventId, message) {
  console.error(`[dispatcher] event ${eventId} failed:`, message);
  await pool.query(
    `UPDATE policy_events SET status = 'failed', error = $1, processed_at = now() WHERE id = $2`,
    [message, eventId]
  );
}

// Holds a SESSION-level advisory lock (not transaction-scoped -- the work
// inside includes a slow network call to the ledger, so the lock has to
// outlive any single SQL transaction) keyed on policy_no for the duration
// of `fn`. Different policies proceed independently; two events for the
// SAME policy never process concurrently, even across restarts or a
// second dispatcher process.
async function withPolicyLock(policyNo, fn) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [policyNo]);
    return await fn(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [policyNo]).catch(() => {});
    client.release();
  }
}

async function processEvent(event) {
  await withPolicyLock(event.policy_no, async (client) => {
    // Read fresh, under the lock -- never from a value captured when the
    // row was written or from an earlier tick. Every event type after
    // activation archives and re-creates, so a cached contract id or
    // version would be stale the moment another event lands.
    const { rows } = await client.query(
      `SELECT p.*, i.canton_party_id AS insurer_canton_party_id, i.oracle_operator_party,
              i.default_grace_period_days AS insurer_default_grace_period_days,
              i.mortgagee_continuation_days AS insurer_mortgagee_continuation_days,
              i.first_premium_withdrawal_days AS insurer_first_premium_withdrawal_days,
              i.default_event_window_timezone AS insurer_default_event_window_timezone,
              i.default_event_window_start_hour AS insurer_default_event_window_start_hour,
              i.default_event_aggregation AS insurer_default_event_aggregation
       FROM policies p JOIN insurers i ON i.id = p.insurer_id WHERE p.id = $1`,
      [event.policy_no]
    );
    const policy = rows[0];
    if (!policy) {
      await markFailed(event.id, 'policy not found');
      return;
    }
    if (!policy.insurer_canton_party_id) {
      await markFailed(event.id, 'insurer has no allocated Canton party');
      return;
    }

    const handler = EVENT_HANDLERS[event.event_type];
    let result;
    try {
      result = await handler(event, policy);
    } catch (err) {
      await markFailed(event.id, err.message);
      return;
    }

    // The ledger action has already succeeded past this point. If the SQL
    // write-back fails, the row must not end up 'done' (it wasn't
    // recorded) or stuck in 'processing' (indistinguishable from a crash
    // mid-flight) -- it ends in 'failed' with the commandId and
    // contractId embedded in the error text, so a human can find the real
    // on-ledger state and reconcile by hand. It is never auto-retried:
    // retrying a successful create/exercise risks doing it twice. This
    // fallback is shared by all three implemented event types; only
    // `result.writeBack` (each handler's own SQL, see EVENT_HANDLERS)
    // differs between them.
    try {
      await withTransaction(async (txClient) => {
        await result.writeBack(txClient);
        await txClient.query(
          `UPDATE policy_events SET status = 'done', resulting_contract_id = $1, processed_at = now() WHERE id = $2`,
          [result.contractId, event.id]
        );
      });
      console.log(
        `[dispatcher] event ${event.id} (${event.event_type}) policy ${policy.id} -> contract ${result.contractId}`
      );
    } catch (err) {
      const detail =
        `ledger succeeded (commandId=${result.commandId}, contractId=${result.contractId}) ` +
        `but write-back failed: ${err.message} -- needs manual reconciliation, do not re-submit`;
      console.error(`[dispatcher] CRITICAL: policy ${policy.id} event ${event.id}: ${detail}`);
      await pool
        .query(
          `UPDATE policy_events SET status = 'failed', resulting_contract_id = $1, error = $2, processed_at = now()
           WHERE id = $3`,
          [result.contractId, detail, event.id]
        )
        .catch((err2) => {
          console.error(
            `[dispatcher] CRITICAL: even the failure write-back failed for event ${event.id} -- fully manual ` +
              `recovery needed. commandId=${result.commandId} contractId=${result.contractId}`,
            err2
          );
        });
    }
  });
}

// SKIP LOCKED so a second concurrent dispatcher process, if one is ever
// run, can't claim the same row twice.
async function claimNext() {
  const { rows } = await pool.query(`
    UPDATE policy_events SET status = 'processing'
    WHERE id = (
      SELECT id FROM policy_events
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  return rows[0] ?? null;
}

// Processes pending events one at a time. Different policies' events could
// safely run concurrently (the per-policy advisory lock is what makes that
// safe) -- this loop doesn't do so, sequential is simple and fast enough
// at this scale; the locking is what keeps that a safe choice to revisit
// later rather than a correctness requirement now.
// ---------------------------------------------------------------------------
// m. 1434(2) -- first-premium default. One handler per act.
// ---------------------------------------------------------------------------

// Three months, in the statute's own unit. NOT converted to a day count
// anywhere: "üç ay" is three calendar months from the due date, and picking a
// number of days to stand for it would be inventing a figure the text does
// not give. The per-policy deadline is computed with calendar arithmetic
// below, and the configured window is measured against it.
const STATUTORY_MAX_FIRST_PREMIUM_WITHDRAWAL_MONTHS = 3;

// Calendar months, clamping to the end of a shorter month -- 31 Dec + 3
// months is 31 Mar, but 30 Nov + 3 months is 28/29 Feb, not 2/3 Mar.
function addCalendarMonths(date, months) {
  const d = new Date(date.getTime());
  const targetMonth = d.getUTCMonth() + months;
  const dayOfMonth = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(targetMonth);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
  ).getUTCDate();
  d.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return d;
}

// The window m. 1434(2) allows, resolved per policy.
//
// THIS IS A CEILING, and it is the inverse of resolveGracePeriodDays' floor.
// Do not "fix" one to match the other -- they guard in opposite directions,
// for the reason spelled out in the error below.
//
// m. 1434(2) gives the insurer a right exercisable WITHIN three months of the
// due date, which then lapses. m. 1452(3) forbids varying m. 1434 to the
// DETRIMENT of the sigorta ettiren, sigortalı or lehtar. A shorter window is
// less time in which the insurer may withdraw, so it is not to their
// detriment and is permitted; a longer one is.
function resolveFirstPremiumWindow(policy) {
  const days = policy.insurer_first_premium_withdrawal_days;
  if (days === null || days === undefined) {
    throw new Error(
      `no first-premium withdrawal window configured for policy ${policy.id}: set ` +
        `insurers.first_premium_withdrawal_days -- refusing to assume a statutory value`
    );
  }
  if (!policy.premium_due_date) {
    throw new Error(
      `policy ${policy.id} has no reported premium due date -- both of m. 1434(2)'s periods run ` +
        `from the vade, so nothing about this mechanism can be computed until it is reported`
    );
  }
  const dueDate = new Date(policy.premium_due_date);
  const statutoryDeadline = addCalendarMonths(dueDate, STATUTORY_MAX_FIRST_PREMIUM_WITHDRAWAL_MONTHS);
  const configuredDeadline = new Date(dueDate.getTime() + days * 24 * 60 * 60 * 1000);
  if (configuredDeadline.getTime() > statutoryDeadline.getTime()) {
    throw new Error(
      `first-premium withdrawal window of ${days} day(s) configured for policy ${policy.id} runs past ` +
        `the ${STATUTORY_MAX_FIRST_PREMIUM_WITHDRAWAL_MONTHS} months TTK 6102 m. 1434(2) allows ` +
        `(due ${dueDate.toISOString()}, statutory deadline ${statutoryDeadline.toISOString()}, ` +
        `configured ${configuredDeadline.toISOString()}). This is a CEILING, not a floor -- the ` +
        `opposite of the m. 1434(3) grace period: the article gives the insurer a right exercisable ` +
        `WITHIN three months, and m. 1452(3) forbids varying it to the detriment of the sigorta ` +
        `ettiren/sigortalı/lehtar, so a SHORTER window is permitted and a longer one is not. ` +
        `Configure ${STATUTORY_MAX_FIRST_PREMIUM_WITHDRAWAL_MONTHS} months or less`
    );
  }
  return { dueDate, deadline: configuredDeadline, statutoryDeadline };
}

// m. 1434(2)'s two routes, as the token records them.
const WITHDRAWAL_PATHS = new Set(['WP_InsurerWithdrew', 'WP_DeemedNoEnforcement']);

// The insurer reports that a first instalment, or a premium payable in one
// sum, fell due on a given date and has not been paid. m. 1431(1) puts that
// date at contract formation against delivery of the policy -- neither of
// which this platform can observe, so it is told, exactly like the ihtar
// service date.
async function handlePremiumDueDate(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  const { dueDate } = event.payload ?? {};
  if (!dueDate) {
    throw new Error(
      `premium due date event ${event.id} is missing dueDate -- the vade is the insurer's reported ` +
        `fact, never inferred, and both of m. 1434(2)'s periods run from it`
    );
  }
  const instant = new Date(dueDate);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`premium due date event ${event.id} has an unparseable dueDate: ${dueDate}`);
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_RecordPremiumDueDate',
    actAs: [policy.insurer_canton_party_id],
    argument: { dueDate: instant.toISOString() },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_RecordPremiumDueDate',
    event
  );

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      // Default axis only. `status` is untouched -- whether cover ever began
      // is m. 1421's question and this mechanism does not answer it.
      await txClient.query(
        `UPDATE policies SET default_state = 'first_premium_unpaid', daml_contract_id = $1,
           current_version = COALESCE($2, current_version), premium_due_date = $3
         WHERE id = $4`,
        [newContractId, newVersion, instant.toISOString(), policy.id]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_default_state, new_default_state,
            old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,$3,$4,'first_premium_unpaid',$5,$6,$7)`,
        [
          policy.id,
          event.event_type,
          policy.status,
          policy.default_state,
          policy.daml_contract_id,
          newContractId,
          `first premium reported due ${instant.toISOString()} and unpaid (TTK m. 1434(2))`,
        ]
      );
    },
  };
}

// "dava veya takip yoluyla" -- the insurer says it pursued the premium claim.
// Recording COMMENCEMENT only: whether it proved fruitless (semeresiz) is
// m. 1431(4)'s trigger for substitution by the sigortalı, a different fact,
// deliberately not implemented.
async function handleEnforcementCommenced(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  const { commencedAt } = event.payload ?? {};
  if (!commencedAt) {
    throw new Error(
      `enforcement event ${event.id} is missing commencedAt -- the platform cannot observe ` +
        `litigation, so the date is the insurer's reported fact`
    );
  }
  const instant = new Date(commencedAt);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`enforcement event ${event.id} has an unparseable commencedAt: ${commencedAt}`);
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_RecordEnforcementCommenced',
    actAs: [policy.insurer_canton_party_id],
    argument: { commencedAt: instant.toISOString() },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_RecordEnforcementCommenced',
    event
  );

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version),
           enforcement_commenced_at = $3 WHERE id = $4`,
        [newContractId, newVersion, instant.toISOString(), policy.id]
      );
    },
  };
}

// m. 1457: the insured property has been attached, or the attachment lifted.
//
// Both reported from outside with their own dates -- the platform cannot
// observe an icra file, and holds no case number, court, office identifier or
// party identity for one. Recorded per COVERAGE, which is an approximation:
// the article attaches to the property and this system has no property
// registry. Same approximation v17 made for the mortgagee's charge.
async function handleAttachmentFact(event, policy, { choice, dateField, column, label }) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  const { coverageCode } = event.payload ?? {};
  const supplied = (event.payload ?? {})[dateField];
  if (!coverageCode) {
    throw new Error(
      `${label} event ${event.id} is missing coverageCode -- m. 1457 is recorded per coverage`
    );
  }
  if (!supplied || Number.isNaN(new Date(supplied).getTime())) {
    throw new Error(
      `${label} event ${event.id} is missing or has an unparseable ${dateField} -- the platform ` +
        `cannot observe an icra file, so the date is the insurer's reported fact`
    );
  }
  const instant = new Date(supplied);

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice,
    actAs: [policy.insurer_canton_party_id],
    argument: { coverageCode, [dateField]: instant.toISOString() },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(responseData, choice, event);

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version)
         WHERE id = $3`,
        [newContractId, newVersion, policy.id]
      );
      const { rowCount } = await txClient.query(
        `UPDATE policy_coverages SET ${column} = $1 WHERE policy_id = $2 AND coverage_code = $3`,
        [instant.toISOString(), policy.id, coverageCode]
      );
      if (rowCount !== 1) {
        throw new Error(
          `${label} event ${event.id}: expected exactly one coverage row for ${coverageCode}, ` +
            `updated ${rowCount}`
        );
      }
    },
  };
}

// Function declarations, not const arrows: the handler map at the top of this
// file references them before this point, and only declarations are hoisted.
function handleAttachment(event, policy) {
  return handleAttachmentFact(event, policy, {
    choice: 'PolicyToken_RecordAttachment',
    dateField: 'attachedAt',
    column: 'attached_at',
    label: 'attachment',
  });
}

function handleAttachmentLifted(event, policy) {
  return handleAttachmentFact(event, policy, {
    choice: 'PolicyToken_RecordAttachmentLifted',
    dateField: 'liftedAt',
    column: 'attachment_lifted_at',
    label: 'attachment_lifted',
  });
}

// m. 1434(4): the insurer elects to terminate at the end of the insurance
// period. THE THIRD way a contract ends for non-payment -- (2) is withdrawal,
// (3) is automatic at the end of a notice period -- and the only one that is
// discretionary with a deferred effect.
//
// The period is SUPPLIED by the insurer, never derived. m. 1411 ties it to
// how the premium is CALCULATED and this system holds no calculation basis;
// start_date/end_date are the contract term, a different thing. What the
// LEDGER checks is that two recorded service dates actually fall inside the
// period named -- which is why noticeServiceDates exists.
async function handleTwoNoticeElection(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  const { electedAt, insurancePeriodStart, insurancePeriodEnd } = event.payload ?? {};
  for (const [name, value] of [
    ['electedAt', electedAt],
    ['insurancePeriodStart', insurancePeriodStart],
    ['insurancePeriodEnd', insurancePeriodEnd],
  ]) {
    if (!value || Number.isNaN(new Date(value).getTime())) {
      throw new Error(
        `two_notice_election event ${event.id} is missing or has an unparseable ${name} -- the ` +
          `insurance period is the insurer's own fact and is never derived here`
      );
    }
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_ElectTwoNoticeTermination',
    actAs: [policy.insurer_canton_party_id],
    argument: {
      electedAt: new Date(electedAt).toISOString(),
      insurancePeriodStart: new Date(insurancePeriodStart).toISOString(),
      insurancePeriodEnd: new Date(insurancePeriodEnd).toISOString(),
    },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_ElectTwoNoticeTermination',
    event
  );

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version),
           default_state = 'two_notice_elected', two_notice_election_at = $3,
           two_notice_effective_at = $4
         WHERE id = $5`,
        [
          newContractId,
          newVersion,
          new Date(electedAt).toISOString(),
          new Date(insurancePeriodEnd).toISOString(),
          policy.id,
        ]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_default_state, new_default_state,
            old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,$3,$4,'two_notice_elected',$5,$6,$7)`,
        [
          policy.id,
          event.event_type,
          policy.status,
          policy.default_state,
          policy.daml_contract_id,
          newContractId,
          'm. 1434(4): two ihtars in one insurance period; termination elected to take effect ' +
            'at the end of that period',
        ]
      );
    },
  };
}

// m. 1434(4): the deferred effect landing. Queued by twoNoticeSweeper.js as a
// STATE TEST -- the sweeper does not decide this, it observes that the frozen
// instant has passed.
//
// The instant is read from the token, never from a clock, so a sweeper
// running three days late records the instant it would have recorded on time.
// Same discipline as the m. 1434(3) termination instant.
async function handleTwoNoticeTermination(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  if (!policy.two_notice_effective_at) {
    throw new Error(
      `two_notice_termination event ${event.id}: policy ${policy.id} has no recorded effective ` +
        `instant -- the election must be recorded before its effect can land`
    );
  }
  const effective = new Date(policy.two_notice_effective_at);

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_ApplyTwoNoticeTermination',
    actAs: [policy.insurer_canton_party_id],
    // The ledger re-checks this against its own frozen field. Supplying the
    // same instant rather than `now` keeps the two in step and makes a late
    // sweep indistinguishable from a punctual one.
    argument: { appliedAt: effective.toISOString() },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_ApplyTwoNoticeTermination',
    event
  );

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      // The coverage end is NOT written again here. two_notice_effective_at
      // already holds it -- it is the same instant the token sets
      // coverageValidThrough to -- and there is no coverage_valid_through
      // column in SQL at all: the m. 1434(3) path records terminated_at for
      // the same reason.
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version),
           default_state = 'two_notice_terminated'
         WHERE id = $3`,
        [newContractId, newVersion, policy.id]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_default_state, new_default_state,
            old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,$3,$4,'two_notice_terminated',$5,$6,$7)`,
        [
          policy.id,
          event.event_type,
          policy.status,
          policy.default_state,
          policy.daml_contract_id,
          newContractId,
          'm. 1434(4): the elected termination took effect at the end of the insurance period',
        ]
      );
    },
  };
}

// m. 1456(6): the mortgagee asked. Reported by the insurer, which is who
// receives the request -- the platform is not addressable by a mortgagee and
// does not want to be.
//
// Nothing about who asked is recorded beyond the policy itself, which already
// names the mortgagee. No name, address or contact detail is accepted here.
async function handleMortgageeInfoRequest(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  const { requestedAt } = event.payload ?? {};
  if (!requestedAt) {
    throw new Error(
      `mortgagee_info_request event ${event.id} is missing requestedAt -- the platform does not ` +
        `receive the request, so the date is the insurer's reported fact`
    );
  }
  const instant = new Date(requestedAt);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`mortgagee_info_request event ${event.id} has an unparseable requestedAt: ${requestedAt}`);
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_RecordMortgageeInfoRequest',
    actAs: [policy.insurer_canton_party_id],
    argument: { requestedAt: instant.toISOString() },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_RecordMortgageeInfoRequest',
    event
  );

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version),
           mortgagee_info_requested_at = $3 WHERE id = $4`,
        [newContractId, newVersion, instant.toISOString(), policy.id]
      );
    },
  };
}

// m. 1456(6): the insurer says it gave the information.
//
// WHAT was disclosed is deliberately not recorded. The token already carries
// the cover and the sum insured, and the mortgagee -- an observer -- can read
// them directly; a second copy in a disclosure log could only drift from the
// first. What this records is the ACT, which is the thing standing
// observation cannot evidence.
async function handleMortgageeInfoProvided(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  const { providedAt } = event.payload ?? {};
  if (!providedAt) {
    throw new Error(
      `mortgagee_info_provided event ${event.id} is missing providedAt -- the platform does not ` +
        `answer the request, so the date is the insurer's reported fact`
    );
  }
  const instant = new Date(providedAt);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`mortgagee_info_provided event ${event.id} has an unparseable providedAt: ${providedAt}`);
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_RecordMortgageeInfoProvided',
    actAs: [policy.insurer_canton_party_id],
    argument: { providedAt: instant.toISOString() },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_RecordMortgageeInfoProvided',
    event
  );

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version),
           mortgagee_info_provided_at = $3 WHERE id = $4`,
        [newContractId, newVersion, instant.toISOString(), policy.id]
      );
    },
  };
}

// m. 1431(4), fact ONE. Enforcement against the sigorta ettiren for the
// premium debt proved fruitless.
//
// Deliberately NOT the same fact as enforcement_commenced above, and it does
// not require it: commencement SUSPENDS m. 1434(2)'s deemed withdrawal,
// fruitlessness OPENS substitution, and the m. 1434(3) notice mechanism has
// no commencement column at all. Requiring one would force that path to
// report something it was never given a place to record.
async function handleEnforcementFruitless(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  const { fruitlessAt, route } = event.payload ?? {};
  if (!fruitlessAt) {
    throw new Error(
      `enforcement_fruitless event ${event.id} is missing fruitlessAt -- the platform cannot ` +
        `observe an enforcement proceeding, so the date is the insurer's reported fact`
    );
  }
  // Recorded, never guessed at: m. 1434(2) names "dava veya takip" while
  // m. 1431(4) names only "takip", so which route it actually was is a fact a
  // later reading may turn on.
  if (route !== 'ER_Takip' && route !== 'ER_Dava') {
    throw new Error(
      `enforcement_fruitless event ${event.id} has an unrecognized route '${route}' -- ` +
        `expected one of ER_Takip, ER_Dava`
    );
  }
  const instant = new Date(fruitlessAt);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`enforcement_fruitless event ${event.id} has an unparseable fruitlessAt: ${fruitlessAt}`);
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_RecordEnforcementFruitless',
    actAs: [policy.insurer_canton_party_id],
    argument: { fruitlessAt: instant.toISOString(), route },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_RecordEnforcementFruitless',
    event
  );

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version),
           enforcement_fruitless_at = $3, enforcement_route = $4 WHERE id = $5`,
        [newContractId, newVersion, instant.toISOString(), route, policy.id]
      );
    },
  };
}

// m. 1431(4), fact TWO. The insurer notified the sigortali.
//
// The ledger enforces the ordering as well; this handler does not re-derive
// it. The token's own assertion is the line that cannot be bypassed.
async function handleSubstitutionNotice(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  const { notifiedAt } = event.payload ?? {};
  if (!notifiedAt) {
    throw new Error(
      `substitution_notice event ${event.id} is missing notifiedAt -- the platform cannot serve ` +
        `a notice, so the date is the insurer's reported fact`
    );
  }
  const instant = new Date(notifiedAt);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`substitution_notice event ${event.id} has an unparseable notifiedAt: ${notifiedAt}`);
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_RecordSubstitutionNotice',
    actAs: [policy.insurer_canton_party_id],
    argument: { notifiedAt: instant.toISOString() },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_RecordSubstitutionNotice',
    event
  );

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version),
           substitution_notified_at = $3 WHERE id = $4`,
        [newContractId, newVersion, instant.toISOString(), policy.id]
      );
    },
  };
}

// m. 1431(4), fact THREE, and the only handler in this file that changes who
// a party is. "Sozlesme bu kisilerle devam eder" -- the contract continues
// WITH the sigortali, so policyholder_id becomes insured_policyholder_id and
// the superseded party is recorded rather than dropped.
//
// Never routed through handleEndorsement: Amend is forbidden to touch the
// policyholder and stays forbidden.
async function handleSubstitution(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  // The precondition the whole paragraph rests on. Checked here as well as on
  // the ledger so the row fails with a readable reason rather than a
  // ledger interpretation error.
  if (!policy.insured_policyholder_id || policy.insured_policyholder_id === policy.policyholder_id) {
    throw new Error(
      `policy ${policy.id} is not insurance for another's account -- its sigortali is its sigorta ` +
        `ettiren, so m. 1431(4) has nobody to substitute in`
    );
  }
  const { substitutedAt } = event.payload ?? {};
  if (!substitutedAt) {
    throw new Error(
      `substitution event ${event.id} is missing substitutedAt -- the platform cannot witness an ` +
        `undertaking, so the date is the insurer's reported fact`
    );
  }
  const instant = new Date(substitutedAt);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`substitution event ${event.id} has an unparseable substitutedAt: ${substitutedAt}`);
  }

  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_SubstitutePolicyholder',
    actAs: [policy.insurer_canton_party_id],
    argument: { substitutedAtInstant: instant.toISOString() },
  });
  const { commandId, newContractId, newVersion } = readReMintResult(
    responseData,
    'PolicyToken_SubstitutePolicyholder',
    event
  );

  const supersededId = policy.policyholder_id;
  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      // default_state is deliberately NOT touched. An undertaking is not a
      // payment; the premium is exactly as unpaid as it was, and clearing the
      // default would assert something m. 1431(4) does not say. What the
      // substitution does prevent is the termination completing -- see the
      // freeze in graceSweeper.js and in PolicyToken_Terminate.
      await txClient.query(
        `UPDATE policies SET daml_contract_id = $1, current_version = COALESCE($2, current_version),
           substituted_at = $3, superseded_policyholder_id = $4,
           policyholder_id = insured_policyholder_id
         WHERE id = $5`,
        [newContractId, newVersion, instant.toISOString(), supersededId, policy.id]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_default_state, new_default_state,
            old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,$3,$4,$4,$5,$6,$7)`,
        [
          policy.id,
          event.event_type,
          policy.status,
          // BOTH axes recorded unchanged, deliberately. A substitution moves
          // neither: the claim axis is untouched and the default axis is
          // frozen rather than cleared, and the audit chain should show that
          // rather than leave it to be inferred from an absence.
          policy.default_state,
          policy.daml_contract_id,
          newContractId,
          `m. 1431(4): the sigortali took over the premium; the contract continues with them. ` +
            `Superseded policyholder ${supersededId}.`,
        ]
      );
    },
  };
}

// The first premium was paid after all, before either route completed.
// Deliberately NOT handleReinstatement: that is the exit from m. 1434(3)'s
// notice period, and the two mechanisms are kept apart.
async function handleFirstPremiumPaid(event, policy) {
  if (!policy.daml_contract_id) {
    throw new Error(`policy ${policy.id} has no active token`);
  }
  // m. 1421: this date is when the insurer's liability begins, so it is the
  // insurer's REPORTED date and never a clock reading. Until v15 the argument
  // was supplied as Date.now() and then discarded by the choice; harmless
  // while nothing depended on it, not harmless now.
  const { paidAt } = event.payload ?? {};
  if (!paidAt) {
    throw new Error(
      `first-premium-paid event ${event.id} is missing paidAt -- the platform cannot observe a ` +
        `payment, and under m. 1421 this date is when cover begins`
    );
  }
  const paidInstant = new Date(paidAt);
  if (Number.isNaN(paidInstant.getTime())) {
    throw new Error(`first-premium-paid event ${event.id} has an unparseable paidAt: ${paidAt}`);
  }
  const responseData = await exerciseChoice({
    commandSeed: event.id,
    moduleName: 'Insurance.PolicyToken',
    entityName: 'PolicyToken',
    contractId: policy.daml_contract_id,
    choice: 'PolicyToken_RecordFirstPremiumPaid',
    actAs: [policy.insurer_canton_party_id],
    argument: { paidAt: paidInstant.toISOString() },
  });
  const { commandId, newContractId, newVersion, newPayload } = readReMintResult(
    responseData,
    'PolicyToken_RecordFirstPremiumPaid',
    event
  );
  const newDefaultState = DAML_DEFAULT_STATE_TO_SQL[newPayload?.defaultState];
  if (!newDefaultState) {
    throw new Error(
      `unrecognized defaultState '${newPayload?.defaultState}' on the token re-minted by ` +
        `PolicyToken_RecordFirstPremiumPaid for event ${event.id}`
    );
  }

  return {
    contractId: newContractId,
    commandId,
    writeBack: async (txClient) => {
      // The due date stays on the row: it is a fact about what happened, not
      // a flag to clear -- the same reasoning that keeps notice_service_date
      // after reinstatement.
      //
      // coverage_began_at and its basis are mirrored off the re-minted token
      // rather than assumed: where cover had already begun by agreement the
      // choice keeps the EARLIER instant, so writing paidInstant here would
      // overwrite it.
      await txClient.query(
        `UPDATE policies SET default_state = $1, daml_contract_id = $2,
           current_version = COALESCE($3, current_version), first_premium_paid_at = $5,
           coverage_began_at = $6, coverage_start_basis = $7
         WHERE id = $4`,
        [
          newDefaultState,
          newContractId,
          newVersion,
          policy.id,
          paidInstant.toISOString(),
          newPayload?.coverageBeganAt ?? null,
          newPayload?.coverageStartBasis ?? null,
        ]
      );
      await txClient.query(
        `INSERT INTO policy_status_history
           (policy_id, event_type, old_status, new_status, old_default_state, new_default_state,
            old_daml_contract_id, new_daml_contract_id, reason)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8)`,
        [
          policy.id,
          event.event_type,
          policy.status,
          policy.default_state,
          newDefaultState,
          policy.daml_contract_id,
          newContractId,
          'first premium reported paid before either m. 1434(2) route completed',
        ]
      );
    },
  };
}

// Withdrawal under m. 1434(2), by whichever route the event names.
//
// Shared by both outbox types: 'first_premium_withdrawal' (the insurer's own
// act, sentence 1) and 'first_premium_deemed_withdrawal' (operation of law
// from inaction, sentence 2, written only by the sweeper). One handler
// because the ledger act is the same; two event types because the acts are
// not, and which one applied is a fact a later reading may turn on.
function makeWithdrawalHandler(path) {
  return async function handleFirstPremiumWithdrawal(event, policy) {
    if (!policy.daml_contract_id) {
      throw new Error(`policy ${policy.id} has no active token to withdraw from`);
    }
    if (policy.default_state !== 'first_premium_unpaid') {
      throw new Error(
        `policy ${policy.id} is not in first-premium default (default_state=` +
          `'${policy.default_state}') -- m. 1434(2) withdrawal applies only to it`
      );
    }
    // Refused rather than defaulted: without the vade there is no period for
    // either of m. 1434(2)'s clocks to run from.
    const { dueDate, deadline } = resolveFirstPremiumWindow(policy);

    if (path === 'WP_DeemedNoEnforcement') {
      // Sentence 2 follows from the claim NOT having been pursued. Re-checked
      // here, fresh and under the advisory lock, not only in the sweeper: the
      // insurer could have reported enforcement between the sweep and this
      // handler running.
      if (policy.enforcement_commenced_at) {
        throw new Error(
          `policy ${policy.id} has enforcement reported as commenced ` +
            `${new Date(policy.enforcement_commenced_at).toISOString()} -- m. 1434(2)'s deemed ` +
            `withdrawal follows from the claim NOT having been pursued, so it does not apply`
        );
      }
    }

    // The withdrawal instant. For the deemed route it is the deadline itself,
    // derived from the reported due date -- not a clock reading, so a sweeper
    // running late records the instant it would have recorded on time. For
    // the insurer's own act it is when the act was reported.
    const withdrawnAt =
      path === 'WP_DeemedNoEnforcement' ? deadline : new Date(event.payload?.withdrawnAt ?? Date.now());
    if (Number.isNaN(withdrawnAt.getTime())) {
      throw new Error(`withdrawal event ${event.id} has an unparseable withdrawnAt`);
    }
    if (path === 'WP_InsurerWithdrew' && withdrawnAt.getTime() > deadline.getTime()) {
      throw new Error(
        `policy ${policy.id}: the insurer's withdrawal is dated ${withdrawnAt.toISOString()}, past the ` +
          `window ending ${deadline.toISOString()} (due ${dueDate.toISOString()}). m. 1434(2) gives ` +
          `the right WITHIN the period; after it the right has lapsed and sentence 2 governs instead`
      );
    }

    const responseData = await exerciseChoice({
      commandSeed: event.id,
      moduleName: 'Insurance.PolicyToken',
      entityName: 'PolicyToken',
      contractId: policy.daml_contract_id,
      choice: 'PolicyToken_WithdrawForFirstPremium',
      actAs: [policy.insurer_canton_party_id],
      argument: { withdrawnAt: withdrawnAt.toISOString(), path },
    });
    const { commandId, newContractId, newVersion } = readReMintResult(
      responseData,
      'PolicyToken_WithdrawForFirstPremium',
      event
    );

    return {
      contractId: newContractId,
      commandId,
      writeBack: async (txClient) => {
        // The token is re-minted, NOT archived. Whether cayma leaves the
        // contract as never having existed is unresolved on the text --
        // an open legal question -- and archiving would encode an answer.
        await txClient.query(
          `UPDATE policies SET default_state = 'withdrawn_for_first_premium', daml_contract_id = $1,
             current_version = COALESCE($2, current_version), withdrawn_at = $3, withdrawal_path = $4
           WHERE id = $5`,
          [newContractId, newVersion, withdrawnAt.toISOString(), path, policy.id]
        );
        await txClient.query(
          `INSERT INTO policy_status_history
             (policy_id, event_type, old_status, new_status, old_default_state, new_default_state,
              old_daml_contract_id, new_daml_contract_id, reason)
           VALUES ($1,$2,$3,$3,$4,'withdrawn_for_first_premium',$5,$6,$7)`,
          [
            policy.id,
            event.event_type,
            policy.status,
            policy.default_state,
            policy.daml_contract_id,
            newContractId,
            path === 'WP_DeemedNoEnforcement'
              ? `three-month period from ${dueDate.toISOString()} elapsed with no suit or ` +
                `enforcement reported; withdrawn by operation of law (TTK m. 1434(2), 2nd sentence)`
              : `insurer withdrew ${withdrawnAt.toISOString()}, within the period from ` +
                `${dueDate.toISOString()} (TTK m. 1434(2), 1st sentence)`,
          ]
        );
      },
    };
  };
}

// A ledger outage, stage 1 of the outage handling: the dispatcher stops CLAIMING rows
// rather than failing them. A claimed row can only reach done or failed (the
// table's own trigger), and failed is terminal -- so claiming through an
// outage would burn every pending row for as long as it lasted. Left pending,
// they are picked up when the participant answers again, with nothing for an
// operator to do.
//
// THE PROBE IS NOT A GUARANTEE, AND IS NOT MEANT TO BE. If it passes and the
// command that follows fails, the row still ends `failed`, exactly as before:
// a submitted command may have reached the ledger, and retrying it risks
// minting twice. The probe only keeps rows out of the claim loop while the
// participant is known to be unreachable; it never makes a failed exercise
// retryable, and it does not touch the outbox's state machine.
let ledgerOutageSince = null;
let lastOutageLogAt = 0;
const OUTAGE_LOG_EVERY_MS = 5 * 60 * 1000;

// Logged once when an outage starts and then rarely, because this runs every
// poll: a five-minute outage would otherwise be 150 identical lines.
function noteLedgerUnreachable(err) {
  const now = Date.now();
  if (ledgerOutageSince === null) {
    ledgerOutageSince = now;
    lastOutageLogAt = now;
    console.error(`[dispatcher] ledger unreachable -- claiming nothing until it answers, pending rows stay pending: ${err.message}`);
  } else if (now - lastOutageLogAt >= OUTAGE_LOG_EVERY_MS) {
    lastOutageLogAt = now;
    console.error(`[dispatcher] ledger still unreachable after ${Math.round((now - ledgerOutageSince) / 1000)}s: ${err.message}`);
  }
}

function noteLedgerReachable() {
  if (ledgerOutageSince === null) return;
  console.log(`[dispatcher] ledger answers again after ${Math.round((Date.now() - ledgerOutageSince) / 1000)}s -- resuming`);
  ledgerOutageSince = null;
}

// probeLedger is the seam tests use to supply a failing probe, the same shape
// as the sweepers' insurerIds. Production passes nothing.
export async function runOnce({ probeLedger = getLedgerEnd } = {}) {
  // The probe costs one GET per poll, so it is only worth making when there
  // is something to claim: an idle dispatcher makes no ledger call at all.
  const { rows: waiting } = await pool.query(
    `SELECT 1 FROM policy_events WHERE status = 'pending' LIMIT 1`
  );
  if (waiting.length === 0) return;

  try {
    await probeLedger();
  } catch (err) {
    noteLedgerUnreachable(err);
    return;
  }
  noteLedgerReachable();

  for (;;) {
    const event = await claimNext();
    if (!event) break;
    await processEvent(event);
  }
}

export function startDispatcher() {
  console.log(`[dispatcher] polling every ${config.mintWatcher.pollMs}ms`);
  setInterval(() => {
    runOnce().catch((err) => console.error('[dispatcher] run failed:', err));
  }, config.mintWatcher.pollMs);
}

// See oracleBot.js for why pathToFileURL is used here instead of manual
// string concatenation (Windows path-format mismatch made that dead code).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDispatcher();
  runOnce().catch((err) => console.error('[dispatcher] initial run failed:', err));
}
