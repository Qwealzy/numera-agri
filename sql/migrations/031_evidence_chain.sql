-- 031: the evidence chain -- raw provider responses, kept, and tied to payouts.
--
-- The first real-data run found that the
-- provider does not give the same answer twice for the same moment: two calls
-- minutes apart returned different values and a model-run timestamp that went
-- BACKWARDS. A third party re-asking cannot reproduce the number a payout was
-- decided on. So the response actually received is kept, byte for byte, with
-- its SHA-256, and the hash goes onto the ledger inside attestationRef.
--
-- Immutability is enforced in two places, and the second is the one that
-- counts. The table refuses UPDATE, and a CHECK ties the stored hash to the
-- stored bytes, so a row cannot be edited in place or saved with a hash that
-- does not match. DELETE is allowed on purpose -- retention and test cleanup
-- need it, and a reading's foreign key already stops a response being removed
-- while a reading still points at it. What makes a swapped body DETECTABLE is
-- that the hash also lives on the ledger, which this database cannot rewrite.

CREATE TABLE oracle_raw_responses (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_url          TEXT NOT NULL,
  request_params       JSONB NOT NULL,
  http_status          INTEGER NOT NULL,
  -- The response body exactly as the application received it (after the
  -- transport's gzip is undone), not a re-serialisation of the parsed JSON.
  body                 BYTEA NOT NULL,
  sha256               TEXT NOT NULL,
  -- The provider's own statement of when its data was produced, verbatim, so
  -- it is evidence of what the provider said rather than our reading of it.
  provider_updated_at  TEXT,
  fetched_at           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT oracle_raw_responses_sha256_matches_body
    CHECK (sha256 = encode(digest(body, 'sha256'), 'hex'))
);

CREATE OR REPLACE FUNCTION refuse_oracle_raw_response_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'oracle_raw_responses is append-only: row % cannot be updated', OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_oracle_raw_responses_no_update
  BEFORE UPDATE ON oracle_raw_responses
  FOR EACH ROW EXECUTE FUNCTION refuse_oracle_raw_response_update();

-- Every reading the oracle bot records points at the response it came from.
-- Nullable: readings written directly (tests, verify scripts, and every
-- reading recorded before this migration) have none, and say so.
ALTER TABLE oracle_readings ADD COLUMN raw_response_id UUID REFERENCES oracle_raw_responses(id);

-- The attestation built when the window closed. Kept here as the single
-- source the dispatcher reads, so what went onto the ledger and what this
-- table records cannot drift apart.
ALTER TABLE trigger_windows ADD COLUMN attestation_ref TEXT;

-- A payout points straight at the event that caused it. oracle_reading_id
-- already existed and was never written; trigger_window_id is new, and it is
-- what names every reading of an aggregated event, including a mean, which has
-- no single deciding reading.
ALTER TABLE payout_events ADD COLUMN trigger_window_id UUID REFERENCES trigger_windows(id);
