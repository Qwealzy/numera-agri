-- ============================================================================
-- Stage 3 Part 1: expiry sweep.
--
-- The sweeper needs to query "expiry in the past, still open" directly in
-- SQL, but `policies` only ever stored start_date/end_date (bare calendar
-- dates) -- the actual absolute expiry instant (noon local time,
-- Europe/Istanbul, the market convention already applied once at mint time
-- in dispatcher.js's handleActivation) was computed for the mint payload
-- and then discarded, never persisted. Mirrored into SQL here the same way
-- current_version already mirrors the ledger's own `version` field -- the
-- ledger stays the source of truth for expiry; this column exists purely
-- so the sweeper can query without recomputing the noon-Istanbul
-- conversion a second time in SQL (which would risk the two disagreeing).
-- Written once, at activation, alongside current_version/daml_contract_id;
-- never modified afterward in this stage (no Amend/renewal yet).
--
-- 'expiry' is a new outbox event_type, keyed like 'activation' on
-- (policy_no) via a partial unique index -- a policy expires once. Per
-- migration 006's own precedent, ALTER TYPE ... ADD VALUE and the index
-- referencing that new value are safe in the same file because psql runs
-- each top-level statement as its own auto-committed transaction, not one
-- shared transaction, when invoked without explicit BEGIN/COMMIT.
-- ============================================================================

ALTER TABLE policies ADD COLUMN expiry TIMESTAMPTZ;

CREATE INDEX idx_policies_expiry_open ON policies(expiry) WHERE status IN ('active', 'partially_paid');

ALTER TYPE event_type ADD VALUE 'expiry';

CREATE UNIQUE INDEX idx_policy_events_expiry_key
  ON policy_events (policy_no)
  WHERE event_type = 'expiry';
