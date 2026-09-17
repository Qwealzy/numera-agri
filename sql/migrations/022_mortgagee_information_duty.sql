-- ============================================================================
-- The mortgagee's information request and the insurer's response
-- (TTK 6102 m. 1456(6)).
--
-- "Sigortacı, istem üzerine, sınırlı ayni hak sahibi olduğunu bildiren kişiye
-- sigorta koruması ile sigorta bedelinin miktarı hakkında bilgi verir."
--
-- The information was never missing. A named mortgagee is already an observer
-- of the PolicyToken and can read the cover, the sum insured, the remaining
-- limit and the tier matrix continuously, without asking anyone. What was
-- missing is the ACT: the duty is request -> response, and standing access is
-- a state, which cannot evidence a response to a request nobody recorded.
--
-- Neither date is a clock reading. The platform does not receive the request,
-- does not answer it, and holds no name, address or contact detail for the
-- person who asked -- the request is identified by the policy, which already
-- names the mortgagee.
--
-- A request is OUTSTANDING while requested_at is set and provided_at is NULL
-- or older than it. That is the only state in this duty worth surfacing, and
-- it is why these are two columns rather than a log: what matters is whether
-- the insurer currently owes an answer.
--
-- NOTHING HERE RECORDS WHAT WAS DISCLOSED. The token already carries the
-- cover and the sum insured; a second copy in a disclosure log could only
-- drift from the first.
--
-- ON m. 1456(7), WHICH THIS MIGRATION DELIBERATELY DOES NOT IMPLEMENT.
-- m. 1416 is an ADDRESSING RULE, not a record-keeping duty: "sigortacıya
-- bildirilmiş son adreslerine" is passive -- an address the insurer was told
-- -- and nothing requires anyone to maintain a register or verify one is
-- current. It allocates risk to the person who moved without saying so. It
-- therefore requires no fact this schema does not already hold:
-- mortgagee_notified_at records that the insurer says it notified, which is
-- the only thing a non-insurer can honestly record.
-- ============================================================================

ALTER TABLE policies ADD COLUMN mortgagee_info_requested_at TIMESTAMPTZ;
ALTER TABLE policies ADD COLUMN mortgagee_info_provided_at  TIMESTAMPTZ;

-- Mirrors the token's ensure clauses. Ordering only -- deliberately NOT
-- provided_at >= requested_at, because a later request leaves an older
-- response behind it and that is exactly how "outstanding" is expressed.
ALTER TABLE policies ADD CONSTRAINT policies_mortgagee_info_response_needs_request
  CHECK (mortgagee_info_provided_at IS NULL OR mortgagee_info_requested_at IS NOT NULL);
ALTER TABLE policies ADD CONSTRAINT policies_mortgagee_info_needs_mortgagee
  CHECK (mortgagee_info_requested_at IS NULL OR mortgagee_policyholder_id IS NOT NULL);

-- The outstanding requests: the insurer owes an answer on these. m. 1456(6)
-- sets no deadline and none is computed here -- this only makes the state
-- findable.
CREATE INDEX idx_policies_mortgagee_info_outstanding
  ON policies (mortgagee_info_requested_at)
  WHERE mortgagee_info_requested_at IS NOT NULL
    AND (mortgagee_info_provided_at IS NULL
         OR mortgagee_info_provided_at < mortgagee_info_requested_at);

-- Two acts, two types. The request is the mortgagee's act reported by the
-- insurer; the response is the insurer's own.
ALTER TYPE event_type ADD VALUE 'mortgagee_info_request';
ALTER TYPE event_type ADD VALUE 'mortgagee_info_provided';
