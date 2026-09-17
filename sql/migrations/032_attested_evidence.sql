-- 032: attested evidence -- the bytes a ledger hash points at cannot be deleted.
--
-- Migration 031 kept every provider response byte for byte and allowed
-- DELETE, relying on a reading's foreign key to stop a response going while a
-- reading still pointed at it. That only held while the chain was intact:
-- delete the payouts, the outbox rows, the windows and the readings first, and
-- the response is unreferenced. The second real-data run's teardown did
-- exactly that and deleted the bytes behind a hash already on the ledger
-- (seen in the first real-data run), and the provider does not give the same
-- answer twice, so they cannot be fetched again.
--
-- Decided on 2026-09-13: evidence whose hash has reached the ledger
-- cannot be deleted; a response never attested stays deletable. What is held
-- is the bytes, not the chain -- the policy, the window and the outbox row stay
-- deletable -- so this table points at nothing but the response, and carries
-- the rest as plain values, the attestation exactly as it was sent included.
--
-- The dispatcher writes these rows in their own committed statement BEFORE the
-- exercise that carries the hash, so a call that succeeds with a write-back
-- that fails, a call that fails, and a call that never returns all leave the
-- bytes held. For a min or max the hash covers the deciding reading's
-- response; for a mean, every response the window combines.
--
-- What this stops is an accidental or scripted DELETE or TRUNCATE. It does not
-- stop a role that can drop the table or its triggers, mark the database as a
-- test database, or turn triggers off -- a superuser or the owner can do all
-- of those.

CREATE TABLE attested_evidence (
  -- The trigger outbox row whose exercise carried the hash.
  policy_event_id    UUID NOT NULL,
  raw_response_id    UUID NOT NULL REFERENCES oracle_raw_responses(id) ON DELETE RESTRICT NOT DEFERRABLE,
  sha256             TEXT NOT NULL,
  trigger_window_id  UUID NOT NULL,
  policy_id          UUID NOT NULL,
  -- The command id the exercise was submitted under, which is the one the
  -- ledger records for it.
  command_id         TEXT NOT NULL,
  -- The attestation exactly as it went onto the ledger, so the row still says
  -- what it is evidence for once the window row is gone.
  attestation_ref    TEXT NOT NULL,
  attested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_event_id, raw_response_id)
);

-- True only in a database whose own catalog carries the marker that
-- markTestDatabase() (node/test-support/testDbGuard.mjs) sets with ALTER
-- DATABASE. Read from pg_db_role_setting, never from current_setting(): any
-- session can SET app.is_test_database for itself, but only the database's
-- owner or a superuser can change what the catalog holds.
CREATE OR REPLACE FUNCTION is_marked_test_database() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      JOIN pg_database d ON d.oid = s.setdatabase
     WHERE d.datname = current_database()
       AND s.setrole = 0
       AND 'app.is_test_database=on' = ANY (s.setconfig)
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION refuse_attested_evidence_update() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'attested_evidence is append-only: the row for response % cannot be updated', OLD.raw_response_id;
END;
$$ LANGUAGE plpgsql;

-- Row-level for DELETE, statement-level for TRUNCATE. A TRUNCATE of
-- oracle_raw_responses ... CASCADE reaches this table too, and its BEFORE
-- TRUNCATE trigger refuses the whole command.
CREATE OR REPLACE FUNCTION refuse_attested_evidence_removal() RETURNS TRIGGER AS $$
BEGIN
  IF is_marked_test_database() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'attested_evidence is append-only: % refused -- the ledger holds the hash of the bytes these rows keep', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_attested_evidence_no_update
  BEFORE UPDATE ON attested_evidence
  FOR EACH ROW EXECUTE FUNCTION refuse_attested_evidence_update();

CREATE TRIGGER trg_attested_evidence_no_delete
  BEFORE DELETE ON attested_evidence
  FOR EACH ROW EXECUTE FUNCTION refuse_attested_evidence_removal();

CREATE TRIGGER trg_attested_evidence_no_truncate
  BEFORE TRUNCATE ON attested_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_attested_evidence_removal();
