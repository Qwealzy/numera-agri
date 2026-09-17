-- ============================================================================
-- The in-flight-scoped unique indexes for m. 1434(4)'s two outbox types.
--
-- SEPARATE FILE for the same reason 021 and 023 were: `ALTER TYPE ... ADD
-- VALUE` cannot be used in the same transaction that later reads the new
-- value, and migration 024 adds four of them.
--
-- Scoped to pending/processing, the shape migration 010 established: a
-- failed election may legitimately be retried later, but two of the same act
-- in flight at once for one policy is a double-submission.
-- ============================================================================

-- The pending elections, for the sweeper. A state test: the effect lands when
-- the frozen instant has passed, and the instant itself is never a clock
-- reading. It lives here rather than in 024 for the same reason as the two
-- below -- it READS a default_state value that 024 adds.
CREATE INDEX idx_policies_two_notice_pending
  ON policies (two_notice_effective_at)
  WHERE default_state = 'two_notice_elected';

CREATE UNIQUE INDEX idx_policy_events_two_notice_election_key
  ON policy_events (policy_no) WHERE event_type = 'two_notice_election' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_two_notice_termination_key
  ON policy_events (policy_no) WHERE event_type = 'two_notice_termination' AND status IN ('pending', 'processing');
