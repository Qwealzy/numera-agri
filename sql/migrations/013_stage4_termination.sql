-- ============================================================================
-- Termination for non-payment (TTK 6102 m. 1434(3)).
--
-- Replaces the suspension model, which was wrong on the statute. m. 1434(3):
-- at the end of the notice period the contract is `feshedilmiş olur` --
-- deemed TERMINATED. That is a consequence, not a power the insurer may
-- choose to exercise; there is no suspension state in the paragraph; and
-- m. 1452(3) makes m. 1434 non-derogable against the insured, so the
-- general conditions cannot introduce one either.
--
-- 'suspended' CANNOT be removed from the default_state enum. Postgres has no
-- DROP VALUE, and policy_status_history is append-only and legitimately
-- holds rows carrying it from before this change -- those are historical
-- facts about what the system did, and rewriting them would be dishonest.
-- It becomes a DEAD value, exactly like 'grace_period'/'suspended' in
-- policy_status. No application code writes it after this migration.
-- ============================================================================

ALTER TYPE default_state ADD VALUE 'terminated';

-- The facts a premium refund is computed from (m. 1419, protected by
-- m. 1452(3)), and nothing more. There is deliberately NO refund amount and
-- NO premium figure here: the insurer holds the premium and does the
-- arithmetic, exactly as with set-off under m. 1431(5).
--
-- terminated_at is DERIVED FROM THE NOTICE -- the externally supplied
-- service date plus the policy's own grace period -- never a clock reading.
-- term_start mirrors the token's new termStart field (the policy term's
-- start instant, noon Europe/Istanbul), which the token never carried
-- before, so "days unrun" could not be derived from the contract alone.
ALTER TABLE policies ADD COLUMN term_start   TIMESTAMPTZ;
ALTER TABLE policies ADD COLUMN terminated_at TIMESTAMPTZ;
ALTER TABLE policies ADD COLUMN unrun_days   INTEGER;

-- m. 1456(4) and (5). All recorded facts, never actions: this system
-- generates and sends no notification. mortgagee_notified_at is the
-- insurer's reported date for having notified a known real-right holder;
-- the continuation window opens at termination and its end is computed from
-- configured days (below), never a literal; the election is recorded if one
-- is reported, and nothing acts on it.
ALTER TABLE policies ADD COLUMN mortgagee_notified_at          TIMESTAMPTZ;
ALTER TABLE policies ADD COLUMN mortgagee_continuation_ends_at TIMESTAMPTZ;
ALTER TABLE policies ADD COLUMN mortgagee_election             TEXT;
ALTER TABLE policies ADD COLUMN mortgagee_election_at          TIMESTAMPTZ;

-- The m. 1456(5) window length, per insurer. Nullable with NO default, for
-- the same reason default_grace_period_days is: a statutory period is
-- legally constrained configuration, never a literal in code or a SQL
-- default. If a policy names a mortgagee and this is unset, termination
-- fails loudly rather than assuming a number.
ALTER TABLE insurers ADD COLUMN mortgagee_continuation_days INTEGER;

-- Two new outbox event types. 'suspension' stays in the enum as dead --
-- same reason as above; 8 historical rows carry it.
ALTER TYPE event_type ADD VALUE 'termination';
ALTER TYPE event_type ADD VALUE 'termination_archive';

-- m. 1456(4) and (5), both insurer-reported facts arriving through the API
-- rather than from a sweeper.
ALTER TYPE event_type ADD VALUE 'mortgagee_notice';
ALTER TYPE event_type ADD VALUE 'mortgagee_election';

CREATE INDEX idx_policies_terminated_unarchived
  ON policies (terminated_at)
  WHERE default_state = 'terminated' AND daml_contract_id IS NOT NULL;

-- In-flight-scoped, as migrations 010 and 012 established. An unscoped index
-- permanently bricks a policy the moment a human-reported event is rejected
-- and needs correcting -- that has now bitten twice (notice/suspension in
-- 010, settlement in 012), so every new event type gets the scoped form from
-- the start.
CREATE UNIQUE INDEX idx_policy_events_termination_key
  ON policy_events (policy_no)
  WHERE event_type = 'termination' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_termination_archive_key
  ON policy_events (policy_no)
  WHERE event_type = 'termination_archive' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_mortgagee_notice_key
  ON policy_events (policy_no)
  WHERE event_type = 'mortgagee_notice' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_mortgagee_election_key
  ON policy_events (policy_no)
  WHERE event_type = 'mortgagee_election' AND status IN ('pending', 'processing');

-- Migrate the 5 existing suspended policies forward. Each one's contract
-- was, on the statute, terminated the moment its notice period elapsed --
-- the system merely recorded that wrongly as a suspension. terminated_at is
-- reconstructed the same way the new code computes it: the recorded notice
-- service date plus that policy's own grace period. unrun_days is the whole
-- days from there to the policy's expiry, floored at zero (a policy whose
-- term had already ended has none).
--
-- The token on the ledger is NOT touched by this migration. Those 5 tokens
-- carry a DS_Suspended that no longer exists in the new package, so they are
-- unreadable by this codebase after the package change and are archived by
-- the ordinary package-migration cleanup instead.
UPDATE policies SET
  default_state = 'terminated',
  terminated_at = notice_service_date + (grace_period_days * INTERVAL '1 day'),
  unrun_days = GREATEST(
    0,
    EXTRACT(DAY FROM (expiry - (notice_service_date + (grace_period_days * INTERVAL '1 day'))))::int
  )
WHERE default_state = 'suspended';

-- m. 1434(4): a second notice in the SAME insurance period gives the insurer
-- a further right. This COUNTS them and nothing else -- the right itself is
-- deliberately not implemented, and no code reads this column to act on it.
--
-- Mirrors the token's own noticeCount, which is where the count actually
-- lives; handleNotice reads it back off the re-minted contract rather than
-- incrementing here, so SQL can never drift from the ledger. Per insurance
-- period without a reset: a renewal is a new policy row and a new token,
-- both starting at zero. Reinstatement does NOT reset it -- paying after
-- the first notice is exactly the case the paragraph is about.
ALTER TABLE policies ADD COLUMN notice_count INTEGER NOT NULL DEFAULT 0;

-- Backfill from the append-only history rather than guessing: every notice
-- ever served wrote one row there.
UPDATE policies p SET notice_count = h.n
FROM (
  SELECT policy_id, count(*)::int AS n
  FROM policy_status_history WHERE event_type = 'notice' GROUP BY policy_id
) h
WHERE h.policy_id = p.id;

-- Floor at one for any policy that carries a notice_service_date but has no
-- 'notice' history row to count. Six such rows exist here: their notice was
-- written straight onto `policies` by a fixture rather than going through
-- the dispatcher, so the history never recorded it. A served notice that
-- counts as zero would contradict the token's own ensure clause
-- (isNone noticeServiceDate == (noticeCount == 0)), so the date is taken as
-- the more reliable of the two facts.
UPDATE policies SET notice_count = GREATEST(notice_count, 1)
WHERE notice_service_date IS NOT NULL;
