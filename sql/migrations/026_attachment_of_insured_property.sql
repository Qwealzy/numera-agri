-- ============================================================================
-- Attachment of the insured property (TTK 6102 m. 1457).
--
-- "Sigortalı mal haczedilirse, sigortacı, zamanında bilgilendirilmek şartıyla,
-- sigorta tazminatını icra müdürlüğüne ödeyerek borcundan kurtulur. Bir malın
-- haczinde, icra memuru, borçludan söz konusu malların sigortalı olup
-- olmadığını ... sorar; ... sigorta tazminatının diğer bir bildirime kadar
-- ancak icra müdürlüğüne ödenilmesiyle borçtan kurtulacağını sigortacıya
-- ihtar eder."
--
-- THE FOURTH RECIPIENT, and the only one nobody designates. A DISCHARGE
-- mechanism rather than a duty -- "ödeyerek borcundan kurtulur" tells the
-- insurer how to pay validly -- but the officer's ihtar says the insurer is
-- discharged "ANCAK icra müdürlüğüne ödenilmesiyle", so after it the
-- alternatives stop discharging. Permissive in form, constraining in effect.
--
-- AN APPROXIMATION, stated rather than hidden: the article attaches to the
-- PROPERTY ("Sigortalı mal haczedilirse", "Bir malın haczinde") and this
-- system has no property registry. The coverage is its nearest honest unit --
-- the same approximation v17 already made for the mortgagee's charge.
--
-- NO IDENTIFIER IS HELD. No case number, no court, no office identifier, no
-- party identity. The routing decision needs none, and holding one would make
-- this platform the place such things live.
--
-- m. 1457 is in NONE of m. 1486's lists, so it is not protected and may be
-- varied by contract -- unlike m. 1456(1), which m. 1486(2) protects. The
-- entitlement of the real-right holder is mandatory; this discharge mechanism
-- is not.
-- ============================================================================

-- Attached NOW means attached_at is set and attachment_lifted_at is NULL or
-- OLDER than it. The shape follows m. 1456(6)'s outstanding request, and it
-- earns its keep the same way: an attachment can be lifted and later
-- re-imposed without either date being lost.
--
-- Lifting is a fact the Code itself anticipates rather than one this system
-- invented: the officer's ihtar binds "DİĞER BİR BİLDİRİME KADAR" -- until a
-- further notification.
ALTER TABLE policy_coverages ADD COLUMN attached_at         TIMESTAMPTZ;
ALTER TABLE policy_coverages ADD COLUMN attachment_lifted_at TIMESTAMPTZ;

-- A lifting needs something to lift. Deliberately NOT lifted_at >= attached_at
-- -- a lifting OLDER than the attachment in front of it is exactly how
-- "attached again" is expressed.
ALTER TABLE policy_coverages ADD CONSTRAINT policy_coverages_lifting_needs_attachment
  CHECK (attachment_lifted_at IS NULL OR attached_at IS NOT NULL);

-- The fourth recipient.
ALTER TABLE payout_events DROP CONSTRAINT payout_events_recipient_known;
ALTER TABLE payout_events ADD CONSTRAINT payout_events_recipient_known
  CHECK (recipient IS NULL
         OR recipient IN ('PDR_Insured', 'PDR_Mortgagee', 'PDR_Beneficiary', 'PDR_EnforcementOffice'));

-- A third kind of row, and it must stay distinct from the m. 1456(2) surplus:
-- the two have different reasons and different resolutions.
--
--   unrouted_competing_claims  m. 1456's charge and m. 1457's attachment both
--                              bite on one coverage. The Code supplies no
--                              priority rule -- they sit as (a) sınırlı ayni
--                              hak and (b) haciz under one heading, two
--                              species of one genus -- and the ranking
--                              question is İcra ve İflas Kanunu territory,
--                              which is not in this repository. NOTHING is
--                              routed.
ALTER TABLE payout_events DROP CONSTRAINT payout_events_record_kind_known;
ALTER TABLE payout_events ADD CONSTRAINT payout_events_record_kind_known
  CHECK (record_kind IN ('payout', 'unrouted_remainder', 'unrouted_competing_claims'));

-- Both unrouted kinds are review items from the moment they exist, and
-- neither names a recipient -- nobody has decided who the money goes to.
ALTER TABLE payout_events DROP CONSTRAINT payout_events_remainder_needs_review;
ALTER TABLE payout_events ADD CONSTRAINT payout_events_remainder_needs_review
  CHECK (record_kind = 'payout'
         OR (review_contract_id IS NOT NULL AND recipient IS NULL));

-- Two acts, two types. Both reported from outside -- the platform cannot
-- observe an icra file.
ALTER TYPE event_type ADD VALUE 'attachment';
ALTER TYPE event_type ADD VALUE 'attachment_lifted';
