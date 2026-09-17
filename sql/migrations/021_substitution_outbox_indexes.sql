-- ============================================================================
-- The in-flight-scoped unique indexes for m. 1431(4)'s three outbox types.
--
-- SEPARATE FILE, and it has to be: `ALTER TYPE ... ADD VALUE` cannot be used
-- in the same transaction that later reads the new value, and migration 020
-- adds all three. The same reason 008 and 009 are split from 006 -- see
-- 008's own header, which is where this was first written down.
--
-- Scoped to pending/processing rather than to the whole table (the shape
-- migration 010 established): a second act of the same kind is legitimate
-- later -- a substitution attempt that failed can be retried -- but two
-- in flight at once for the same policy is a double-submission.
-- ============================================================================

CREATE UNIQUE INDEX idx_policy_events_enforcement_fruitless_key
  ON policy_events (policy_no) WHERE event_type = 'enforcement_fruitless' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_substitution_notice_key
  ON policy_events (policy_no) WHERE event_type = 'substitution_notice' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_substitution_key
  ON policy_events (policy_no) WHERE event_type = 'substitution' AND status IN ('pending', 'processing');
