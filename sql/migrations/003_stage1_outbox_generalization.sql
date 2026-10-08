-- Addendum: generalize the outbox. `policy_activated` only ever
-- carried one event type (activation) and could hold exactly one row per
-- policy, ever -- that shape can't carry endorsement/renewal/notice/release
-- events later. `policy_events` replaces it as the single channel every
-- ledger-changing action enters through, for every event type, forever.
-- Only 'activation' has a dispatcher handler in this stage; the other four
-- are accepted into the table and explicitly rejected when processed.

CREATE TYPE event_type AS ENUM ('activation', 'endorsement', 'renewal', 'notice', 'release');

-- SQL-side mirror of the token's on-ledger `version` field. 0 = no token
-- minted yet. Read fresh (never cached) before processing any event, and
-- compared against that event's expected_version for optimistic
-- concurrency control -- a mismatch fails the row rather than rebasing.
ALTER TABLE policies ADD COLUMN current_version INTEGER NOT NULL DEFAULT 0;

-- Structured event_type alongside the existing free-text reason, so the
-- supersession chain (which event caused which archive+re-create) is
-- queryable, not just readable in prose.
ALTER TABLE policy_status_history ADD COLUMN event_type event_type;

CREATE TABLE policy_events (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_no              UUID NOT NULL REFERENCES policies(id),
  event_type             event_type NOT NULL,
  expected_version       INTEGER NOT NULL,
  payload                JSONB,
  status                 outbox_status NOT NULL DEFAULT 'pending',
  resulting_contract_id  TEXT,
  error                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at           TIMESTAMPTZ,
  -- Idempotency key: a retried write for the same (policy, type, version)
  -- is a no-op; a later event building on a higher version is a new row,
  -- never blocked.
  UNIQUE (policy_no, event_type, expected_version)
);

CREATE INDEX idx_policy_events_status ON policy_events(status);
CREATE INDEX idx_policy_events_policy_no ON policy_events(policy_no);

-- Enforces pending -> processing -> {done, failed} in the table itself,
-- not only by application discipline.
CREATE OR REPLACE FUNCTION enforce_policy_event_status_transition() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status = 'processing') OR
    (OLD.status = 'processing' AND NEW.status IN ('done', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid policy_events status transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_policy_events_status_transition
  BEFORE UPDATE ON policy_events
  FOR EACH ROW EXECUTE FUNCTION enforce_policy_event_status_transition();

-- Carry existing policy_activated rows over as 'activation' events (direct
-- INSERT of already-terminal rows, so the transition trigger above --
-- UPDATE-only -- doesn't apply here), then retire the old table.
INSERT INTO policy_events
  (policy_no, event_type, expected_version, status, resulting_contract_id, error, created_at, processed_at)
SELECT policy_id, 'activation', 0, status, contract_id, error, created_at,
       CASE WHEN status IN ('done', 'failed') THEN updated_at ELSE NULL END
FROM policy_activated;

UPDATE policies SET current_version = 1 WHERE daml_contract_id IS NOT NULL;

-- policy_documents (migration 002) pointed its outbox reference at
-- policy_activated specifically -- redirect it to the now-generic
-- policy_events before that table goes away.
ALTER TABLE policy_documents DROP CONSTRAINT policy_documents_produced_by_activation_fkey;
ALTER TABLE policy_documents RENAME COLUMN produced_by_activation TO produced_by_event;
ALTER TABLE policy_documents ADD CONSTRAINT policy_documents_produced_by_event_fkey
  FOREIGN KEY (produced_by_event) REFERENCES policy_events(id);

DROP TABLE policy_activated;
