import { Router } from 'express';
import crypto from 'node:crypto';
import { pool, withTransaction } from '../db.js';
import { buildRecord } from '../notifications/payoutRecord.js';
import { buildPolicyRecord, buildPolicySummary } from '../notifications/policyRecord.js';
import { parseStandInCellId, ORACLE_METRICS } from '../oracle/oracleBot.js';
import { newTextSalt } from '../dispatch/ledgerText.js';
import { STATUTORY_MIN_GRACE_PERIOD_DAYS, isNumeric14_2Amount } from '../dispatch/dispatcher.js';
import { validateTierSet, PG_INTEGER_MAX, toNumeric } from '../dispatch/tiers.js';
import { AGGREGATIONS } from '../oracle/eventWindow.js';

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
async function ensurePolicyholderRecord(client, insurer, policyholderInput) {
  // Neither field is stored. Rejecting outright is the honest behaviour --
  // silently discarding it would let a caller believe a name or national id
  // had been saved when nothing was. externalRef is the only identity this
  // platform holds for a person; the insurer's own systems hold the rest.
  // Unreachable today: POST /policies, the only caller, refuses both fields for every role first.
  if (policyholderInput.fullName !== undefined || policyholderInput.nationalId !== undefined) {
    const err = new Error(
      'fullName and nationalId are not accepted or stored by this platform -- identify people by externalRef only'
    );
    err.status = 400;
    throw err;
  }
  requireInsurerReference(policyholderInput, 'externalRef');
  // Insert first, in the caller's transaction. A select first let two
  // creations naming the same new person both find no row, and the second
  // INSERT then failed the UNIQUE with a 500. On a conflict this one waits for
  // the other transaction, and the SELECT below reads the row it committed.
  const inserted = await client.query(
    `INSERT INTO policyholders (insurer_id, external_ref)
     VALUES ($1, $2)
     ON CONFLICT (insurer_id, external_ref) DO NOTHING
     RETURNING *`,
    [insurer.id, policyholderInput.externalRef]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await client.query(
    'SELECT * FROM policyholders WHERE insurer_id = $1 AND external_ref = $2',
    [insurer.id, policyholderInput.externalRef]
  );
  return existing.rows[0];
}

// externalRef is the insurer's own reference for a person, never the person.
// Eleven digits and nothing else is the form of a T.C. kimlik numarası, and a
// value with whitespace in it reads as a name; either is refused rather than
// stored. The value itself is not repeated in the error, since it may be the
// very thing that must not be kept.
function requireInsurerReference(personInput, field) {
  const ref = String(personInput.externalRef ?? '');
  if (/^\d{11}$/.test(ref)) {
    const err = new Error(
      `${field} is 11 digits, the form of a T.C. kimlik numarası -- no person's national id enters this ` +
        `platform; send the insurer's own reference for the person`
    );
    err.status = 400;
    throw err;
  }
  if (/\s/.test(ref)) {
    const err = new Error(
      `${field} contains whitespace, the form of a name -- no person's name enters this platform; send ` +
        `the insurer's own reference for the person`
    );
    err.status = 400;
    throw err;
  }
}

// A coverage names exactly one cell, and one the oracle can read: the cell is
// put through the oracle's own parser, so a cell that reaches the database
// here is one the oracle will fetch rather than skip. More than one cell is
// refused because what several cells mean together is not defined, and today
// each cell would pay on its own.
function requireCoverageCell(coverageInput) {
  const code = coverageInput.coverageCode ?? '(no coverageCode)';
  const { cellIds } = coverageInput;
  if (!Array.isArray(cellIds) || cellIds.length === 0) {
    const err = new Error(`cellIds on coverage ${code} must be a non-empty array`);
    err.status = 400;
    throw err;
  }
  for (const cellId of cellIds) {
    try {
      parseStandInCellId(cellId);
    } catch (parseErr) {
      const err = new Error(`coverage ${code}: ${parseErr.message} -- the oracle cannot read this cell`);
      err.status = 400;
      throw err;
    }
  }
  if (cellIds.length > 1) {
    const err = new Error(
      `coverage ${code} names ${cellIds.length} cells; one cell per coverage is accepted -- what several ` +
        `cells mean together (any of them, all of them, their average, a share each) is not defined, and ` +
        `today each cell would pay on its own, so it is refused until the insurer defines it`
    );
    err.status = 400;
    throw err;
  }
}

// v22. A coverage states the metric its tiers are written for and
// what a tier percentage is a percentage OF. Both required, neither defaulted:
// the metric must be one the oracle emits (oracleBot.js ORACLE_METRICS), or
// no trigger on the coverage could ever meet the token's metric check; the
// basis is one of the ledger's two.
const PAYOUT_BASES = new Set(['PB_RemainingLimit', 'PB_SumInsured']);

function requireCoverageTerms(coverageInput) {
  const code = coverageInput.coverageCode ?? '(no coverageCode)';
  if (!ORACLE_METRICS.includes(coverageInput.metric)) {
    const err = new Error(
      `metric on coverage ${code} is required and must be a code the oracle supplies ` +
        `(${ORACLE_METRICS.join(', ')}), got ${JSON.stringify(coverageInput.metric)}`
    );
    err.status = 400;
    throw err;
  }
  if (!PAYOUT_BASES.has(coverageInput.payoutBasis)) {
    const err = new Error(
      `payoutBasis on coverage ${code} is required, with no default, and must be one of ` +
        `${[...PAYOUT_BASES].join(', ')}, got ${JSON.stringify(coverageInput.payoutBasis)}`
    );
    err.status = 400;
    throw err;
  }
}

// On create and renew, the premium and each sum insured are held to
// the endorsement's amount rule (isNumeric14_2Amount, the NUMERIC(14,2) > 0
// columns), and each coverageCode must be a non-empty string, before any write.
// A failure names the field, so it is a 400 rather than the column's 500 or a
// silently rounded amount.
function requireTermsAmounts(policyTerms, coverageInputs) {
  if (!isNumeric14_2Amount(policyTerms.premiumAmount)) {
    const err = new Error(
      'policyTerms.premiumAmount must be greater than zero with at most 12 integer digits and 2 decimals'
    );
    err.status = 400;
    throw err;
  }
  coverageInputs.forEach((c, i) => {
    if (typeof c?.coverageCode !== 'string' || c.coverageCode === '') {
      const err = new Error(`coverages[${i}] coverageCode must be a non-empty string`);
      err.status = 400;
      throw err;
    }
    if (!isNumeric14_2Amount(c.sumInsured)) {
      const err = new Error(
        `coverages[${i}] (coverage ${c.coverageCode}) sumInsured must be greater than zero with at most ` +
          `12 integer digits and 2 decimals`
      );
      err.status = 400;
      throw err;
    }
  });
}

// An inline decimal in the form its payout_tiers column gives it: "-2.0000"
// for NUMERIC(12,4), "25.00" for NUMERIC(5,2). validateTierSet has already
// held it to that scale, so nothing is rounded.
function columnDecimal(value, places) {
  if (value === null || value === undefined) return null;
  const n = toNumeric(value);
  const abs = n < 0n ? -n : n;
  const scale = 10n ** 10n;
  return `${n < 0n ? '-' : ''}${abs / scale}.${String(abs % scale).padStart(10, '0').slice(0, places)}`;
}

// A coverage's own payoutTiers, sent on create or renew. Any value but
// undefined is the inline set, so null and [] are refused; a refusal is a 400
// before any write, and its messages never echo a label. The set is
// snapshotted sorted by tierOrder, in the snapshot shape and the decimal form
// the configured rows produce, so one set gives one snapshot by either path.
function inlineTierSet(coverageInput) {
  let validated;
  try {
    validated = validateTierSet(coverageInput.payoutTiers);
  } catch (cause) {
    const err = new Error(`payoutTiers on coverage ${coverageInput.coverageCode} are refused: ${cause.message}`);
    err.status = 400;
    throw err;
  }
  return {
    tiers: validated.tiers.map((t) => ({
      tierOrder: t.tierOrder,
      label: t.label,
      minValue: columnDecimal(t.minValue, 4),
      maxValue: columnDecimal(t.maxValue, 4),
      payoutPct: columnDecimal(t.payoutPct, 2),
      shape: t.shape,
      pctAtMin: columnDecimal(t.pctAtMin, 2),
      pctAtMax: columnDecimal(t.pctAtMax, 2),
    })),
    gaps: validated.gaps.map((g) => ({ ...g, from: columnDecimal(g.from, 4), to: columnDecimal(g.to, 4) })),
  };
}

// Resolves and snapshots one coverage's tier matrix at creation time -- not
// re-read at mint time, which may be much later depending on when the
// policy is activated. See the tiered payout matrix note in the README. Throws a 422 if
// the insurer hasn't configured tiers for this coverage's product/peril,
// unless the coverage carries its own payoutTiers --
// a package policy creates all-or-nothing: one unconfigured coverage fails
// the whole request rather than creating a partial policy.
async function resolveCoverage(insurer, coverageInput) {
  // Inline wins over the configured rows.
  const inline = coverageInput.payoutTiers === undefined ? null : inlineTierSet(coverageInput);
  const tiersResult = inline ? null : await pool.query(
    `SELECT * FROM payout_tiers
     WHERE insurer_id = $1 AND product_code = $2 AND peril_type = $3
     ORDER BY tier_order ASC`,
    [insurer.id, coverageInput.productCode, coverageInput.perilType]
  );
  if (!inline && tiersResult.rows.length === 0) {
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
  const coverage = {
    coverageCode: coverageInput.coverageCode,
    productCode: coverageInput.productCode,
    perilType: coverageInput.perilType,
    cellIds: coverageInput.cellIds,
    sumInsured: coverageInput.sumInsured,
    mortgageeClaimAmount: coverageInput.mortgageeClaimAmount ?? null,
    metric: coverageInput.metric,
    payoutBasis: coverageInput.payoutBasis,
    payoutTiersSnapshot: inline ? inline.tiers : tiersResult.rows.map((t) => ({
      tierOrder: t.tier_order,
      label: t.label,
      minValue: t.threshold_min === null ? null : String(t.threshold_min),
      maxValue: t.threshold_max === null ? null : String(t.threshold_max),
      payoutPct: String(t.payout_percentage),
      // v22. The tier's shape as configured; a step tier's end
      // percentages are NULL, a linear tier's both set (payout_tiers CHECKs).
      shape: t.shape,
      pctAtMin: t.pct_at_min === null ? null : String(t.pct_at_min),
      pctAtMax: t.pct_at_max === null ? null : String(t.pct_at_max),
    })),
  };
  if (inline) return { ...coverage, gaps: inline.gaps, tiersSource: 'inline' };
  // The rows may have been written by SQL, setupDemo or seed rather than by
  // the PUT, which runs validateTierSet. A set it refuses fails the whole
  // package with a 422, as a missing one does; its messages never
  // echo a label.
  let validated;
  try {
    validated = validateTierSet(coverage.payoutTiersSnapshot);
  } catch (cause) {
    const err = new Error(
      `the payout_tiers configured for ${coverageInput.productCode}/${coverageInput.perilType} ` +
        `(coverage ${coverageInput.coverageCode}) are refused: ${cause.message}`
    );
    err.status = 422;
    throw err;
  }
  return { ...coverage, payoutTiersSnapshot: validated.tiers, gaps: validated.gaps, tiersSource: 'configured' };
}

// POST /api/v1/policies -- creation only. Writes the policy's terms to SQL
// and returns. Does not touch Canton, does not allocate a Party, does not
// mint. Activation (below) is a separate, later act.
// Body:
//   policyholder: { externalRef }
//   policyTerms:  { premiumAmount, currency?, startDate, endDate }
//   coverages:    [{ coverageCode, productCode, perilType, cellIds[], sumInsured,
//                    metric, payoutBasis, payoutTiers? }, ...]
//                  -- required, non-empty, coverageCode unique within the
//                  array. There is no single-coverage
//                  convenience shape -- even a one-coverage policy (e.g.
//                  today's frost product) sends a one-element array.
//                  payoutTiers, in the snapshot shape, is the coverage's own
//                  tier set; sent, it is used instead of the configured
//                  `payout_tiers` rows.
//   actuarialPayload: opaque pass-through of whatever the insurer's own
//                      SAS/Python pricing job computed -- stored for audit,
//                      not interpreted here.
// payoutDestination is not accepted here -- it is system-derived below, from
// whether the policy names a mortgagee (accepted in this body) and whether a
// coverage carries a mortgageeClaimAmount (accepted per coverage).
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
      requireDocumentHash(beneficiaryDescriptorHash, 'beneficiaryDescriptorHash');
    }
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
    // The token's own ensure clause forbids a claim amount on a policy with
    // no mortgagee. Caught here so the caller gets a 400 naming the coverage
    // rather than a ledger rejection at activation time, minutes later.
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
    requireTermsAmounts(policyTerms, coverageInputs);
    const coverageCodes = coverageInputs.map((c) => c.coverageCode);
    if (new Set(coverageCodes).size !== coverageCodes.length) {
      const err = new Error('coverageCode must be unique within a policy');
      err.status = 400;
      throw err;
    }
    for (const coverageInput of coverageInputs) requireCoverageCell(coverageInput);
    for (const coverageInput of coverageInputs) requireCoverageTerms(coverageInput);
    // Every role's reference is checked before the first of them is written,
    // so a refused beneficiary does not leave the policyholder's row behind.
    for (const [role, input] of [
      ['policyholder', policyholderInput],
      ['mortgagee', mortgageeInput],
      ['insured', insuredInput],
      ['beneficiary', beneficiaryInput],
    ]) {
      if (input && (input.fullName !== undefined || input.nationalId !== undefined)) {
        const err = new Error(
          `${role}: fullName and nationalId are not accepted or stored by this platform -- identify people by externalRef only`
        );
        err.status = 400;
        throw err;
      }
      if (input) requireInsurerReference(input, `${role}.externalRef`);
    }

    const resolvedCoverages = [];
    for (const coverageInput of coverageInputs) {
      resolvedCoverages.push(await resolveCoverage(insurer, coverageInput));
    }

    const { policy, coverages, policyholder, mortgagee, insured, beneficiary } = await withTransaction(async (client) => {
      // The roles' rows are written in externalRef order, not role order. In
      // role order, two creations naming the same new people in crossed roles
      // (X policyholder and Y insured on one, the reverse on the other) each
      // held an uncommitted row the other's insert waited on, and Postgres
      // ended that deadlock with a 500. One order for every creation leaves no
      // cycle to wait in.
      const people = {};
      const named = [
        ['policyholder', policyholderInput],
        ['mortgagee', mortgageeInput],
        ['insured', insuredInput],
        ['beneficiary', beneficiaryInput],
      ].filter(([, input]) => input);
      named.sort(([, a], [, b]) => {
        const [x, y] = [String(a.externalRef), String(b.externalRef)];
        return x < y ? -1 : x > y ? 1 : 0;
      });
      for (const [role, input] of named) people[role] = await ensurePolicyholderRecord(client, insurer, input);
      const policyholder = people.policyholder;
      // Resolved through the SAME registry as the policyholder, so a person who
      // holds two roles on one policy is one row and one Party, and a bank
      // named on four hundred policies is one row and one Party reused four
      // hundred times. Party allocation itself still happens later, at
      // activation -- this only reserves the identity.
      const mortgagee = people.mortgagee ?? null;
      const insured = people.insured ?? null;
      const beneficiary = people.beneficiary ?? null;

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
                  sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, mortgagee_claim_amount,
                  metric, payout_basis)
               VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11)
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
                c.metric,
                c.payoutBasis,
              ]
            )
          ).rows[0]
        );
      }
      return { policy: policyRow, coverages: coverageRows, policyholder, mortgagee, insured, beneficiary };
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
      // v22: the cell commitment's salt stays in SQL. It is what makes
      // the ledger's commitment unguessable from the cell, so, like an event's
      // textSalt (notifications/policyRecord.js), it is not returned.
      // Each coverage also names where its tiers came from and the inner gaps
      // of that set; the source is not stored.
      coverages: coverages.map(({ cell_commitment_salt: _salt, ...coverage }, i) => ({
        ...coverage,
        tiersSource: resolvedCoverages[i].tiersSource,
        gaps: resolvedCoverages[i].gaps,
      })),
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

// The way in for an insurer's reported instant: only an
// RFC 3339 date-time with a Z or +-hh:mm offset, T and Z in either case, and
// at most three fraction digits -- a longer fraction is refused, never cut to
// the millisecond Date keeps. A string without an offset would be read in this
// server's zone, and a non-string (true, 1) would reach the ledger as 1970.
// The parts are compared, not the toISOString() round trip requireCalendarDate
// uses, which would refuse '...T09:00:00Z' and '+03:00' too. A day the
// calendar does not have, hour 24, minute or second 60, an offset past 23:59
// and year 0000 are refused. `message` is the route's own text; the format is
// appended to it. The rule belongs to this route layer alone: the
// dispatcher's mirror stays loose on format on purpose, because other writers,
// such as a scale-measurement script kept outside this repository, write settlement rows directly.
const RFC3339_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

function requireInstant(value, message) {
  const parts = typeof value === 'string' ? RFC3339_INSTANT.exec(value) : null;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    parts ? parts.slice(1).map((part) => (part === undefined ? 0 : Number(part))) : [];
  const date = new Date(0);
  if (parts) date.setUTCFullYear(year, month - 1, day);
  if (
    !parts ||
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    const err = new Error(
      `${message} (an RFC 3339 date-time with a Z or +-hh:mm offset and at most three fraction digits, ` +
        'e.g. 2026-09-10T09:00:00Z)'
    );
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

// The check GET /payouts/:payoutId and GET /policies/:policyId make, for the
// POST routes: Postgres would refuse a non-UUID with 22P02, which reaches the
// caller as a 500.
function requireUuidParam(req, name) {
  if (!PAYOUT_ID.test(req.params[name])) {
    const err = new Error(`${name} must be a UUID`);
    err.status = 400;
    throw err;
  }
}

// The outbox row a 202 answers with. The payload stays in SQL:
// it holds the salts and the insurer's raw free text. Error text is
// never returned, and the contract ids go with it. Renew's read can
// find no row, when the one queued finished before it; that stays undefined.
function acceptedEvent(row) {
  if (row === undefined) return undefined;
  const { payload: _payload, error: _error, resulting_contract_id: _resulting, source_contract_id: _source, ...event } = row;
  return event;
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
    requireUuidParam(req, 'policyId');
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

    res.status(202).json({ event: acceptedEvent(outbox.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// Every lifecycle endpoint below is the same shape as /activate:
// authenticate, confirm the policy belongs to this insurer, write one
// outbox row, return it. None of them touches the ledger;
// dispatch/dispatcher.js is still the only thing that ever does.
//
// The idempotency guarantee changed from "at most one of
// this event type per policy, ever" to "at most one IN FLIGHT per policy".
// The old shape made a second default cycle impossible -- a reinstated
// policy could never receive a later notice -- and would have been wrong
// for endorsements from the start, since a policy is amended many times
// over its life. A call made while a row of its type is still pending or
// processing is refused with 409 naming that row, and writes nothing;
// queueing a new one after the previous cycle finished is now allowed.
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
  requireUuidParam(req, 'policyId');
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

  // Nothing inserted -- an event of this type is already in flight. Refused
  // and that row named, rather than that row returned, because this request
  // may carry different content (the renewal line, 2026-09-13).
  const inFlight = await pool.query(
    `SELECT * FROM policy_events
     WHERE policy_no = $1 AND event_type = $2 AND status IN ('pending', 'processing')
     ORDER BY created_at DESC LIMIT 1`,
    [req.params.policyId, eventType]
  );
  const queued = inFlight.rows[0];
  // No row: the one in flight finished between the INSERT and this read.
  const err = new Error(
    queued
      ? `${eventType} event ${queued.id} is already ${queued.status} for policy ${req.params.policyId} -- ` +
          'a second one is refused, not merged into it'
      : `a ${eventType} event for policy ${req.params.policyId} was in flight and finished before it could be ` +
          'named -- nothing was queued for this request; send it again'
  );
  err.status = 409;
  throw err;
}

// POST /api/v1/policies/:policyId/notice -- premium default, step 1: the
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
    res.status(202).json({ event: acceptedEvent(event) });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/policies/:policyId/reinstate -- premium default, step 3: the
// insurer tells us the outstanding premium has been paid. Takes no body:
// the same policy resumes on its original dates, so there is nothing to
// supply. This is narrowed to the grace period only: once the notice
// period elapses the contract is terminated (TTK 6102 m. 1434(3)) and a
// later payment does not undo that -- the Daml choice enforces it.
policiesRouter.post('/policies/:policyId/reinstate', async (req, res, next) => {
  try {
    const event = await insertLifecycleEvent(req, 'reinstatement');
    res.status(202).json({ event: acceptedEvent(event) });
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

// POST /api/v1/policies/:policyId/endorse -- change
// a LIVE policy's terms. Distinct from a renewal, which is a new policy
// with a new term and a predecessor reference, and which is implemented
// separately as POST /api/v1/policies/:policyId/renew below.
//
// Body (every field optional except `reason`, but at least one actual
// change is required -- an endorsement that changes nothing is rejected
// rather than burning a version):
//   reason:                one of ENDORSEMENT_REASONS above (required)
//   sumInsuredChanges:     [{ coverageCode, sumInsured }]  -- remainingLimit
//                          moves by the same delta; it never resets
//   coveragesToAdd:        [{ coverageCode, productCode, perilType, cellIds[],
//                             sumInsured, payoutTiers,
//                             mortgageeClaimAmount?, metric, payoutBasis }]
//                          -- payoutDestination and remainingLimit are
//                          derived, not accepted
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
// An added coverage's tier set is validated and sorted by tierOrder here
// (see validateTierSet). Every sumInsured, in sumInsuredChanges and in
// coveragesToAdd, is held to the NUMERIC(14,2) form, greater than zero, here
// and in the dispatcher. An added coverage's payoutDestination and
// remainingLimit are derived by the dispatcher, and its mortgageeClaimAmount is
// held to the same form and needs an effective mortgagee, checked here.
// A code both removed and added, and the removal of a
// coverage attached now (m. 1457), are refused here and in the dispatcher.
// Everything else is passed to the Daml
// choice as given. The invariants (delta arithmetic, no removing a paid-out coverage,
// no empty or duplicate coverage list, no amending a terminated policy) are
// enforced there, in one place, rather than being re-checked here and
// risking the two disagreeing.
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
    // A sumInsured is held to policy_coverages.sum_insured's
    // NUMERIC(14,2), greater than zero, here and in the dispatcher.
    if (!Array.isArray(sumInsuredChanges)) {
      const err = new Error('sumInsuredChanges must be an array of { coverageCode, sumInsured }');
      err.status = 400;
      throw err;
    }
    for (const c of sumInsuredChanges) {
      if (!c?.coverageCode || !isNumeric14_2Amount(c.sumInsured)) {
        const err = new Error(
          `sumInsuredChanges for coverage ${c?.coverageCode ?? '(no coverageCode)'} needs a coverageCode and a ` +
            `sumInsured greater than zero with at most 12 integer digits and 2 decimals`
        );
        err.status = 400;
        throw err;
      }
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
    const addedTiers = [];
    for (const c of coveragesToAdd) {
      if (!c.coverageCode || !c.productCode || !c.perilType || !Array.isArray(c.cellIds)) {
        const err = new Error(
          `added coverage ${c.coverageCode ?? '(no coverageCode)'} must supply coverageCode, ` +
            `productCode, perilType, and cellIds`
        );
        err.status = 400;
        throw err;
      }
      requireCoverageCell(c);
      requireCoverageTerms(c);
      if (!isNumeric14_2Amount(c.sumInsured)) {
        const err = new Error(
          `added coverage ${c.coverageCode} needs a sumInsured greater than zero with at most ` +
            `12 integer digits and 2 decimals`
        );
        err.status = 400;
        throw err;
      }
      // Both are derived by the dispatcher, so a value sent for
      // either is refused, not ignored.
      for (const key of ['payoutDestination', 'remainingLimit']) {
        if (key in c) {
          const err = new Error(
            `added coverage ${c.coverageCode} carries ${key}, which is not accepted -- it is derived`
          );
          err.status = 400;
          throw err;
        }
      }
      // A claim, when sent, is held to the sumInsured form.
      if (
        c.mortgageeClaimAmount !== undefined &&
        c.mortgageeClaimAmount !== null &&
        !isNumeric14_2Amount(c.mortgageeClaimAmount)
      ) {
        const err = new Error(
          `mortgageeClaimAmount on added coverage ${c.coverageCode} must be greater than zero with at most ` +
            `12 integer digits and 2 decimals`
        );
        err.status = 400;
        throw err;
      }
      // The set is held to validateTierSet's rules
      // (including the label rule) before the outbox row is written,
      // and queued sorted by tierOrder. Its messages never echo a label.
      try {
        addedTiers.push(validateTierSet(c.payoutTiers).tiers);
      } catch (cause) {
        const err = new Error(`payoutTiers on added coverage ${c.coverageCode} are refused: ${cause.message}`);
        err.status = 400;
        throw err;
      }
    }
    // A coverage is not replaced under its own code, and one that
    // is attached now (m. 1457; schema.sql's idx_policy_coverages_attached) is
    // not removed, under any code -- a coverage added in its place carries no
    // attachment. The policy is read scoped to the insurer, so another
    // insurer's policy id is 404. The dispatcher repeats both before the ledger.
    const replacedCodes = coveragesToAdd
      .map((c) => c.coverageCode)
      .filter((code) => coverageCodesToRemove.includes(code));
    if (replacedCodes.length > 0) {
      const err = new Error(
        `coverage(s) ${replacedCodes.join(', ')} are both removed and added in one endorsement -- ` +
          `add the coverage under a different code`
      );
      err.status = 400;
      throw err;
    }
    if (coverageCodesToRemove.length > 0) {
      const insurer = await authenticateInsurer(req);
      requireUuidParam(req, 'policyId');
      const { rows } = await pool.query(
        `SELECT c.coverage_code FROM policies p
           LEFT JOIN policy_coverages c
             ON c.policy_id = p.id AND c.coverage_code = ANY($3::text[])
            AND c.attached_at IS NOT NULL
            AND (c.attachment_lifted_at IS NULL OR c.attachment_lifted_at < c.attached_at)
          WHERE p.id = $1 AND p.insurer_id = $2`,
        [req.params.policyId, insurer.id, coverageCodesToRemove]
      );
      if (rows.length === 0) {
        const err = new Error('policy not found');
        err.status = 404;
        throw err;
      }
      const attachedCodes = rows.map((r) => r.coverage_code).filter((code) => code !== null);
      if (attachedCodes.length > 0) {
        const err = new Error(
          `coverage(s) ${attachedCodes.join(', ')} are under attachment (m. 1457) and cannot be removed -- ` +
            `a coverage added in their place would carry no attachment; record the attachment lifted first`
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
    // A mortgagee that is set must be one of this insurer's policyholders:
    // policies.mortgagee_policyholder_id mirrors the token's mortgagee, and a
    // party with no row there cannot be mirrored. Refused here with a 400; the
    // dispatcher refuses a row queued past this.
    if (changesMortgagee && newMortgagee !== null) {
      const insurer = await authenticateInsurer(req);
      const registered = typeof newMortgagee === 'string' && (
        await pool.query('SELECT 1 FROM policyholders WHERE canton_party_id = $1 AND insurer_id = $2', [
          newMortgagee,
          insurer.id,
        ])
      ).rows.length > 0;
      if (!registered) {
        const err = new Error(
          'newMortgagee must be the party of one of this insurer\'s policyholders, or null to clear the mortgagee'
        );
        err.status = 400;
        throw err;
      }
    }
    // A claim needs an effective mortgagee, as on creation -- the
    // newMortgagee this body sets, or else the policy's own. The policy is read
    // first, scoped to the insurer, so another insurer's policy id is 404, never 400.
    const claimingCoverages = coveragesToAdd.filter(
      (c) => c.mortgageeClaimAmount !== undefined && c.mortgageeClaimAmount !== null
    );
    if (claimingCoverages.length > 0) {
      const insurer = await authenticateInsurer(req);
      requireUuidParam(req, 'policyId');
      const { rows: [policy] } = await pool.query(
        'SELECT mortgagee_policyholder_id FROM policies WHERE id = $1 AND insurer_id = $2',
        [req.params.policyId, insurer.id]
      );
      if (!policy) {
        const err = new Error('policy not found');
        err.status = 404;
        throw err;
      }
      const effectiveMortgagee = changesMortgagee ? newMortgagee ?? null : policy.mortgagee_policyholder_id;
      if (effectiveMortgagee === null) {
        const err = new Error(
          `added coverage(s) ${claimingCoverages.map((c) => c.coverageCode).join(', ')} carry a ` +
            `mortgageeClaimAmount but the policy names no mortgagee`
        );
        err.status = 400;
        throw err;
      }
    }

    const event = await insertLifecycleEvent(req, 'endorsement', {
      reason,
      sumInsuredChanges,
      // v22. Each added coverage's cell-commitment salt is drawn here,
      // when the row is written, so a retried dispatch sends the same
      // commitment (the ledgerText.js rule); the dispatcher stores it on the
      // coverage row it creates.
      coveragesToAdd: coveragesToAdd.map((c, i) => ({ ...c, payoutTiers: addedTiers[i], cellCommitmentSalt: newTextSalt() })),
      coverageCodesToRemove,
      newExpiry: newExpiry ?? null,
      // Tri-state, carried as {value} when the caller asked for a change
      // and omitted entirely when it did not -- see the body doc above.
      // dispatcher.js turns this into the Daml nested-Optional wire form.
      ...(changesBeneficiary ? { newBeneficiary: { value: newBeneficiary ?? null } } : {}),
      ...(changesMortgagee ? { newMortgagee: { value: newMortgagee ?? null } } : {}),
      newDocumentHash: newDocumentHash ?? null,
    });
    res.status(202).json({ event: acceptedEvent(event) });
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

// POST /api/v1/policies/:policyId/renew -- open a NEW risk
// period succeeding this one. `:policyId` is the PREDECESSOR.
//
// A renewal is not an endorsement. An endorsement changes the terms of the
// policy it acts on, in place, at version + 1; a renewal creates a
// different policy with its own policyNo and leaves the predecessor
// running to its own term end. Both are live at once during the overlap.
//
// Body:
//   policyTerms: { premiumAmount, currency?, startDate, endDate }  (required)
//   coverages:   [{ coverageCode, productCode, perilType, cellIds[], sumInsured,
//                   metric, payoutBasis, payoutTiers? }]
//                 (required, non-empty, unique coverageCodes; payoutTiers as
//                 on creation)
//   documentHash: the new period's own document hash (required, as on creation)
//
// Terms, sums insured, and tiers are INPUTS for the new period, never
// copied from the predecessor -- a renewal may legitimately change any of
// them, and tiers are taken from a coverage's payoutTiers when it sends
// them, otherwise re-snapshotted from the current `payout_tiers`
// configuration, never inherited from the old token. What IS carried
// over is the customer and risk identity: the policyholder (and therefore
// the Canton party, which is reused and never reallocated) and the insurer.
//
// The limits of the new period always start at their full sums insured --
// see the reset in dispatcher.js's handleRenewal, which is deliberately the
// inverse of the delta arithmetic in the endorsement path.
policiesRouter.post('/policies/:policyId/renew', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    requireUuidParam(req, 'policyId');
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
    requireTermsAmounts(policyTerms, coverageInputs);
    const coverageCodes = coverageInputs.map((c) => c.coverageCode);
    if (new Set(coverageCodes).size !== coverageCodes.length) {
      const err = new Error('coverageCode must be unique within a policy');
      err.status = 400;
      throw err;
    }
    for (const coverageInput of coverageInputs) requireCoverageCell(coverageInput);
    for (const coverageInput of coverageInputs) requireCoverageTerms(coverageInput);
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

    // Tiers come from the request or are looked up fresh for the new period,
    // never inherited.
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
            // terms: the successor's cover begins only when its own first
            // premium is reported. /renew takes no agreed cover start
            // (agreedCoverageStart is read on creation only). Inheriting the
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
              sum_insured, remaining_limit, payout_tiers_snapshot, payout_destination, mortgagee_claim_amount,
              metric, payout_basis)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,NULL,$9,$10)`,
          [
            policyRow.id,
            c.coverageCode,
            c.productCode,
            c.perilType,
            JSON.stringify(c.cellIds),
            c.sumInsured,
            JSON.stringify(c.payoutTiersSnapshot),
            JSON.stringify(['PDR_Insured']),
            c.metric,
            c.payoutBasis,
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

    // Each coverage's tier source and the inner gaps of its set, in request
    // order; the source is not stored.
    const coverages = resolvedCoverages.map(({ coverageCode, tiersSource, gaps }) => ({ coverageCode, tiersSource, gaps }));
    res.status(202).json({ predecessorPolicyId: predecessor.id, successorPolicyId: successor.id, event: acceptedEvent(outbox.rows[0]), coverages });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Reporting what happened to a payout
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
  requireUuidParam(req, 'payoutId');
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

// The row's salt is drawn here, when the row is written, so a retried
// dispatch sends the same digest of the free text (dispatch/ledgerText.js).
async function queueSettlementEvent(payout, targetContractId, payload) {
  payload = { ...payload, textSalt: newTextSalt() };
  const inserted = await pool.query(
    `INSERT INTO policy_events (policy_no, event_type, source_contract_id, payload)
     VALUES ($1, 'settlement', $2, $3)
     ON CONFLICT (source_contract_id)
       WHERE event_type = 'settlement' AND status IN ('pending', 'processing')
     DO NOTHING
     RETURNING *`,
    [payout.policy_id, targetContractId, JSON.stringify(payload)]
  );
  if (inserted.rows[0]) return inserted.rows[0];
  // A report already queued refuses this one, as insertLifecycleEvent does.
  const { rows } = await pool.query(
    `SELECT * FROM policy_events
     WHERE event_type = 'settlement' AND source_contract_id = $1 AND status IN ('pending', 'processing')
     ORDER BY created_at DESC LIMIT 1`,
    [targetContractId]
  );
  const queued = rows[0];
  // No row: the one in flight finished between the INSERT and this read.
  const err = new Error(
    queued
      ? `payout ${payout.id}: settlement event ${queued.id} (action '${queued.payload.action}') is already ` +
          `${queued.status} -- a second report is refused, not merged into it`
      : `payout ${payout.id}: a settlement event was in flight and finished before it could be named -- ` +
          'nothing was queued for this report; send it again'
  );
  err.status = 409;
  throw err;
}

// settledAt and closedAt, the insurer's reported instants, are bounded on
// both sides. Not after this server's clock, with no margin -- the rule a
// first premium's paidAt already follows below. Not before
// payout_events.approved_at, which holds the PayoutApproved's approvedAt on a
// payout and the review item's flaggedAt on an unrouted amount; on an item
// MarkFailed raised, the item's own flaggedAt is later and is not held in
// SQL, so approved_at is the bound checked there. A payout with no
// approved_at cannot be checked, and the report is refused rather than
// queued unchecked. dispatch/dispatcher.js applies the same bounds to the
// row, because a settlement row can be written by a path other than these.
function refuseFutureInstant(field, value) {
  if (new Date(value).getTime() > Date.now()) {
    const err = new Error(
      `${field} ${new Date(value).toISOString()} is in the future -- it reports something that has not ` +
        'happened yet'
    );
    err.status = 400;
    throw err;
  }
}

function refuseInstantBeforeApproval(payout, field, value) {
  if (!payout.approved_at) {
    const err = new Error(
      `payout ${payout.id} has no approved_at, so its ${field} cannot be checked against the instant ` +
        'the ledger recorded for it -- refused rather than queued unchecked'
    );
    err.status = 409;
    throw err;
  }
  if (new Date(value).getTime() < new Date(payout.approved_at).getTime()) {
    const err = new Error(
      `${field} ${new Date(value).toISOString()} is before payout ${payout.id}'s approved_at ` +
        `${new Date(payout.approved_at).toISOString()} -- it cannot precede the instant the ledger recorded for it`
    );
    err.status = 400;
    throw err;
  }
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
    requireInstant(
      settledAt,
      'settledAt is required and must be a valid date -- the settlement date is the insurer\'s ' +
        'reported fact, never taken from a system clock'
    );
    refuseFutureInstant('settledAt', settledAt);
    if (!PAID_ROLES.has(paidRole)) {
      const err = new Error(`paidRole must be one of: ${[...PAID_ROLES].join(', ')}`);
      err.status = 400;
      throw err;
    }

    const { payout, targetContractId } = await loadPayoutForReport(req);
    refuseInstantBeforeApproval(payout, 'settledAt', settledAt);
    const action = payout.review_contract_id ? 'resolve_settled' : 'settle';
    const event = await queueSettlementEvent(payout, targetContractId, {
      action,
      bankReference,
      settledAt,
      paidRole,
    });
    res.status(202).json({ payoutId: payout.id, action, event: acceptedEvent(event) });
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
    res.status(202).json({ payoutId: payout.id, action: 'fail', event: acceptedEvent(event) });
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
// Body: { unpaidReason, note, closedAt }
//   closedAt (v22) is the instant the insurer declares the item closed,
//   its reported fact like settledAt, never taken from a system clock. The
//   ledger records it on the PayoutClosedUnpaid it leaves, beside that
//   record's own ledger time.
policiesRouter.post('/payouts/:payoutId/close-unpaid', async (req, res, next) => {
  try {
    const { unpaidReason, note, closedAt } = req.body ?? {};
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
    requireInstant(
      closedAt,
      'closedAt is required and must be a valid date -- the closing instant is the insurer\'s ' +
        'declared fact, never taken from a system clock'
    );
    refuseFutureInstant('closedAt', closedAt);
    const { payout, targetContractId } = await loadPayoutForReport(req);
    if (!payout.review_contract_id) {
      const err = new Error(
        `payout ${payout.id} is not under manual review -- only a review item can be closed unpaid`
      );
      err.status = 409;
      throw err;
    }
    refuseInstantBeforeApproval(payout, 'closedAt', closedAt);
    const event = await queueSettlementEvent(payout, targetContractId, {
      action: 'resolve_unpaid',
      unpaidReason,
      note,
      closedAt,
    });
    res.status(202).json({ payoutId: payout.id, action: 'resolve_unpaid', event: acceptedEvent(event) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// The insurer READS its payouts (the pull half).
//
// The webhook carries the thin envelope and nothing else; every detail of a
// payout is fetched here, with the insurer's own API key
// (a design rule of the notification contract). The
// record's shape is notifications/payoutRecord.js, and
// docs/api/notifications-v1.openapi.json is its contract.
//
// These two only read. They queue no policy_events row and touch no ledger,
// so they need no Canton party either -- unlike every report above.
// ---------------------------------------------------------------------------
const PAYOUT_STATUSES = new Set(['approved', 'manual_review', 'settled', 'closed_unpaid']);
const PAYOUT_RECORD_KINDS = new Set(['payout', 'unrouted_remainder', 'unrouted_competing_claims']);
const PAYOUT_PAGE_DEFAULT = 50;
const PAYOUT_PAGE_MAX = 200;

// The columns buildRecord reads, and the JOINs that scope a row to an insurer.
// policy_coverages is a LEFT JOIN: an endorsement can remove a coverage
// (dispatcher.js deletes the row) and the payout it once produced remains.
const PAYOUT_RECORD_SELECT = `
  SELECT pe.id, pe.policy_id, ph.external_ref AS customer_ref, pe.coverage_code,
         pc.product_code, pc.peril_type, pe.tier_label, pe.payout_percentage, pe.payout_amount,
         pe.currency, pe.recipient, pe.record_kind, pe.is_full_settlement, pe.status,
         pe.approved_at, pe.created_at, pe.settled_at, pe.resolved_at, pe.trigger_window_id,
         pe.daml_contract_id, pe.event_start, pe.event_end, pe.evidence_digest, pe.closed_at,
         pe.resolution_record_contract_id,
         to_char(pe.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
    FROM payout_events pe
    JOIN policies p ON p.id = pe.policy_id
    JOIN policyholders ph ON ph.id = p.policyholder_id
    LEFT JOIN policy_coverages pc ON pc.policy_id = pe.policy_id AND pc.coverage_code = pe.coverage_code`;

async function loadNotificationsByPayout(payoutIds) {
  const byPayout = new Map(payoutIds.map((id) => [id, []]));
  if (payoutIds.length === 0) return byPayout;
  const { rows } = await pool.query(
    `SELECT id, payout_event_id, kind, status, delivered_at
       FROM payout_notifications
      WHERE payout_event_id = ANY($1::uuid[])
      ORDER BY created_at ASC, id ASC`,
    [payoutIds]
  );
  for (const row of rows) byPayout.get(row.payout_event_id).push(row);
  return byPayout;
}

// The cursor is opaque to the caller: base64url of { c, i } -- the last row's
// created_at and id. `c` is TEXT PRODUCED BY POSTGRES, to the microsecond, and
// goes back into the query as text. It is never a JS Date: a Date holds
// milliseconds, so a cursor built from one lands BEFORE the row it names and
// the next page repeats or skips the rows that share its millisecond.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYOUT_ID = CURSOR_ID;

const encodePayoutCursor = (row) =>
  Buffer.from(JSON.stringify({ c: row.created_at_cursor, i: row.id })).toString('base64url');

function decodePayoutCursor(after) {
  const refuse = () => {
    const err = new Error('after is not a cursor this API issued');
    err.status = 400;
    return err;
  };
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(after), 'base64url').toString('utf8'));
  } catch {
    throw refuse();
  }
  if (!parsed || typeof parsed.c !== 'string' || typeof parsed.i !== 'string') throw refuse();
  if (!CURSOR_TIME.test(parsed.c) || !CURSOR_ID.test(parsed.i)) throw refuse();
  // The pattern admits 30 February; Postgres would not, and would answer 500.
  // The Date is used ONLY to test that the calendar has this instant.
  const instant = new Date(parsed.c);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 19) !== parsed.c.slice(0, 19)) throw refuse();
  return parsed;
}

// GET /api/v1/payouts?status=&recordKind=&after=&limit=
// -> { items: [PayoutRecord, ...], nextCursor }
// Oldest first, (created_at, id) ascending, so a caller that keeps its last
// cursor sees every later payout exactly once. nextCursor is null on the last
// page.
policiesRouter.get('/payouts', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    const { status, recordKind, after, limit: limitInput } = req.query;

    if (status !== undefined && !PAYOUT_STATUSES.has(status)) {
      const err = new Error(`status must be one of: ${[...PAYOUT_STATUSES].join(', ')}`);
      err.status = 400;
      throw err;
    }
    if (recordKind !== undefined && !PAYOUT_RECORD_KINDS.has(recordKind)) {
      const err = new Error(`recordKind must be one of: ${[...PAYOUT_RECORD_KINDS].join(', ')}`);
      err.status = 400;
      throw err;
    }
    let limit = PAYOUT_PAGE_DEFAULT;
    if (limitInput !== undefined) {
      limit = /^\d+$/.test(String(limitInput)) ? Number(limitInput) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > PAYOUT_PAGE_MAX) {
        const err = new Error(`limit must be an integer between 1 and ${PAYOUT_PAGE_MAX}`);
        err.status = 400;
        throw err;
      }
    }
    const cursor = after === undefined ? null : decodePayoutCursor(after);

    // One row past the page says whether there is a next page without a
    // second query.
    const { rows } = await pool.query(
      `${PAYOUT_RECORD_SELECT}
      WHERE p.insurer_id = $1
        AND ($2::text IS NULL OR pe.status::text = $2)
        AND ($3::text IS NULL OR pe.record_kind = $3)
        AND ($4::text IS NULL OR (pe.created_at, pe.id) > ($4::timestamptz, $5::uuid))
      ORDER BY pe.created_at ASC, pe.id ASC
      LIMIT $6`,
      [insurer.id, status ?? null, recordKind ?? null, cursor?.c ?? null, cursor?.i ?? null, limit + 1]
    );
    const page = rows.slice(0, limit);
    const notifications = await loadNotificationsByPayout(page.map((r) => r.id));
    res.json({
      items: page.map((r) => buildRecord(r, notifications.get(r.id))),
      nextCursor: rows.length > limit ? encodePayoutCursor(page[page.length - 1]) : null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/payouts/:payoutId -> PayoutRecord
// Another insurer's payout is 404, the same answer as one that does not
// exist: a 403 would confirm the id is real.
policiesRouter.get('/payouts/:payoutId', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    // Postgres would refuse a non-UUID with 22P02, which reaches the caller as
    // a 500.
    if (!PAYOUT_ID.test(req.params.payoutId)) {
      const err = new Error('payoutId must be a UUID');
      err.status = 400;
      throw err;
    }
    const { rows } = await pool.query(
      `${PAYOUT_RECORD_SELECT}
      WHERE pe.id = $1 AND p.insurer_id = $2`,
      [req.params.payoutId, insurer.id]
    );
    if (!rows[0]) {
      const err = new Error('payout not found');
      err.status = 404;
      throw err;
    }
    const notifications = await loadNotificationsByPayout([rows[0].id]);
    res.json(buildRecord(rows[0], notifications.get(rows[0].id)));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/policies?after=&limit=
// -> { items: [PolicySummary, ...], nextCursor }
// The caller's own policies, one summary each for a list screen; the shape is
// buildPolicySummary in notifications/policyRecord.js, and the rest of a
// policy is GET /policies/:policyId. Newest first, (created_at, id)
// descending: a policy created after the first page was read is on a fresh
// first page, never on a later one. limit, after and the cursor are those of
// GET /payouts. Reads only.
policiesRouter.get('/policies', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    const { after, limit: limitInput } = req.query;

    let limit = PAYOUT_PAGE_DEFAULT;
    if (limitInput !== undefined) {
      limit = /^\d+$/.test(String(limitInput)) ? Number(limitInput) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > PAYOUT_PAGE_MAX) {
        const err = new Error(`limit must be an integer between 1 and ${PAYOUT_PAGE_MAX}`);
        err.status = 400;
        throw err;
      }
    }
    const cursor = after === undefined ? null : decodePayoutCursor(after);

    // One row past the page, as in GET /payouts.
    const { rows } = await pool.query(
      `SELECT id, status, default_state, currency,
              to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
              coverage_began_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
         FROM policies
        WHERE insurer_id = $1
          AND ($2::text IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [insurer.id, cursor?.c ?? null, cursor?.i ?? null, limit + 1]
    );
    const page = rows.slice(0, limit);
    const ids = page.map((r) => r.id);
    const coverages = await pool.query(
      `SELECT policy_id, coverage_code, product_code, peril_type, sum_insured, remaining_limit
         FROM policy_coverages
        WHERE policy_id = ANY($1::uuid[])
        ORDER BY created_at ASC, coverage_code ASC`,
      [ids]
    );
    // Each policy's newest outbox row, in the order GET /policies/:policyId
    // lists its events.
    const lastEvents = await pool.query(
      `SELECT DISTINCT ON (policy_no) policy_no, id, event_type, status, created_at, processed_at, error
         FROM policy_events
        WHERE policy_no = ANY($1::uuid[])
        ORDER BY policy_no, created_at DESC, id DESC`,
      [ids]
    );
    const coveragesByPolicy = new Map(ids.map((id) => [id, []]));
    for (const row of coverages.rows) coveragesByPolicy.get(row.policy_id).push(row);
    const lastEventByPolicy = new Map(lastEvents.rows.map((row) => [row.policy_no, row]));
    res.json({
      items: page.map((r) => buildPolicySummary(r, coveragesByPolicy.get(r.id), lastEventByPolicy.get(r.id) ?? null)),
      nextCursor: rows.length > limit ? encodePayoutCursor(page[page.length - 1]) : null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/policies/:policyId -> PolicyRecord
// The policy's state and the outcome of its outbox rows, newest first, at
// most PAYOUT_PAGE_DEFAULT of them; eventsTruncated says there were more.
// The record's shape is notifications/policyRecord.js. Tenant scope and the
// 404 are those of GET /payouts/:payoutId: another insurer's policy is
// indistinguishable from one that does not exist.
policiesRouter.get('/policies/:policyId', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    if (!PAYOUT_ID.test(req.params.policyId)) {
      const err = new Error('policyId must be a UUID');
      err.status = 400;
      throw err;
    }
    const { rows } = await pool.query(
      `SELECT id, status, default_state,
              to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
              term_start, expiry, coverage_began_at, daml_contract_id, enforcement_route
         FROM policies
        WHERE id = $1 AND insurer_id = $2`,
      [req.params.policyId, insurer.id]
    );
    if (!rows[0]) {
      const err = new Error('policy not found');
      err.status = 404;
      throw err;
    }
    const coverages = await pool.query(
      `SELECT coverage_code, product_code, peril_type, sum_insured, remaining_limit, cell_ids
         FROM policy_coverages
        WHERE policy_id = $1
        ORDER BY created_at ASC, coverage_code ASC`,
      [rows[0].id]
    );
    const events = await pool.query(
      `SELECT id, event_type, status, created_at, processed_at, error
         FROM policy_events
        WHERE policy_no = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [rows[0].id, PAYOUT_PAGE_DEFAULT + 1]
    );
    res.json(buildPolicyRecord(
      rows[0],
      coverages.rows,
      events.rows.slice(0, PAYOUT_PAGE_DEFAULT),
      events.rows.length > PAYOUT_PAGE_DEFAULT
    ));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// m. 1456(4) and (5): the mortgagee facts.
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
    requireInstant(
      notifiedAt,
      'notifiedAt is required and must be a valid date -- the notification date is the ' +
        "insurer's reported fact, never inferred"
    );
    const event = await insertLifecycleEvent(req, 'mortgagee_notice', { notifiedAt });
    res.status(202).json({ event: acceptedEvent(event) });
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
    res.status(202).json({ event: acceptedEvent(event) });
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
    // Refused once the first premium is recorded paid: a due date reported
    // after the payment would move a paid policy into first-premium default.
    // Refused here with a 409; the dispatcher refuses a row queued past this.
    const insurer = await authenticateInsurer(req);
    requireUuidParam(req, 'policyId');
    const { rows: [recorded] } = await pool.query(
      `SELECT first_premium_paid_at FROM policies
        WHERE id = $1 AND insurer_id = $2 AND first_premium_paid_at IS NOT NULL`,
      [req.params.policyId, insurer.id]
    );
    if (recorded) {
      const err = new Error(
        `policy ${req.params.policyId} already has its first premium recorded as paid at ` +
          `${recorded.first_premium_paid_at.toISOString()} -- a premium due date is not recorded after the payment`
      );
      err.status = 409;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'premium_due_date', { dueDate });
    res.status(202).json({ event: acceptedEvent(event) });
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
    requireInstant(
      commencedAt,
      'commencedAt is required and must be a valid date -- the platform cannot observe litigation'
    );
    const event = await insertLifecycleEvent(req, 'enforcement_commenced', { commencedAt });
    res.status(202).json({ event: acceptedEvent(event) });
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
    requireInstant(
      attachedAt,
      'attachedAt is required and must be a valid date -- the platform cannot observe an icra file'
    );
    const event = await insertLifecycleEvent(req, 'attachment', { coverageCode, attachedAt });
    res.status(202).json({ event: acceptedEvent(event) });
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
    requireInstant(
      liftedAt,
      'liftedAt is required and must be a valid date -- the platform cannot observe an icra file'
    );
    const event = await insertLifecycleEvent(req, 'attachment_lifted', { coverageCode, liftedAt });
    res.status(202).json({ event: acceptedEvent(event) });
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
      const message =
        `${name} is required and must be a valid date -- the insurance period is the insurer's ` +
          `own fact under m. 1411 and is never derived here`;
      if (name === 'electedAt') {
        requireInstant(value, message);
      } else if (!value || Number.isNaN(new Date(value).getTime())) {
        const err = new Error(message);
        err.status = 400;
        throw err;
      }
    }
    const event = await insertLifecycleEvent(req, 'two_notice_election', {
      electedAt, insurancePeriodStart, insurancePeriodEnd,
    });
    res.status(202).json({ event: acceptedEvent(event) });
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
    requireInstant(
      requestedAt,
      'requestedAt is required and must be a valid date -- the platform does not receive the ' +
        'request, so the date is the insurer\'s reported fact'
    );
    const event = await insertLifecycleEvent(req, 'mortgagee_info_request', { requestedAt });
    res.status(202).json({ event: acceptedEvent(event) });
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
    requireInstant(
      providedAt,
      'providedAt is required and must be a valid date -- the platform does not answer the ' +
        'request, so the date is the insurer\'s reported fact'
    );
    const event = await insertLifecycleEvent(req, 'mortgagee_info_provided', { providedAt });
    res.status(202).json({ event: acceptedEvent(event) });
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
    requireInstant(
      fruitlessAt,
      'fruitlessAt is required and must be a valid date -- the platform cannot observe an ' +
        'enforcement proceeding, only be told about one'
    );
    if (route !== 'ER_Takip' && route !== 'ER_Dava') {
      const err = new Error('route is required and must be one of ER_Takip, ER_Dava');
      err.status = 400;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'enforcement_fruitless', { fruitlessAt, route });
    res.status(202).json({ event: acceptedEvent(event) });
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
    requireInstant(
      notifiedAt,
      'notifiedAt is required and must be a valid date -- the platform cannot serve a notice'
    );
    const event = await insertLifecycleEvent(req, 'substitution_notice', { notifiedAt });
    res.status(202).json({ event: acceptedEvent(event) });
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
    requireInstant(
      substitutedAt,
      'substitutedAt is required and must be a valid date -- the platform cannot witness an ' +
        'undertaking, only record that it was reported'
    );
    const event = await insertLifecycleEvent(req, 'substitution', { substitutedAt });
    res.status(202).json({ event: acceptedEvent(event) });
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
//
// v22. A paidAt after this server's clock reports a payment that has
// not happened yet, and the ledger refuses it against its own clock, with no
// allowance for clock difference. Refused here first, with the same zero
// margin, so the insurer gets a 400 rather than a failed outbox row.
policiesRouter.post('/policies/:policyId/first-premium-paid', async (req, res, next) => {
  try {
    const { paidAt } = req.body ?? {};
    requireInstant(
      paidAt,
      'paidAt is required and must be a valid date -- under m. 1421 the insurer\'s liability ' +
        'begins at this instant, and the platform cannot observe a payment'
    );
    if (new Date(paidAt).getTime() > Date.now()) {
      const err = new Error(
        `paidAt ${new Date(paidAt).toISOString()} is in the future -- a first premium cannot be reported ` +
          'paid before it was paid, and the ledger refuses it too'
      );
      err.status = 400;
      throw err;
    }
    // Reported once. A second report can reach the ledger, which keeps the
    // cover start it already has, while the dispatcher's write-back would
    // overwrite first_premium_paid_at -- SQL and the ledger would disagree.
    // Refused here with a 409; the dispatcher refuses a row queued past this.
    const insurer = await authenticateInsurer(req);
    requireUuidParam(req, 'policyId');
    const { rows: [recorded] } = await pool.query(
      `SELECT first_premium_paid_at FROM policies
        WHERE id = $1 AND insurer_id = $2 AND first_premium_paid_at IS NOT NULL`,
      [req.params.policyId, insurer.id]
    );
    if (recorded) {
      const err = new Error(
        `policy ${req.params.policyId} already has its first premium recorded as paid at ` +
          `${recorded.first_premium_paid_at.toISOString()} -- it is reported once`
      );
      err.status = 409;
      throw err;
    }
    const event = await insertLifecycleEvent(req, 'first_premium_paid', { paidAt });
    res.status(202).json({ event: acceptedEvent(event) });
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
    if (withdrawnAt !== undefined && withdrawnAt !== null) {
      requireInstant(withdrawnAt, 'withdrawnAt, if given, must be a valid date');
    }
    const event = await insertLifecycleEvent(req, 'first_premium_withdrawal', {
      withdrawnAt: withdrawnAt ?? new Date().toISOString(),
    });
    res.status(202).json({ event: acceptedEvent(event) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Terms API: the
// insurer's own terms and tier sets, read and written here instead of in SQL.
// Always the authenticated insurer's own row and rows, never another's.
// ---------------------------------------------------------------------------

// The terms document's keys and the insurers columns they are.
export const TERMS_COLUMNS = Object.freeze({
  defaultGracePeriodDays: 'default_grace_period_days',
  mortgageeContinuationDays: 'mortgagee_continuation_days',
  firstPremiumWithdrawalDays: 'first_premium_withdrawal_days',
  defaultEventWindowTimezone: 'default_event_window_timezone',
  defaultEventWindowStartHour: 'default_event_window_start_hour',
  defaultEventAggregation: 'default_event_aggregation',
});

const termsDocument = (row) =>
  Object.fromEntries(Object.entries(TERMS_COLUMNS).map(([key, column]) => [key, row[column]]));

function termsRefusal(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// The test eventWindow.js's resolveFrozenWindowRule applies to a frozen zone.
function isKnownTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// GET /api/v1/terms -> the six values, null where unset.
policiesRouter.get('/terms', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    res.json(termsDocument(insurer));
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/terms
// Body: the whole document, every one of the six keys; null unsets a value,
// and a missing key is refused, never read as "unchanged".
//
// What a PUT reaches today: the grace period and the event window are frozen
// onto a policy at its activation, so a change to either affects later
// activations only. The mortgagee continuation days and the first-premium
// withdrawal days are frozen onto a policy at its activation too (migration
// 037), so a change to either also affects later activations only.
//
// The grace floor is checked here as well as at activation, which still
// checks it. The withdrawal days get no ceiling here: the three months of
// m. 1434(2) stay checked where the window is computed
// (resolveFirstPremiumWindow, dispatcher.js).
policiesRouter.put('/terms', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    const body = req.body ?? {};
    for (const key of Object.keys(TERMS_COLUMNS)) {
      if (!Object.hasOwn(body, key)) {
        throw termsRefusal(`${key} is missing -- PUT /terms takes the whole document; send null to leave a value unset`);
      }
    }
    const grace = body.defaultGracePeriodDays;
    if (grace !== null && !(Number.isInteger(grace) && grace >= STATUTORY_MIN_GRACE_PERIOD_DAYS)) {
      throw termsRefusal(
        `defaultGracePeriodDays must be null or an integer of at least ${STATUTORY_MIN_GRACE_PERIOD_DAYS}, ` +
          `the notice period of TTK 6102 m. 1434(3)`
      );
    }
    for (const key of ['mortgageeContinuationDays', 'firstPremiumWithdrawalDays']) {
      const days = body[key];
      if (days !== null && !(Number.isInteger(days) && days > 0)) {
        throw termsRefusal(`${key} must be null or a positive integer`);
      }
    }
    for (const key of ['defaultGracePeriodDays', 'mortgageeContinuationDays', 'firstPremiumWithdrawalDays']) {
      if (body[key] !== null && body[key] > PG_INTEGER_MAX) {
        throw termsRefusal(`${key} must be at most ${PG_INTEGER_MAX}, the largest value its INTEGER column holds`);
      }
    }
    const { defaultEventWindowTimezone: timezone, defaultEventWindowStartHour: startHour,
      defaultEventAggregation: aggregation } = body;
    const windowUnset = [timezone, startHour, aggregation].filter((v) => v === null).length;
    if (windowUnset !== 0 && windowUnset !== 3) {
      throw termsRefusal(
        'defaultEventWindowTimezone, defaultEventWindowStartHour and defaultEventAggregation are all set or all null'
      );
    }
    if (windowUnset === 0) {
      if (typeof timezone !== 'string' || !isKnownTimezone(timezone)) {
        throw termsRefusal('defaultEventWindowTimezone is not an IANA time zone');
      }
      if (!(Number.isInteger(startHour) && startHour >= 0 && startHour <= 23)) {
        throw termsRefusal('defaultEventWindowStartHour must be an integer from 0 to 23');
      }
      if (!AGGREGATIONS.includes(aggregation)) {
        throw termsRefusal(`defaultEventAggregation must be one of ${AGGREGATIONS.join(', ')}`);
      }
    }
    const keys = Object.keys(TERMS_COLUMNS);
    const { rows } = await pool.query(
      `UPDATE insurers SET ${keys.map((key, i) => `${TERMS_COLUMNS[key]} = $${i + 2}`).join(', ')}
        WHERE id = $1
        RETURNING ${Object.values(TERMS_COLUMNS).join(', ')}`,
      [insurer.id, ...keys.map((key) => body[key])]
    );
    res.json(termsDocument(rows[0]));
  } catch (err) {
    next(err);
  }
});

// A payout_tiers row in the snapshot shape resolveCoverage builds.
function tierFromRow(t) {
  return {
    tierOrder: t.tier_order,
    label: t.label,
    minValue: t.threshold_min === null ? null : String(t.threshold_min),
    maxValue: t.threshold_max === null ? null : String(t.threshold_max),
    payoutPct: String(t.payout_percentage),
    shape: t.shape,
    pctAtMin: t.pct_at_min === null ? null : String(t.pct_at_min),
    pctAtMax: t.pct_at_max === null ? null : String(t.pct_at_max),
  };
}

function tierSetNotFound() {
  const err = new Error('no payout tiers configured for this product and peril');
  err.status = 404;
  return err;
}

// PUT and DELETE of one insurer's sets wait on its insurers row, one at a
// time, so the UNIQUE (insurer_id, product_code, peril_type, tier_order)
// index never turns two concurrent writes into a 500.
async function lockInsurerRow(client, insurerId) {
  await client.query('SELECT id FROM insurers WHERE id = $1 FOR UPDATE', [insurerId]);
}

// GET /api/v1/terms/payout-tiers/:productCode/:perilType
// -> { productCode, perilType, tiers }, ordered by tier_order. No set is 404
// and so is another insurer's: the two look the same.
policiesRouter.get('/terms/payout-tiers/:productCode/:perilType', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    const { productCode, perilType } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM payout_tiers
        WHERE insurer_id = $1 AND product_code = $2 AND peril_type = $3
        ORDER BY tier_order ASC`,
      [insurer.id, productCode, perilType]
    );
    if (rows.length === 0) throw tierSetNotFound();
    res.json({ productCode, perilType, tiers: rows.map(tierFromRow) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/terms/payout-tiers/:productCode/:perilType
// Body: { tiers }, the whole set. validateTierSet refuses it with a 400, or the
// set replaces the old one in one transaction; the answer
// lists the gaps between tiers as validateTierSet found them.
// Issued policies are untouched: each coverage carries its own snapshot.
policiesRouter.put('/terms/payout-tiers/:productCode/:perilType', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    const { productCode, perilType } = req.params;
    let validated;
    try {
      validated = validateTierSet(req.body?.tiers);
    } catch (err) {
      err.status = 400;
      throw err;
    }
    const stored = await withTransaction(async (client) => {
      await lockInsurerRow(client, insurer.id);
      await client.query(
        'DELETE FROM payout_tiers WHERE insurer_id = $1 AND product_code = $2 AND peril_type = $3',
        [insurer.id, productCode, perilType]
      );
      const rows = [];
      for (const t of validated.tiers) {
        const inserted = await client.query(
          `INSERT INTO payout_tiers
             (insurer_id, product_code, peril_type, tier_order, label, threshold_min, threshold_max,
              payout_percentage, shape, pct_at_min, pct_at_max)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [insurer.id, productCode, perilType, t.tierOrder, t.label, t.minValue ?? null, t.maxValue ?? null,
            t.payoutPct, t.shape, t.pctAtMin ?? null, t.pctAtMax ?? null]
        );
        rows.push(inserted.rows[0]);
      }
      return rows;
    });
    res.json({ productCode, perilType, tiers: stored.map(tierFromRow), gaps: validated.gaps });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/terms/payout-tiers/:productCode/:perilType
// Removes the set; none is 404. The next POST /policies for
// that product and peril is then refused 422, as for a set never configured,
// unless its coverage sends its own payoutTiers.
policiesRouter.delete('/terms/payout-tiers/:productCode/:perilType', async (req, res, next) => {
  try {
    const insurer = await authenticateInsurer(req);
    const { productCode, perilType } = req.params;
    const deleted = await withTransaction(async (client) => {
      await lockInsurerRow(client, insurer.id);
      const { rowCount } = await client.query(
        'DELETE FROM payout_tiers WHERE insurer_id = $1 AND product_code = $2 AND peril_type = $3',
        [insurer.id, productCode, perilType]
      );
      return rowCount;
    });
    if (deleted === 0) throw tierSetNotFound();
    res.json({ productCode, perilType });
  } catch (err) {
    next(err);
  }
});
