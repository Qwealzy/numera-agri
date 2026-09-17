-- ============================================================================
-- Retroactive cover (TTK 6102 m. 1458).
--
-- m. 1458(1) sentence 1: "Sigorta, sigorta koruması sözleşmenin yapılmasından
-- önceki bir tarihten itibaren sağlanacak şekilde yapılabilir." Backdating
-- cover is EXPRESSLY LAWFUL and stays possible.
--
-- Sentence 2 is the danger: the contract is VOID where the riziko's
-- occurrence -- or the disappearance of its possibility -- was known at
-- formation by the sigortacı AND the sigorta ettiren AND (if aware of the
-- insurance) the sigortalı. m. 1486(1) lists that sentence specifically among
-- those a contract may not contravene, which makes it `geçersiz` rather than
-- merely varied away -- a stronger consequence than m. 1452(3)'s.
--
-- Sentence 3 -- policyholder or insured knew, insurer did not: insurer not
-- bound but entitled to the whole premium -- is NOT in m. 1486(1)'s list.
--
-- **In a parametric product this stops being theoretical.** The determinant
-- of a loss is oracle data, which is historical and queryable, so a policy
-- backdated over an already-recorded frost would trigger and pay on a loss
-- that had already happened when the contract was made.
--
-- WHAT THIS DOES NOT DO. It does not decide whether anyone knew anything.
-- m. 1458 turns on the knowledge of three persons at a moment; a row in a
-- database that nobody read is not obviously that, and the platform cannot
-- settle it. It performs a mechanical check of its OWN data and records what
-- that check saw, so a lawyer can reason from a fact rather than a log line.
-- ============================================================================

-- When the check ran. Mirrors the token's own retroactiveCoverCheckedAt --
-- the only part of this that reaches the ledger, because a passing check
-- should record that it ran, not the whole search.
ALTER TABLE policies ADD COLUMN retroactive_cover_checked_at TIMESTAMPTZ;

-- The outcome, kept queryable rather than buried in the JSON below.
--
-- The distinction between the two passing values is the point of this column
-- and must never be collapsed: a policy on a cell the platform has never
-- observed passes the check having verified NOTHING. Reading that later as
-- "we confirmed there was no frost" would be exactly wrong, and the whole
-- reason m. 1458 is dangerous here is that people trust automated checks.
--
--   RC_PassedWithData        -- every cell had readings in the window, and
--                               none of them matched a tier
--   RC_PassedNoDataForCells  -- the check ran, but at least one cell had NO
--                               readings at all in the window. A vacuous pass
--                               over that cell. Verified nothing about it.
--
-- There is deliberately no stored "failed" value: a matching reading refuses
-- the mint, so no token exists and the policy stays pending_mint. The reason
-- lives on the failed policy_events row.
ALTER TABLE policies ADD COLUMN retroactive_cover_check_status TEXT;
ALTER TABLE policies ADD CONSTRAINT policies_retro_check_status_known
  CHECK (retroactive_cover_check_status IS NULL
         OR retroactive_cover_check_status IN ('RC_PassedWithData', 'RC_PassedNoDataForCells'));
ALTER TABLE policies ADD CONSTRAINT policies_retro_check_status_with_timestamp
  CHECK ((retroactive_cover_check_status IS NULL) = (retroactive_cover_checked_at IS NULL));

-- The check's own limits, made legible. Off-ledger because the ledger needs
-- only the timestamp, but recoverable because a vacuous pass must not read
-- later as a verified one.
--
-- Records the window actually searched and, per cell, how many readings the
-- platform held for it. A cell with zero is what drives
-- RC_PassedNoDataForCells above.
--
-- The platform's history is only as good as the cells it has already been
-- observing: readings are written per policy, so a cell no prior policy
-- covered has no history at all. This column is where that shows.
ALTER TABLE policies ADD COLUMN retroactive_cover_check_result JSONB;

CREATE INDEX idx_policies_retro_check_vacuous
  ON policies (retroactive_cover_checked_at)
  WHERE retroactive_cover_check_status = 'RC_PassedNoDataForCells';

-- The check joins readings to coverages by CELL, not by policy: a brand-new
-- backdated policy has no readings of its own, so the readings that matter
-- belong to other policies covering the same ground.
CREATE INDEX idx_oracle_readings_cell_measured ON oracle_readings (cell_id, measured_at);
