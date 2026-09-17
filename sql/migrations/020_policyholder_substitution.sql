-- ============================================================================
-- Policyholder substitution (TTK 6102 m. 1431(4)).
--
-- "Başkası lehine yapılan sigortada, prim borcu için sigorta ettirenin
-- aleyhine yapılan takip semeresiz kalmışsa, zarar sigortalarında sigortalı
-- ... bu durumun sigortacı tarafından kendilerine bildirilmesi hâlinde, primi
-- ödemeyi üstlenirlerse sözleşme bu kişilerle devam eder; aksi hâlde,
-- sigortacı sigorta ettirene karşı sahip olduğu hakları kullanır."
--
-- This is the ONLY mechanism in this system that changes who a party is.
-- Endorsement is forbidden to touch the policyholder and stays forbidden.
--
-- THREE facts, three dates, three outbox types, in one order and only that
-- order. The platform cannot observe litigation, cannot serve a notice and
-- cannot witness an undertaking, so each is reported from outside with its
-- own supplied date and none is ever inferred from another.
--
-- The contract continues WITH the sigortalı -- "sözleşme bu kişilerle devam
-- eder", not merely for their benefit -- so policyholder_id becomes
-- insured_policyholder_id. m. 1454(1) leaves the contract's rights with the
-- sigortalı throughout, so afterwards one person holds both roles and the
-- paragraph is spent: there is no distinct third party left to substitute in,
-- which is why this can never fire twice on one policy.
-- ============================================================================

-- Fact one. Enforcement against the sigorta ettiren for the premium debt
-- proved fruitless.
--
-- NOT enforcement_commenced_at, which migration 016 added for m. 1434(2).
-- Commencement is what SUSPENDS the deemed withdrawal; fruitlessness is what
-- OPENS substitution. One exists without the other, and the m. 1434(3) notice
-- mechanism has no commencement column at all -- making this depend on one
-- would force that path to report something it was never given a place to
-- record.
ALTER TABLE policies ADD COLUMN enforcement_fruitless_at TIMESTAMPTZ;

-- Which route was pursued, kept rather than flattened. m. 1434(2) names both
-- -- "dava veya takip yoluyla" -- while m. 1431(4) names only "takip
-- semeresiz kalmışsa". Whether `takip` there is narrow or general is not
-- settled on the text, so the platform records which it actually was.
ALTER TABLE policies ADD COLUMN enforcement_route TEXT;
ALTER TABLE policies ADD CONSTRAINT policies_enforcement_route_known
  CHECK (enforcement_route IS NULL OR enforcement_route IN ('ER_Takip', 'ER_Dava'));
ALTER TABLE policies ADD CONSTRAINT policies_enforcement_fruitless_facts_together
  CHECK ((enforcement_fruitless_at IS NULL) = (enforcement_route IS NULL));

-- Fact two. The insurer notified the sigortalı. On the text this is a
-- CONDITION of the right, not merely its occasion.
ALTER TABLE policies ADD COLUMN substitution_notified_at TIMESTAMPTZ;
ALTER TABLE policies ADD CONSTRAINT policies_substitution_notice_needs_fruitless
  CHECK (substitution_notified_at IS NULL OR enforcement_fruitless_at IS NOT NULL);

-- Fact three. The sigortalı undertook to pay. An ACT, not a payment: nothing
-- here records an amount, an instalment or a balance, and the premium is as
-- unpaid after a substitution as before it.
ALTER TABLE policies ADD COLUMN substituted_at TIMESTAMPTZ;
ALTER TABLE policies ADD CONSTRAINT policies_substitution_needs_notice
  CHECK (substituted_at IS NULL OR substitution_notified_at IS NOT NULL);

-- Who was superseded. Kept on the record without keeping the observation
-- right: the old party leaves the token's observers with the role, because it
-- is no longer a party and 5684 m. 35(8)/(9) makes continued disclosure to a
-- non-party the wrong default.
--
-- Nothing here says they were released. m. 1431(4) does not address it and
-- the premise of the paragraph is that enforcement against them failed, so
-- arrears plainly exist. Recorded, not concluded.
ALTER TABLE policies ADD COLUMN superseded_policyholder_id UUID REFERENCES policyholders(id);
ALTER TABLE policies ADD CONSTRAINT policies_superseded_party_with_substitution
  CHECK ((substituted_at IS NULL) = (superseded_policyholder_id IS NULL));

-- After substitution the two roles are one person.
ALTER TABLE policies ADD CONSTRAINT policies_substitution_moved_the_party
  CHECK (substituted_at IS NULL OR policyholder_id = insured_policyholder_id);

-- THE FREEZE. graceSweeper.js must not queue a termination for a substituted
-- policy: m. 1431(4)'s "sözleşme bu kişilerle devam eder" cannot coexist with
-- m. 1434(3)'s "sözleşme feshedilmiş olur". That incompatibility is the whole
-- of the reasoning -- no article says the clock stops, resets or runs on, and
-- nothing here asserts any of those. default_state is deliberately NOT
-- cleared: the premium is still unpaid, and the notice facts stay exactly
-- where they were.
--
-- The sweeper's own predicate carries the exclusion; this index is what keeps
-- it cheap.
CREATE INDEX idx_policies_substituted
  ON policies (substituted_at)
  WHERE substituted_at IS NOT NULL;

-- Three outbox types, because each is a distinct act with a distinct
-- consequence and the dispatcher's handler map is where they differ.
ALTER TYPE event_type ADD VALUE 'enforcement_fruitless';
ALTER TYPE event_type ADD VALUE 'substitution_notice';
ALTER TYPE event_type ADD VALUE 'substitution';
