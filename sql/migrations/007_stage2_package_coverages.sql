-- ============================================================================
-- Package policies (multiple coverages per token).
--
-- sumInsured/remainingLimit/payoutTiers/payoutDestination/
-- mortgageeClaimAmount move off `policies` onto their own per-coverage
-- table, keyed on policy + coverage code, mirroring the Daml token's own
-- move onto a `Coverage` record -- one source of truth per value, on both
-- sides. product_code/peril_type/cell_ids move with them: tier lookup and
-- oracle cell-reading now both happen per coverage, not per policy.
--
-- No data migration needed: every `policies` row was archived on the
-- ledger and deleted from SQL before this migration ran (see
-- the package-migration cleanup) specifically so this could be a clean
-- structural change with nothing to carry over -- `policies` held 0 rows
-- when this was written.
-- ============================================================================

CREATE TABLE policy_coverages (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id               UUID NOT NULL REFERENCES policies(id),
  coverage_code           TEXT NOT NULL,
  product_code            TEXT NOT NULL,
  peril_type              TEXT NOT NULL,
  cell_ids                JSONB NOT NULL,
  sum_insured             NUMERIC(14,2) NOT NULL CHECK (sum_insured > 0),
  remaining_limit         NUMERIC(14,2) NOT NULL CHECK (remaining_limit >= 0),
  payout_tiers_snapshot   JSONB NOT NULL,
  payout_destination      JSONB NOT NULL,
  mortgagee_claim_amount  NUMERIC(14,2),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, coverage_code)
);

CREATE INDEX idx_policy_coverages_policy ON policy_coverages(policy_id);

CREATE TRIGGER trg_policy_coverages_updated_at BEFORE UPDATE ON policy_coverages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE policies DROP COLUMN product_code;
ALTER TABLE policies DROP COLUMN peril_type;
ALTER TABLE policies DROP COLUMN cell_ids;
ALTER TABLE policies DROP COLUMN sum_insured;
ALTER TABLE policies DROP COLUMN remaining_limit;
ALTER TABLE policies DROP COLUMN payout_tiers_snapshot;

-- Traceability: which coverage a reading was fetched for / a payout came
-- from. Both tables held 0 rows when this ran, so NOT NULL needs no
-- backfill.
ALTER TABLE oracle_readings ADD COLUMN coverage_code TEXT NOT NULL;
ALTER TABLE payout_events ADD COLUMN coverage_code TEXT NOT NULL;
