-- ============================================================================
-- Parametric Insurance Tokenization Platform -- PostgreSQL schema
--
-- This database is the off-chain system of record for auth, API intake, and
-- audit/history data. Canton/Daml remains the source of truth for policy
-- terms and payout authorization: rows here are written PENDING first, then
-- updated ONLY after the corresponding Daml ledger command has been
-- confirmed -- never before -- so this DB can always be rebuilt from the
-- ledger if it is ever lost, and never drifts ahead of what actually
-- happened on-chain.
--
-- THIS FILE IS THE ONLY SUPPORTED INSTALL PATH. A new database is built by
-- applying this file, then optionally sql/seed.sql. It is verified to apply
-- to an empty database on its own, and that verification is part of every
-- change to it.
--
-- sql/migrations/ is applied history for databases that already exist. It is
-- NOT a second install route and cannot be replayed from nothing: migration
-- 001 expects the schema that predates the outbox, which is not in this
-- repository and cannot be faithfully reconstructed. `node
-- scripts/checkMigrationBase.mjs` demonstrates the failure.
--
-- This file therefore MIRRORS the migrations rather than being generated from
-- them: every change here is paired with a numbered migration, and vice
-- versa. The two are kept equal by hand, and where they cannot be -- enum
-- sort order, see the notes at policy_status and event_type below -- the
-- divergence is written down rather than hidden.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid(), digest()

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------

CREATE TYPE party_allocation_status AS ENUM ('PENDING', 'ALLOCATED', 'FAILED');

-- Shared lifecycle vocabulary with Daml's PolicyStatus (daml/daml/Insurance/
-- Types.daml) -- the two must never drift into separate spellings for the
-- same state. 'pending_mint' is the one SQL-only exception: there is no
-- token yet at that point, so Daml has no contract to hold a status field
-- for it in the first place.
-- CLAIM/TERM axis only, as of Stage 3 Part 3. The premium-default states
-- moved to `default_state` below -- the two are orthogonal (a policy can be
-- partially paid AND in its grace period at once) and packing both into
-- this one column caused a real defect: see migration 010's header and the
-- DefaultState comment in daml/daml/Insurance/Types.daml.
--
-- 'grace_period' and 'suspended' REMAIN in this enum but are dead values --
-- no application code writes either any more. They are kept only because
-- policy_status_history is append-only and still holds rows carrying them
-- from before the split, and because Postgres cannot drop an enum value
-- without recreating the type and every dependent object. Do not
-- reintroduce a write to them; use `default_state` instead.
-- ORDER DIVERGENCE, deliberate and recorded. The list below fixes this type's
-- `enumsortorder`; a database grown through sql/migrations/ has the same
-- VALUES in a different order, because `ALTER TYPE ... ADD VALUE` appends and
-- 009 added 'grace_period' last rather than third. Same set, different sort.
--
-- Harmless while nothing sorts by or range-compares the column: equality, IN
-- and NOT IN are order-independent, and that is all this codebase does with
-- it. The moment a query writes ORDER BY, `<`, BETWEEN or MIN/MAX on
-- policies.status (or policy_status_history.old_status/new_status), it starts
-- answering differently depending on which path built the database.
--
-- NOT reconciled, on purpose. Postgres cannot reorder an existing enum --
-- ADD VALUE ... BEFORE/AFTER positions only the value being added -- so
-- aligning them means recreating the type and rewriting every column that
-- uses it, for zero behavioural gain today. Rewriting the migrations instead
-- would make applied history describe something that never ran.
--
-- Guarded by node/test/enumOrdering.test.mjs, which fails if any query starts
-- depending on the order. If you are here because that test failed: the fix
-- is normally to stop depending on the order, not to reconcile these two.
CREATE TYPE policy_status AS ENUM (
  'pending_mint',        -- SQL row exists, Daml Create not yet confirmed
  'active',
  'grace_period',         -- DEAD as of Stage 3 Part 3 -- historical rows only, use default_state
  'suspended',            -- DEAD as of Stage 3 Part 3 -- historical rows only, use default_state
  'partially_paid',      -- one or more partial payouts fired, NFT re-minted at a reduced limit
  'expired',              -- burned: reached expiry with no outstanding claim
  'cancelled',            -- burned: non-payment past the grace period
  'claimed_and_closed',  -- burned: remaining limit exhausted by payout(s)
  'manual_review'
);

-- The premium-default axis (Stage 3 Part 3), deliberately separate from
-- policy_status above and moved independently of it: a payout changes only
-- `status`, and notice/termination/reinstatement change only `default_state`.
-- Shares its vocabulary with Daml's DefaultState (Insurance/Types.daml),
-- kept in sync by hand like every other shared enum here.
--   none         -- no notice outstanding; premium not in default
--   grace_period -- notice served; coverage CONTINUES in full, losses payable
--   terminated   -- notice period elapsed unpaid; the CONTRACT has ended
--   suspended    -- DEAD (Stage 4, migration 013). The suspension model was
--                   wrong on TTK 6102 m. 1434(3): at the end of the notice
--                   period the contract is `feshedilmiş olur`, terminated,
--                   not suspended -- and m. 1452(3) makes m. 1434
--                   non-derogable against the insured, so the general
--                   conditions could not have introduced a suspension state
--                   either. Postgres has no DROP VALUE and
--                   policy_status_history legitimately holds historical rows
--                   carrying it, so the value stays and nothing writes it.
--   first_premium_unpaid        -- m. 1434(2): the insurer has reported a
--                                 first instalment (or a one-sum premium)
--                                 due and unpaid. A DIFFERENT mechanism
--                                 from grace_period/terminated above:
--                                 no ihtar, no ten days, three months
--                                 from the due date, and cayma rather
--                                 than fesih. Never conflate the two.
--   withdrawn_for_first_premium  -- withdrawn under m. 1434(2), by the
--                                 insurer's act or by operation of law.
--                                 Named for THIS cayma: Book Six carries
--                                 at least two others (m. 1430(3) and
--                                 m. 1439) which must be able to take
--                                 their own names later.
--   two_notice_elected     -- m. 1434(4): two ihtars were sent in one
--                             insurance period and the insurer has elected
--                             to terminate "sigorta doneminin sonunda hukum
--                             dogurmak uzere". The contract RUNS ON until
--                             then -- cover in full, losses payable -- and
--                             nothing about the election shortens it. The
--                             THIRD way a contract ends for non-payment, and
--                             not to be conflated with the other two: (2) is
--                             withdrawal, (3) is automatic at the end of a
--                             notice period, this one is discretionary with
--                             a deferred effect.
--   two_notice_terminated  -- that effect has landed at the period end.
CREATE TYPE default_state AS ENUM ('none', 'grace_period', 'suspended', 'terminated',
                                  'first_premium_unpaid', 'withdrawn_for_first_premium',
                                  'two_notice_elected', 'two_notice_terminated');

-- Why the most recent endorsement happened. Only meaningful for an
-- endorsement -- a reduction of sum insured is not its own document type,
-- it's an endorsement with this reason code. Used both by
-- policy_documents.endorsement_reason (section 4c) and by
-- policies.last_amendment_reason, which is why it is declared up here
-- rather than beside the document tables it originally served.
CREATE TYPE endorsement_reason AS ENUM (
  'sum_insured_increase',
  'sum_insured_reduction',
  'insured_object_change',
  'tier_change',
  'correction'
);

-- Same lowercase-with-underscores convention as policy_status -- not the
-- same shared vocabulary (this one has no Daml counterpart), just the same
-- spelling style throughout the schema.
-- Stage 4: 'settled' and 'closed_unpaid' are the two terminal states a
-- payout can reach. The 'eft_*' values are DEAD -- named for an Open Banking
-- bridge removed in Stage 1 Cleanup that is not coming back; they remain
-- only because Postgres cannot drop an enum value without recreating the
-- type and every dependent object. Do not write them.
CREATE TYPE payout_event_status AS ENUM (
  'approved',         -- PayoutApproved live on the ledger, awaiting the insurer's report
  'eft_pending',      -- DEAD
  'eft_sent',         -- DEAD
  'eft_confirmed',    -- DEAD
  'eft_failed',       -- DEAD
  'manual_review',    -- MarkFailed fired; a ManualReviewRequired item is live
  'settled',          -- insurer reported settlement; closed
  'closed_unpaid'     -- closed with a recorded reason; no money moved
);

CREATE TYPE outbox_status AS ENUM ('pending', 'processing', 'done', 'failed');

-- ---------------------------------------------------------------------------
-- 1. insurers -- the B2B tenants of this SaaS platform
-- ---------------------------------------------------------------------------
CREATE TABLE insurers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name             TEXT NOT NULL,
  api_key_hash           TEXT NOT NULL UNIQUE,      -- sha256(api key) hex digest; raw key is never stored
  canton_party_id        TEXT UNIQUE,                -- this insurer's own Daml Party (signatory on every PolicyToken it mints)
  canton_party_status    party_allocation_status NOT NULL DEFAULT 'PENDING',
  oracle_operator_party  TEXT,                        -- separate, platform-controlled Party allowed to feed readings for this insurer's policies (see PolicyToken.daml -- kept distinct from canton_party_id on purpose)
  -- Fallback used when a policy does not carry its own grace_period_days.
  -- Deliberately nullable with NO default: the statutory minimum is a
  -- legally constrained configuration value, never a literal in code, Daml,
  -- or a SQL default. If both this and the policy's own value are unset,
  -- activation fails loudly rather than assuming a number.
  default_grace_period_days INTEGER,
  -- The m. 1456(5) continuation window offered to a known real-right holder
  -- at termination, per insurer, frozen onto the policy at its activation
  -- (policies.mortgagee_continuation_days, migration 037). Nullable with NO
  -- default for exactly the same reason as the column above: a statutory
  -- period is legally constrained configuration, never a literal. A policy
  -- that names a mortgagee and was activated while this was unset fails
  -- termination loudly.
  mortgagee_continuation_days INTEGER,
  -- m. 1434(2)'s window. A CEILING, not a floor -- the inverse of
  -- default_grace_period_days above. The article gives the insurer a right
  -- exercisable WITHIN three months; m. 1452(3) forbids varying m. 1434 to
  -- the insured's detriment, so a SHORTER window is permitted and a longer
  -- one is not. Do not "fix" this to match the grace period's floor.
  first_premium_withdrawal_days INTEGER,
  -- The event window (migration 030). Which window and which aggregation are
  -- product decisions, so these follow default_grace_period_days exactly:
  -- nullable, NO default, resolved and frozen onto the policy at activation.
  -- Unlike the grace period, an unset window refuses the TRIGGER, not the
  -- activation. start_hour 0 is a calendar day.
  default_event_window_timezone TEXT,
  default_event_window_start_hour INTEGER
    CONSTRAINT insurers_default_event_window_start_hour_range
      CHECK (default_event_window_start_hour BETWEEN 0 AND 23),
  default_event_aggregation TEXT
    CONSTRAINT insurers_default_event_aggregation_known
      CHECK (default_event_aggregation IN ('min', 'max', 'mean')),
  commission_bps         INTEGER NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
  webhook_url            TEXT,
  -- Bumped when the insurer rotates its signing secret, so a receiver can tell
  -- which secret signed a delivery. The secret itself is never stored here.
  webhook_secret_version INTEGER NOT NULL DEFAULT 1,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- webhook_url has been on insurers since the first schema. It is the
-- notification address, set by the insurer through the CLI:
-- node/src/scripts/setWebhook.js writes it, and
-- node/src/notifications/sender.js reads it to post each notification.
COMMENT ON COLUMN insurers.webhook_url IS
  'The notification address, set with the CLI. May belong to a sub-processor of the insurer.';

-- ---------------------------------------------------------------------------
-- 2. policyholders -- the insurer's own end customers (e.g. farmers). One
--    Canton Party per policyholder, reused across all of that
--    policyholder's policies (never one party per policy). No IBAN or bank
--    detail here -- the platform stores no account numbers, a standing
--    decision (migration 015).
-- ---------------------------------------------------------------------------
CREATE TABLE policyholders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_id           UUID NOT NULL REFERENCES insurers(id),
  external_ref         TEXT NOT NULL,                -- insurer's own customer id
  -- No name, no national id: neither carried a working function (party
  -- reuse has always run on external_ref alone, below), and a name plus a
  -- reversible-in-practice hash of a small-keyspace id was pure liability.
  -- Dropped in migration 028; the API rejects fullName/nationalId outright.
  canton_party_id      TEXT UNIQUE,                    -- opaque party id (hint is a random token, never the name/external_ref) -- allocated on first activation, reused for every later policy
  canton_party_status  party_allocation_status NOT NULL DEFAULT 'PENDING',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (insurer_id, external_ref)
);

-- ---------------------------------------------------------------------------
-- 3. payout_tiers -- Module 2: the tiered payout matrix, configured per
--    insurer + product + peril. Snapshotted at policy creation and at the
--    renewal request and carried onto the Daml PolicyToken contract, so
--    evaluation stays fully on-ledger and auditable -- editing a row here
--    only affects a policy created, or a renewal requested, afterward.
-- ---------------------------------------------------------------------------
CREATE TABLE payout_tiers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_id          UUID NOT NULL REFERENCES insurers(id),
  product_code        TEXT NOT NULL,
  peril_type          TEXT NOT NULL,                  -- e.g. FROST, DROUGHT, HAIL
  tier_order          INTEGER NOT NULL,                -- evaluated in ascending order; first matching band wins
  label               TEXT NOT NULL,
  threshold_min       NUMERIC(12,4),                   -- inclusive lower bound; NULL = unbounded below
  threshold_max       NUMERIC(12,4),                   -- inclusive upper bound; NULL = unbounded above
  payout_percentage   NUMERIC(5,2) NOT NULL,
  -- v22 (migration 036). TS_Step pays payout_percentage; TS_Linear
  -- interpolates from pct_at_min at threshold_min to pct_at_max at
  -- threshold_max, and payout_percentage is then the larger of the two. The
  -- rules are Types.daml's validTier, below as CHECKs.
  shape               TEXT NOT NULL,
  pct_at_min          NUMERIC(5,2),
  pct_at_max          NUMERIC(5,2),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (insurer_id, product_code, peril_type, tier_order)
);

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
-- payout_percentage > 0 for a step tier. A linear tier whose two end
-- percentages are both 0 has 0 as its highest rate, which validTier admits.
ALTER TABLE payout_tiers ADD CONSTRAINT payout_tiers_payout_percentage_range
  CHECK (payout_percentage <= 100
         AND (payout_percentage > 0 OR (shape = 'TS_Linear' AND payout_percentage >= 0)));

-- ---------------------------------------------------------------------------
-- 4. policies -- created by POST /api/v1/policies (SQL only, no ledger
--    call -- this is "creation", not "activation"). Every ledger-changing
--    action (minting included) only happens once a matching row exists in
--    `policy_events` (see below) and only node/src/dispatch/dispatcher.js
--    ever touches the ledger in response to one. A policy's Party is NOT
--    stored here -- it belongs to policyholders (one party per
--    policyholder, reused across all of their policies). current_version
--    mirrors the token's on-ledger `version` field -- 0 until activated --
--    and is what every event's `expected_version` is checked against.
--    Stage 2 Part 2: product_code/peril_type/cell_ids/sum_insured/
--    remaining_limit/payout_tiers_snapshot moved to policy_coverages
--    (below) -- a package policy has one premium and one term but several
--    independent coverages, each with its own values; this table now only
--    carries what's genuinely policy-wide.
-- ---------------------------------------------------------------------------
CREATE TABLE policies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_id          UUID NOT NULL REFERENCES insurers(id),
  policyholder_id     UUID NOT NULL REFERENCES policyholders(id),
  premium_amount      NUMERIC(14,2) NOT NULL CHECK (premium_amount > 0),
  currency            TEXT NOT NULL DEFAULT 'TRY',
  start_date          DATE NOT NULL,
  end_date            DATE NOT NULL CHECK (end_date > start_date),
  status              policy_status NOT NULL DEFAULT 'pending_mint',
  -- Premium-default axis, independent of `status` above (Stage 3 Part 3).
  -- 'none' is the state machine's initial state, not a business default.
  default_state       default_state NOT NULL DEFAULT 'none',
  current_version     INTEGER NOT NULL DEFAULT 0,    -- mirrors the token's on-ledger `version`; 0 = not yet activated
  daml_contract_id    TEXT,                          -- current active PolicyToken cid; changes on every archive+re-create
  -- Stage 3 Part 1: mirrors the token's own absolute `expiry` instant
  -- (noon local time, Europe/Istanbul, computed once in dispatcher.js's
  -- handleActivation and written here the same time as current_version)
  -- so expirySweeper.js can query "expiry in the past" without
  -- recomputing that conversion a second time in SQL. NULL until
  -- activated; afterwards an endorsement's write-back moves it to the
  -- re-minted token's expiry.
  expiry              TIMESTAMPTZ,
  -- Stage 3 Part 2: this policy's own grace period, if it overrides the
  -- insurer's default (insurers.default_grace_period_days). Nullable, no
  -- SQL default -- see that column's comment for why there is no literal
  -- fallback number anywhere.
  grace_period_days   INTEGER,
  -- The event window this policy is evaluated under (migration 030): the
  -- override before activation, the frozen resolved value after it, the same
  -- two meanings grace_period_days has. NULL after activation means no rule
  -- was configured, and the oracle bot then never triggers this policy.
  event_window_timezone TEXT,
  event_window_start_hour INTEGER
    CONSTRAINT policies_event_window_start_hour_range
      CHECK (event_window_start_hour BETWEEN 0 AND 23),
  event_aggregation TEXT
    CONSTRAINT policies_event_aggregation_known
      CHECK (event_aggregation IN ('min', 'max', 'mean')),
  -- The m. 1456(5) continuation window, frozen here at activation from
  -- insurers.mortgagee_continuation_days (migration 037), so a later change
  -- to the insurer's value never moves an activated policy's window. NULL
  -- until activated; NULL after it means none was configured then, and
  -- termination of a policy that names a mortgagee fails loudly.
  mortgagee_continuation_days INTEGER,
  -- m. 1434(2)'s window, frozen here at activation from
  -- insurers.first_premium_withdrawal_days (migration 037) the same way. Its
  -- three-month CEILING is checked where the window is used
  -- (resolveFirstPremiumWindow, dispatcher.js), not here. NULL after
  -- activation means none was configured then: the sweeper does not select
  -- the policy, and a withdrawal fails loudly.
  first_premium_withdrawal_days INTEGER,
  -- Mirrors of the token's own noticeServiceDate/noticeRecordedAt, written
  -- by dispatcher.js's handleNotice write-back. notice_service_date is the
  -- statutory service date supplied by the insurer (never system-generated);
  -- notice_recorded_at is when this platform was told, so a gap between the
  -- two stays visible. graceSweeper.js reads notice_service_date directly
  -- here so it never has to call the ledger to decide whether a grace
  -- period has elapsed.
  -- Role intake. All three are OPTIONAL and all three are nullable.
  -- mortgagee and beneficiary point into `policyholders`, which is the
  -- party registry for every role, not only the policyholder -- so a bank
  -- named on four hundred policies is one row and ONE reused Canton party,
  -- and a person holding two roles on one policy is one party too.
  -- m. 1421(1): "Aksine sözleşme yoksa, sigortacının sorumluluğu primin
  -- veya ilk taksidinin ödenmesi ile başlar." The missing partner to
  -- coverage_valid_through's on-ledger twin -- the schema has always
  -- carried when cover ENDS and never when it BEGAN.
  --
  -- NULL means COVER HAS NOT BEGUN. Minting therefore no longer means the
  -- policy is live: it means the contract exists. m. 1422 (no premium
  -- earned where the risk became impossible before liability began) and
  -- m. 1430(3) (the sigorta ettiren may withdraw before liability begins,
  -- against half the premium) both presuppose that interval.
  --
  -- A timestamp and NOT a new state: a state would be derivable from this
  -- column, giving two sources of truth that can disagree. Never inferred
  -- -- no timer, no default, no "assume paid after N days" -- and there is
  -- no configured period here at all. m. 1421 states none, and m. 1424's
  -- 24-hour/15-day delivery deadline is a different obligation. The only
  -- guard the text supports is DIRECTIONAL: an agreed start may never be
  -- later than payment, since m. 1452(3) lists 1421 and so permits varying
  -- it only in the insured's favour.
  coverage_began_at        TIMESTAMPTZ,
  coverage_start_basis     TEXT,
  -- The insurer's REPORTED first-premium receipt date, its own fact: where
  -- cover was agreed to start earlier, this is recorded but does not move
  -- the start.
  first_premium_paid_at    TIMESTAMPTZ,
  -- m. 1431(4): policyholder substitution, as THREE externally reported
  -- facts. "Başkası lehine yapılan sigortada, prim borcu için sigorta
  -- ettirenin aleyhine yapılan takip semeresiz kalmışsa ... sigortalı, bu
  -- durumun sigortacı tarafından kendilerine bildirilmesi hâlinde, primi
  -- ödemeyi üstlenirlerse sözleşme bu kişilerle devam eder."
  --
  -- The only mechanism here that changes who a party is. Endorsement is
  -- forbidden to touch policyholder_id and stays forbidden.
  --
  -- enforcement_fruitless_at is NOT enforcement_commenced_at. Commencement
  -- SUSPENDS m. 1434(2)'s deemed withdrawal; fruitlessness OPENS m. 1431(4).
  -- One exists without the other, and the m. 1434(3) notice mechanism has no
  -- commencement column at all.
  --
  -- enforcement_route is kept rather than flattened: m. 1434(2) names both
  -- routes ("dava veya takip yoluyla") while m. 1431(4) names only "takip",
  -- and whether that is narrow or general is unsettled on the text.
  --
  -- substituted_at records an ACT, not a payment. Nothing here holds an
  -- amount, an instalment or a balance, and the premium is as unpaid after a
  -- substitution as before it -- which is why default_state is untouched by
  -- one.
  enforcement_fruitless_at   TIMESTAMPTZ,
  enforcement_route          TEXT,
  substitution_notified_at   TIMESTAMPTZ,
  substituted_at             TIMESTAMPTZ,
  -- Who was superseded, kept on the record without keeping the observation
  -- right -- the old party leaves the token's observers with the role. Says
  -- nothing about release: m. 1431(4) does not address it, and the premise of
  -- the paragraph is that enforcement against them failed.
  superseded_policyholder_id UUID REFERENCES policyholders(id),
  -- m. 1456(6): "Sigortacı, istem üzerine, sınırlı ayni hak sahibi olduğunu
  -- bildiren kişiye sigorta koruması ile sigorta bedelinin miktarı hakkında
  -- bilgi verir."
  --
  -- The information was never missing: a named mortgagee already observes the
  -- PolicyToken and can read the cover, the sum insured and the remaining
  -- limit continuously. What was missing is the ACT -- the duty is request ->
  -- response, and standing access is a state, which cannot evidence a
  -- response to a request nobody recorded.
  --
  -- Both dates are externally reported. Nothing here records WHAT was
  -- disclosed: the token already carries it, and a second copy could only
  -- drift from the first. No name, address or contact detail is held for the
  -- person who asked; the request is identified by the policy.
  --
  -- A request is OUTSTANDING while requested_at is set and provided_at is
  -- NULL or older than it -- which is why a later request deliberately leaves
  -- an older response behind it.
  -- m. 1434(4). Every notice service date, not just the latest that
  -- notice_service_date holds: the paragraph turns on TWO ihtars "bir sigorta
  -- donemi icinde", and one date plus a count cannot answer whether both fell
  -- inside a given period.
  --
  -- notice_count COUNTS PER POLICY, NOT PER INSURANCE PERIOD -- safe only
  -- while a term does not exceed one period, which is an accident of this
  -- product rather than a guarantee. The election checks these dates against
  -- a supplied period instead of trusting the count.
  notice_service_dates TIMESTAMPTZ[] NOT NULL DEFAULT '{}',
  -- The election, and the instant its effect lands. The effective instant is
  -- the SUPPLIED period end, frozen at election, so a sweeper running late
  -- records the instant it would have recorded on time.
  --
  -- THE PERIOD IS SUPPLIED, NEVER DERIVED. m. 1411 ties it to how the premium
  -- is CALCULATED and this system holds no calculation basis; start_date /
  -- end_date are the contract term, which is a different thing.
  two_notice_election_at  TIMESTAMPTZ,
  two_notice_effective_at TIMESTAMPTZ,
  mortgagee_info_requested_at TIMESTAMPTZ,
  mortgagee_info_provided_at  TIMESTAMPTZ,
  -- m. 1458. Sentence 1 makes backdating cover expressly lawful; sentence 2
  -- makes the contract VOID where the riziko's occurrence was already known
  -- at formation, and m. 1486(1) names that sentence specifically, so it
  -- cannot be agreed around. In a parametric product this stops being
  -- theoretical: the determinant of a loss is oracle data, which is
  -- historical and queryable.
  --
  -- These three record a MECHANICAL check of the platform's own readings,
  -- run at mint over the window from cover start to contract formation.
  -- They decide nothing about knowledge -- m. 1458 turns on what three
  -- persons knew at a moment, which this platform cannot establish.
  --
  -- The status column's two passing values must never be collapsed:
  --   RC_PassedWithData        every cell had readings in the window and
  --                            none matched a tier
  --   RC_PassedNoDataForCells  at least one cell had NO readings at all --
  --                            a VACUOUS pass over that cell, verifying
  --                            nothing about it
  -- There is deliberately no stored "failed" value: a matching reading
  -- refuses the mint, so no token exists and the policy stays pending_mint,
  -- with the reason on the failed policy_events row.
  --
  -- The JSONB carries the check's own limits -- the window searched and, per
  -- cell, how many readings the platform held. Off-ledger because the token
  -- needs only the timestamp, but recoverable, because a vacuous pass must
  -- never read later as "we confirmed there was no frost".
  retroactive_cover_checked_at   TIMESTAMPTZ,
  retroactive_cover_check_status TEXT,
  retroactive_cover_check_result JSONB,
  -- The sigortalı where distinct from the sigorta ettiren. A PRECONDITION
  -- for m. 1454 and m. 1431(4); the m. 1431(4) substitution (migration 020)
  -- acts on it. NULL means "the same person", the common case.
  insured_policyholder_id     UUID REFERENCES policyholders(id),
  -- Hash of the policy document. The document itself never reaches this
  -- platform.
  -- Required, as a SHA-256 in 64 lowercase hex characters (migration 034).
  document_hash               TEXT NOT NULL,
  mortgagee_policyholder_id   UUID REFERENCES policyholders(id),
  beneficiary_policyholder_id UUID REFERENCES policyholders(id),
  -- The alternative to a named beneficiary: a designation identifying no
  -- specific person ("my spouse at the time of loss"), for which no Party
  -- can exist. Only the HASH is ever supplied -- the API takes
  -- beneficiaryDescriptorHash directly, so the descriptive text reaches
  -- neither this database nor the ledger. Mirrors the token's own
  -- beneficiaryDescriptorHash, which is on-ledger because TTK 6102
  -- m. 1494(2) attaches a consequence to naming NO beneficiary, so "none"
  -- and "described but not named" must be distinguishable from the
  -- contract alone.
  beneficiary_descriptor_hash TEXT,
  notice_service_date TIMESTAMPTZ,
  notice_recorded_at  TIMESTAMPTZ,
  -- m. 1434(4) counts notices within one insurance period. Mirrors the
  -- token's own noticeCount, read back off the re-minted contract rather
  -- than incremented here, so SQL cannot drift from the ledger. Counting is
  -- all this column does: nothing reads it to act on it. The further right
  -- the paragraph gives the insurer after a second notice, the two-notice
  -- election (migrations 024/025), checks notice_service_dates against a
  -- supplied period instead. Per policy, not per insurance period (see
  -- notice_service_dates above), without a reset --
  -- a renewal is a new row and a new token, both starting at zero -- and
  -- reinstatement does NOT reset it, since paying after the first notice is
  -- exactly the case the paragraph is about.
  notice_count        INTEGER NOT NULL DEFAULT 0,
  -- m. 1434(2), the FIRST-premium mechanism. Kept apart from the notice
  -- fields above on purpose: this is not a variant of that flow.
  --
  -- premium_due_date is REPORTED by the insurer, never derived -- m. 1431(1)
  -- puts it at contract formation against delivery of the policy, neither of
  -- which this platform can observe. Both of m. 1434(2)'s three-month clocks
  -- run from it, so nothing about the mechanism can be computed until it is
  -- reported, and a withdrawal or sweep without it is refused, not defaulted.
  --
  -- enforcement_commenced_at records that the insurer says it pursued the
  -- claim "dava veya takip yoluyla". COMMENCEMENT only: whether it proved
  -- fruitless (semeresiz) is m. 1431(4)'s trigger, a different fact,
  -- recorded in enforcement_fruitless_at (migration 020). Its presence
  -- forecloses the deemed path.
  --
  -- There is deliberately NO refund figure here and no analogue of
  -- unrun_days: m. 1419 returns only premiums actually paid, and in
  -- first-premium default nothing was.
  premium_due_date         TIMESTAMPTZ,
  enforcement_commenced_at TIMESTAMPTZ,
  withdrawn_at             TIMESTAMPTZ,
  withdrawal_path          TEXT,
  -- The policy term's start instant (noon Europe/Istanbul), mirroring the
  -- token's termStart. Stage 4 added it because "days unrun" could not be
  -- derived from the contract alone without it. NULL until activated.
  term_start          TIMESTAMPTZ,
  -- Stage 4 termination (m. 1434(3)), written together by handleTermination.
  -- terminated_at is DERIVED FROM THE NOTICE -- the externally supplied
  -- service date plus this policy's own grace period -- never a clock
  -- reading, so a sweeper that runs late records the same instant it would
  -- have recorded on time. unrun_days is the whole days from there to
  -- expiry.
  --
  -- These are the FACTS a premium refund is computed from (m. 1419,
  -- protected by m. 1452(3)) and nothing more. There is deliberately no
  -- refund amount and no premium figure here: the insurer holds the premium
  -- and does the arithmetic, exactly as with set-off under m. 1431(5).
  terminated_at       TIMESTAMPTZ,
  unrun_days          INTEGER,
  -- v22 (migration 036): the two instants an archive of the token
  -- returns. contract_ended_at is when the CONTRACT ended (the token's
  -- expiry, or its frozen termination instant); record_closed_at is the
  -- ledger time of the archive. Kept apart: neither stands in for the other.
  -- NULL on a policy archived before v22 or not archived at all.
  contract_ended_at   TIMESTAMPTZ,
  record_closed_at    TIMESTAMPTZ,
  -- m. 1456(4) and (5). All recorded facts, never actions -- this system
  -- generates and sends no notification, and does not implement the
  -- mortgagee taking the contract over. mortgagee_notified_at is the
  -- insurer's reported date for having notified a known real-right holder;
  -- the continuation window opens at termination and its end is computed
  -- from mortgagee_continuation_days above, frozen from the insurer's value
  -- at activation (migration 037), never a literal; the
  -- election is recorded if one is reported, and nothing acts on it.
  mortgagee_notified_at          TIMESTAMPTZ,
  mortgagee_continuation_ends_at TIMESTAMPTZ,
  mortgagee_election             TEXT,
  mortgagee_election_at          TIMESTAMPTZ,
  -- Mirrors the token's own amendmentReason -- why the most recent
  -- endorsement happened (Stage 3 Part 3). NULL until first amended.
  last_amendment_reason endorsement_reason,
  -- The renewal chain (Stage 3 Part 4), navigable in both directions
  -- without walking the ledger. A renewal mints a NEW policy row; these
  -- link it to the period it succeeds. renewed_by_policy_id doubles as the
  -- "already renewed" guard -- a period is succeeded exactly once -- and
  -- SQL is the only place that fact can live, since the renewal
  -- deliberately never modifies the predecessor token.
  predecessor_policy_id UUID REFERENCES policies(id),
  renewed_by_policy_id  UUID REFERENCES policies(id),
  actuarial_payload   JSONB,                         -- pass-through of the SAS/Python-computed pricing inputs
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_policies_insurer ON policies(insurer_id);
CREATE INDEX idx_policies_policyholder ON policies(policyholder_id);
-- The three beneficiary states are exclusive: named, described, or none.
-- Enforced here as well as in the token's ensure clause, so a bad row fails
-- in SQL with a readable message rather than at the ledger minutes later.
-- m. 1421, mirroring the token's ensure clauses.
ALTER TABLE policies ADD CONSTRAINT policies_cover_start_facts_together
  CHECK ((coverage_began_at IS NULL) = (coverage_start_basis IS NULL));
ALTER TABLE policies ADD CONSTRAINT policies_cover_start_basis_known
  CHECK (coverage_start_basis IS NULL
         OR coverage_start_basis IN ('CSB_PremiumPaid', 'CSB_AgreedWithoutPayment'));
-- m. 1458: the outcome and the timestamp are one fact, recorded together.
ALTER TABLE policies ADD CONSTRAINT policies_retro_check_status_known
  CHECK (retroactive_cover_check_status IS NULL
         OR retroactive_cover_check_status IN ('RC_PassedWithData', 'RC_PassedNoDataForCells'));
ALTER TABLE policies ADD CONSTRAINT policies_retro_check_status_with_timestamp
  CHECK ((retroactive_cover_check_status IS NULL) = (retroactive_cover_checked_at IS NULL));
ALTER TABLE policies ADD CONSTRAINT policies_document_hash_not_empty
  CHECK (document_hash IS NULL OR document_hash <> '');
ALTER TABLE policies ADD CONSTRAINT policies_document_hash_is_sha256_hex
  CHECK (document_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE policies ADD CONSTRAINT policies_beneficiary_named_xor_described
  CHECK (NOT (beneficiary_policyholder_id IS NOT NULL AND beneficiary_descriptor_hash IS NOT NULL));
ALTER TABLE policies ADD CONSTRAINT policies_beneficiary_descriptor_not_empty
  CHECK (beneficiary_descriptor_hash IS NULL OR beneficiary_descriptor_hash <> '');

-- m. 1434(2), mirroring the token's own ensure clauses.
ALTER TABLE policies ADD CONSTRAINT policies_withdrawal_facts_together
  CHECK ((withdrawn_at IS NULL) = (withdrawal_path IS NULL));
ALTER TABLE policies ADD CONSTRAINT policies_withdrawal_needs_due_date
  CHECK (withdrawn_at IS NULL OR premium_due_date IS NOT NULL);
ALTER TABLE policies ADD CONSTRAINT policies_enforcement_needs_due_date
  CHECK (enforcement_commenced_at IS NULL OR premium_due_date IS NOT NULL);
-- The two premium mechanisms are mutually exclusive on one policy:
-- m. 1434(2) is the first premium, m. 1434(3) the ones that follow.
ALTER TABLE policies ADD CONSTRAINT policies_premium_mechanisms_exclusive
  CHECK (premium_due_date IS NULL OR notice_service_date IS NULL);
-- m. 1434(4), mirroring the token's own ensure clauses.
ALTER TABLE policies ADD CONSTRAINT policies_notice_dates_match_count
  CHECK (notice_count = COALESCE(array_length(notice_service_dates, 1), 0));
ALTER TABLE policies ADD CONSTRAINT policies_two_notice_facts_together
  CHECK ((two_notice_election_at IS NULL) = (two_notice_effective_at IS NULL));
ALTER TABLE policies ADD CONSTRAINT policies_two_notice_effect_is_deferred
  CHECK (two_notice_election_at IS NULL OR two_notice_effective_at > two_notice_election_at);
-- v22, mirroring migration 036.
ALTER TABLE policies ADD CONSTRAINT policies_archive_instants_together
  CHECK ((contract_ended_at IS NULL) = (record_closed_at IS NULL));

-- m. 1456(6), mirroring the token's own ensure clauses. Ordering only --
-- deliberately NOT provided_at >= requested_at, because the outstanding state
-- is expressed by a later request sitting in front of an older response.
ALTER TABLE policies ADD CONSTRAINT policies_mortgagee_info_response_needs_request
  CHECK (mortgagee_info_provided_at IS NULL OR mortgagee_info_requested_at IS NOT NULL);
ALTER TABLE policies ADD CONSTRAINT policies_mortgagee_info_needs_mortgagee
  CHECK (mortgagee_info_requested_at IS NULL OR mortgagee_policyholder_id IS NOT NULL);

-- m. 1431(4), mirroring the token's own ensure clauses. The three facts
-- happen in one order and only that order, enforced here as well so the
-- sequence cannot be bypassed by writing SQL directly.
ALTER TABLE policies ADD CONSTRAINT policies_enforcement_route_known
  CHECK (enforcement_route IS NULL OR enforcement_route IN ('ER_Takip', 'ER_Dava'));
ALTER TABLE policies ADD CONSTRAINT policies_enforcement_fruitless_facts_together
  CHECK ((enforcement_fruitless_at IS NULL) = (enforcement_route IS NULL));
ALTER TABLE policies ADD CONSTRAINT policies_substitution_notice_needs_fruitless
  CHECK (substitution_notified_at IS NULL OR enforcement_fruitless_at IS NOT NULL);
ALTER TABLE policies ADD CONSTRAINT policies_substitution_needs_notice
  CHECK (substituted_at IS NULL OR substitution_notified_at IS NOT NULL);
ALTER TABLE policies ADD CONSTRAINT policies_superseded_party_with_substitution
  CHECK ((substituted_at IS NULL) = (superseded_policyholder_id IS NULL));
-- After substitution the two roles are held by one person.
ALTER TABLE policies ADD CONSTRAINT policies_substitution_moved_the_party
  CHECK (substituted_at IS NULL OR policyholder_id = insured_policyholder_id);
ALTER TABLE policies ADD CONSTRAINT policies_withdrawal_path_known
  CHECK (withdrawal_path IS NULL OR withdrawal_path IN ('WP_InsurerWithdrew', 'WP_DeemedNoEnforcement'));

-- firstPremiumSweeper.js's state test.
CREATE INDEX idx_policies_first_premium_open
  ON policies (premium_due_date)
  WHERE default_state = 'first_premium_unpaid' AND enforcement_commenced_at IS NULL;
-- Change C: policies whose cover never began. They cannot be swept -- the
-- text gives no basis to end a contract merely because cover has not
-- started -- so the dashboards surface them as inert instead.
CREATE INDEX idx_policies_cover_not_begun
  ON policies (created_at)
  WHERE coverage_began_at IS NULL AND status NOT IN ('expired', 'cancelled', 'claimed_and_closed');
-- The vacuous passes, findable. A policy minted over a cell the platform had
-- never observed is the one shape whose "check ran" record proves least.
CREATE INDEX idx_policies_retro_check_vacuous
  ON policies (retroactive_cover_checked_at)
  WHERE retroactive_cover_check_status = 'RC_PassedNoDataForCells';
-- THE FREEZE. graceSweeper.js must not queue a termination for a substituted
-- policy: m. 1431(4)'s "sözleşme bu kişilerle devam eder" cannot coexist with
-- m. 1434(3)'s "sözleşme feshedilmiş olur". That incompatibility is the whole
-- of the reasoning -- no article says the clock stops, resets or runs on, and
-- nothing here asserts any of those. The sweeper's predicate carries the
-- exclusion; this index keeps it cheap.
-- The outstanding m. 1456(6) requests: the insurer owes an answer on these.
-- The article sets no deadline and none is computed anywhere; this only makes
-- the state findable.
CREATE INDEX idx_policies_mortgagee_info_outstanding
  ON policies (mortgagee_info_requested_at)
  WHERE mortgagee_info_requested_at IS NOT NULL
    AND (mortgagee_info_provided_at IS NULL
         OR mortgagee_info_provided_at < mortgagee_info_requested_at);
-- The pending m. 1434(4) elections, for the sweeper -- a state test, and the
-- instant is the frozen period end rather than a clock reading.
CREATE INDEX idx_policies_two_notice_pending
  ON policies (two_notice_effective_at)
  WHERE default_state = 'two_notice_elected';
CREATE INDEX idx_policies_substituted
  ON policies (substituted_at)
  WHERE substituted_at IS NOT NULL;
CREATE INDEX idx_policies_mortgagee ON policies (mortgagee_policyholder_id)
  WHERE mortgagee_policyholder_id IS NOT NULL;
CREATE INDEX idx_policies_expiry_open ON policies(expiry) WHERE status IN ('active', 'partially_paid');
-- Phase two of termination: terminated contracts whose token is still live
-- because a payout raised on it had not yet resolved (Stage 4).
CREATE INDEX idx_policies_terminated_unarchived
  ON policies (terminated_at)
  WHERE default_state = 'terminated' AND daml_contract_id IS NOT NULL;
CREATE INDEX idx_policies_default_state ON policies(default_state);
CREATE INDEX idx_policies_predecessor ON policies(predecessor_policy_id);
-- A given policy may be succeeded by at most one other.
CREATE UNIQUE INDEX idx_policies_renewed_by_unique
  ON policies (renewed_by_policy_id) WHERE renewed_by_policy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4z. policy_coverages -- Stage 2 Part 2: one row per coverage on a
--    package policy (fire, theft, glass, ... -- or just one row for a
--    single-coverage product like today's frost policy, no special case).
--    Mirrors the Daml token's own Coverage record field-for-field.
--    payout_tiers_snapshot keeps the same snapshot semantics the old
--    policy-level column had: frozen at policy creation time, so editing
--    payout_tiers afterward never affects an already-created policy.
--    product_code/peril_type/cell_ids moved here from `policies` too --
--    tier lookup and oracle cell-reading both happen per coverage now.
-- ---------------------------------------------------------------------------
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
  -- m. 1457. The attachment of the insured property, and its lifting.
  --
  -- AN APPROXIMATION, stated rather than hidden: the article attaches to the
  -- PROPERTY ("Sigortalı mal haczedilirse") and this system has no property
  -- registry. The coverage is its nearest honest unit -- the same
  -- approximation v17 made for the mortgagee's charge one column above.
  --
  -- Attached NOW means attached_at is set and attachment_lifted_at is NULL or
  -- OLDER than it. A lifting older than the attachment in front of it is how
  -- "attached again" is expressed, which is why there is no >= constraint
  -- between them.
  --
  -- Lifting is a fact the Code anticipates, not one this system invented: the
  -- officer's ihtar binds "diğer bir bildirime kadar". No case number, court,
  -- office identifier or party identity is held for any of it.
  attached_at             TIMESTAMPTZ,
  attachment_lifted_at    TIMESTAMPTZ,
  -- v22 (migration 036). The metric code the coverage's tiers are written
  -- for the metric -- required at the API and checked there against the codes the
  -- oracle can supply; what a tier percentage is a percentage OF, with
  -- no default; and the salt of the cell commitment the token and every
  -- trigger carry, "sha256:" + hex(SHA-256(salt || cell id)). The salt
  -- never reaches the ledger. Random, not a product value, so a default draws
  -- it.
  metric                  TEXT NOT NULL,
  payout_basis            TEXT NOT NULL,
  cell_commitment_salt    TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, coverage_code)
);

CREATE INDEX idx_policy_coverages_policy ON policy_coverages(policy_id);

-- Non-negativity only. "a claim amount requires a policy-level mortgagee"
-- spans two tables and cannot be a CHECK; routes/policies.js and PolicyToken's
-- ensure clause enforce that, and the ledger is the one that cannot be
-- bypassed.
--
-- >= rather than >, since m. 1456 routing (migration 019) DECREMENTS this as
-- payouts are routed to the mortgagee. It falls to 0 and stays there, never
-- back to NULL: "charged and exhausted" and "never charged" are different
-- facts that route differently.
-- m. 1457: a lifting needs something to lift.
ALTER TABLE policy_coverages ADD CONSTRAINT policy_coverages_lifting_needs_attachment
  CHECK (attachment_lifted_at IS NULL OR attached_at IS NOT NULL);
ALTER TABLE policy_coverages ADD CONSTRAINT policy_coverages_claim_needs_mortgagee
  CHECK (mortgagee_claim_amount IS NULL OR mortgagee_claim_amount >= 0);
ALTER TABLE policy_coverages ADD CONSTRAINT policy_coverages_metric_not_empty
  CHECK (metric <> '');
ALTER TABLE policy_coverages ADD CONSTRAINT policy_coverages_payout_basis_known
  CHECK (payout_basis IN ('PB_RemainingLimit', 'PB_SumInsured'));
ALTER TABLE policy_coverages ADD CONSTRAINT policy_coverages_cell_commitment_salt_hex
  CHECK (cell_commitment_salt ~ '^[0-9a-f]{64}$');
CREATE INDEX idx_policies_status ON policies(status);
CREATE INDEX idx_policies_contract_id ON policies(daml_contract_id);

-- ---------------------------------------------------------------------------
-- 4a0. oracle_raw_responses -- the provider response each reading came from,
--    byte for byte, with its SHA-256 (migration 031). Declared HERE, before
--    oracle_readings, which references it. The provider does not give the
--    same answer twice for the same moment, so the one actually received is
--    kept and its hash goes onto the ledger inside attestationRef. The table
--    refuses UPDATE and ties the hash to the bytes with a CHECK; DELETE is
--    allowed for retention and test cleanup. What makes a swapped body
--    detectable is the copy of the hash on the ledger.
--    Migration 032 narrows that DELETE: a response whose hash has been sent to
--    the ledger is held by attested_evidence (4a0b, below) and can no longer
--    be deleted, whatever is deleted around it first; a response never
--    attested still can.
-- ---------------------------------------------------------------------------
CREATE TABLE oracle_raw_responses (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_url          TEXT NOT NULL,
  request_params       JSONB NOT NULL,
  http_status          INTEGER NOT NULL,
  -- The body exactly as the application received it (after the transport's
  -- gzip is undone), not a re-serialisation of the parsed JSON.
  body                 BYTEA NOT NULL,
  sha256               TEXT NOT NULL,
  -- The provider's own statement of when its data was produced, verbatim.
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

-- ---------------------------------------------------------------------------
-- 4a0b. attested_evidence -- the responses whose hash has been sent to the
--    ledger (migration 032). Declared HERE, after oracle_raw_responses, the
--    only table it references. Each row holds its response against DELETE
--    through a RESTRICT foreign key, so deleting the payouts, outbox rows,
--    windows and readings first leaves the bytes exactly where they were.
--    Everything else is a plain value -- the policy, the window and the outbox
--    row stay deletable -- and the attestation is kept as it was sent. The
--    dispatcher writes the rows before the exercise that carries the hash: for
--    a min or max the deciding reading's response, for a mean every response
--    the window combines. UPDATE is always refused; DELETE and TRUNCATE only
--    go through in a database whose catalog marks it as a test database.
--    This stops an accidental or scripted delete, not a role that can drop
--    the table or its triggers or mark the database.
-- ---------------------------------------------------------------------------
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

-- The foreign-key check on every DELETE from oracle_raw_responses looks rows up
-- by raw_response_id, which the primary key cannot serve (migration 033).
CREATE INDEX idx_attested_evidence_raw_response ON attested_evidence(raw_response_id);

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

-- ---------------------------------------------------------------------------
-- 4a. oracle_readings -- Module 4: raw readings ingested by the oracle bot
--    before/after being submitted to the ledger via EvaluateTrigger.
--
--    Declared HERE, before policy_events, because policy_events.reading_id
--    references it. It was numbered 6 and declared after that table until
--    the ordering fix; nothing about the table itself changed.
-- ---------------------------------------------------------------------------
CREATE TABLE oracle_readings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id             UUID NOT NULL REFERENCES policies(id),
  coverage_code         TEXT NOT NULL,                -- which of the policy's coverages this cell belongs to (Stage 2 Part 2)
  cell_id               TEXT NOT NULL,
  metric                TEXT NOT NULL,               -- e.g. TEMPERATURE_C
  value                 NUMERIC(12,4) NOT NULL,
  measured_at           TIMESTAMPTZ NOT NULL,
  source                TEXT NOT NULL,               -- e.g. name of the weather/IoT provider
  submitted_to_ledger   BOOLEAN NOT NULL DEFAULT FALSE,
  daml_result           JSONB,                       -- EvaluateTriggerResult returned by the ledger
  raw_response_id       UUID REFERENCES oracle_raw_responses(id), -- the response this reading came from (migration 031); NULL for readings written directly
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oracle_readings_policy ON oracle_readings(policy_id);
-- m. 1458's check joins readings to coverages by CELL, never by policy: a
-- brand-new backdated policy has no readings of its own, so the readings
-- that matter belong to other policies covering the same ground.
CREATE INDEX idx_oracle_readings_cell_measured ON oracle_readings (cell_id, measured_at);

-- ---------------------------------------------------------------------------
-- 4a2. trigger_windows -- one row per evaluated event window (migration 030).
--    Declared HERE, after oracle_readings (determining_reading_id) and before
--    policy_events (trigger_window_id). Before this table every reading
--    produced its own trigger, so one frost night of eight readings paid
--    eight times; now a coverage is evaluated once per window. The UNIQUE key
--    is the idempotency guarantee for the window, and the rule that produced
--    the row is recorded on it, so each evaluation is self-describing.
-- ---------------------------------------------------------------------------
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
  -- The reading that decided the value for min and max; a mean has none, and
  -- the constraint below holds that line in the table itself.
  determining_reading_id UUID REFERENCES oracle_readings(id),
  reading_ids            UUID[] NOT NULL,
  -- The attestation built when the window closed, and the single source the
  -- dispatcher reads, so the ledger copy and this one cannot drift (031).
  attestation_ref        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- v22 (migration 036). The event interval the trigger sends: the window
  -- clipped to the recorded cover start and to the contract's end as SQL
  -- records it when the window is queued. Written once, at queueing. NULL on
  -- a row written before v22, never backfilled.
  event_start            TIMESTAMPTZ,
  event_end              TIMESTAMPTZ,
  CONSTRAINT trigger_windows_key UNIQUE (policy_id, coverage_code, cell_id, window_start),
  CONSTRAINT trigger_windows_ordered CHECK (window_end > window_start),
  CONSTRAINT trigger_windows_aggregation_known CHECK (aggregation IN ('min', 'max', 'mean')),
  CONSTRAINT trigger_windows_has_readings CHECK (cardinality(reading_ids) > 0),
  CONSTRAINT trigger_windows_determining_reading
    CHECK ((aggregation = 'mean') = (determining_reading_id IS NULL))
);
-- v22, mirroring migration 036.
ALTER TABLE trigger_windows ADD CONSTRAINT trigger_windows_event_interval
  CHECK ((event_start IS NULL) = (event_end IS NULL)
         AND (event_start IS NULL
              OR (event_start < event_end AND event_start >= window_start AND event_end <= window_end)));

-- ---------------------------------------------------------------------------
-- 4b. policy_events -- the outbox. This table, and only this table, is what
--    authorizes node/src/dispatch/dispatcher.js to touch the ledger. A
--    stray write to `policies` must never cause a ledger action on its
--    own. Every ledger-changing action for every event type enters here --
--    there is no second channel and no per-event-type table.
--    Every event type has a working dispatcher handler (EVENT_HANDLERS)
--    except 'release' and 'suspension', which are accepted and explicitly
--    rejected when processed (notImplemented, not silently skipped).
--    Idempotency is scoped per event type via partial unique indexes
--    below, not one shared triple -- a (policy_no,
--    expected_version) pair is not a unique key for a *reading* (two
--    different readings can legitimately share it), and 'settlement' has
--    no policy-version concept at all, only a PayoutApproved contract id.
--    A 'failed' row (wrong expected_version, ledger rejection, or a
--    write-back that failed after the ledger already succeeded) is never
--    auto-retried, rebased, or cleaned up -- it waits for a human.
-- ---------------------------------------------------------------------------
-- 'suspension' is DEAD from Stage 4 on -- see the default_state comment.
-- Nothing writes it; historical rows carrying it stay readable.
-- ORDER DIVERGENCE, deliberate and recorded -- the same case as
-- policy_status above, and the full reasoning is there. This list is grouped
-- by meaning; a database grown through sql/migrations/ carries the same
-- values in the chronological order the features were built (003's five
-- first, then 006, 008, 009, 013, 016, 020, 022, 024, 026 appending). Same
-- set, different sort.
-- Guarded by node/test/enumOrdering.test.mjs.
CREATE TYPE event_type AS ENUM ('activation', 'trigger', 'settlement', 'expiry', 'notice', 'suspension', 'termination', 'termination_archive', 'mortgagee_notice', 'mortgagee_election', 'reinstatement', 'endorsement', 'renewal', 'release',
  -- m. 1434(2). Each is a distinct act with a distinct consequence, so each
  -- gets its own type; the dispatcher's handler map is where they differ.
  'premium_due_date', 'enforcement_commenced', 'first_premium_paid',
  'first_premium_withdrawal', 'first_premium_deemed_withdrawal',
  -- m. 1431(4). Three acts, three types: the platform cannot infer any of
  -- them from another, and the dispatcher's handler map is where they differ.
  'enforcement_fruitless', 'substitution_notice', 'substitution',
  -- m. 1456(6). The request is the mortgagee's act reported by the insurer;
  -- the response is the insurer's own.
  'mortgagee_info_request', 'mortgagee_info_provided',
  -- m. 1434(4). The election is an act; the landing is a consequence a
  -- sweeper observes, exactly like the m. 1434(3) termination.
  'two_notice_election', 'two_notice_termination',
  -- m. 1457. Two acts, both reported from outside -- the platform cannot
  -- observe an icra file.
  'attachment', 'attachment_lifted');

CREATE TABLE policy_events (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_no              UUID NOT NULL REFERENCES policies(id),
  event_type             event_type NOT NULL,
  expected_version       INTEGER,                     -- the token version this event is built on; 0 for activation, informational for trigger, NULL (no concept) for settlement
  reading_id             UUID REFERENCES oracle_readings(id), -- the 'trigger' idempotency key before migration 030, left over from then; no production path writes it -- trigger_window_id below is the key now
  trigger_window_id      UUID REFERENCES trigger_windows(id), -- idempotency key for windowed 'trigger' rows (migration 030) -- one evaluation per (coverage, cell, window)
  source_contract_id     TEXT,                         -- idempotency key for 'settlement' -- the PayoutApproved contract id being processed
  payload                JSONB,                       -- event-specific data only; the platform accepts no name, national id, IBAN or document content, so none is copied here -- but a 'settlement' row holds the insurer's free text (bank reference, failure reason, note) raw, beside its salt, and that text is whatever the insurer typed; the ledger gets only its salted digest; carries observedValue/metric for 'trigger'
  status                 outbox_status NOT NULL DEFAULT 'pending',
  resulting_contract_id  TEXT,
  error                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_policy_events_activation_key
  ON policy_events (policy_no, expected_version) WHERE event_type = 'activation';
CREATE UNIQUE INDEX idx_policy_events_trigger_key
  ON policy_events (reading_id) WHERE event_type = 'trigger';
-- A second trigger row for one window cannot be created, whatever inserts
-- it (migration 030). This is the trigger idempotency key;
-- idx_policy_events_trigger_key above, on reading_id, is left over from
-- before migration 030, and no production path writes reading_id. Partial,
-- so a row with no window can still be inserted -- the dispatcher refuses
-- such a row before sending anything, and only that refusal's test in
-- node/test/dispatcher.test.mjs still writes one.
CREATE UNIQUE INDEX idx_policy_events_trigger_window_key
  ON policy_events (trigger_window_id) WHERE event_type = 'trigger' AND trigger_window_id IS NOT NULL;
-- In-flight only (Stage 4), like every other lifecycle event type since
-- migration 010: a rejected settlement report must not permanently consume
-- a payout's only chance to be reported on. "A payout ends once" is
-- enforced by handleSettlement's resolved_at check and by the ledger.
CREATE UNIQUE INDEX idx_policy_events_settlement_key
  ON policy_events (source_contract_id)
  WHERE event_type = 'settlement' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_expiry_key
  ON policy_events (policy_no) WHERE event_type = 'expiry';
-- Stage 3 Part 3 re-scoped these four from "once per policy, ever" to
-- "at most one IN FLIGHT per policy". The old shape made a second default
-- cycle impossible -- a reinstated policy could never receive a later
-- notice -- which was a known limitation in Part 2 and is fixed here.
-- Restricting to pending/processing keeps the guarantee that actually
-- mattered (never queue the same action twice concurrently) while allowing
-- a policy to default, be reinstated, and default again; endorsements
-- likewise happen many times over a policy's life.
CREATE UNIQUE INDEX idx_policy_events_notice_key
  ON policy_events (policy_no) WHERE event_type = 'notice' AND status IN ('pending', 'processing');
-- Dead alongside the 'suspension' event type itself; kept so a database
-- built from this file matches one migrated up through 013.
CREATE UNIQUE INDEX idx_policy_events_suspension_key
  ON policy_events (policy_no) WHERE event_type = 'suspension' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_termination_key
  ON policy_events (policy_no) WHERE event_type = 'termination' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_termination_archive_key
  ON policy_events (policy_no) WHERE event_type = 'termination_archive' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_mortgagee_notice_key
  ON policy_events (policy_no) WHERE event_type = 'mortgagee_notice' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_premium_due_date_key
  ON policy_events (policy_no) WHERE event_type = 'premium_due_date' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_enforcement_commenced_key
  ON policy_events (policy_no) WHERE event_type = 'enforcement_commenced' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_first_premium_paid_key
  ON policy_events (policy_no) WHERE event_type = 'first_premium_paid' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_first_premium_withdrawal_key
  ON policy_events (policy_no) WHERE event_type = 'first_premium_withdrawal' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_first_premium_deemed_key
  ON policy_events (policy_no) WHERE event_type = 'first_premium_deemed_withdrawal' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_attachment_key
  ON policy_events (policy_no) WHERE event_type = 'attachment' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_attachment_lifted_key
  ON policy_events (policy_no) WHERE event_type = 'attachment_lifted' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_two_notice_election_key
  ON policy_events (policy_no) WHERE event_type = 'two_notice_election' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_two_notice_termination_key
  ON policy_events (policy_no) WHERE event_type = 'two_notice_termination' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_mortgagee_info_request_key
  ON policy_events (policy_no) WHERE event_type = 'mortgagee_info_request' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_mortgagee_info_provided_key
  ON policy_events (policy_no) WHERE event_type = 'mortgagee_info_provided' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_enforcement_fruitless_key
  ON policy_events (policy_no) WHERE event_type = 'enforcement_fruitless' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_substitution_notice_key
  ON policy_events (policy_no) WHERE event_type = 'substitution_notice' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_substitution_key
  ON policy_events (policy_no) WHERE event_type = 'substitution' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_mortgagee_election_key
  ON policy_events (policy_no) WHERE event_type = 'mortgagee_election' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_reinstatement_key
  ON policy_events (policy_no) WHERE event_type = 'reinstatement' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_endorsement_key
  ON policy_events (policy_no) WHERE event_type = 'endorsement' AND status IN ('pending', 'processing');
-- Keyed on the PREDECESSOR's policy id -- a renewal is an act on the policy
-- being renewed (which is also the id handleRenewal advisory-locks).
CREATE UNIQUE INDEX idx_policy_events_renewal_key
  ON policy_events (policy_no) WHERE event_type = 'renewal' AND status IN ('pending', 'processing');

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

-- ---------------------------------------------------------------------------
-- 4c. policy_documents -- one document mechanism for every named Turkish
--    insurance document (offer, endorsement, renewal, release, formal
--    notice), not a separate table/type per document. Off-ledger only --
--    never store content, a signature, a name, or a national id here or
--    on the ledger, only a hash + an external storage pointer. A row here
--    never changes policy state by itself; state changes come from a
--    policy_events row, and a document is evidence attached to one. No
--    document-type handling is implemented yet -- this is schema only.
-- ---------------------------------------------------------------------------
CREATE TYPE document_type AS ENUM ('offer', 'endorsement', 'renewal', 'release', 'formal_notice');

-- (endorsement_reason is declared up in the enumerations block near the top
-- of this file, not here where it used to sit -- `policies` gained a
-- last_amendment_reason column of that type in Stage 3 Part 3, and
-- `policies` is created well before this section, so the type has to exist
-- by then for a fresh top-to-bottom run of this file to work.)

CREATE TABLE policy_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id           UUID NOT NULL REFERENCES policies(id),
  document_type       document_type NOT NULL,
  endorsement_reason  endorsement_reason,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_at        TIMESTAMPTZ NOT NULL,
  content_hash        TEXT NOT NULL,
  storage_reference   TEXT NOT NULL,
  produced_by_event   UUID REFERENCES policy_events(id),  -- which outbox row (if any) produced this document
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (document_type = 'endorsement' OR endorsement_reason IS NULL)
);

CREATE INDEX idx_policy_documents_policy ON policy_documents(policy_id);
CREATE INDEX idx_policy_documents_type ON policy_documents(document_type);

-- ---------------------------------------------------------------------------
-- 5. policy_status_history -- append-only audit trail, one row per
--    Archive+Create cycle on the Daml side (mint, partial re-mint, cancelled,
--    settle, expire). Without contract keys on this PV34 network, this is
--    the supersession chain -- the only audit trail linking a re-minted
--    token to its predecessor. Never key anything off old/new
--    _daml_contract_id (plain TEXT, not a foreign key) -- policy_id is the
--    stable identity.
-- ---------------------------------------------------------------------------
CREATE TABLE policy_status_history (
  id                    BIGSERIAL PRIMARY KEY,
  policy_id             UUID NOT NULL REFERENCES policies(id),
  event_type            event_type,
  old_status            policy_status,
  new_status            policy_status NOT NULL,
  -- The premium-default axis (Stage 3 Part 3). Both NULL on an event that
  -- moved only the claim axis; both set on notice, termination,
  -- reinstatement and the first-premium and two-notice events, which move
  -- only this one and leave status unchanged ('suspension' is dead -- see
  -- the event_type comment).
  old_default_state     default_state,
  new_default_state     default_state,
  old_daml_contract_id  TEXT,
  new_daml_contract_id  TEXT,
  reason                TEXT,
  changed_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 7. payout_events -- one row per Daml PayoutApproved contract, plus the
--    unrouted rows (record_kind below), which have no PayoutApproved.
--    Inserted by dispatch/dispatcher.js (handleTrigger) and
--    listeners/payoutListener.js; UNIQUE(daml_contract_id) is what makes
--    both idempotent if they ever race on the same event.
-- ---------------------------------------------------------------------------
CREATE TABLE payout_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id            UUID NOT NULL REFERENCES policies(id),
  coverage_code        TEXT NOT NULL,               -- which coverage this payout came from (Stage 2 Part 2)
  oracle_reading_id    UUID REFERENCES oracle_readings(id),
  trigger_window_id    UUID REFERENCES trigger_windows(id), -- the aggregated event that caused this payout (migration 031); names every reading, including a mean's
  tier_label           TEXT,
  -- v22 (migration 036): the rate the ledger applied, at a Daml Decimal's ten
  -- places, so an interpolated rate from a linear tier is held exactly.
  payout_percentage    NUMERIC(13,10) NOT NULL,
  payout_amount        NUMERIC(14,2) NOT NULL CHECK (payout_amount > 0),
  currency             TEXT NOT NULL,
  is_full_settlement   BOOLEAN NOT NULL DEFAULT FALSE,
  status               payout_event_status NOT NULL DEFAULT 'approved',
  -- The PayoutApproved that started the chain; never overwritten. NULLABLE
  -- only for an unrouted remainder (record_kind below), which has no
  -- PayoutApproved by construction -- it is the part of an indemnity that
  -- never became one. UNIQUE still holds: Postgres permits many NULLs in a
  -- unique index.
  daml_contract_id     TEXT UNIQUE,
  -- Which recipient this row is owed to, mirroring PayoutApproved.recipient
  -- (m. 1456). One row per recipient, because m. 1427 runs maturity and
  -- default per claim: paying the bank does not discharge what is owed to the
  -- insured. NULL on an unrouted remainder -- nobody has decided who it goes
  -- to, and that is the point of it.
  recipient            TEXT,
  -- 'payout'             a PayoutApproved exists and someone is owed this.
  -- 'unrouted_remainder' the excess over the mortgagee's remaining secured
  --                      claim on a charged coverage. m. 1456(2) forbids
  --                      paying the sigortalı without izin and offers no
  --                      surplus carve-out, so this is recorded for a human
  --                      rather than routed. A ManualReviewRequired exists;
  --                      no PayoutApproved does.
  -- 'unrouted_competing_claims'
  --                      m. 1456's charge and m. 1457's attachment both bite
  --                      on one coverage. The Code supplies no priority rule
  --                      -- they sit as (a) sınırlı ayni hak and (b) haciz
  --                      under one heading, two species of one genus -- and
  --                      the ranking question is İcra ve İflas Kanunu
  --                      territory, not in this repository. NOTHING routes,
  --                      and the mortgagee's claim is not decremented either.
  --
  -- One table on purpose: a remainder resolves through the same
  -- ManualReviewRequired_Resolve* paths as a failed payout, inheriting
  -- close-unpaid and resolve-settled rather than needing a second queue.
  record_kind          TEXT NOT NULL DEFAULT 'payout',
  -- Stage 4. The platform never moves money: bank_reference is an opaque
  -- string the insurer reports AFTER settling through its own systems, not
  -- a means of paying, and settled_at is its reported date -- an external
  -- fact like notice_service_date, never a system clock reading. No IBAN or
  -- account number is stored here or anywhere else, by design.
  bank_reference       TEXT,
  settled_at           TIMESTAMPTZ,
  paid_role            TEXT,                        -- PDR_Insured / PDR_Mortgagee / PDR_Beneficiary / PDR_EnforcementOffice, as asserted
  unpaid_reason        TEXT,                        -- UR_Waived / UR_Disputed / UR_Litigation / UR_Other
  resolution_note      TEXT,
  review_contract_id   TEXT,                        -- the ManualReviewRequired superseding it, if MarkFailed fired
  resolved_at          TIMESTAMPTZ,                 -- when a terminal state was reached; elapsed time derived, never stored
  -- The approval instant as the LEDGER recorded it: PayoutApproved.approvedAt,
  -- which is the same `now` the dispatcher hands PolicyToken_EvaluateTrigger --
  -- not the moment the SQL row happened to be written. On an unrouted row
  -- (record_kind above), which has no PayoutApproved, it is the review
  -- item's ManualReviewRequired.flaggedAt, the same `now` of the same
  -- exercise. m. 1427 runs maturity
  -- from the approval, so the value carried to the insurer has to be the value
  -- on the ledger. NULL means a row written before this column existed; there
  -- is no backfill, because no true value for those rows exists off the ledger.
  approved_at          TIMESTAMPTZ,
  -- v22 (migration 036). The event the payout was approved for, as the
  -- trigger sent it ([event_start, event_end)), and the evidence digest
  -- the ledger recorded on PayoutApproved; the insurer's declared
  -- closing instant on a review item closed unpaid; and the PayoutSettled or
  -- PayoutClosedUnpaid the resolution left on the ledger. NULL on a row
  -- written before v22; never backfilled, the same rule as approved_at.
  event_start          TIMESTAMPTZ,
  event_end            TIMESTAMPTZ,
  evidence_digest      TEXT,
  closed_at            TIMESTAMPTZ,
  resolution_record_contract_id TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN payout_events.approved_at IS
  'Mirror of the ledger''s PayoutApproved.approvedAt. NULL = row written before this column existed; never backfilled.';

-- m. 1456 routing constraints, mirroring migration 019.
ALTER TABLE payout_events ADD CONSTRAINT payout_events_recipient_known
  CHECK (recipient IS NULL
         OR recipient IN ('PDR_Insured', 'PDR_Mortgagee', 'PDR_Beneficiary', 'PDR_EnforcementOffice'));
ALTER TABLE payout_events ADD CONSTRAINT payout_events_record_kind_known
  CHECK (record_kind IN ('payout', 'unrouted_remainder', 'unrouted_competing_claims'));
ALTER TABLE payout_events ADD CONSTRAINT payout_events_contract_id_matches_kind
  CHECK ((record_kind = 'payout') = (daml_contract_id IS NOT NULL));
-- A remainder is a review item from the moment it exists -- never 'approved',
-- because nothing approved paying it to anyone.
ALTER TABLE payout_events ADD CONSTRAINT payout_events_remainder_needs_review
  CHECK (record_kind = 'payout'
         OR (review_contract_id IS NOT NULL AND recipient IS NULL));
-- v22, mirroring migration 036.
ALTER TABLE payout_events ADD CONSTRAINT payout_events_event_interval
  CHECK ((event_start IS NULL) = (event_end IS NULL)
         AND (event_start IS NULL OR event_start < event_end));
ALTER TABLE payout_events ADD CONSTRAINT payout_events_evidence_digest_form
  CHECK (evidence_digest IS NULL OR evidence_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE payout_events ADD CONSTRAINT payout_events_record_only_when_resolved
  CHECK (resolution_record_contract_id IS NULL OR status IN ('settled', 'closed_unpaid'));
ALTER TABLE payout_events ADD CONSTRAINT payout_events_closed_at_only_when_closed_unpaid
  CHECK (closed_at IS NULL OR status = 'closed_unpaid');

-- The unrouted remainders, findable. A queue a human has to work: m. 1456(3)
-- makes leaving one unattended the insurer's exposure, not untidiness.
-- The coverages currently under attachment (m. 1457).
CREATE INDEX idx_policy_coverages_attached
  ON policy_coverages (policy_id, coverage_code)
  WHERE attached_at IS NOT NULL
    AND (attachment_lifted_at IS NULL OR attachment_lifted_at < attached_at);

-- The competing-claims review items -- the ones a human must work, because
-- nothing was routed on them at all.
CREATE INDEX idx_payout_events_competing_claims
  ON payout_events (policy_id, created_at)
  WHERE record_kind = 'unrouted_competing_claims' AND resolved_at IS NULL;

CREATE INDEX idx_payout_events_unrouted
  ON payout_events (policy_id, created_at)
  WHERE record_kind = 'unrouted_remainder' AND resolved_at IS NULL;

CREATE INDEX idx_payout_events_unresolved
  ON payout_events (created_at) WHERE resolved_at IS NULL;

CREATE INDEX idx_payout_events_status ON payout_events(status);

-- ---------------------------------------------------------------------------
-- 8. payout_notifications -- the queue of what the insurer is to be told
--    about an approved payout (migration 035).
--
--    NOT a policy_events row. That table is the outbox for ledger-changing
--    actions and forbids retry on purpose (README "One outbox...",
--    dispatch/dispatcher.js's header comment on the outbox and
--    processEvent's "never auto-retried" comment): a create or an exercise that
--    already succeeded must never be attempted twice. An HTTPS notification is
--    the opposite kind of work -- it has to be retried until it lands. So it
--    gets a table of its own, run with the same discipline (a status-transition
--    trigger in the table, ownership by SKIP LOCKED), and the dispatcher stays
--    the single path to the ledger.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_insurers_updated_at BEFORE UPDATE ON insurers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_policyholders_updated_at BEFORE UPDATE ON policyholders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_policies_updated_at BEFORE UPDATE ON policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_policy_coverages_updated_at BEFORE UPDATE ON policy_coverages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_payout_events_updated_at BEFORE UPDATE ON payout_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_payout_notifications_updated_at BEFORE UPDATE ON payout_notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
