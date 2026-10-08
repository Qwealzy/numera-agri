-- ============================================================================
-- Payout routing between the mortgagee and the insured (TTK 6102 m. 1456).
--
-- m. 1456(1): "Sınırlı ayni hak ile takyit edilmiş bir mal üzerindeki, malike
-- ait menfaat sigortalandığı takdirde ... sınırlı ayni hak sahibinin hakkı
-- sigorta tazminatı üzerinde de devam eder." The real right CONTINUES over
-- the indemnity as substitute object -- so a payout from the coverage the
-- charge sits on is owed to the bank, up to its remaining claim. m. 1486(2)
-- lists m. 1456(1), so a contract term contrary to it is void.
--
-- Each recipient gets its OWN PayoutApproved and therefore its own row here.
-- m. 1427 runs maturity and default per claim: paying the bank does not
-- discharge what is owed to the insured, and the system has to be able to say
-- "the bank settled today, the insured could not be reached".
--
-- WHAT IS NOT ROUTED. m. 1456(2) is a flat prohibition -- "ayni hak
-- sahiplerinin izni bulunmadıkça, sigortacı sigorta tazminatını sigortalıya
-- ödeyemez" -- and its only carve-out is repair or restoration against
-- security, not a surplus above the secured claim. Whether the excess may be
-- paid to the sigortalı without izin is unsettled on the text, and m. 1456(3)
-- leaves an insurer that gets it wrong liable to the real-right holder. So
-- the excess is RECORDED and left to a human; it is never routed
-- automatically. Encoding it either way would be making a legal choice.
-- ============================================================================

-- Which recipient this row is owed to, mirroring PayoutApproved.recipient.
-- NULL on an unrouted remainder -- that is the whole point of it: nobody has
-- decided who it goes to.
ALTER TABLE payout_events ADD COLUMN recipient TEXT;
ALTER TABLE payout_events ADD CONSTRAINT payout_events_recipient_known
  CHECK (recipient IS NULL
         OR recipient IN ('PDR_Insured', 'PDR_Mortgagee', 'PDR_Beneficiary'));

-- Two kinds of row now live here:
--
--   payout              a PayoutApproved exists on the ledger and someone is
--                       owed this amount.
--   unrouted_remainder  the part of an indemnity on a charged coverage that
--                       exceeds the remaining secured claim. NO PayoutApproved
--                       exists for it. A ManualReviewRequired does, and a
--                       human decides.
--
-- They share this table deliberately: a remainder resolves through exactly
-- the same ManualReviewRequired_Resolve* paths as a failed payout, so it
-- inherits close-unpaid and resolve-settled unchanged rather than needing a
-- second queue and a second set of endpoints.
ALTER TABLE payout_events ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'payout';
ALTER TABLE payout_events ADD CONSTRAINT payout_events_record_kind_known
  CHECK (record_kind IN ('payout', 'unrouted_remainder'));

-- A remainder has no PayoutApproved to point at, so the column that has been
-- NOT NULL from the start has to admit NULL for exactly that case -- and only
-- that case. UNIQUE still holds: Postgres permits many NULLs in a unique
-- index, and every real payout still gets exactly one row.
ALTER TABLE payout_events ALTER COLUMN daml_contract_id DROP NOT NULL;
ALTER TABLE payout_events ADD CONSTRAINT payout_events_contract_id_matches_kind
  CHECK ((record_kind = 'payout') = (daml_contract_id IS NOT NULL));

-- A remainder is a review item from the moment it exists -- it is never
-- 'approved', because nothing approved paying it to anyone.
ALTER TABLE payout_events ADD CONSTRAINT payout_events_remainder_needs_review
  CHECK (record_kind = 'payout'
         OR (review_contract_id IS NOT NULL AND recipient IS NULL));

-- The unrouted remainders, findable. This is a queue a human has to work,
-- and m. 1456(3) makes leaving one unattended the insurer's exposure rather
-- than a tidiness problem.
CREATE INDEX idx_payout_events_unrouted
  ON payout_events (policy_id, created_at)
  WHERE record_kind = 'unrouted_remainder' AND resolved_at IS NULL;

-- The mortgagee's remaining claim now DECREMENTS as payouts are routed to it,
-- the way remaining_limit already does. Mirrors Coverage.mortgageeClaimAmount
-- on the token.
--
-- It falls to 0, never back to NULL: "charged and exhausted" and "never
-- charged" are different facts that route differently. A coverage that never
-- had a charge pays the insured as it always did; one whose claim is spent
-- sends the whole payout to review, because the alternative would let the
-- ORDER of payouts decide what the arithmetic was not allowed to.
-- The existing constraint demanded a STRICTLY positive claim, which was right
-- while the value never moved and is wrong now that it does: a claim routed
-- down to nothing has to be recordable as 0. Replaced rather than
-- supplemented, because two CHECKs on one column disagreeing is how a table
-- ends up with a rule nobody can find.
ALTER TABLE policy_coverages DROP CONSTRAINT policy_coverages_claim_needs_mortgagee;
ALTER TABLE policy_coverages ADD CONSTRAINT policy_coverages_claim_needs_mortgagee
  CHECK (mortgagee_claim_amount IS NULL OR mortgagee_claim_amount >= 0);
