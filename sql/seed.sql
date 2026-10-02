-- ============================================================================
-- Demo/local-testing seed data. Delete before production.
--
-- Creates one demo insurer (API key "demo-api-key" -- hashed the same way
-- node/src/routes/policies.js checks it, so `curl -H "x-api-key: demo-api-key"`
-- against the running API will authenticate against this row) and the
-- payout-tier matrix straight from the product brief:
--   -2C to 0C  -> 25%
--   below -4C  -> 100%
--
-- NOTE: only those two bands are inserted. The gap between -4C and -2C was
-- left unspecified in the brief -- a reading that lands there will match no
-- tier and pay nothing (fails closed) until a row is added for it. That is
-- deliberate: better to leave a visible gap than invent an actuarial number.
-- Add the missing band here once underwriting confirms it.
-- ============================================================================

WITH demo_insurer AS (
  INSERT INTO insurers (legal_name, api_key_hash, canton_party_status, commission_bps)
  VALUES (
    'Demo Insurance A.S.',
    encode(digest('demo-api-key', 'sha256'), 'hex'),
    'PENDING',   -- run node/src/scripts/onboardInsurer.js to allocate real Canton parties
    1000
  )
  RETURNING id
)
INSERT INTO payout_tiers
  (insurer_id, product_code, peril_type, tier_order, label, threshold_min, threshold_max, payout_percentage, shape)
SELECT id, 'FROST-STANDARD', 'FROST', 1, 'Mild frost (-2C to 0C)', -2.0, 0.0, 25.00, 'TS_Step' FROM demo_insurer
UNION ALL
SELECT id, 'FROST-STANDARD', 'FROST', 2, 'Severe frost (below -4C)', NULL, -4.0, 100.00, 'TS_Step' FROM demo_insurer;
