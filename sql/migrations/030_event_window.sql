-- 030: the event window -- one evaluation per (coverage, cell, window).
--
-- Before this, every oracle reading produced its own 'trigger' outbox row and
-- the only idempotency key was reading_id. Nothing stopped the same event
-- being paid twice: the oracle bot polls every 15 minutes, so one frost night
-- yielding eight readings under the threshold produced eight triggers and
-- eight payouts. Readings are now folded into a window and a coverage is
-- evaluated once per window, with the window's aggregated value.
--
-- Which window and which aggregation are PRODUCT decisions, so none has a
-- default. They follow default_grace_period_days exactly: an insurer default,
-- a policy override, nullable with NO SQL default, resolved and frozen onto
-- the policy row at activation. One difference, deliberate: an unset grace
-- period refuses activation, an unset window does not -- it refuses the
-- TRIGGER, and the oracle bot logs why. A window is always one local day,
-- starting at event_window_start_hour; 0 is a calendar day.

ALTER TABLE insurers
  ADD COLUMN default_event_window_timezone TEXT,
  ADD COLUMN default_event_window_start_hour INTEGER
    CONSTRAINT insurers_default_event_window_start_hour_range
      CHECK (default_event_window_start_hour BETWEEN 0 AND 23),
  ADD COLUMN default_event_aggregation TEXT
    CONSTRAINT insurers_default_event_aggregation_known
      CHECK (default_event_aggregation IN ('min', 'max', 'mean'));

ALTER TABLE policies
  ADD COLUMN event_window_timezone TEXT,
  ADD COLUMN event_window_start_hour INTEGER
    CONSTRAINT policies_event_window_start_hour_range
      CHECK (event_window_start_hour BETWEEN 0 AND 23),
  ADD COLUMN event_aggregation TEXT
    CONSTRAINT policies_event_aggregation_known
      CHECK (event_aggregation IN ('min', 'max', 'mean'));

-- One row per evaluated window. The UNIQUE key is the idempotency guarantee
-- for the window itself, and it records the rule that produced it, so each
-- evaluation is self-describing evidence rather than a pointer back into a
-- configuration that could be read differently later.
CREATE TABLE trigger_windows (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id              UUID NOT NULL REFERENCES policies(id),
  coverage_code          TEXT NOT NULL,
  cell_id                TEXT NOT NULL,
  window_start           TIMESTAMPTZ NOT NULL,
  window_end             TIMESTAMPTZ NOT NULL,
  timezone               TEXT NOT NULL,
  start_hour             INTEGER NOT NULL,
  aggregation            TEXT NOT NULL,
  metric                 TEXT NOT NULL,
  aggregated_value       NUMERIC(12,4) NOT NULL,
  -- The reading that decided the value for min and max. A mean has no deciding
  -- reading, and the constraint below holds that line in the table itself.
  determining_reading_id UUID REFERENCES oracle_readings(id),
  reading_ids            UUID[] NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trigger_windows_key UNIQUE (policy_id, coverage_code, cell_id, window_start),
  CONSTRAINT trigger_windows_ordered CHECK (window_end > window_start),
  CONSTRAINT trigger_windows_aggregation_known CHECK (aggregation IN ('min', 'max', 'mean')),
  CONSTRAINT trigger_windows_has_readings CHECK (cardinality(reading_ids) > 0),
  CONSTRAINT trigger_windows_determining_reading
    CHECK ((aggregation = 'mean') = (determining_reading_id IS NULL))
);

-- The outbox side of the same guarantee: a second trigger row for one window
-- cannot be created, whatever inserts it. Partial, so the direct-SQL trigger
-- rows that tests and verify scripts still write -- keyed on reading_id, with
-- no window -- are unaffected.
ALTER TABLE policy_events ADD COLUMN trigger_window_id UUID REFERENCES trigger_windows(id);
CREATE UNIQUE INDEX idx_policy_events_trigger_window_key
  ON policy_events (trigger_window_id) WHERE event_type = 'trigger' AND trigger_window_id IS NOT NULL;
