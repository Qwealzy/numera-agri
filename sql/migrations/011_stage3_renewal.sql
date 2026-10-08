-- ============================================================================
-- Renewal (tecditname) -- the last lifecycle mechanism.
--
-- A renewal is NOT an endorsement. An endorsement archives and re-mints the
-- SAME policy at version + 1; a renewal opens a NEW risk period as a NEW
-- policy row with a NEW policyNo, and deliberately leaves the predecessor
-- alone to run to its own term end. Both are live at once during the
-- overlap, which is correct and must not be treated as an error anywhere.
--
-- Two columns, not one, because the chain has to be navigable in both
-- directions without walking the ledger:
--   successor.predecessor_policy_id -> the policy it renews
--   predecessor.renewed_by_policy_id -> the policy that renewed it
-- The second is also the "already renewed" guard: a period is succeeded
-- exactly once, and since the renewal never modifies the predecessor
-- token, SQL is the only place that fact can live (see the note in
-- dispatcher.js's handleRenewal for why the ledger cannot hold it).
--
-- Both are nullable and self-referential; neither cascades. A policy with
-- both set is a middle link in a renewal chain, which is the normal steady
-- state for a long-running customer.
-- ============================================================================

ALTER TABLE policies ADD COLUMN predecessor_policy_id UUID REFERENCES policies(id);
ALTER TABLE policies ADD COLUMN renewed_by_policy_id  UUID REFERENCES policies(id);

-- A given policy may be succeeded by at most one other. Enforced in the
-- table rather than only by handleRenewal's check, so a second renewal can
-- never be written even if two dispatchers somehow raced past the advisory
-- lock. Partial, because NULL (not yet renewed) is the common case and
-- must not collide with itself.
CREATE UNIQUE INDEX idx_policies_renewed_by_unique
  ON policies (renewed_by_policy_id) WHERE renewed_by_policy_id IS NOT NULL;

CREATE INDEX idx_policies_predecessor ON policies(predecessor_policy_id);

-- Same in-flight-only shape as every other lifecycle event type since
-- migration 010: at most one renewal queued per predecessor policy at a
-- time, rather than at most one ever. "Succeeded exactly once" is the
-- renewed_by_policy_id guard's job, not this index's -- keeping them
-- separate is what lets a renewal that FAILED (rejected while in default,
-- say) be corrected and retried once the default is cleared, instead of
-- permanently burning the policy's one renewal slot on a rejected attempt.
--
-- Note the key is the PREDECESSOR's policy id: a renewal event is an act
-- on the policy being renewed, which is also why handleRenewal takes the
-- advisory lock on that id (so a renewal cannot race a notice,
-- endorsement, or trigger on the same policy).
CREATE UNIQUE INDEX idx_policy_events_renewal_key
  ON policy_events (policy_no)
  WHERE event_type = 'renewal' AND status IN ('pending', 'processing');
