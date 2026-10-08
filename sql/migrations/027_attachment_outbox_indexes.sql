-- ============================================================================
-- The in-flight-scoped unique indexes for m. 1457's two outbox types, and the
-- indexes over attached coverages and competing-claims review items.
--
-- SEPARATE FILE for the reason 021, 023 and 025 were: `ALTER TYPE ... ADD
-- VALUE` cannot be used in the same transaction that later reads the new
-- value, and migration 026 adds both. An earlier pair of migrations proved the rule also
-- applies WITHIN a file -- a partial index placed above its own ADD VALUE
-- fails on its own line -- so anything reading a new value goes after the
-- transaction that adds it, whether that means a later statement or a later
-- file.
-- ============================================================================

-- The coverages currently under attachment: attached, with no lifting after
-- it. A lifting OLDER than the attachment means it was re-imposed.
CREATE INDEX idx_policy_coverages_attached
  ON policy_coverages (policy_id, coverage_code)
  WHERE attached_at IS NOT NULL
    AND (attachment_lifted_at IS NULL OR attachment_lifted_at < attached_at);

-- The competing-claims review items -- the ones a human must work, because
-- nothing was routed on them at all.
CREATE INDEX idx_payout_events_competing_claims
  ON payout_events (policy_id, created_at)
  WHERE record_kind = 'unrouted_competing_claims' AND resolved_at IS NULL;

CREATE UNIQUE INDEX idx_policy_events_attachment_key
  ON policy_events (policy_no) WHERE event_type = 'attachment' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_attachment_lifted_key
  ON policy_events (policy_no) WHERE event_type = 'attachment_lifted' AND status IN ('pending', 'processing');
