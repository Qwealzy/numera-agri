-- 036: the SQL side of Daml package v22.
--
-- Every column here mirrors a field the v22 ledger carries or returns; none
-- carries a product value of its own. Where a backfill is needed it is taken
-- from what the existing rows already are, and says so.
--
-- Checked before writing this, read-only, on the working database: every
-- oracle_readings row (35) and every trigger_windows row (3) carries the
-- metric TEMPERATURE_C, the one code the oracle has ever emitted
-- (node/src/oracle/oracleBot.js, readingFromResponse); policy_coverages holds
-- 2 rows, each naming one cell.

-- ---------------------------------------------------------------------------
-- payout_tiers: a shape per tier. Mirrors Types.daml's validTier.
-- ---------------------------------------------------------------------------

-- Every tier that exists today is a step tier: v21 had no other shape.
ALTER TABLE payout_tiers ADD COLUMN shape TEXT;
UPDATE payout_tiers SET shape = 'TS_Step';
ALTER TABLE payout_tiers ALTER COLUMN shape SET NOT NULL;
ALTER TABLE payout_tiers ADD COLUMN pct_at_min NUMERIC(5,2);
ALTER TABLE payout_tiers ADD COLUMN pct_at_max NUMERIC(5,2);

ALTER TABLE payout_tiers ADD CONSTRAINT payout_tiers_shape_known
  CHECK (shape IN ('TS_Step', 'TS_Linear'));
-- A step tier carries no end percentages. A linear tier needs both bounds,
-- in order, both end percentages inside [0, 100], and payout_percentage equal
-- to the larger end percentage -- "the highest rate this tier can pay".
ALTER TABLE payout_tiers ADD CONSTRAINT payout_tiers_shape_fields
  CHECK ((shape = 'TS_Step' AND pct_at_min IS NULL AND pct_at_max IS NULL)
         OR (shape = 'TS_Linear'
             AND threshold_min IS NOT NULL AND threshold_max IS NOT NULL
             AND threshold_min < threshold_max
             AND pct_at_min IS NOT NULL AND pct_at_min >= 0 AND pct_at_min <= 100
             AND pct_at_max IS NOT NULL AND pct_at_max >= 0 AND pct_at_max <= 100
             AND payout_percentage = GREATEST(pct_at_min, pct_at_max)));
-- payout_percentage > 0 stays for a step tier. A linear tier whose two end
-- percentages are both 0 has 0 as its highest rate, which validTier admits,
-- so that one case is let through; nothing else about the range changes.
ALTER TABLE payout_tiers DROP CONSTRAINT payout_tiers_payout_percentage_check;
ALTER TABLE payout_tiers ADD CONSTRAINT payout_tiers_payout_percentage_range
  CHECK (payout_percentage <= 100
         AND (payout_percentage > 0 OR (shape = 'TS_Linear' AND payout_percentage >= 0)));

-- ---------------------------------------------------------------------------
-- policy_coverages: the metric, the payout basis and the salt of the
-- cell commitment.
-- ---------------------------------------------------------------------------

-- Backfilled from what the rows are: the oracle has only ever emitted
-- TEMPERATURE_C (see the header). No default for new rows: the API requires
-- the metric and checks it against the codes the oracle can supply.
ALTER TABLE policy_coverages ADD COLUMN metric TEXT;
UPDATE policy_coverages SET metric = 'TEMPERATURE_C';
ALTER TABLE policy_coverages ALTER COLUMN metric SET NOT NULL;
ALTER TABLE policy_coverages ADD CONSTRAINT policy_coverages_metric_not_empty
  CHECK (metric <> '');

-- Backfilled with the basis v21 applied to every coverage: its
-- evaluateAgainstTiers took the percentage of the remaining limit. No default
-- for new rows: the API requires it.
ALTER TABLE policy_coverages ADD COLUMN payout_basis TEXT;
UPDATE policy_coverages SET payout_basis = 'PB_RemainingLimit';
ALTER TABLE policy_coverages ALTER COLUMN payout_basis SET NOT NULL;
ALTER TABLE policy_coverages ADD CONSTRAINT policy_coverages_payout_basis_known
  CHECK (payout_basis IN ('PB_RemainingLimit', 'PB_SumInsured'));

-- The token and every trigger carry "sha256:" + hex(SHA-256(salt || cell id))
-- (node/src/dispatch/ledgerText.js); the salt stays here and never reaches
-- the ledger. Random, not a product value, so a default draws it; a volatile
-- default gives each existing row a salt of its own.
ALTER TABLE policy_coverages ADD COLUMN cell_commitment_salt TEXT NOT NULL
  DEFAULT encode(gen_random_bytes(32), 'hex');
ALTER TABLE policy_coverages ADD CONSTRAINT policy_coverages_cell_commitment_salt_hex
  CHECK (cell_commitment_salt ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- payout_events: the event interval and the evidence digest the payout was
-- approved on, the insurer's declared closing instant and the
-- record the resolution left on the ledger.
-- ---------------------------------------------------------------------------

-- NULL on a row written before v22; never backfilled, because no true value
-- for those rows exists off the ledger (the same rule as approved_at).
ALTER TABLE payout_events ADD COLUMN event_start TIMESTAMPTZ;
ALTER TABLE payout_events ADD COLUMN event_end TIMESTAMPTZ;
ALTER TABLE payout_events ADD COLUMN evidence_digest TEXT;
ALTER TABLE payout_events ADD COLUMN closed_at TIMESTAMPTZ;
ALTER TABLE payout_events ADD COLUMN resolution_record_contract_id TEXT;

ALTER TABLE payout_events ADD CONSTRAINT payout_events_event_interval
  CHECK ((event_start IS NULL) = (event_end IS NULL)
         AND (event_start IS NULL OR event_start < event_end));
ALTER TABLE payout_events ADD CONSTRAINT payout_events_evidence_digest_form
  CHECK (evidence_digest IS NULL OR evidence_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE payout_events ADD CONSTRAINT payout_events_record_only_when_resolved
  CHECK (resolution_record_contract_id IS NULL OR status IN ('settled', 'closed_unpaid'));
ALTER TABLE payout_events ADD CONSTRAINT payout_events_closed_at_only_when_closed_unpaid
  CHECK (closed_at IS NULL OR status = 'closed_unpaid');

-- ---------------------------------------------------------------------------
-- policies: the two instants an archive of the token returns.
-- ---------------------------------------------------------------------------

-- contract_ended_at is when the CONTRACT ended (the token's expiry, or its
-- frozen termination instant); record_closed_at is the ledger time of the
-- archive. Kept apart: neither stands in for the other. NULL on a policy
-- archived before v22 or not archived at all.
ALTER TABLE policies ADD COLUMN contract_ended_at TIMESTAMPTZ;
ALTER TABLE policies ADD COLUMN record_closed_at TIMESTAMPTZ;
ALTER TABLE policies ADD CONSTRAINT policies_archive_instants_together
  CHECK ((contract_ended_at IS NULL) = (record_closed_at IS NULL));

-- ---------------------------------------------------------------------------
-- payout_events.payout_percentage: the rate the ledger applied (v22).
-- ---------------------------------------------------------------------------

-- The column mirrors TriggerResult.payoutPct, which since v22 is the rate the
-- ledger computed: on a linear tier an interpolation, a Daml Decimal. A Daml
-- Decimal is Numeric 10 -- ten decimal places -- so scale 10 holds every value
-- the ledger can return exactly, where NUMERIC(5,2) rounded it. Three integer
-- digits keep the range the column already had (up to 999.99): a rate the
-- ledger derives from end percentages it holds inside [0, 100]. Existing rows
-- are 2-place values and convert without change.
ALTER TABLE payout_events ALTER COLUMN payout_percentage TYPE NUMERIC(13,10);

-- ---------------------------------------------------------------------------
-- trigger_windows: the event interval the trigger sends, fixed when the
-- window is queued.
-- ---------------------------------------------------------------------------

-- [event_start, event_end) is the window clipped to cover: it starts no
-- earlier than the recorded cover start and ends no later than the contract's
-- end as SQL records it when the window is queued (the term's end, a recorded
-- m. 1434(3) termination instant, or a m. 1434(4) effective instant). Written
-- once, at queueing, so the bound cannot move afterwards; the dispatcher sends
-- it as the trigger's eventStart/eventEnd. NULL on a row written before v22,
-- never backfilled: no bound was recorded for those rows.
ALTER TABLE trigger_windows ADD COLUMN event_start TIMESTAMPTZ;
ALTER TABLE trigger_windows ADD COLUMN event_end TIMESTAMPTZ;
ALTER TABLE trigger_windows ADD CONSTRAINT trigger_windows_event_interval
  CHECK ((event_start IS NULL) = (event_end IS NULL)
         AND (event_start IS NULL
              OR (event_start < event_end AND event_start >= window_start AND event_end <= window_end)));

-- ---------------------------------------------------------------------------
-- policy_coverages.payout_tiers_snapshot: the shape fields a v22 tier carries.
-- ---------------------------------------------------------------------------

-- The snapshot is what a mint sends as the token's payoutTiers, and a v22
-- PayoutTier requires `shape` (and `pctAtMin`/`pctAtMax`, which a step tier
-- leaves empty). Every snapshot written before v22 is of step tiers, for the
-- same reason as payout_tiers above, so the three keys are added as that, in
-- the snapshot's own order; a snapshot that already carries them is untouched.
UPDATE policy_coverages c
   SET payout_tiers_snapshot = (
     SELECT jsonb_agg(t || jsonb_build_object('shape', 'TS_Step', 'pctAtMin', NULL, 'pctAtMax', NULL) ORDER BY i)
       FROM jsonb_array_elements(c.payout_tiers_snapshot) WITH ORDINALITY AS e(t, i))
 WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(c.payout_tiers_snapshot) AS e(t) WHERE NOT (t ? 'shape'));
