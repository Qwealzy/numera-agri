// Stage 2 Part 1: the one place a payout notification is queued.
//
// It takes the caller's client rather than the pool, so it joins the caller's
// transaction. handleTrigger's write-back queues the notification in the same
// transaction as the payout_events INSERT it belongs to: a payout that is
// recorded and a notification that is owed commit together or not at all.
//
// It sends nothing, and it stores no payload. The row points at the payout;
// the sender builds the envelope from immutable fields at delivery time
// (the design rule that the
// webhook carries a thin envelope only, everything else moves to an
// API-key-authenticated GET).
//
// ON CONFLICT is the idempotency guarantee. Both producers -- this write-back
// and payoutListener's defensive insert -- may reach the same payout, and the
// second must not queue a second notification for it.
export async function enqueuePayoutNotification(client, { payoutEventId, insurerId, kind }) {
  await client.query(
    `INSERT INTO payout_notifications (payout_event_id, insurer_id, kind)
     VALUES ($1,$2,$3)
     ON CONFLICT (payout_event_id, kind) DO NOTHING`,
    [payoutEventId, insurerId, kind]
  );
}
