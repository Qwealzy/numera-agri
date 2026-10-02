// The record the insurer reads from GET
// /api/v1/policies/:policyId (routes/policies.js) -- its own policy's state,
// and the outcome of the outbox rows its requests queued. Every POST under
// /api/v1 except POST /policies (201 with the draft policy) answers 202 with
// an outbox row; this is where the insurer learns what became of it.
//
// Pure, and built from an explicit whitelist, like payoutRecord.js: each
// output field names the one input column it reads, so a column added to the
// query -- or handed in by a caller -- cannot reach the wire by accident.
// Deliberately NOT read, whatever the row carries: an event's payload (it
// holds the insurer's free text -- bankReference, failureReason, note -- and
// the textSalt that makes their ledger digest recomputable), its error text,
// its resulting_contract_id and source_contract_id, and every party id.
//
// A failed event carries a reason CODE, never its error text. The text can
// hold party ids, contract ids, a ledger error body or an internal path. It
// is matched against the dispatcher's own refusals below; what is returned is
// the fixed message beside the pattern, never anything taken from the text.
// Anything not matched is internal_or_ledger_error, and the detail stays with
// the platform operator, who finds it by the event id.
//
// ledgerContractId is the policy's CURRENT PolicyToken. Every lifecycle event
// archives the token and creates a new one, so it changes; it is null before
// the first mint, and null again once the token is archived without a
// re-mint (expired, cancelled, claimed_and_closed).
//
// NUMERIC columns stay the text pg hands over, as in payoutRecord.js.

// The values of policy_events.status (outbox_status in sql/schema.sql).
const EVENT_STATUSES = new Set(['pending', 'processing', 'done', 'failed']);

// The dispatcher's refusals that were written for the insurer to read and
// that it can act on. Anchored to the start of the dispatcher's own message
// wherever the message is the dispatcher's; cover_not_begun is a Daml
// assertMsg and arrives inside a ledger error body, so it is matched as a
// phrase.
//
// Matching on text makes a message's wording its identity, here and in three
// other places: reviewReasonKind in routes/debug.js (the prefix of the reason
// a Daml ManualReviewRequired carries), EXPECTED_REFUSALS in scripts/doctor.mjs
// (substrings of policy_events.error) and the tests under node/test that
// assert on error text. cover_not_begun follows a Daml assertMsg in
// PolicyToken.daml, which changes only with a new package;
// retroactive_cover_check_refused follows the dispatcher's own message in
// dispatch/dispatcher.js, which can change with no package, and doctor
// matches the same text. When such a text changes, change every match with
// it: an unmatched failure here silently becomes internal_or_ledger_error. A
// kind field on ManualReviewRequired (for example unroutedReason)
// would free only the debug classification from the text.
const FAILURE_REASONS = [
  {
    code: 'insurer_party_not_allocated',
    pattern: /^insurer has no allocated Canton party$/,
    message: 'The insurer has no ledger party yet; onboarding has not completed.',
  },
  {
    code: 'oracle_party_not_configured',
    pattern: /^no oracle operator party configured for insurer /,
    message: 'No oracle operator is configured for the insurer; the policy is not minted without one.',
  },
  {
    code: 'oracle_party_is_insurer',
    pattern: /^insurer \S+ \(policy \S+\) has its own Canton party as insurers\.oracle_operator_party /,
    message: 'The insurer is configured as its own oracle operator; the policy is not minted that way.',
  },
  {
    code: 'grace_period_not_configured',
    pattern: /^no grace period configured for policy /,
    message: 'No grace period is configured for the policy or the insurer.',
  },
  {
    code: 'grace_period_below_statutory_minimum',
    pattern: /^grace period of \d+ day\(s\) configured for policy \S+ is below the /,
    message: 'The configured grace period is shorter than the statutory notice period.',
  },
  {
    code: 'retroactive_cover_check_refused',
    pattern: /^m\. 1458 retroactive-cover check REFUSED the mint for policy /,
    message: 'The platform holds a reading that matches a payout tier inside the backdated cover window; the mint was refused.',
  },
  {
    code: 'retroactive_cover_check_no_cells',
    pattern: /^policy \S+ is backdated but names no cells, so the m\. 1458 check has nothing to search/,
    message: 'The policy is backdated but names no cells, so the retroactive-cover check cannot run.',
  },
  {
    code: 'cover_not_begun',
    pattern: /cover has not begun on this policy \(m\. 1421\)/,
    message: 'Cover has not begun on this policy: no first premium payment or agreed cover start is recorded.',
  },
  {
    code: 'mortgagee_continuation_not_configured',
    pattern: /^policy \S+ names a mortgagee but no continuation window is configured: /,
    message: 'The policy names a mortgagee but no mortgagee continuation window was configured for the insurer when the policy was activated.',
  },
  {
    code: 'first_premium_withdrawal_window_not_configured',
    pattern: /^no first-premium withdrawal window configured for policy /,
    message: 'No first-premium withdrawal window was configured for the insurer when the policy was activated.',
  },
];

const UNRECOGNISED = {
  code: 'internal_or_ledger_error',
  message: 'The request could not be completed. Quote the event id to the platform operator.',
};

export const FAILURE_CODES = [...FAILURE_REASONS.map((r) => r.code), UNRECOGNISED.code];

const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

function buildFailure(error) {
  const known = typeof error === 'string' ? FAILURE_REASONS.find((r) => r.pattern.test(error)) : undefined;
  const { code, message } = known ?? UNRECOGNISED;
  return { code, message };
}

function buildCoverage(coverageRow) {
  if (!Array.isArray(coverageRow.cell_ids)) {
    throw new Error(`coverage ${coverageRow.coverage_code} has cell_ids that are not an array`);
  }
  return {
    coverageCode: coverageRow.coverage_code,
    productCode: coverageRow.product_code,
    perilType: coverageRow.peril_type,
    sumInsured: coverageRow.sum_insured,
    remainingLimit: coverageRow.remaining_limit,
    cellIds: coverageRow.cell_ids.map(String),
  };
}

function buildEvent(eventRow) {
  if (!EVENT_STATUSES.has(eventRow.status)) {
    throw new Error(`event ${eventRow.id} has a status that is not published: ${eventRow.status}`);
  }
  return {
    eventId: eventRow.id,
    eventType: eventRow.event_type,
    status: eventRow.status,
    createdAt: iso(eventRow.created_at),
    processedAt: iso(eventRow.processed_at),
    failure: eventRow.status === 'failed' ? buildFailure(eventRow.error) : null,
  };
}

// eventsTruncated says the policy has more events than were read.
export function buildPolicyRecord(policyRow, coverageRows, eventRows, eventsTruncated) {
  return {
    policyId: policyRow.id,
    status: policyRow.status,
    defaultState: policyRow.default_state,
    // DATE columns arrive as 'YYYY-MM-DD' text (to_char in the route's
    // query), never as a JS Date: pg would build one at local midnight.
    startDate: policyRow.start_date,
    endDate: policyRow.end_date,
    // The term's instants, NULL until activated.
    termStart: iso(policyRow.term_start),
    expiry: iso(policyRow.expiry),
    coverageBegun: policyRow.coverage_began_at !== null && policyRow.coverage_began_at !== undefined,
    coverageBeganAt: iso(policyRow.coverage_began_at),
    onLedger: policyRow.daml_contract_id !== null && policyRow.daml_contract_id !== undefined,
    ledgerContractId: policyRow.daml_contract_id ?? null,
    // m. 1431(4): the route (ER_Takip | ER_Dava) of the policy's latest
    // recorded fruitless enforcement; null until one is recorded.
    enforcementRoute: policyRow.enforcement_route ?? null,
    coverages: coverageRows.map(buildCoverage),
    events: eventRows.map(buildEvent),
    eventsTruncated: eventsTruncated === true,
  };
}

// One item of GET /api/v1/policies, the list: the same whitelist, cut down
// for a list screen. A coverage leaves out its cell ids; the newest outbox row
// is built exactly as an event of the record above, or is null when the
// policy has none. currency is the policy's (policies.currency); a coverage
// row carries none of its own.
export function buildPolicySummary(policyRow, coverageRows, lastEventRow) {
  return {
    policyId: policyRow.id,
    status: policyRow.status,
    defaultState: policyRow.default_state,
    currency: policyRow.currency,
    startDate: policyRow.start_date,
    endDate: policyRow.end_date,
    coverageBegun: policyRow.coverage_began_at !== null && policyRow.coverage_began_at !== undefined,
    coverageBeganAt: iso(policyRow.coverage_began_at),
    coverages: coverageRows.map((coverageRow) => ({
      coverageCode: coverageRow.coverage_code,
      productCode: coverageRow.product_code,
      perilType: coverageRow.peril_type,
      sumInsured: coverageRow.sum_insured,
      remainingLimit: coverageRow.remaining_limit,
    })),
    lastEvent: lastEventRow === null ? null : buildEvent(lastEventRow),
  };
}
