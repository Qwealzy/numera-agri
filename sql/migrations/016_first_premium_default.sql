-- ============================================================================
-- First-premium default (TTK 6102 m. 1434(2)) -- cayma, not fesih.
--
-- The SECOND premium-default mechanism, and a different one. m. 1434(2)
-- governs the first instalment or a premium payable in one sum; m. 1434(3),
-- already implemented, governs the ones that follow. They share nothing:
--
--   m. 1434(3)          ihtar, ten days, service date -> FESIH (termination)
--   m. 1434(2)          no notice, three months from the due date -> CAYMA
--                       (withdrawal), by the insurer's act OR by operation
--                       of law where the claim was not pursued
--
-- They therefore get separate vocabulary here, not shared states with a
-- discriminator. Conflating them is the specific failure this guards against.
-- ============================================================================

ALTER TYPE default_state ADD VALUE 'first_premium_unpaid';
ALTER TYPE default_state ADD VALUE 'withdrawn_for_first_premium';

-- The facts a later reading would need, and nothing else.
--
-- premium_due_date is REPORTED, never derived. m. 1431(1) puts it at
-- "sözleşme yapılır yapılmaz ve poliçenin teslimi karşılığında" -- contract
-- formation against delivery of the policy -- neither of which this platform
-- can observe, exactly as it cannot observe when an ihtar was served. Both of
-- m. 1434(2)'s three-month clocks run from it, so nothing about this
-- mechanism can be computed until it is reported, and a withdrawal or a sweep
-- on a policy without it is refused rather than defaulted to anything.
ALTER TABLE policies ADD COLUMN premium_due_date TIMESTAMPTZ;

-- "dava veya takip yoluyla istenmemiş olması" -- the insurer says it pursued
-- the claim. COMMENCEMENT only: whether the enforcement proved fruitless
-- (semeresiz) is m. 1431(4)'s trigger for the sigortalı taking over the
-- premium, a different fact, deliberately not implemented. Its presence is
-- what forecloses the deemed path.
ALTER TABLE policies ADD COLUMN enforcement_commenced_at TIMESTAMPTZ;

-- Set together by the withdrawal, never afterwards. withdrawal_path records
-- WHICH of m. 1434(2)'s two routes ended the contract -- the insurer's own
-- act, or operation of law from inaction. Both reach the same state; which
-- applied is a fact a later reading may turn on.
ALTER TABLE policies ADD COLUMN withdrawn_at    TIMESTAMPTZ;
ALTER TABLE policies ADD COLUMN withdrawal_path TEXT;

-- There is deliberately NO refund figure and no analogue of unrun_days.
-- m. 1419 returns only premiums "ödenmiş" -- actually paid -- and in
-- first-premium default nothing was. m. 1441's measure ("rizikoyu taşıdığı
-- süreye ait primler") is empty where m. 1421 means the insurer never bore
-- the risk. There is no arithmetic to support, so none is stored.

-- The window, per insurer. Nullable with NO default, like every other
-- statutory period here.
--
-- IMPORTANT -- this is a CEILING, not a floor, and it is the inverse of
-- insurers.default_grace_period_days. m. 1434(2) gives the insurer a right
-- exercisable WITHIN three months, which then lapses. Under m. 1452(3) the
-- article may not be varied to the DETRIMENT of the sigorta ettiren,
-- sigortalı or lehtar: a SHORTER window is less time for the insurer and so
-- permitted; a LONGER one is not. Do not "fix" this to match the grace
-- period's floor -- they guard in opposite directions on purpose.
ALTER TABLE insurers ADD COLUMN first_premium_withdrawal_days INTEGER;

-- The token's ensure clauses, mirrored so a bad row fails in SQL with a
-- readable message rather than at the ledger minutes later.
ALTER TABLE policies ADD CONSTRAINT policies_withdrawal_facts_together
  CHECK ((withdrawn_at IS NULL) = (withdrawal_path IS NULL));
ALTER TABLE policies ADD CONSTRAINT policies_withdrawal_needs_due_date
  CHECK (withdrawn_at IS NULL OR premium_due_date IS NOT NULL);
ALTER TABLE policies ADD CONSTRAINT policies_enforcement_needs_due_date
  CHECK (enforcement_commenced_at IS NULL OR premium_due_date IS NOT NULL);
-- The two mechanisms are mutually exclusive on one policy: m. 1434(2) is the
-- first premium, m. 1434(3) the ones that follow.
ALTER TABLE policies ADD CONSTRAINT policies_premium_mechanisms_exclusive
  CHECK (premium_due_date IS NULL OR notice_service_date IS NULL);
ALTER TABLE policies ADD CONSTRAINT policies_withdrawal_path_known
  CHECK (withdrawal_path IS NULL OR withdrawal_path IN ('WP_InsurerWithdrew', 'WP_DeemedNoEnforcement'));

-- Four new outbox event types. Each is a distinct act with a distinct
-- consequence, so each gets its own type rather than one type with a mode
-- field -- the dispatcher's handler map is the place those differences live.
ALTER TYPE event_type ADD VALUE 'premium_due_date';
ALTER TYPE event_type ADD VALUE 'enforcement_commenced';
ALTER TYPE event_type ADD VALUE 'first_premium_paid';
ALTER TYPE event_type ADD VALUE 'first_premium_withdrawal';
ALTER TYPE event_type ADD VALUE 'first_premium_deemed_withdrawal';

-- In-flight-scoped, as migrations 010, 012 and 013 established. An unscoped
-- index permanently bricks a policy the moment a human-reported event is
-- rejected and needs correcting; that has bitten twice.
CREATE UNIQUE INDEX idx_policy_events_premium_due_date_key
  ON policy_events (policy_no)
  WHERE event_type = 'premium_due_date' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_enforcement_commenced_key
  ON policy_events (policy_no)
  WHERE event_type = 'enforcement_commenced' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_first_premium_paid_key
  ON policy_events (policy_no)
  WHERE event_type = 'first_premium_paid' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_first_premium_withdrawal_key
  ON policy_events (policy_no)
  WHERE event_type = 'first_premium_withdrawal' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX idx_policy_events_first_premium_deemed_key
  ON policy_events (policy_no)
  WHERE event_type = 'first_premium_deemed_withdrawal' AND status IN ('pending', 'processing');

-- The sweeper's state test: still in first-premium default, due date
-- reported, no enforcement reported.
CREATE INDEX idx_policies_first_premium_open
  ON policies (premium_due_date)
  WHERE default_state = 'first_premium_unpaid' AND enforcement_commenced_at IS NULL;
