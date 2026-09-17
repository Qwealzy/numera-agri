-- ============================================================================
-- Stage 1 -- shared lifecycle status vocabulary.
--
-- Replaces policy_status's old ad-hoc labels with the vocabulary now shared
-- with Daml's PolicyStatus (daml/daml/Insurance/Types.daml): active,
-- suspended, partially_paid, expired, cancelled, claimed_and_closed,
-- manual_review -- plus 'pending_mint', which stays SQL-only because there
-- is no token yet at that point for Daml to have an opinion about.
--
-- Mapping from the old values: LAPSED (burned for non-payment) -> cancelled;
-- SETTLED (burned, remaining limit exhausted by payout) ->
-- claimed_and_closed. Every other old value renames 1:1 to its lowercase
-- equivalent.
-- ============================================================================

CREATE TYPE policy_status_new AS ENUM (
  'pending_mint',
  'active',
  'suspended',
  'partially_paid',
  'expired',
  'cancelled',
  'claimed_and_closed',
  'manual_review'
);

ALTER TABLE policies ALTER COLUMN status DROP DEFAULT;

ALTER TABLE policies
  ALTER COLUMN status TYPE policy_status_new USING (
    CASE status::text
      WHEN 'PENDING_MINT'   THEN 'pending_mint'
      WHEN 'ACTIVE'         THEN 'active'
      WHEN 'SUSPENDED'      THEN 'suspended'
      WHEN 'PARTIALLY_PAID' THEN 'partially_paid'
      WHEN 'EXPIRED'        THEN 'expired'
      WHEN 'LAPSED'         THEN 'cancelled'
      WHEN 'SETTLED'        THEN 'claimed_and_closed'
    END
  )::policy_status_new;

ALTER TABLE policies ALTER COLUMN status SET DEFAULT 'pending_mint';

ALTER TABLE policy_status_history
  ALTER COLUMN old_status TYPE policy_status_new USING (
    CASE old_status::text
      WHEN 'PENDING_MINT'   THEN 'pending_mint'
      WHEN 'ACTIVE'         THEN 'active'
      WHEN 'SUSPENDED'      THEN 'suspended'
      WHEN 'PARTIALLY_PAID' THEN 'partially_paid'
      WHEN 'EXPIRED'        THEN 'expired'
      WHEN 'LAPSED'         THEN 'cancelled'
      WHEN 'SETTLED'        THEN 'claimed_and_closed'
      ELSE NULL
    END
  )::policy_status_new;

ALTER TABLE policy_status_history
  ALTER COLUMN new_status TYPE policy_status_new USING (
    CASE new_status::text
      WHEN 'PENDING_MINT'   THEN 'pending_mint'
      WHEN 'ACTIVE'         THEN 'active'
      WHEN 'SUSPENDED'      THEN 'suspended'
      WHEN 'PARTIALLY_PAID' THEN 'partially_paid'
      WHEN 'EXPIRED'        THEN 'expired'
      WHEN 'LAPSED'         THEN 'cancelled'
      WHEN 'SETTLED'        THEN 'claimed_and_closed'
    END
  )::policy_status_new;

DROP TYPE policy_status;
ALTER TYPE policy_status_new RENAME TO policy_status;
