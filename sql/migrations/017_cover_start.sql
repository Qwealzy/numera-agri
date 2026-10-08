-- ============================================================================
-- Cover start (TTK 6102 m. 1421), and two intake gaps that needed no package.
--
-- m. 1421(1): "Aksine sözleşme yoksa, sigortacının sorumluluğu primin veya ilk
-- taksidinin ödenmesi ile başlar." Unless otherwise agreed, the insurer's
-- liability begins WITH PAYMENT of the premium or its first instalment.
--
-- **Minting no longer means the policy is live.** It means the contract
-- exists. That is a change to the original design's assumption, and it is what
-- this migration records. Until now the platform would evaluate and pay a
-- claim on a policy whose premium was never paid and whose cover, by default,
-- never began.
--
-- Two articles independently presuppose the interval this creates, so it is
-- not an edge case: m. 1422 (the insurer earns NO premium where the risk
-- became impossible before liability began) and m. 1430(3) (the sigorta
-- ettiren may withdraw before liability begins, against half the premium).
-- Neither would mean anything if the contract were not already in existence
-- with cover not yet running.
-- ============================================================================

-- The missing partner to the coverage END the schema has always carried.
-- NULL means cover has not begun.
--
-- Deliberately a TIMESTAMP and not a new state on default_state or
-- policy_status: a state would be fully derivable from this column, giving
-- two sources of truth that can disagree.
--
-- Never inferred. The platform cannot observe a payment any more than it can
-- observe an ihtar being served: no timer, no default, no "assume paid after
-- N days". There is no configured period here at all -- m. 1421 states none,
-- and m. 1424's 24-hour/15-day policy-delivery deadline is a different
-- obligation that this migration does not implement. The only guard the text
-- supports is DIRECTIONAL, not temporal (see below).
ALTER TABLE policies ADD COLUMN coverage_began_at TIMESTAMPTZ;

-- WHY it began. m. 1421 makes payment the default trigger but expressly
-- allows "aksine sözleşme", and m. 1452(3) lists 1421 -- so it may be varied
-- only in the insured's FAVOUR: cover may be agreed to start earlier than
-- payment, never later. Recorded because m. 1422 and m. 1430(3) both turn on
-- whether liability had begun, and telling an agreed early start from a
-- payment is what lets a later reading apply them.
ALTER TABLE policies ADD COLUMN coverage_start_basis TEXT;

-- The insurer's REPORTED first-premium receipt date. Its own column because
-- it is a distinct fact from the instant cover began: where cover was agreed
-- to start earlier, the payment date is recorded but does not move the start.
--
-- Fixes a defect introduced in v14: PolicyToken_RecordFirstPremiumPaid took a
-- `paidAt` argument, discarded it without assigning it to any field, and the
-- dispatcher supplied a clock reading rather than a reported date. Harmless
-- while nothing depended on it; not harmless once it determines when the
-- insurer's liability begins.
ALTER TABLE policies ADD COLUMN first_premium_paid_at TIMESTAMPTZ;

-- Mirrors the token's ensure clauses.
ALTER TABLE policies ADD CONSTRAINT policies_cover_start_facts_together
  CHECK ((coverage_began_at IS NULL) = (coverage_start_basis IS NULL));
ALTER TABLE policies ADD CONSTRAINT policies_cover_start_basis_known
  CHECK (coverage_start_basis IS NULL
         OR coverage_start_basis IN ('CSB_PremiumPaid', 'CSB_AgreedWithoutPayment'));

-- ----------------------------------------------------------------------------
-- Two intake gaps. NEITHER needed a package change -- `insured : Party` and
-- `documentHash : Optional Text` have been on PolicyToken for a long time,
-- exactly as `mortgagee` and `beneficiary` were before v13. Only the
-- intake path was missing.
-- ----------------------------------------------------------------------------

-- The sigortalı as a party distinct from the sigorta ettiren. dispatcher.js
-- has hard-coded insured = policyholder from the start, so the distinct party
-- could not exist. Resolved through the same registry as every other role,
-- so one person holding two roles is still one party.
--
-- A PRECONDITION for m. 1454 (insurance for another's account) and m. 1431(4)
-- (the sigortalı taking over the premium where enforcement against the
-- sigorta ettiren proves fruitless). NEITHER is implemented here: this is
-- intake only, and no behaviour that depends on the distinction changes.
ALTER TABLE policies ADD COLUMN insured_policyholder_id UUID REFERENCES policyholders(id);

-- The hash of the policy document. Declared on the token from the start and
-- never set by anything. Optional, and the hash only -- the document itself
-- never reaches this platform.
ALTER TABLE policies ADD COLUMN document_hash TEXT;
ALTER TABLE policies ADD CONSTRAINT policies_document_hash_not_empty
  CHECK (document_hash IS NULL OR document_hash <> '');

-- Policies whose cover never began and about which nothing has been
-- reported. They cannot be swept -- the text gives no basis to end a contract
-- merely because cover has not started, and inventing a period is forbidden.
-- Surfaced as inert instead (/debug/contracts), the way the renewal gap is:
-- visible, flagged, not acted on.
CREATE INDEX idx_policies_cover_not_begun
  ON policies (created_at)
  WHERE coverage_began_at IS NULL AND status NOT IN ('expired', 'cancelled', 'claimed_and_closed');
