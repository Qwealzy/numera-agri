-- 037: the m. 1456(5) mortgagee continuation window and the m. 1434(2)
-- first-premium withdrawal window are frozen onto the policy at activation
-- (the rule that such periods are frozen at activation).
--
-- Until now both were read from insurers when they were used, so a change to
-- the insurer's value reached policies already active. From here activation
-- and a renewal's activation copy them onto the row in the same UPDATE as
-- grace_period_days, and a NULL is frozen as NULL: the refusal
-- stays where the window is used, as before.
--
-- A policy already activated (current_version > 0) takes its insurer's value
-- as it stands now, the value it would have read at its next use.
-- A policy not yet activated keeps NULL until its activation writes it.

BEGIN;

ALTER TABLE policies ADD COLUMN mortgagee_continuation_days INTEGER;
ALTER TABLE policies ADD COLUMN first_premium_withdrawal_days INTEGER;

UPDATE policies p
   SET mortgagee_continuation_days = i.mortgagee_continuation_days,
       first_premium_withdrawal_days = i.first_premium_withdrawal_days
  FROM insurers i
 WHERE i.id = p.insurer_id
   AND p.current_version > 0;

COMMIT;
