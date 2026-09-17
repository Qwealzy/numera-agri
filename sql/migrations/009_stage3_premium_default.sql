-- ============================================================================
-- Stage 3 Part 2: premium default, grace period, suspension, reinstatement.
--
-- Three distinct states, not two: 'grace_period' (notice served, coverage
-- continues in full) is a new status, added alongside the already-existing
-- 'suspended' (coverage stops -- this value has existed since migration 001
-- but was never actually produced by any code path until now; its old
-- inline comment describing it as "premium default grace period" was
-- always the wrong state for that description -- corrected below).
--
-- 'notice' has existed as an event_type since migration 003 but was never
-- wired to a handler -- no new enum value needed for it, only the wiring
-- (dispatch/dispatcher.js) and its own idempotency index (it never had one,
-- since migration 006 only added per-type indexes for activation/trigger/
-- settlement). 'suspension' (the grace-sweeper-produced event) and
-- 'reinstatement' (insurer-initiated) are genuinely new event types.
-- ============================================================================

ALTER TYPE policy_status ADD VALUE 'grace_period';

ALTER TYPE event_type ADD VALUE 'suspension';
ALTER TYPE event_type ADD VALUE 'reinstatement';

-- Change D: grace period is per-policy config, falling back to an
-- insurer-level default -- never a hardcoded number anywhere. Nullable on
-- both: a policy row may specify its own override at creation, and an
-- insurer may have no default at all, in which case dispatch/dispatcher.js's
-- handleActivation fails the activation loudly rather than guessing.
ALTER TABLE policies ADD COLUMN grace_period_days INTEGER;
ALTER TABLE insurers ADD COLUMN default_grace_period_days INTEGER;

-- Mirrors of the two notice fields Stage 3 Part 2 added to the Daml token
-- (PolicyToken.noticeServiceDate/noticeRecordedAt) -- same "SQL mirrors
-- what the ledger already holds, for querying without touching the ledger"
-- principle as policies.expiry (migration 008). The grace-period sweeper
-- needs notice_service_date directly in SQL to compute "has the grace
-- period elapsed" without ever calling the ledger.
ALTER TABLE policies ADD COLUMN notice_service_date TIMESTAMPTZ;
ALTER TABLE policies ADD COLUMN notice_recorded_at TIMESTAMPTZ;

-- Same (policy_no)-scoped shape as the expiry index (migration 008). NOTE
-- this means each of these can happen at most ONCE per policy, ever -- a
-- policy that is reinstated and then defaults a second time cannot have a
-- second notice served through the outbox. Correct for the single default
-- cycle this stage implements; revisit (adding a cycle number to the key)
-- if repeated default cycles are ever needed.
CREATE UNIQUE INDEX idx_policy_events_notice_key
  ON policy_events (policy_no)
  WHERE event_type = 'notice';

CREATE UNIQUE INDEX idx_policy_events_suspension_key
  ON policy_events (policy_no)
  WHERE event_type = 'suspension';

CREATE UNIQUE INDEX idx_policy_events_reinstatement_key
  ON policy_events (policy_no)
  WHERE event_type = 'reinstatement';
