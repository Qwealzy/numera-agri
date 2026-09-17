import { Router } from 'express';
import crypto from 'node:crypto';
import { pool, withTransaction } from '../db.js';

export const policiesRouter = Router();

async function authenticateInsurer(req) {
  const apiKey = req.header('x-api-key');
  if (!apiKey) {
    const err = new Error('missing x-api-key header');
    err.status = 401;
    throw err;
  }
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const { rows } = await pool.query(
    'SELECT * FROM insurers WHERE api_key_hash = $1 AND is_active = true',
    [apiKeyHash]
  );
  if (rows.length === 0) {
    const err = new Error('unknown or inactive insurer');
    err.status = 401;
    throw err;
  }
  return rows[0];
}

// SQL-only -- no Daml/Canton call here at all. Party allocation happens
// later, reactively, in dispatch/dispatcher.js -- and only once, on that
// policyholder's first activation; every later policy for the same
// external_ref reuses the existing Party.
async function ensurePolicyholderRecord(insurer, policyholderInput) {
  // Neither field is stored. Rejecting outright is the honest behaviour --
  // silently discarding it would let a caller believe a name or national id
  // had been saved when nothing was. externalRef is the only identity this
  // platform holds for a person; the insurer's own systems hold the rest.
  if (policyholderInput.fullName !== undefined || policyholderInput.nationalId !== undefined) {
    const err = new Error(
      'fullName and nationalId are not accepted or stored by this platform -- identify people by externalRef only'
    );
    err.status = 400;
    throw err;
  }
  const existing = await pool.query(
    'SELECT * FROM policyholders WHERE insurer_id = $1 AND external_ref = $2',
    [insurer.id, policyholderInput.externalRef]
  );
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await pool.query(
    `INSERT INTO policyholders (insurer_id, external_ref)
     VALUES ($1, $2) RETURNING *`,
    [insurer.id, policyholderInput.externalRef]
  );
  return inserted.rows[0];
}

// Resolves and snapshots one coverage's tier matrix at creation time -- not
// re-read at mint time, which may be much later depending on when the
// policy is activated. See Module 2 note in the README. Throws a 422 if
// the insurer hasn't configured tiers for this coverage's product/peril --
// a package policy creates all-or-nothing: one unconfigured coverage fails
// the whole request rather than creating a partial policy.
async function resolveCoverage(insurer, coverageInput) {
  const tiersResult = await pool.query(
    `SELECT * FROM payout_tiers
     WHERE insurer_id = $1 AND product_code = $2 AND peril_type = $3
     ORDER BY tier_order ASC`,
    [insurer.id, coverageInput.productCode, coverageInput.perilType]
  );
  if (tiersResult.rows.length === 0) {
    const err = new Error(
      `no payout_tiers configured for ${coverageInput.productCode}/${coverageInput.perilType} ` +
        `(coverage ${coverageInput.coverageCode}) -- add rows before creating a policy`
    );
    err.status = 422;
    throw err;
  }
  // A mortgagee's claim on THIS coverage. Absent is the normal case, not a
  // missing value -- a bank's charge may sit on the fire coverage and not
  // the glass one. It is a CEILING on what the mortgagee may be paid from
  // this coverage; the split between mortgagee and insured is the insurer's
  // own arithmetic, off-system, like every other money question here.
  if (coverageInput.mortgageeClaimAmount !== undefined && coverageInput.mortgageeClaimAmount !== null) {
    const amount = Number(coverageInput.mortgageeClaimAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      const err = new Error(
        `mortgageeClaimAmount on coverage ${coverageInput.coverageCode} must be a positive number`
      );
      err.status = 400;
      throw err;
    }
  }
  return {
    coverageCode: coverageInput.coverageCode,
    productCode: coverageInput.productCode,
    perilType: coverageInput.perilType,
    cellIds: coverageInput.cellIds,
    sumInsured: coverageInput.sumInsured,
    mortgageeClaimAmount: coverageInput.mortgageeClaimAmount ?? null,
    payoutTiersSnapshot: tiersResult.rows.map((t) => ({
      tierOrder: t.tier_order,
      label: t.label,
      minValue: t.threshold_min === null ? null : String(t.threshold_min),
      maxValue: t.threshold_max === null ? null : String(t.threshold_max),
      payoutPct: String(t.payout_percentage),
    })),
  };
}

// POST /api/v1/policies -- creation only. Writes the policy's terms to SQL
// and returns. Does not touch Canton, does not allocate a Party, does not
// mint. Activation (below) is a separate, later act.
// Body:
//   policyholder: { externalRef }
//   policyTerms:  { premiumAmount, currency?, startDate, endDate }
//   coverages:    [{ coverageCode, productCode, perilType, cellIds[], sumInsured }, ...]
//                  -- required, non-empty, coverageCode unique within the
//                  array. Stage 2 Part 2: there is no single-coverage
//                  convenience shape -- even a one-coverage policy (e.g.
//                  today's frost product) sends a one-element array.
//   actuarialPayload: opaque pass-through of whatever the insurer's own
//                      SAS/Python pricing job computed -- stored for audit,
//                      not interpreted here.
// payoutDestination/mortgageeClaimAmount are not accepted here -- there is
// still no payout-destination mechanism (no mortgagee intake exists
// anywhere in this system yet), so both are system-derived, the same way
// insured/beneficiary/mortgagee already are at activation time.
policiesRouter.post('/policies', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);

    const {
      policyholder: policyholderInput,
      // Both optional, and both are PEOPLE the insurer has onboarded, in the
      // same shape as policyholder: { externalRef }.
      // Each gets exactly one Party per (person, insurer), reused across
      // every policy naming them -- see ensurePolicyholderRecord.
      mortgagee: mortgageeInput,
      beneficiary: beneficiaryInput,
      // The sigortalı, where distinct from the sigorta ettiren. Same shape as
      // the other roles and resolved through the same registry. Omitted means
      // "the same person", which is the common case and what the statute
      // assumes where nothing else is said.
      insured: insuredInput,
      // "aksine sözleşme" (m. 1421(1)): the parties agreed cover starts on a
      // date irrespective of payment. Supplying it makes cover begin then;
      // omitting it means cover begins when the insurer reports receiving the
      // first premium, which is the Code's default.
      agreedCoverageStart,
      // The hash of the policy document. The document itself never reaches
      // this platform.
      documentHash,
      // The alternative to a named beneficiary: a designation that identifies
      // no specific person ("my spouse at the time of loss"), so no Party can
      // exist for it. The HASH is supplied, never the text -- the platform
      // never sees the descriptive wording at all.
      beneficiaryDescriptorHash,
      policyTerms,
      coverages: coverageInputs,
      actuarialPayload,
    } = req.body;
    if (!policyholderInput || !policyTerms || !Array.isArray(coverageInputs) || coverageInputs.length === 0) {
      const err = new Error('policyholder, policyTerms, and a non-empty coverages array are required');
      err.status = 400;
      throw err;
    }
    requireCalendarDate(policyTerms.startDate, 'policyTerms.startDate');
    requireCalendarDate(policyTerms.endDate, 'policyTerms.endDate');
    // Both are YYYY-MM-DD by now, so string order is date order.
    if (policyTerms.endDate <= policyTerms.startDate) {
      const err = new Error('policyTerms.endDate must be after policyTerms.startDate');
      err.status = 400;
      throw err;
    }
    // The three beneficiary states are exclusive -- named, described, or
    // none. Allowing both would make "which one governs" a question neither
    // the contract nor TTK 6102 m. 1494(2) could answer.
    if (beneficiaryInput && beneficiaryDescriptorHash) {
      const err = new Error(
        'a beneficiary is either named (beneficiary) or described (beneficiaryDescriptorHash), never both'
      );
      err.status = 400;
      throw err;
    }
    if (beneficiaryDescriptorHash !== undefined && beneficiaryDescriptorHash !== null) {
      if (typeof beneficiaryDescriptorHash !== 'string' || beneficiaryDescriptorHash === '') {
        const err = new Error('beneficiaryDescriptorHash must be a non-empty string');
        err.status = 400;
        throw err;
      }
    }
    // The token's own ensure clause forbids a claim amount on a policy with
    // no mortgagee. Caught here so the caller gets a 400 naming the coverage
    // rather than a ledger rejection at activation time, minutes later.
    if (agreedCoverageStart !== undefined && agreedCoverageStart !== null) {
      if (Number.isNaN(new Date(agreedCoverageStart).getTime())) {
        const err = new Error('agreedCoverageStart must be a valid date');
        err.status = 400;
        throw err;
      }
    }
    // Required: a policy with no document hash is not created, so it is never
    // minted.
    requireDocumentHash(documentHash, 'documentHash');
    const claimingCoverages = coverageInputs.filter(
      (c) => c.mortgageeClaimAmount !== undefined && c.mortgageeClaimAmount !== null
    );
    if (claimingCoverages.length > 0 && !mortgageeInput) {
      const err = new Error(
        `coverage(s) ${claimingCoverages.map((c) => c.coverageCode).join(', ')} carry a ` +
          `mortgageeClaimAmount but the policy names no mortgagee`
      );
      err.status = 400;
      throw err;
    }
    const coverageCodes = coverageInputs.map((c) => c.coverageCode);
    if (new Set(coverageCodes).size !== coverageCodes.length) {
      const err = new Error('coverageCode must be unique within a policy');
      err.status = 400;
      throw err;
    }

    const resolvedCoverages = [];
    for (const coverageInput of coverageInputs) {
      resolvedCoverages.push(await resolveCoverage(insurer, coverageInput));
    }

    const policyholder = await ensurePolicyholderRecord(insurer, policyholderInput);
    // Resolved through the SAME registry as the policyholder, so a person who
    // holds two roles on one policy is one row and one Party, and a bank
    // named on four hundred policies is one row and one Party reused four
    // hundred times. Party allocation itself still happens later, at
    // activation -- this only reserves the identity.
    const mortgagee = mortgageeInput ? await ensurePolicyholderRecord(insurer, mortgageeInput) : null;
    const insured = insuredInput ? await ensurePolicyholderRecord(insurer, insuredInput) : null;
    const beneficiary = beneficiaryInput ? await ensurePolicyholderRecord(insurer, beneficiaryInput) : null;

    const { policy, coverages } = await withTransaction(async (client) => {
      const policyRow = (
        await client.query(
          `INSERT INTO policies
             (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date, status, actuarial_payload,
              mortgagee_policyholder_id, beneficiary_policyholder_id, beneficiary_descriptor_hash,
              insured_policyholder_id, document_hash, coverage_began_at, coverage_start_basis)
           VALUES ($1,$2,$3,$4,$5,$6,'pending_mint',$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING *`,
          [
            insurer.id,
            policyholder.id,
            policyTerms.premiumAmount,
            policyTerms.currency ?? 'TRY',
            policyTerms.startDate,
            policyTerms.endDate,
            actuarialPayload ? JSON.stringify(actuarialPayload) : null,
            mortgagee ? mortgagee.id : null,
            beneficiary ? beneficiary.id : null,
            beneficiaryDescriptorHash ?? null,
            insured ? insured.id : null,
            documentHash ?? null,
            // m. 1421. NULL here is the normal case and means cover has not
            // begun: the policy will mint as a contract that exists, and
            // cover starts when the insurer reports the first premium.
            agreedCoverageStart ?? null,
            agreedCoverageStart ? 'CSB_AgreedWithoutPayment' : null,
          ]
        )
      ).rows[0];

      const coverageRows = [];
      for (const c of resolvedCoverages) {
        // payoutDestination: PDR_Mortgagee is added when the policy names a
        // mortgagee AND this coverage carries a claim amount -- a bank whose
        // charge does not reach this coverage is not a destination for it.
        // Computed once here rather than re-derived at activation, since it
        // is fully determined by input available now.
        //
        // This is a DESTINATION list, not a split. Nothing anywhere divides a
        // payout between mortgagee and insured; that stays the insurer's, as
        // with every other money question in this system.
        coverageRows.push(
          (
            await client.query(
              `INSERT INTO policy_coverages
                 (policy_id, coverage_code, product_code, peril_type, cell_ids,
                  sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, mortgagee_claim_amount)
               VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)
               RETURNING *`,
              [
                policyRow.id,
                c.coverageCode,
                c.productCode,
                c.perilType,
                JSON.stringify(c.cellIds),
                c.sumInsured,
                JSON.stringify(c.payoutTiersSnapshot),
                JSON.stringify(
                  mortgagee && c.mortgageeClaimAmount !== null
                    ? ['PDR_Insured', 'PDR_Mortgagee']
                    : ['PDR_Insured']
                ),
                c.mortgageeClaimAmount,
              ]
            )
          ).rows[0]
        );
      }
      return { policy: policyRow, coverages: coverageRows };
    });

    // No redaction needed on the way out: a policyholders row carries only
    // externalRef and Canton identity now, nothing the insurer didn't
    // already send or that isn't already theirs.
    res.status(201).json({
      policy: {
        ...policy,
        start_date: dateColumnToString(policy.start_date),
        end_date: dateColumnToString(policy.end_date),
      },
      coverages,
      policyholder,
      mortgagee,
      beneficiary,
      insured,
    });
  } catch (err) {
    next(err);
  }
});

// start_date and end_date are DATE columns, and pg's default DATE parser
// builds the JS Date at LOCAL midnight. JSON then renders 2026-09-12 as
// "2026-09-11T21:00:00.000Z" on a UTC+3 machine -- a day earlier than both what
// the caller sent and what is stored. Verified 2026-09-13: the stored value
// is right (DATE::text was 2026-09-12), only the rendering was wrong. The
// dispatcher has handled the same trap internally for a long time (see
// dispatcher.js's pgDateToDateString); this is the API's side of it. Local
// getters are the exact inverse of how the Date was built, so the stored date
// comes back whatever the process's own time zone is.
function dateColumnToString(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// The way in to those same columns. A cast to DATE keeps the calendar day
// written in the string and drops the time and offset: '2026-09-11T21:31Z'
// was stored as 2026-09-11 while Istanbul was already on the 12th, and the
// dispatcher turns that day into the token's term instants. So only a plain
// date is accepted -- converting a timestamp would mean guessing which day was
// meant. Create and renew call this before any SQL write. A day the calendar
// does not have is refused here too, not left to Postgres: 2026-13-01 does not
// parse, 2026-02-30 rolls into March and fails the round trip, and year 0000
// round-trips but is a year Postgres has no day in.
function requireCalendarDate(value, field) {
  const parsed =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (
    !parsed ||
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() < 1 ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    const err = new Error(`${field} must be a calendar date YYYY-MM-DD (no time or offset)`);
    err.status = 400;
    throw err;
  }
}

// The policy document's hash, in the one form accepted: a SHA-256 as 64
// lowercase hex characters. The insurer produces the document in its own
// systems and sends only this; the document itself, which names the people on
// it, never reaches the platform. policies carries the same rule as a CHECK,
// for the paths that write the table without this route.
function requireDocumentHash(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    const err = new Error(`${field} must be a SHA-256 hash: 64 lowercase hex characters`);
    err.status = 400;
    throw err;
  }
}

// POST /api/v1/policies/:policyId/activate -- writes an 'activation' row
// to the policy_events outbox and returns immediately;
// dispatch/dispatcher.js is the only code path that ever reacts to it.
// (policy_no, event_type, expected_version) is the idempotency key, so
// retrying this call for the same policy is a harmless no-op (ON CONFLICT
// DO NOTHING) -- it returns whatever the existing row's state already is
// rather than creating a second one. Activation is always
// expected_version=0 (there is no token yet).
policiesRouter.post('/policies/:policyId/activate', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    if (!insurer.canton_party_id) {
      const err = new Error('insurer has no allocated Canton party yet -- run onboardInsurer.js first');
      err.status = 409;
      throw err;
    }

    const policy = await pool.query('SELECT * FROM policies WHERE id = $1 AND insurer_id = $2', [
      req.params.policyId,
      insurer.id,
    ]);
    if (policy.rows.length === 0) {
      const err = new Error('policy not found');
      err.status = 404;
      throw err;
    }

    await pool.query(
      `INSERT INTO policy_events (policy_no, event_type, expected_version)
       VALUES ($1, 'activation', 0)
       ON CONFLICT (policy_no, expected_version) WHERE event_type = 'activation' DO NOTHING`,
      [req.params.policyId]
    );

    const outbox = await pool.query(
      `SELECT * FROM policy_events WHERE policy_no = $1 AND event_type = 'activation' AND expected_version = 0`,
      [req.params.policyId]
    );

    res.status(202).json({ event: outbox.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Every lifecycle endpoint below is the same shape as /activate:
// authenticate, confirm the policy belongs to this insurer, write one
// outbox row, return it. None of them touches the ledger;
// dispatch/dispatcher.js is still the only thing that ever does.
//
// Stage 3 Part 3: the idempotency guarantee changed from "at most one of
// this event type per policy, ever" to "at most one IN FLIGHT per policy".
// The old shape made a second default cycle impossible -- a reinstated
// policy could never receive a later notice -- and would have been wrong
// for endorsements from the start, since a policy is amended many times
// over its life. Retrying a call while a row is still pending or
// processing is still a harmless no-op; queueing a new one after the
// previous cycle finished is now allowed.
//
// The event type is interpolated into the ON CONFLICT predicate literally
// rather than bound as a parameter, because Postgres infers which partial
// unique index an ON CONFLICT targets by matching the predicate at plan
// time -- a bound parameter there matches no index. It is whitelisted
// immediately below, so nothing caller-controlled ever reaches the string.
const LIFECYCLE_EVENT_TYPES = new Set([
  'notice', 'reinstatement', 'endorsement', 'mortgagee_notice', 'mortgagee_election',
  // m. 1434(2), the first-premium mechanism -- see the block at the end of
  // this file. Kept in the same set because the outbox shape is identical;
  // the mechanisms are not, which is why they have their own event types.
  'premium_due_date', 'enforcement_commenced', 'first_premium_paid',
  'first_premium_withdrawal',
  // m. 1431(4), the substitution mechanism. Three types because they are
  // three distinct acts; same outbox shape, so the same set.
  'enforcement_fruitless', 'substitution_notice', 'substitution',
  // m. 1456(6). Two acts, two types.
  'mortgagee_info_request', 'mortgagee_info_provided',
  // m. 1434(4). Only the ELECTION is queueable here -- the landing is the
  // sweeper's, because it is a consequence rather than an act.
  'two_notice_election',
  // m. 1457. Two acts, two types.
  'attachment', 'attachment_lifted',
]);

async function insertLifecycleEvent(req, eventType, payload = null) {
  if (!LIFECYCLE_EVENT_TYPES.has(eventType)) {
    throw new Error(`refusing to queue unknown lifecycle event type '${eventType}'`);
  }
  const insurer = await authenticateInsurer(req);
  if (!insurer.canton_party_id) {
    const err = new Error('insurer has no allocated Canton party yet -- run onboardInsurer.js first');
    err.status = 409;
    throw err;
  }
  const policy = await pool.query('SELECT * FROM policies WHERE id = $1 AND insurer_id = $2', [
    req.params.policyId,
    insurer.id,
  ]);
  if (policy.rows.length === 0) {
    const err = new Error('policy not found');
    err.status = 404;
    throw err;
  }

  const inserted = await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, payload) VALUES ($1, '${eventType}', $2)
     ON CONFLICT (policy_no) WHERE event_type = '${eventType}' AND status IN ('pending', 'processing')
     DO NOTHING
     RETURNING *`,
    [req.params.policyId, payload ? JSON.stringify(payload) : null]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  // Nothing inserted -- an identical event is already in flight. Return
  // that row rather than a fresh one, same as /activate does on a retry.
  const inFlight = await pool.query(
    `SELECT * FROM policy_events
     WHERE policy_no = $1 AND event_type = $2 AND status IN ('pending', 'processing')
     ORDER BY created_at DESC LIMIT 1`,
    [req.params.policyId, eventType]
  );
  return inFlight.rows[0];
}

// POST /api/v1/policies/:policyId/notice -- Stage 3 Part 2, step 1: the
// insurer tells us a policy is in premium default and that formal notice
// has been served. This system does NOT compute premium default, track
// instalments, or observe payment -- the insurer is the only party that
// knows, and this endpoint is how it says so.
//
// serviceDate is REQUIRED and is rejected outright if absent: statutory
// time runs from when the notice was actually served on the policyholder,
// which this platform cannot observe. It is never inferred from the request
// time, never defaulted to today, and never backfilled. (When the platform
// was told is a separate fact, recorded independently by the dispatcher as
// noticeRecordedAt -- see handleNotice.)
policiesRouter.post('/policies/:policyId/notice', async (req, res, next) => {
  try {
    const { serviceDate } = req.body ?? {};
    if (!serviceDate) {
      const err = new Error(
        'serviceDate is required -- a notice\'s service date must be supplied, never inferred or defaulted'
      );
      err.status = 400;
      throw err;
    }
    if (Number.isNaN(new Date(serviceDate).getTime())) {
      const err = new Error(`serviceDate is not a valid date: ${serviceDate}`);
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'notice', { serviceDate });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/reinstate -- Stage 3 Part 2, step 3: the
// insurer tells us the outstanding premium has been paid. Takes no body:
// the same policy resumes on its original dates, so there is nothing to
// supply. Stage 4 narrowed this to the grace period only: once the notice
// period elapses the contract is terminated (TTK 6102 m. 1434(3)) and a
// later payment does not undo that -- the Daml choice enforces it.
policiesRouter.post('/policies/:policyId/reinstate', async (req, res, next) => {
  try {
    const event = await insertLifecycleEvent(req, 'reinstatement');
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// Valid values of the Daml EndorsementReason enum. Mirrored in
// dispatch/dispatcher.js's DAML_REASON_TO_SQL (which maps them onto the SQL
// enum) and in sql/schema.sql's endorsement_reason -- three hand-kept
// spellings of one vocabulary, the same arrangement every other shared enum
// in this system uses. Checked here so a typo is a 400 at the API boundary
// rather than a failed outbox row discovered later.
const ENDORSEMENT_REASONS = new Set([
  'ER_SumInsuredIncrease',
  'ER_SumInsuredReduction',
  'ER_InsuredObjectChange',
  'ER_TierChange',
  'ER_Correction',
]);

// POST /api/v1/policies/:policyId/endorse -- Stage 3 Part 3, Part B: change
// a LIVE policy's terms. Distinct from a renewal, which is a new policy
// with a new term and a predecessor reference, and which is not
// implemented.
//
// Body (every field optional except `reason`, but at least one actual
// change is required -- an endorsement that changes nothing is rejected
// rather than burning a version):
//   reason:                one of ENDORSEMENT_REASONS above (required)
//   sumInsuredChanges:     [{ coverageCode, sumInsured }]  -- remainingLimit
//                          moves by the same delta; it never resets
//   coveragesToAdd:        [{ coverageCode, productCode, perilType, cellIds[],
//                             sumInsured, payoutTiers, payoutDestination,
//                             mortgageeClaimAmount? }]
//   coverageCodesToRemove: ["FIRE", ...]  -- rejected if already paid out
//   newExpiry:             ISO instant; moves expiry and coverageValidThrough
//                          together
//   newBeneficiary/newMortgagee: OMIT the key to leave the role alone, send
//                          null to clear it, send a party id to set it.
//                          Omitted and explicit-null are genuinely
//                          different here, so presence is tested with `in`
//                          and the tri-state is carried into the payload as
//                          {value} / absent -- not as a bare null, which
//                          could not tell the two apart.
//   newDocumentHash:       hash of the endorsement document, if any
//
// Everything here is passed to the Daml choice as given. The invariants
// (delta arithmetic, no removing a paid-out coverage, no empty or duplicate
// coverage list, no amending a terminated policy) are enforced there, in one
// place, rather than being re-checked here and risking the two disagreeing.
policiesRouter.post('/policies/:policyId/endorse', async (req, res, next) => {
  try {
    const {
      reason,
      sumInsuredChanges = [],
      coveragesToAdd = [],
      coverageCodesToRemove = [],
      newExpiry,
      newBeneficiary,
      newMortgagee,
      newDocumentHash,
    } = req.body ?? {};

    if (!reason) {
      const err = new Error('reason is required -- every endorsement must record why it happened');
      err.status = 400;
      throw err;
    }
    if (!ENDORSEMENT_REASONS.has(reason)) {
      const err = new Error(
        `reason must be one of: ${[...ENDORSEMENT_REASONS].join(', ')} -- got '${reason}'`
      );
      err.status = 400;
      throw err;
    }

    const body = req.body ?? {};
    const changesBeneficiary = 'newBeneficiary' in body;
    const changesMortgagee = 'newMortgagee' in body;
    const changesNothing =
      sumInsuredChanges.length === 0 &&
      coveragesToAdd.length === 0 &&
      coverageCodesToRemove.length === 0 &&
      newExpiry === undefined &&
      !changesBeneficiary &&
      !changesMortgagee &&
      newDocumentHash === undefined;
    if (changesNothing) {
      const err = new Error(
        'an endorsement must change something -- supply at least one of sumInsuredChanges, ' +
          'coveragesToAdd, coverageCodesToRemove, newExpiry, newBeneficiary, newMortgagee, or newDocumentHash'
      );
      err.status = 400;
      throw err;
    }

    // An added coverage needs product_code/peril_type/cell_ids for its SQL
    // row; the Daml Coverage record carries none of them, so they cannot be
    // recovered later from the token. Rejected here rather than defaulted.
    for (const c of coveragesToAdd) {
      if (!c.coverageCode || !c.productCode || !c.perilType || !Array.isArray(c.cellIds)) {
        const err = new Error(
          `added coverage ${c.coverageCode ?? '(no coverageCode)'} must supply coverageCode, ` +
            `productCode, perilType, and cellIds`
        );
        err.status = 400;
        throw err;
      }
    }
    // Optional, but a hash that is sent is held to the same form as on
    // creation.
    if (newDocumentHash !== undefined && newDocumentHash !== null) {
      requireDocumentHash(newDocumentHash, 'newDocumentHash');
    }

    const event = await insertLifecycleEvent(req, 'endorsement', {
      reason,
      sumInsuredChanges,
      coveragesToAdd,
      coverageCodesToRemove,
      newExpiry: newExpiry ?? null,
      // Tri-state, carried as {value} when the caller asked for a change
      // and omitted entirely when it did not -- see the body doc above.
      // dispatcher.js turns this into the Daml nested-Optional wire form.
      ...(changesBeneficiary ? { newBeneficiary: { value: newBeneficiary ?? null } } : {}),
      ...(changesMortgagee ? { newMortgagee: { value: newMortgagee ?? null } } : {}),
      newDocumentHash: newDocumentHash ?? null,
    });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// Statuses a predecessor may be renewed from. Mirrors
// dispatch/dispatcher.js's RENEWABLE_STATUSES -- checked here so an
// obviously-invalid renewal is a 409 at the API boundary instead of an
// orphaned pending_mint row plus a failed outbox event. The dispatcher's
// copy is the authoritative one: it re-reads the predecessor fresh, under
// the advisory lock, where this route cannot.
const RENEWABLE_STATUSES = new Set(['active', 'partially_paid', 'expired']);

// POST /api/v1/policies/:policyId/renew -- Stage 3 Part 4: open a NEW risk
// period succeeding this one. `:policyId` is the PREDECESSOR.
//
// A renewal is not an endorsement. An endorsement changes the terms of the
// policy it acts on, in place, at version + 1; a renewal creates a
// different policy with its own policyNo and leaves the predecessor
// running to its own term end. Both are live at once during the overlap.
//
// Body:
//   policyTerms: { premiumAmount, currency?, startDate, endDate }  (required)
//   coverages:   [{ coverageCode, productCode, perilType, cellIds[], sumInsured }]
//                 (required, non-empty, unique coverageCodes)
//   documentHash: the new period's own document hash (required, as on creation)
//
// Terms, sums insured, and tiers are INPUTS for the new period, never
// copied from the predecessor -- a renewal may legitimately change any of
// them, and tiers are re-snapshotted from the current `payout_tiers`
// configuration rather than inherited from the old token. What IS carried
// over is the customer and risk identity: the policyholder (and therefore
// the Canton party, which is reused and never reallocated) and the insurer.
//
// The limits of the new period always start at their full sums insured --
// see the reset in dispatcher.js's handleRenewal, which is deliberately the
// inverse of the delta arithmetic in the endorsement path.
policiesRouter.post('/policies/:policyId/renew', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    if (!insurer.canton_party_id) {
      const err = new Error('insurer has no allocated Canton party yet -- run onboardInsurer.js first');
      err.status = 409;
      throw err;
    }

    const { policyTerms, coverages: coverageInputs, actuarialPayload, documentHash } = req.body ?? {};
    if (!policyTerms || !Array.isArray(coverageInputs) || coverageInputs.length === 0) {
      const err = new Error(
        'policyTerms and a non-empty coverages array are required -- a renewal supplies the new ' +
          'period\'s terms and sums insured, it does not copy the predecessor\'s'
      );
      err.status = 400;
      throw err;
    }
    requireCalendarDate(policyTerms.startDate, 'policyTerms.startDate');
    requireCalendarDate(policyTerms.endDate, 'policyTerms.endDate');
    // Both are YYYY-MM-DD by now, so string order is date order.
    if (policyTerms.endDate <= policyTerms.startDate) {
      const err = new Error('policyTerms.endDate must be after policyTerms.startDate');
      err.status = 400;
      throw err;
    }
    const coverageCodes = coverageInputs.map((c) => c.coverageCode);
    if (new Set(coverageCodes).size !== coverageCodes.length) {
      const err = new Error('coverageCode must be unique within a policy');
      err.status = 400;
      throw err;
    }
    requireDocumentHash(documentHash, 'documentHash');

    const predecessorResult = await pool.query(
      'SELECT * FROM policies WHERE id = $1 AND insurer_id = $2',
      [req.params.policyId, insurer.id]
    );
    const predecessor = predecessorResult.rows[0];
    if (!predecessor) {
      const err = new Error('policy not found');
      err.status = 404;
      throw err;
    }

    // Fail fast on the states that can never be renewed. These are checked
    // again in handleRenewal under the advisory lock, which is what
    // actually protects against a state change between here and there --
    // this is purely so the caller gets a useful error instead of a
    // pending_mint row that never mints.
    if (predecessor.default_state !== 'none') {
      const err = new Error(
        `cannot renew policy ${predecessor.id}: it is in premium default ` +
          `(default_state='${predecessor.default_state}'). Clear the prior period's premium debt and ` +
          `reinstate it before underwriting a new period`
      );
      err.status = 409;
      throw err;
    }
    if (!RENEWABLE_STATUSES.has(predecessor.status)) {
      const err = new Error(
        `cannot renew policy ${predecessor.id}: status '${predecessor.status}' is not renewable ` +
          `(expected one of ${[...RENEWABLE_STATUSES].join(', ')})`
      );
      err.status = 409;
      throw err;
    }
    if (predecessor.renewed_by_policy_id) {
      const err = new Error(
        `cannot renew policy ${predecessor.id}: it has already been renewed by ` +
          `${predecessor.renewed_by_policy_id} -- a period is succeeded exactly once`
      );
      err.status = 409;
      throw err;
    }

    // Tiers are looked up fresh for the new period, not inherited.
    const resolvedCoverages = [];
    for (const coverageInput of coverageInputs) {
      resolvedCoverages.push(await resolveCoverage(insurer, coverageInput));
    }

    // The successor policy row + its coverages are created here, exactly as
    // POST /policies does, and the outbox row that mints it is keyed on the
    // PREDECESSOR (so handleRenewal locks the policy being renewed, and a
    // renewal cannot race a notice/endorsement/trigger on it). The new
    // policy's id travels in the payload.
    const { successor } = await withTransaction(async (client) => {
      // A renewal already queued or in flight refuses this one before any
      // write: the ON CONFLICT below would skip only the outbox row and still
      // leave a successor that nothing mints. The predecessor is locked first,
      // so a second request waits here until the first commits, and the check
      // then reads the row the first one queued. Refused rather than merged
      // into the first, because this request may carry different terms.
      // The forward link is read again on the locked row, because a renewal
      // the dispatcher completed after the read above is 'done' by now and
      // would pass the in-flight check.
      const locked = (
        await client.query('SELECT id, renewed_by_policy_id FROM policies WHERE id = $1 FOR UPDATE', [predecessor.id])
      ).rows[0];
      if (locked.renewed_by_policy_id) {
        const err = new Error(
          `cannot renew policy ${predecessor.id}: it has already been renewed by ` +
            `${locked.renewed_by_policy_id} -- a period is succeeded exactly once`
        );
        err.status = 409;
        throw err;
      }
      const inFlight = (
        await client.query(
          `SELECT id, status, payload FROM policy_events
           WHERE policy_no = $1 AND event_type = 'renewal' AND status IN ('pending', 'processing')`,
          [predecessor.id]
        )
      ).rows[0];
      if (inFlight) {
        const err = new Error(
          `cannot renew policy ${predecessor.id}: renewal event ${inFlight.id} is already ${inFlight.status} ` +
            `for successor ${inFlight.payload.newPolicyId} -- a second renewal is refused, not merged into it`
        );
        err.status = 409;
        throw err;
      }

      const policyRow = (
        await client.query(
          `INSERT INTO policies
             (insurer_id, policyholder_id, premium_amount, currency, start_date, end_date, status,
              actuarial_payload, mortgagee_policyholder_id, beneficiary_policyholder_id,
              beneficiary_descriptor_hash, insured_policyholder_id, document_hash)
           VALUES ($1,$2,$3,$4,$5,$6,'pending_mint',$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [
            insurer.id,
            predecessor.policyholder_id, // customer identity carried over
            policyTerms.premiumAmount,
            policyTerms.currency ?? predecessor.currency,
            policyTerms.startDate,
            policyTerms.endDate,
            actuarialPayload ? JSON.stringify(actuarialPayload) : null,
            // Roles carry over with the customer identity. A renewal opens a
            // new period of the same relationship -- the bank holding the
            // charge and the person designated as beneficiary do not change
            // because the term rolled. Changing them is what the endorsement
            // path is for; this task does not extend it.
            //
            // coverage_began_at deliberately does NOT carry over. A renewal
            // opens a NEW risk period, and m. 1421 applies to it on its own
            // terms: the successor's cover begins when its own first premium
            // is reported, or on its own agreed date. Inheriting the
            // predecessor's start would assert cover for a period nobody has
            // said was paid for. document_hash likewise belongs to a period's
            // own document.
            predecessor.mortgagee_policyholder_id,
            predecessor.beneficiary_policyholder_id,
            predecessor.beneficiary_descriptor_hash,
            predecessor.insured_policyholder_id,
            documentHash,
          ]
        )
      ).rows[0];

      for (const c of resolvedCoverages) {
        // remaining_limit = sum_insured for a brand-new period. The
        // predecessor's remaining limits are not read here or anywhere else
        // on this path -- see handleRenewal's reset comment.
        await client.query(
          `INSERT INTO policy_coverages
             (policy_id, coverage_code, product_code, peril_type, cell_ids,
              sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, mortgagee_claim_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,NULL)`,
          [
            policyRow.id,
            c.coverageCode,
            c.productCode,
            c.perilType,
            JSON.stringify(c.cellIds),
            c.sumInsured,
            JSON.stringify(c.payoutTiersSnapshot),
            JSON.stringify(['PDR_Insured']),
          ]
        );
      }

      await client.query(
        `INSERT INTO policy_events (policy_no, event_type, payload) VALUES ($1, 'renewal', $2)
         ON CONFLICT (policy_no) WHERE event_type = 'renewal' AND status IN ('pending', 'processing')
         DO NOTHING`,
        [predecessor.id, JSON.stringify({ newPolicyId: policyRow.id })]
      );
      return { successor: policyRow };
    });

    const outbox = await pool.query(
      `SELECT * FROM policy_events
       WHERE policy_no = $1 AND event_type = 'renewal' AND status IN ('pending', 'processing')
       ORDER BY created_at DESC LIMIT 1`,
      [predecessor.id]
    );

    res.status(202).json({ predecessorPolicyId: predecessor.id, successorPolicyId: successor.id, event: outbox.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Stage 4 -- reporting what happened to a payout
//
// THE PLATFORM NEVER MOVES MONEY. These endpoints do not pay anyone. The
// insurer settles the indemnity through its own banking systems and then
// reports that fact here; the platform records the report on the ledger and
// closes the payout. No account number is accepted, stored, or transmitted,
// and no banking integration exists to add one to -- a design rule.
//
// Every one of them queues a `settlement` outbox row keyed on the contract
// the report is about, and dispatch/dispatcher.js does the ledger work under
// the usual advisory lock. Nothing here touches the ledger directly.
// ---------------------------------------------------------------------------

// m. 1457 added a fourth. It is never DESIGNATED on a coverage -- see the
// exemption in PayoutBridge.daml -- but it is very much a role an insurer can
// report having paid, and omitting it here refused every enforcement-office
// settlement while the ledger was ready to accept one.
const PAID_ROLES = new Set(['PDR_Insured', 'PDR_Mortgagee', 'PDR_Beneficiary', 'PDR_EnforcementOffice']);
const UNPAID_REASONS = new Set(['UR_Waived', 'UR_Disputed', 'UR_Litigation', 'UR_Other']);

// Loads a payout row for this insurer and returns the contract id the report
// should target: the ManualReviewRequired if the payout has been superseded
// by one, otherwise the original PayoutApproved.
async function loadPayoutForReport(req) {
  const insurer = await authenticateInsurer(req);
  if (!insurer.canton_party_id) {
    const err = new Error('insurer has no allocated Canton party yet -- run onboardInsurer.js first');
    err.status = 409;
    throw err;
  }
  const { rows } = await pool.query(
    `SELECT pe.*, p.insurer_id
     FROM payout_events pe JOIN policies p ON p.id = pe.policy_id
     WHERE pe.id = $1 AND p.insurer_id = $2`,
    [req.params.payoutId, insurer.id]
  );
  const payout = rows[0];
  if (!payout) {
    const err = new Error('payout not found');
    err.status = 404;
    throw err;
  }
  if (payout.resolved_at) {
    const err = new Error(
      `payout ${payout.id} was already resolved (status '${payout.status}') -- a payout ends once`
    );
    err.status = 409;
    throw err;
  }
  // A payout that has been marked failed lives on as its review item; the
  // report targets whichever contract is currently live.
  const targetContractId = payout.review_contract_id ?? payout.daml_contract_id;
  return { payout, targetContractId };
}

async function queueSettlementEvent(payout, targetContractId, payload) {
  await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, source_contract_id, payload)
     VALUES ($1, 'settlement', $2, $3)
     ON CONFLICT (source_contract_id)
       WHERE event_type = 'settlement' AND status IN ('pending', 'processing')
     DO NOTHING`,
    [payout.policy_id, targetContractId, JSON.stringify(payload)]
  );
  const { rows } = await pool.query(
    `SELECT * FROM policy_events WHERE event_type = 'settlement' AND source_contract_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [targetContractId]
  );
  return rows[0];
}

// POST /api/v1/payouts/:payoutId/settle -- the NORMAL path.
//
// The insurer reports a settlement it has already made. Works for a payout
// still at `approved` (exercises PayoutApproved_ConfirmSettlement) and for
// one that was marked failed and is now a review item (exercises
// ManualReviewRequired_ResolveSettled) -- the same evidence either way,
// which is why one endpoint serves both.
//
// Body: { bankReference, settledAt, paidRole }
//   settledAt is the insurer's REPORTED settlement date. It is never taken
//   from a system clock: the platform cannot observe when a transfer landed,
//   only when it was told -- the same principle as a notice's service date.
//   paidRole is checked against the coverage's payoutDestination and a
//   mismatch is rejected. The ledger cannot verify the money moved; it can
//   refuse an assertion that contradicts the policy.
policiesRouter.post('/payouts/:payoutId/settle', async (req, res, next) => {
  try {
    const { bankReference, settledAt, paidRole } = req.body ?? {};
    if (!bankReference) {
      const err = new Error('bankReference is required to report a settlement');
      err.status = 400;
      throw err;
    }
    if (!settledAt || Number.isNaN(new Date(settledAt).getTime())) {
      const err = new Error(
        'settledAt is required and must be a valid date -- the settlement date is the insurer\'s ' +
          'reported fact, never taken from a system clock'
      );
      err.status = 400;
      throw err;
    }
    if (!PAID_ROLES.has(paidRole)) {
      const err = new Error(`paidRole must be one of: ${[...PAID_ROLES].join(', ')}`);
      err.status = 400;
      throw err;
    }

    const { payout, targetContractId } = await loadPayoutForReport(req);
    const action = payout.review_contract_id ? 'resolve_settled' : 'settle';
    const event = await queueSettlementEvent(payout, targetContractId, {
      action,
      bankReference,
      settledAt,
      paidRole,
    });
    res.status(202).json({ payoutId: payout.id, action, event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/payouts/:payoutId/fail -- the EXCEPTION path.
//
// The insurer reports that it could not settle: a closed account, a payee it
// cannot find, a dispute. This is the ONLY way a payout reaches manual
// review; nothing routes one here automatically any more.
//
// Body: { failureReason }
policiesRouter.post('/payouts/:payoutId/fail', async (req, res, next) => {
  try {
    const { failureReason } = req.body ?? {};
    if (!failureReason) {
      const err = new Error(
        'failureReason is required -- a payout is only marked failed on a reported failure'
      );
      err.status = 400;
      throw err;
    }
    const { payout, targetContractId } = await loadPayoutForReport(req);
    if (payout.review_contract_id) {
      const err = new Error(
        `payout ${payout.id} is already under manual review -- resolve it with /settle or /close-unpaid`
      );
      err.status = 409;
      throw err;
    }
    const event = await queueSettlementEvent(payout, targetContractId, {
      action: 'fail',
      failureReason,
    });
    res.status(202).json({ payoutId: payout.id, action: 'fail', event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/payouts/:payoutId/close-unpaid -- review exit 2.
//
// The insurer reports that the amount will not be paid, and that this is
// final: a waiver, a dispute, litigation. Requires an enumerated reason AND
// a free-text note -- the enum is queryable, the note carries what the enum
// flattens.
//
// Recording an outcome is not a legal conclusion that the indemnity was
// lawfully extinguished. It records what the insurer asserted and why.
//
// Body: { unpaidReason, note }
policiesRouter.post('/payouts/:payoutId/close-unpaid', async (req, res, next) => {
  try {
    const { unpaidReason, note } = req.body ?? {};
    if (!UNPAID_REASONS.has(unpaidReason)) {
      const err = new Error(`unpaidReason must be one of: ${[...UNPAID_REASONS].join(', ')}`);
      err.status = 400;
      throw err;
    }
    if (!note) {
      const err = new Error(
        'note is required -- the enumerated reason alone cannot carry the circumstances'
      );
      err.status = 400;
      throw err;
    }
    const { payout, targetContractId } = await loadPayoutForReport(req);
    if (!payout.review_contract_id) {
      const err = new Error(
        `payout ${payout.id} is not under manual review -- only a review item can be closed unpaid`
      );
      err.status = 409;
      throw err;
    }
    const event = await queueSettlementEvent(payout, targetContractId, {
      action: 'resolve_unpaid',
      unpaidReason,
      note,
    });
    res.status(202).json({ payoutId: payout.id, action: 'resolve_unpaid', event });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Stage 4 -- m. 1456(4) and (5): the mortgagee facts.
//
// Both endpoints RECORD what the insurer says happened. This system generates
// and sends no notification, and it does not implement the mortgagee taking
// over the contract -- the window and the election are written down, and
// nothing acts on them.
// ---------------------------------------------------------------------------
const MORTGAGEE_ELECTIONS = new Set(['ME_Continue', 'ME_Decline']);

// POST /api/v1/policies/:policyId/mortgagee-notice
// Body: { notifiedAt }  -- the insurer's reported date, like the service date.
policiesRouter.post('/policies/:policyId/mortgagee-notice', async (req, res, next) => {
  try {
    const { notifiedAt } = req.body ?? {};
    if (!notifiedAt || Number.isNaN(new Date(notifiedAt).getTime())) {
      const err = new Error(
        'notifiedAt is required and must be a valid date -- the notification date is the ' +
          "insurer's reported fact, never inferred"
      );
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'mortgagee_notice', { notifiedAt });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/mortgagee-election
// Body: { election: ME_Continue | ME_Decline }
policiesRouter.post('/policies/:policyId/mortgagee-election', async (req, res, next) => {
  try {
    const { election } = req.body ?? {};
    if (!MORTGAGEE_ELECTIONS.has(election)) {
      const err = new Error(`election must be one of: ${[...MORTGAGEE_ELECTIONS].join(', ')}`);
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'mortgagee_election', { election });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// m. 1434(2) -- first-premium default: cayma, not fesih.
//
// A different mechanism from /notice and /reinstate above, which implement
// m. 1434(3). No ihtar, no ten days, no service date: a three-month window
// running from the premium's due date, and two routes out of it. The routes
// and the states have their own names throughout, deliberately.
//
// The deemed withdrawal (m. 1434(2), 2nd sentence) has NO endpoint here: it
// follows from inaction, so nobody exercises it. sweepers/firstPremiumSweeper.js
// observes that the window elapsed with no enforcement reported and queues it.
// ---------------------------------------------------------------------------

// POST /api/v1/policies/:policyId/premium-due-date
// Body: { dueDate }
//
// The insurer reports that a first instalment, or a premium payable in one
// sum, fell due and has not been paid. m. 1431(1) puts that date at contract
// formation against delivery of the policy -- neither observable here.
policiesRouter.post('/policies/:policyId/premium-due-date', async (req, res, next) => {
  try {
    const { dueDate } = req.body ?? {};
    if (!dueDate || Number.isNaN(new Date(dueDate).getTime())) {
      const err = new Error(
        'dueDate is required and must be a valid date -- both of m. 1434(2)\'s three-month periods ' +
          'run from the vade, and the platform cannot observe policy delivery'
      );
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'premium_due_date', { dueDate });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/enforcement-commenced
// Body: { commencedAt }
//
// "dava veya takip yoluyla" -- the insurer says it pursued the premium claim.
// COMMENCEMENT only, and still only that. Whether it proved fruitless
// (semeresiz) is m. 1431(4)'s trigger for the sigortalı taking over the
// premium, and that is now its own endpoint below with its own field: this
// one SUSPENDS m. 1434(2)'s deemed withdrawal, that one OPENS substitution.
// Neither is derived from the other, and this endpoint is not a precondition
// of that one -- the m. 1434(3) notice mechanism reaches fruitlessness
// without ever passing through here.
policiesRouter.post('/policies/:policyId/enforcement-commenced', async (req, res, next) => {
  try {
    const { commencedAt } = req.body ?? {};
    if (!commencedAt || Number.isNaN(new Date(commencedAt).getTime())) {
      const err = new Error(
        'commencedAt is required and must be a valid date -- the platform cannot observe litigation'
      );
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'enforcement_commenced', { commencedAt });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/attachment
// Body: { coverageCode, attachedAt }
//
// m. 1457: "Sigortalı mal haczedilirse, sigortacı ... sigorta tazminatını icra
// müdürlüğüne ödeyerek borcundan kurtulur." The insurer reports that the
// insured property has been attached -- ordinarily because the icra memuru
// ihtar'd it, which is the second sentence's procedure.
//
// Recorded PER COVERAGE, which is an approximation: the article attaches to
// the property and this platform has no property registry.
//
// NO IDENTIFIER IS ACCEPTED. No case number, no court, no office identifier,
// no party identity. The routing decision needs none of them, and holding one
// would make this platform the place such things live.
policiesRouter.post('/policies/:policyId/attachment', async (req, res, next) => {
  try {
    const { coverageCode, attachedAt } = req.body ?? {};
    if (!coverageCode) {
      const err = new Error('coverageCode is required -- m. 1457 is recorded per coverage');
      err.status = 400;
      throw err;
    }
    if (!attachedAt || Number.isNaN(new Date(attachedAt).getTime())) {
      const err = new Error(
        'attachedAt is required and must be a valid date -- the platform cannot observe an icra file'
      );
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'attachment', { coverageCode, attachedAt });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/attachment-lifted
// Body: { coverageCode, liftedAt }
//
// m. 1457: the officer's ihtar binds "diğer bir bildirime kadar" -- until a
// further notification. Lifting is therefore a fact the Code itself
// anticipates, not one this system invented. Routing returns to normal for
// payouts arising afterwards; nothing reaches back.
policiesRouter.post('/policies/:policyId/attachment-lifted', async (req, res, next) => {
  try {
    const { coverageCode, liftedAt } = req.body ?? {};
    if (!coverageCode) {
      const err = new Error('coverageCode is required -- m. 1457 is recorded per coverage');
      err.status = 400;
      throw err;
    }
    if (!liftedAt || Number.isNaN(new Date(liftedAt).getTime())) {
      const err = new Error(
        'liftedAt is required and must be a valid date -- the platform cannot observe an icra file'
      );
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'attachment_lifted', { coverageCode, liftedAt });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/two-notice-election
// Body: { electedAt, insurancePeriodStart, insurancePeriodEnd }
//
// m. 1434(4): "Bir sigorta dönemi içinde sigorta ettirene iki defa ihtar
// gönderilmişse sigortacı, sigorta döneminin sonunda hüküm doğurmak üzere
// sözleşmeyi feshedebilir."
//
// The THIRD way a contract ends for non-payment. Discretionary -- the insurer
// elects -- and DEFERRED: the contract runs on, cover in full, until the
// period end. Nothing about the election shortens it.
//
// THE PERIOD IS SUPPLIED, NEVER DERIVED. m. 1411 ties it to how the premium is
// calculated, and this platform holds no calculation basis: start_date and
// end_date are the contract term, which is a different thing and coincides
// only sometimes. What the ledger checks is that two recorded notice service
// dates actually fall inside the period named.
//
// There is no endpoint for the effect landing -- that is twoNoticeSweeper.js,
// written as a state test, because the effect is a consequence rather than an
// act.
policiesRouter.post('/policies/:policyId/two-notice-election', async (req, res, next) => {
  try {
    const { electedAt, insurancePeriodStart, insurancePeriodEnd } = req.body ?? {};
    for (const [name, value] of [
      ['electedAt', electedAt],
      ['insurancePeriodStart', insurancePeriodStart],
      ['insurancePeriodEnd', insurancePeriodEnd],
    ]) {
      if (!value || Number.isNaN(new Date(value).getTime())) {
        const err = new Error(
          `${name} is required and must be a valid date -- the insurance period is the insurer's ` +
            `own fact under m. 1411 and is never derived here`
        );
        err.status = 400;
        throw err;
      }
    }
    const event = await insertLifecycleEvent(req, 'two_notice_election', {
      electedAt, insurancePeriodStart, insurancePeriodEnd,
    });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/mortgagee-info-request
// Body: { requestedAt }
//
// m. 1456(6): "Sigortacı, ISTEM ÜZERİNE, sınırlı ayni hak sahibi olduğunu
// bildiren kişiye sigorta koruması ile sigorta bedelinin miktarı hakkında
// bilgi verir." The insurer reports that a request was made to it.
//
// The information itself was never missing -- a named mortgagee observes the
// token and can read the cover and the sum insured whenever it likes. What
// this records is the ACT, because the duty is request -> response and
// standing access cannot evidence a response to a request nobody recorded.
//
// No name, address or contact detail is accepted. The request is identified
// by the policy, which already names the mortgagee.
policiesRouter.post('/policies/:policyId/mortgagee-info-request', async (req, res, next) => {
  try {
    const { requestedAt } = req.body ?? {};
    if (!requestedAt || Number.isNaN(new Date(requestedAt).getTime())) {
      const err = new Error(
        'requestedAt is required and must be a valid date -- the platform does not receive the ' +
          'request, so the date is the insurer\'s reported fact'
      );
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'mortgagee_info_request', { requestedAt });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/mortgagee-info-provided
// Body: { providedAt }
//
// m. 1456(6): the insurer reports having given the information. The platform
// generates and sends nothing, and does not record WHAT was disclosed -- the
// token already carries the cover and the sum insured, and a second copy
// could only drift from the first.
//
// Refused unless a request is outstanding. m. 1456(6) sets no deadline and
// none is computed anywhere.
policiesRouter.post('/policies/:policyId/mortgagee-info-provided', async (req, res, next) => {
  try {
    const { providedAt } = req.body ?? {};
    if (!providedAt || Number.isNaN(new Date(providedAt).getTime())) {
      const err = new Error(
        'providedAt is required and must be a valid date -- the platform does not answer the ' +
          'request, so the date is the insurer\'s reported fact'
      );
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'mortgagee_info_provided', { providedAt });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/enforcement-fruitless
// Body: { fruitlessAt, route }
//
// m. 1431(4), fact ONE of three: "prim borcu için sigorta ettirenin aleyhine
// yapılan takip semeresiz kalmışsa". The insurer reports that its pursuit of
// the premium against the sigorta ettiren came to nothing.
//
// `route` is recorded rather than assumed, because the Code keeps the two
// words apart: m. 1434(2) says "dava veya takip", m. 1431(4) says only
// "takip". Whether that is narrow or general is unsettled on the text, so the
// platform records which it actually was and leaves the question open.
policiesRouter.post('/policies/:policyId/enforcement-fruitless', async (req, res, next) => {
  try {
    const { fruitlessAt, route } = req.body ?? {};
    if (!fruitlessAt || Number.isNaN(new Date(fruitlessAt).getTime())) {
      const err = new Error(
        'fruitlessAt is required and must be a valid date -- the platform cannot observe an ' +
          'enforcement proceeding, only be told about one'
      );
      err.status = 400;
      throw err;
    }
    if (route !== 'ER_Takip' && route !== 'ER_Dava') {
      const err = new Error('route is required and must be one of ER_Takip, ER_Dava');
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'enforcement_fruitless', { fruitlessAt, route });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/substitution-notice
// Body: { notifiedAt }
//
// m. 1431(4), fact TWO: "bu durumun sigortacı tarafından kendilerine
// bildirilmesi hâlinde". The insurer reports having notified the sigortalı.
//
// On the text this is a CONDITION of the sigortalı's right, not merely its
// occasion -- which leaves an asymmetry the article does not resolve, since
// the insurer controls whether the notification happens at all. That question
// is for a lawyer; the platform simply requires the fact before an assumption
// can be recorded.
policiesRouter.post('/policies/:policyId/substitution-notice', async (req, res, next) => {
  try {
    const { notifiedAt } = req.body ?? {};
    if (!notifiedAt || Number.isNaN(new Date(notifiedAt).getTime())) {
      const err = new Error(
        'notifiedAt is required and must be a valid date -- the platform cannot serve a notice'
      );
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'substitution_notice', { notifiedAt });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/substitute-policyholder
// Body: { substitutedAt }
//
// m. 1431(4), fact THREE: "primi ödemeyi üstlenirlerse sözleşme bu kişilerle
// devam eder". The sigortalı undertook to pay, and the contract continues
// with them -- so the policy's policyholder becomes its insured.
//
// The ONLY endpoint in this API that changes who a party is. /endorse cannot
// and must not: a change of party needs its own justification, its own
// preconditions and its own name in the audit chain.
//
// An UNDERTAKING, not a payment. No amount, instalment or balance is accepted
// here or recorded anywhere, and the premium is as unpaid afterwards as
// before -- which is why this does not clear the default state.
policiesRouter.post('/policies/:policyId/substitute-policyholder', async (req, res, next) => {
  try {
    const { substitutedAt } = req.body ?? {};
    if (!substitutedAt || Number.isNaN(new Date(substitutedAt).getTime())) {
      const err = new Error(
        'substitutedAt is required and must be a valid date -- the platform cannot witness an ' +
          'undertaking, only record that it was reported'
      );
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'substitution', { substitutedAt });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/first-premium-paid
// Body: { paidAt }
//
// The insurer reports receiving the first premium. This is the ORDINARY path
// by which cover begins under m. 1421(1), and it is also the exit from
// m. 1434(2)'s default where a due date had been reported -- one fact doing
// two jobs. Deliberately NOT /reinstate: that is the exit from m. 1434(3)'s
// notice period, a different mechanism.
//
// paidAt is required and is the insurer's own reported date. The platform
// cannot observe a payment, and under m. 1421 this date is the instant the
// insurer's liability begins -- so it is never defaulted to now.
policiesRouter.post('/policies/:policyId/first-premium-paid', async (req, res, next) => {
  try {
    const { paidAt } = req.body ?? {};
    if (!paidAt || Number.isNaN(new Date(paidAt).getTime())) {
      const err = new Error(
        'paidAt is required and must be a valid date -- under m. 1421 the insurer\'s liability ' +
          'begins at this instant, and the platform cannot observe a payment'
      );
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'first_premium_paid', { paidAt });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/withdraw-first-premium
// Body: { withdrawnAt? }  -- defaults to now, the moment the act is reported.
//
// m. 1434(2), 1st sentence: the insurer's own act, exercisable within the
// window while payment has not been made. The dispatcher refuses one dated
// past the window -- after it the right has lapsed and the 2nd sentence
// governs instead.
policiesRouter.post('/policies/:policyId/withdraw-first-premium', async (req, res, next) => {
  try {
    const { withdrawnAt } = req.body ?? {};
    if (withdrawnAt !== undefined && Number.isNaN(new Date(withdrawnAt).getTime())) {
      const err = new Error('withdrawnAt, if given, must be a valid date');
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'first_premium_withdrawal', {
      withdrawnAt: withdrawnAt ?? new Date().toISOString(),
    });
    res.status(202).json({ event });
  } catch (err) {
    next(err);
  }
});
