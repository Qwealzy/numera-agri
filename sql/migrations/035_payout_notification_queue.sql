-- 035: the payout notification queue -- one row per approved payout the
-- insurer is to be told about.
--
-- A notification is NOT a policy_events row. That table is the outbox for
-- ledger-changing actions and forbids retry on purpose (README "One outbox...",
-- dispatcher.js:6-12, :2334-2336): a create or an exercise that already
-- succeeded must never be attempted twice. An HTTPS notification is the
-- opposite kind of work -- it has to be retried until it lands. So it gets a
-- table of its own, run with the same discipline (a status-transition trigger
-- in the table, ownership by SKIP LOCKED), and the dispatcher stays the single
-- path to the ledger.
--
-- Nothing in this migration sends anything. The sender, the signature, the GET
-- endpoints and the contract are later sessions' work; this is the queue and
-- the two producers that fill it.

-- The approval instant as the LEDGER recorded it: PayoutApproved.approvedAt,
-- which is the same `now` the dispatcher hands PolicyToken_EvaluateTrigger --
-- not the moment the SQL row happened to be written. m. 1427 runs maturity
-- from the approval, so the value carried to the insurer has to be the value
-- on the ledger. NULL means a row written before this column existed; there is
-- no backfill, because no true value for those rows exists off the ledger.
ALTER TABLE payout_events ADD COLUMN approved_at TIMESTAMPTZ;
COMMENT ON COLUMN payout_events.approved_at IS
  'Mirror of the ledger''s PayoutApproved.approvedAt. NULL = row written before this column existed; never backfilled.';

-- webhook_url has been on insurers since the first schema and no code has ever
-- read it. It is the notification address, set by the insurer through the CLI.
COMMENT ON COLUMN insurers.webhook_url IS
  'The notification address, set with the CLI. May belong to a sub-processor of the insurer.';

-- Bumped when the insurer rotates its signing secret, so a receiver can tell
-- which secret signed a delivery. The secret itself is never stored here.
ALTER TABLE insurers ADD COLUMN webhook_secret_version INTEGER NOT NULL DEFAULT 1;

CREATE TYPE notification_status AS ENUM ('pending', 'processing', 'delivered', 'failed');
-- 'payout_approved'  a record_kind = 'payout' row: someone is owed this and a
--                    PayoutApproved exists for it.
-- 'review_required'  an unrouted remainder or competing claims: nothing was
--                    routed and a human has to work it (m. 1456(2), m. 1457).
CREATE TYPE notification_kind AS ENUM ('payout_approved', 'review_required');

-- One row per (payout event, kind). The UNIQUE is the idempotency guarantee:
-- both producers -- handleTrigger's write-back and payoutListener's defensive
-- insert -- may reach the same payout, and the second must not queue a second
-- notification for it.
CREATE TABLE payout_notifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_event_id  UUID NOT NULL REFERENCES payout_events(id),
  insurer_id       UUID NOT NULL REFERENCES insurers(id),
  kind             notification_kind NOT NULL,
  status           notification_status NOT NULL DEFAULT 'pending',
  attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_code INTEGER,
  last_error       TEXT,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payout_notifications_key UNIQUE (payout_event_id, kind),
  -- 'delivered' is a claim about something that happened at a time; it does
  -- not get to be made without the time.
  CONSTRAINT payout_notifications_delivered_has_time
    CHECK (status <> 'delivered' OR delivered_at IS NOT NULL)
);

-- The claim query: the pending rows whose next attempt is due.
CREATE INDEX idx_payout_notifications_due
  ON payout_notifications (status, next_attempt_at);

-- Enforces pending -> processing -> {delivered, failed, pending} in the table
-- itself, the way enforce_policy_event_status_transition does for the outbox.
-- The one edge the outbox does not have is processing -> pending: a retry.
-- It is admitted only when attempt_count actually rose, so a row cannot be
-- handed back to the queue without recording that an attempt was spent --
-- which is what would let it be retried forever.
CREATE OR REPLACE FUNCTION enforce_payout_notification_status_transition() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'processing' AND NEW.status = 'pending'
     AND NEW.attempt_count <= OLD.attempt_count THEN
    RAISE EXCEPTION 'payout_notifications retry without a spent attempt: attempt_count % -> %',
      OLD.attempt_count, NEW.attempt_count;
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status = 'processing') OR
    (OLD.status = 'processing' AND NEW.status IN ('delivered', 'failed', 'pending'))
  ) THEN
    RAISE EXCEPTION 'invalid payout_notifications status transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payout_notifications_status_transition
  BEFORE UPDATE ON payout_notifications
  FOR EACH ROW EXECUTE FUNCTION enforce_payout_notification_status_transition();

CREATE TRIGGER trg_payout_notifications_updated_at BEFORE UPDATE ON payout_notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
