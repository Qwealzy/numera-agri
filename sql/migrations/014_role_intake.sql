-- ============================================================================
-- Role intake for mortgagee and beneficiary.
--
-- Both roles have existed on PolicyToken since the roles round, and the whole
-- m. 1456 mechanism (notification, continuation window, election) has been
-- implemented and tested since the termination round -- but nothing could
-- ever set them, because there was no intake path. dispatcher.js minted every
-- policy with `mortgagee: null` and `beneficiary: null`, so every one of
-- those choices refused on every policy the platform could create.
--
-- This migration makes both reachable. It does NOT extend what they can do.
-- ============================================================================

-- `policyholders` is the party registry for every role, not only the
-- policyholder. It already has exactly the scoping this needs -- UNIQUE
-- (insurer_id, external_ref), one allocated Canton party per row -- so a bank
-- named as mortgagee on four hundred policies is ONE row and ONE party,
-- reused, rather than four hundred allocations. That matters: see the
-- rights budget of a participant.
--
-- The table is deliberately NOT renamed. Renaming it would touch every query
-- in node/src for no behavioural gain, and "a party this insurer has
-- onboarded" is a fair reading of the existing name.

ALTER TABLE policies ADD COLUMN beneficiary_policyholder_id UUID REFERENCES policyholders(id);
ALTER TABLE policies ADD COLUMN mortgagee_policyholder_id   UUID REFERENCES policyholders(id);

-- A beneficiary designated descriptively -- "my spouse at the time of loss" --
-- identifies no specific person, so no Party can exist for it. Only the HASH
-- is ever supplied or stored: the API accepts `beneficiaryDescriptorHash`
-- directly, so the descriptive text never reaches this database, the ledger,
-- or a log line.
--
-- This mirrors PolicyToken.beneficiaryDescriptorHash rather than replacing
-- it. It is on the ledger because TTK 6102 m. 1494(2) attaches a consequence
-- to naming NO beneficiary, so "none" and "described but not named" have to
-- be distinguishable from the contract alone -- a token with
-- beneficiary = None and nothing else cannot tell them apart.
ALTER TABLE policies ADD COLUMN beneficiary_descriptor_hash TEXT;

-- The three beneficiary states are exclusive: named (a party), described (a
-- hash), or none. Enforced here as well as in the token's ensure clause,
-- because a row that reached the dispatcher in a fourth state would fail at
-- the ledger with a far less legible error.
ALTER TABLE policies ADD CONSTRAINT policies_beneficiary_named_xor_described
  CHECK (NOT (beneficiary_policyholder_id IS NOT NULL AND beneficiary_descriptor_hash IS NOT NULL));
ALTER TABLE policies ADD CONSTRAINT policies_beneficiary_descriptor_not_empty
  CHECK (beneficiary_descriptor_hash IS NULL OR beneficiary_descriptor_hash <> '');

-- policy_coverages.mortgagee_claim_amount already exists (Stage 2 Part 2) and
-- is unchanged. What was missing was any way to SET it: the API did not
-- accept it, and the token's own ensure clause forbids it on a policy with no
-- mortgagee, which was every policy.
--
-- This CHECK enforces POSITIVITY ONLY. The real invariant -- a claim amount
-- may exist only where the POLICY names a mortgagee -- spans two tables and
-- a CHECK constraint cannot express it. It is enforced in the two places
-- that can: routes/policies.js rejects it at intake with a 400 naming the
-- coverage, and PolicyToken's own ensure clause refuses the mint. The ledger
-- is the one that actually cannot be bypassed.
--
-- Absent is the normal case, not a missing value: a bank's charge may sit on
-- the fire coverage and not the glass one.
ALTER TABLE policy_coverages ADD CONSTRAINT policy_coverages_claim_needs_mortgagee
  CHECK (mortgagee_claim_amount IS NULL OR mortgagee_claim_amount > 0);

-- Reused on every activation and every m. 1456 handler, both of which resolve
-- the mortgagee's party from the policy row.
CREATE INDEX idx_policies_mortgagee ON policies (mortgagee_policyholder_id)
  WHERE mortgagee_policyholder_id IS NOT NULL;
