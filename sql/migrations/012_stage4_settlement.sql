-- ============================================================================
-- Closing the payout loop.
--
-- Until now every trigger produced a PayoutApproved, the dispatcher
-- unconditionally exercised PayoutApproved_MarkFailed on it (there was no
-- settlement path), and the resulting ManualReviewRequired had no exit at
-- all. The queue only grew. This migration adds the columns that record
-- how a payout actually ends.
--
-- THE PLATFORM STILL NEVER MOVES MONEY. Nothing here is an account number,
-- a payment instruction, or a banking credential. `bank_reference` is an
-- opaque string the insurer reports AFTER settling through its own systems
-- -- evidence that it says it paid, not a means of paying. No IBAN column
-- is reintroduced, and none may be.
--
-- `payout_amount` remains the GROSS indemnity. Any set-off of outstanding
-- premium against it is the insurer's own arithmetic, off-system, and is
-- deliberately not recorded (TTK 6102 m. 1431(5)).
-- ============================================================================

-- Two terminal states. The 'eft_*' values below them are dead: they were
-- named for an Open Banking bridge that was removed early on and
-- is not coming back. They stay in the enum only because Postgres cannot
-- drop an enum value without recreating the type and every dependent
-- object -- the same reason 'grace_period'/'suspended' still sit in
-- policy_status. Do not write them.
ALTER TYPE payout_event_status ADD VALUE 'settled';
ALTER TYPE payout_event_status ADD VALUE 'closed_unpaid';

-- Settlement evidence, as reported by the insurer. Written on the normal
-- path (PayoutApproved_ConfirmSettlement) and on the review item's settled
-- exit (ManualReviewRequired_ResolveSettled) alike -- deliberately the same
-- columns, because it is the same evidence from a different starting
-- contract.
--
-- settled_at is the insurer's REPORTED settlement date, an external fact
-- like notice_service_date. It is never a system clock reading: the
-- platform cannot observe when a transfer landed, only when it was told.
ALTER TABLE payout_events ADD COLUMN bank_reference TEXT;
ALTER TABLE payout_events ADD COLUMN settled_at     TIMESTAMPTZ;
ALTER TABLE payout_events ADD COLUMN paid_role      TEXT;

-- Unpaid-outcome evidence. Enumerated reason plus a mandatory free-text
-- note -- the enum is queryable, the note carries the circumstances the
-- enum flattens. Recording an outcome is not a legal conclusion that the
-- indemnity was extinguished; it records what the insurer asserted.
ALTER TABLE payout_events ADD COLUMN unpaid_reason   TEXT;
ALTER TABLE payout_events ADD COLUMN resolution_note TEXT;

-- The supersession link, recorded the same way every other
-- archive-and-recreate in this system is. `daml_contract_id` keeps pointing
-- at the PayoutApproved that started the chain; when MarkFailed archives it
-- and creates a review item, that item's contract id lands here rather than
-- overwriting the original -- otherwise the link back to the payout is lost,
-- which is exactly the ambiguity the review item's sourcePayoutContractId
-- fixes on the ledger side.
ALTER TABLE payout_events ADD COLUMN review_contract_id TEXT;

-- The clock. created_at already records when the PayoutApproved
-- was created; this records when it reached a terminal state. Elapsed time
-- is derived from the pair at read time and never stored.
--
-- Deliberately NOT recorded anywhere: default interest, statutory
-- deadlines, or any conclusion about lateness. The system records
-- timestamps; interpreting them is a lawyer's job, not the schema's.
ALTER TABLE payout_events ADD COLUMN resolved_at TIMESTAMPTZ;

CREATE INDEX idx_payout_events_unresolved
  ON payout_events (created_at) WHERE resolved_at IS NULL;

-- Re-scope the settlement idempotency key to IN-FLIGHT rows only, matching
-- what migration 010 did for notice/suspension/reinstatement/endorsement.
-- It was left unscoped, which was harmless while settlement was a single
-- automatic step, and is not now that the insurer reports outcomes by hand:
-- a rejected report (a mistyped paidRole, say) consumed the payout's one
-- and only settlement slot forever, leaving it permanently unreportable.
-- Found in live verification, not by reading.
--
-- The guarantee that actually matters -- never two concurrent reports on
-- one contract -- is unchanged. "A payout ends once" is enforced separately
-- and more directly by handleSettlement's own resolved_at check and by the
-- ledger, where a settled PayoutApproved is archived and cannot be
-- exercised again.
DROP INDEX idx_policy_events_settlement_key;
CREATE UNIQUE INDEX idx_policy_events_settlement_key
  ON policy_events (source_contract_id)
  WHERE event_type = 'settlement' AND status IN ('pending', 'processing');
