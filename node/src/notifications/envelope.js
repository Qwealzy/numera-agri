// The webhook body. The thin envelope, and nothing else
// (a design rule of the notification contract):
// which notification, what kind, which payout, when, and the envelope's own
// version. Amount, recipient role, the insurer's customer reference, coverage
// and every other detail are fetched from the API-key-authenticated GET.
//
// Built from an explicit whitelist of the queue row's own columns. No other
// column is read and nothing is joined, so a column added to the row -- or
// handed in by a caller -- cannot reach the wire by accident.
//
// Returns the serialized body. It is serialized here, once, and the sender
// signs and sends these exact bytes: a second JSON.stringify elsewhere could
// order or format differently from what was signed.

const TYPES = {
  payout_approved: 'payout.approved',
  review_required: 'payout.review_required',
};

export function buildEnvelope(notificationRow) {
  const type = TYPES[notificationRow.kind];
  if (!type) throw new Error(`unknown notification kind: ${notificationRow.kind}`);
  return JSON.stringify({
    id: notificationRow.id,
    type,
    payoutId: notificationRow.payout_event_id,
    createdAt: new Date(notificationRow.created_at).toISOString(),
    apiVersion: 1,
  });
}
