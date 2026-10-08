-- Correction: activation must be driven by an explicit outbox, and
-- a Party belongs to a policyholder, not a policy. Run against a database
-- that already has the earlier schema.sql and the migration that followed it
-- applied.

CREATE TYPE outbox_status AS ENUM ('pending', 'processing', 'done', 'failed');

-- Sole authorization to touch the ledger at this point. mintWatcher.js reads
-- ONLY this table -- it never watches or infers activation from `policies`.
CREATE TABLE policy_activated (
  policy_id     UUID PRIMARY KEY REFERENCES policies(id),
  status        outbox_status NOT NULL DEFAULT 'pending',
  party_id      TEXT,
  contract_id   TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_policy_activated_status ON policy_activated(status);

CREATE TRIGGER trg_policy_activated_updated_at BEFORE UPDATE ON policy_activated
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Party moves back to the policyholder (one Party per policyholder, reused
-- across all of that policyholder's policies -- not one per policy).
ALTER TABLE policyholders ADD COLUMN canton_party_id TEXT UNIQUE;
ALTER TABLE policyholders ADD COLUMN canton_party_status party_allocation_status NOT NULL DEFAULT 'PENDING';

-- IBAN does not exist here. Payment destination is decided elsewhere.
ALTER TABLE policyholders DROP COLUMN iban;

-- Party no longer belongs to the policy.
ALTER TABLE policies DROP COLUMN canton_party_id;
ALTER TABLE policies DROP COLUMN canton_party_status;
