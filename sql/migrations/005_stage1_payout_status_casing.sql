-- ============================================================================
-- Stage 1 cleanup: payout_event_status moves to the same lowercase-with-
-- underscores convention policy_status already uses. Values and their
-- meanings are unchanged -- this is a spelling migration only.
--
-- payout_events held 0 rows when this was written, so the USING mapping
-- below has nothing to convert on this database -- it is still written as
-- a real mapping (not a bare cast) so this migration is correct on any
-- database that does have rows.
-- ============================================================================

CREATE TYPE payout_event_status_new AS ENUM (
  'approved',
  'eft_pending',
  'eft_sent',
  'eft_confirmed',
  'eft_failed',
  'manual_review'
);

ALTER TABLE payout_events ALTER COLUMN status DROP DEFAULT;

ALTER TABLE payout_events
  ALTER COLUMN status TYPE payout_event_status_new USING (
    CASE status::text
      WHEN 'APPROVED'      THEN 'approved'
      WHEN 'EFT_PENDING'   THEN 'eft_pending'
      WHEN 'EFT_SENT'      THEN 'eft_sent'
      WHEN 'EFT_CONFIRMED' THEN 'eft_confirmed'
      WHEN 'EFT_FAILED'    THEN 'eft_failed'
      WHEN 'MANUAL_REVIEW' THEN 'manual_review'
    END
  )::payout_event_status_new;

ALTER TABLE payout_events ALTER COLUMN status SET DEFAULT 'approved';

DROP TYPE payout_event_status;
ALTER TYPE payout_event_status_new RENAME TO payout_event_status;
