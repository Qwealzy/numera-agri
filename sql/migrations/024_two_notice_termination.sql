-- ============================================================================
-- The two-notice termination right (TTK 6102 m. 1434(4)).
--
-- "Bir sigorta dönemi içinde sigorta ettirene iki defa ihtar gönderilmişse
-- sigortacı, sigorta döneminin sonunda hüküm doğurmak üzere sözleşmeyi
-- feshedebilir."
--
-- THE THIRD WAY A CONTRACT ENDS FOR NON-PAYMENT, and it must not be
-- conflated with the other two. m. 1434(2) is withdrawal (cayma);
-- m. 1434(3) is automatic termination at the end of a notice period. This one
-- is DISCRETIONARY -- "feshedebilir" -- and its effect is DEFERRED.
--
-- SENDING SUFFICES. `gönderilmişse` attaches to the sending, twice, and
-- borrows none of (3)'s machinery: (3) spells out "on günlük süre vererek ...
-- bu sürenin bitiminde" and this paragraph does not. The ten days are (3)'s.
--
-- WHEN IS IT EVER REACHABLE? Only where (3) did NOT fire -- where payment
-- arrived inside the ten days, on one or both occasions. That is what the
-- paragraph is for: the chronically late payer, who always pays but only
-- after an ihtar, and whom (3) cannot reach because the debt was cleared each
-- time. The deferral is the other half of the same thought: the premium for
-- the current period WAS paid, so ending the contract immediately would take
-- back cover already bought.
--
-- PAYMENT IN THE INTERVAL DOES NOT DEFEAT IT. The right attaches to two
-- ihtars having been sent, not to an outstanding debt -- and payment is what
-- made the paragraph reachable at all.
--
-- m. 1452(3) lists "1433 ilâ 1449", so the whole of m. 1434 including (4) is
-- non-derogable against the sigorta ettiren, sigortalı and lehtar. The
-- article's own final sentence reserves the reduction rules for life
-- insurance, which this product is not.
-- ============================================================================

-- Every notice service date, not just the latest that notice_service_date
-- holds. m. 1434(4) turns on TWO ihtars "bir sigorta dönemi içinde", and one
-- date plus a count cannot answer whether both fell inside a given period.
--
-- notice_count COUNTS PER POLICY, NOT PER INSURANCE PERIOD. That is safe only
-- while a contract term does not exceed one insurance period -- true of every
-- policy this product writes, but an accident of the product rather than a
-- structural guarantee. A multi-year term would over-count, which is exactly
-- why the election checks these dates against a supplied period instead of
-- trusting the count.
ALTER TABLE policies ADD COLUMN notice_service_dates TIMESTAMPTZ[] NOT NULL DEFAULT '{}';
ALTER TABLE policies ADD CONSTRAINT policies_notice_dates_match_count
  CHECK (notice_count = COALESCE(array_length(notice_service_dates, 1), 0));

-- The election and the instant its effect lands. The effective instant is the
-- SUPPLIED period end, frozen at election, so a sweeper running three days
-- late records the instant it would have recorded on time -- the same
-- discipline as the m. 1434(3) termination instant.
--
-- THE PERIOD IS SUPPLIED, NEVER DERIVED. m. 1411 ties it to how the premium
-- is CALCULATED -- "prim daha kısa zaman dilimlerine göre hesaplanmamış ise
-- ... bir yıldır" -- and this system holds no calculation basis. start_date /
-- end_date are the contract term, a different thing that coincides only
-- sometimes.
ALTER TABLE policies ADD COLUMN two_notice_election_at  TIMESTAMPTZ;
ALTER TABLE policies ADD COLUMN two_notice_effective_at TIMESTAMPTZ;
ALTER TABLE policies ADD CONSTRAINT policies_two_notice_facts_together
  CHECK ((two_notice_election_at IS NULL) = (two_notice_effective_at IS NULL));
ALTER TABLE policies ADD CONSTRAINT policies_two_notice_effect_is_deferred
  CHECK (two_notice_election_at IS NULL OR two_notice_effective_at > two_notice_election_at);

-- Its own vocabulary. Neither 'terminated' nor 'withdrawn_for_first_premium'
-- -- a deferred effect is a state this system has never had.
--
--   two_notice_elected     the insurer has elected; the contract RUNS ON
--                          until the period end, cover in full, losses
--                          payable -- nothing about the election shortens it
--   two_notice_terminated  the effect has landed at the period end
ALTER TYPE default_state ADD VALUE 'two_notice_elected';
ALTER TYPE default_state ADD VALUE 'two_notice_terminated';

-- The election is an act; the landing is a consequence a sweeper observes.
ALTER TYPE event_type ADD VALUE 'two_notice_election';
ALTER TYPE event_type ADD VALUE 'two_notice_termination';
