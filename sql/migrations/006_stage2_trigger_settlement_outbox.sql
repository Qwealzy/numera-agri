-- ============================================================================
-- oracleBot.js and payoutListener.js move onto the outbox
-- instead of calling exerciseChoice directly. Two new event types need
-- idempotency keys the existing (policy_no, event_type, expected_version)
-- triple cannot express -- a (policy_no, expected_version) pair is not
-- unique to one reading (two different readings can legitimately share
-- it), and settlement isn't about a policy version at all, it's about one
-- specific PayoutApproved contract. Left unscoped, the old constraint
-- would also have silently blocked the second of two legitimate
-- same-version readings -- replaced with three event-type-scoped partial
-- indexes rather than adding new columns alongside the old one.
--
-- Confirmed against the live database before writing this: no existing
-- policy_events row violates any of the three new partial indexes.
-- ============================================================================

ALTER TYPE event_type ADD VALUE 'trigger';
ALTER TYPE event_type ADD VALUE 'settlement';

-- Idempotency key for 'trigger': the reading that produced it. The same
-- reading must never produce two payouts; two different readings on the
-- same policy version legitimately can each produce their own row.
ALTER TABLE policy_events ADD COLUMN reading_id UUID REFERENCES oracle_readings(id);

-- Idempotency key for 'settlement': the PayoutApproved contract id it
-- processes.
ALTER TABLE policy_events ADD COLUMN source_contract_id TEXT;

-- 'settlement' rows exercise PayoutApproved, not PolicyToken -- there is
-- no policy version for them to carry. Always NULL for that event type;
-- unchanged (still required) for every other type.
ALTER TABLE policy_events ALTER COLUMN expected_version DROP NOT NULL;

ALTER TABLE policy_events DROP CONSTRAINT policy_events_policy_no_event_type_expected_version_key;

CREATE UNIQUE INDEX idx_policy_events_activation_key
  ON policy_events (policy_no, expected_version)
  WHERE event_type = 'activation';

CREATE UNIQUE INDEX idx_policy_events_trigger_key
  ON policy_events (reading_id)
  WHERE event_type = 'trigger';

CREATE UNIQUE INDEX idx_policy_events_settlement_key
  ON policy_events (source_contract_id)
  WHERE event_type = 'settlement';
