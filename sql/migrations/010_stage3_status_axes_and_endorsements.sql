-- ============================================================================
-- Split the status axes (part A), then endorsements (part B).
--
-- PART A. `policy_status` carried two orthogonal facts at once: the
-- claim/term state (active, partially paid, ...) and the premium-default
-- state (grace period, suspended). A policy can legitimately be BOTH
-- partially paid AND in its grace period, which one column cannot express.
--
-- The consequence was a real defect, found in live verification of the
-- premium-default flow, not by reading the code: a payout during the grace period
-- re-minted with status = 'partially_paid', erasing 'grace_period'.
-- graceSweeper.js filtered on that same column, so it never saw the policy
-- again and never suspended it -- while the premium was still unpaid -- and
-- the notice index (keyed on the policy having no prior notice row) blocked
-- serving a second notice to recover.
--
-- Fixed by giving the default axis its own column rather than by
-- special-casing the trigger. The two now move independently: a payout
-- touches `status` only, and notice/suspension/reinstatement touch
-- `default_state` only.
--
-- 'grace_period' and 'suspended' are deliberately LEFT IN the policy_status
-- enum rather than dropped. Postgres cannot remove a value from an enum
-- type without recreating the type and rewriting every dependent column and
-- index, and policy_status_history is an append-only audit trail that
-- legitimately still contains those old values on rows written before this
-- migration. They are now unused by application code (dispatcher.js writes
-- neither) and must stay that way -- see sql/schema.sql's own comment.
--
-- PART B. Endorsements route through the existing 'endorsement' event_type,
-- which has existed unused since migration 003 and finally gets a handler
-- and an idempotency index here.
-- ============================================================================

CREATE TYPE default_state AS ENUM ('none', 'grace_period', 'suspended');

-- NOT NULL with a 'none' default is safe and correct here: every existing
-- policy row predates the premium-default flow having its own axis, and
-- 'none' ("no notice outstanding") is exactly true for all of them. This
-- is a structural default for a state machine's initial state, not a
-- statutory or business figure -- unlike grace_period_days, which
-- deliberately has no default anywhere.
ALTER TABLE policies ADD COLUMN default_state default_state NOT NULL DEFAULT 'none';

-- Carry over any policy currently sitting in one of the two old
-- packed-into-status states, so the split loses nothing. Their `status` is
-- then reset to the claim-axis value the coverage list implies -- which is
-- what `status` should have said all along on those rows.
UPDATE policies SET default_state = 'grace_period' WHERE status = 'grace_period';
UPDATE policies SET default_state = 'suspended'   WHERE status = 'suspended';
UPDATE policies SET status = CASE
    WHEN EXISTS (
      SELECT 1 FROM policy_coverages c
      WHERE c.policy_id = policies.id AND c.remaining_limit < c.sum_insured
    ) THEN 'partially_paid'::policy_status
    ELSE 'active'::policy_status
  END
  WHERE status IN ('grace_period', 'suspended');

CREATE INDEX idx_policies_default_state ON policies(default_state);

-- Part A (status axes): the notice idempotency key moves off "this policy has never had
-- a notice row" and onto the default state. A policy that was reinstated
-- (default_state back to 'none') must be able to receive a LATER notice --
-- the old UNIQUE(policy_no) WHERE event_type = 'notice' index made a second
-- default cycle impossible, which was flagged as a known limitation in
-- migration 009 and is fixed here.
--
-- What replaces it: a policy may have at most one notice/suspension/
-- reinstatement row that is not yet terminal. Once a row reaches
-- 'done'/'failed' the cycle is over and the next one may be queued. This
-- keeps the "don't queue the same action twice" guarantee that mattered
-- while dropping the "only ever once per policy" limitation that did not.
DROP INDEX idx_policy_events_notice_key;
DROP INDEX idx_policy_events_suspension_key;
DROP INDEX idx_policy_events_reinstatement_key;

CREATE UNIQUE INDEX idx_policy_events_notice_key
  ON policy_events (policy_no)
  WHERE event_type = 'notice' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_suspension_key
  ON policy_events (policy_no)
  WHERE event_type = 'suspension' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_reinstatement_key
  ON policy_events (policy_no)
  WHERE event_type = 'reinstatement' AND status IN ('pending', 'processing');

-- Part B (endorsements): same in-flight-only shape for endorsements. A policy is amended
-- many times over its life, so keying on (policy_no) alone would be wrong
-- from the start here.
CREATE UNIQUE INDEX idx_policy_events_endorsement_key
  ON policy_events (policy_no)
  WHERE event_type = 'endorsement' AND status IN ('pending', 'processing');

-- Part B (endorsements): mirrors the token's own amendmentReason, written by the
-- dispatcher's handleEndorsement write-back. NULL on a policy that has
-- never been endorsed. Reuses the endorsement_reason enum that has existed
-- since migration 002.
ALTER TABLE policies ADD COLUMN last_amendment_reason endorsement_reason;

-- policy_status_history only had old_status/new_status, which was complete
-- while `status` was the only axis. Now that notice/suspension/
-- reinstatement move `default_state` and leave `status` untouched, those
-- three events would record old_status = new_status and the actual change
-- would vanish from the audit trail entirely. These two columns give the
-- second axis the same treatment the first already had.
--
-- Nullable, unlike new_status: an event that moves only the claim axis
-- (activation, trigger, expiry) leaves both NULL rather than restating an
-- unchanged value, so a non-NULL pair here means "this event moved the
-- default axis" without needing to compare them.
ALTER TABLE policy_status_history ADD COLUMN old_default_state default_state;
ALTER TABLE policy_status_history ADD COLUMN new_default_state default_state;
