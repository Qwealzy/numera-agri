-- ============================================================================
-- The in-flight-scoped unique indexes for m. 1456(6)'s two outbox types.
--
-- SEPARATE FILE for the same reason 021 was: `ALTER TYPE ... ADD VALUE`
-- cannot be used in the same transaction that later reads the new value, and
-- migration 022 adds both.
--
-- Scoped to pending/processing: a mortgagee may ask again after being
-- answered -- there is no limit in m. 1456(6) and none is invented here -- but
-- two of the same act in flight at once for one policy is a double-submission.
-- ============================================================================

CREATE UNIQUE INDEX idx_policy_events_mortgagee_info_request_key
  ON policy_events (policy_no) WHERE event_type = 'mortgagee_info_request' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_mortgagee_info_provided_key
  ON policy_events (policy_no) WHERE event_type = 'mortgagee_info_provided' AND status IN ('pending', 'processing');
