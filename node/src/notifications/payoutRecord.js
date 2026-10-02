// Stage 2 Part 3: the payout record the insurer reads from the two GET
// endpoints (routes/policies.js). The webhook carries only the thin envelope
// (envelope.js); everything else about a payout is this record, fetched with
// the insurer's own API key (a design rule of the notification
// contract).
//
// Pure, and built from an explicit whitelist: each output field names the one
// input column it reads. A column added to the query -- or handed in by a
// caller -- cannot reach the wire by accident. Deliberately NOT read, whatever
// the row carries: bank_reference, resolution_note and unpaid_reason (free
// text, or the insurer's own banking reference), review_contract_id, every
// party id, insurer_id, and a notification's last_error.
//
// customerRef is the external_ref of the policy's policyholder AS OF THE READ,
// not as of the approval: after a m. 1431(4) substitution policies.policyholder_id
// names the new person, so a payout approved before it reads back with the new
// person's reference.
//
// NUMERIC columns stay the text pg hands over. They are never passed through
// Number(): a float cannot hold every NUMERIC(14,2) exactly.

// The values routes and the ledger write today. The payout_event_status enum
// also still holds the dead eft_* values (sql/schema.sql); nothing writes
// them, and a row carrying one is refused here rather than published.
const STATUSES = new Set(['approved', 'manual_review', 'settled', 'closed_unpaid']);

// The same wire names envelope.js gives the webhook's `type`, so a
// notification listed here matches the envelope the insurer received.
const NOTIFICATION_TYPES = {
  payout_approved: 'payout.approved',
  review_required: 'payout.review_required',
};

const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

function buildNotification(notificationRow) {
  const type = NOTIFICATION_TYPES[notificationRow.kind];
  if (!type) throw new Error(`unknown notification kind: ${notificationRow.kind}`);
  return {
    id: notificationRow.id,
    type,
    status: notificationRow.status,
    deliveredAt: iso(notificationRow.delivered_at),
  };
}

export function buildRecord(payoutRow, notificationRows) {
  if (!STATUSES.has(payoutRow.status)) {
    throw new Error(`payout ${payoutRow.id} has a status that is not published: ${payoutRow.status}`);
  }
  return {
    payoutId: payoutRow.id,
    policyId: payoutRow.policy_id,
    customerRef: payoutRow.customer_ref,
    coverageCode: payoutRow.coverage_code,
    // NULL when the coverage has since been removed by an endorsement: the
    // payout row outlives the policy_coverages row it was read from.
    productCode: payoutRow.product_code ?? null,
    perilType: payoutRow.peril_type ?? null,
    tierLabel: payoutRow.tier_label ?? null,
    payoutPercentage: payoutRow.payout_percentage,
    amount: payoutRow.payout_amount,
    currency: payoutRow.currency,
    recipientRole: payoutRow.recipient ?? null,
    recordKind: payoutRow.record_kind,
    isFullSettlement: payoutRow.is_full_settlement,
    status: payoutRow.status,
    // NULL on a row written before migration 035; never backfilled.
    approvedAt: iso(payoutRow.approved_at),
    createdAt: iso(payoutRow.created_at),
    settledAt: iso(payoutRow.settled_at),
    resolvedAt: iso(payoutRow.resolved_at),
    triggerWindowId: payoutRow.trigger_window_id ?? null,
    ledgerContractId: payoutRow.daml_contract_id ?? null,
    // v22 (migration 036). The event the payout was approved for and the
    // evidence digest, as the trigger sent them to the ledger; the insurer's
    // declared closing instant on a close-unpaid; and the PayoutSettled or
    // PayoutClosedUnpaid the resolution left on the ledger. NULL on a row
    // written before v22, and the last two until the payout is resolved.
    eventStart: iso(payoutRow.event_start),
    eventEnd: iso(payoutRow.event_end),
    evidenceDigest: payoutRow.evidence_digest ?? null,
    closedAt: iso(payoutRow.closed_at),
    resolutionRecordContractId: payoutRow.resolution_record_contract_id ?? null,
    notifications: notificationRows.map(buildNotification),
  };
}
