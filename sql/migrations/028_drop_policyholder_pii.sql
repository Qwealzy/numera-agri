-- 028: full_name and national_id_hash carried no working function. Party
-- reuse has always run on (insurer_id, external_ref) alone -- national_id_hash
-- was written on every insert and read by nothing; full_name was written and
-- returned to no one. A tuzsuz SHA-256 over the ~9x10^8-value TCKN space is
-- reversible by brute force in minutes, so keeping it was a real liability
-- with no offsetting function. Neither field is accepted by the API anymore
-- (node/src/routes/policies.js rejects fullName/nationalId with 400).
--
-- The UNIQUE(insurer_id, external_ref) constraint that party reuse now rests
-- on entirely was already present (schema.sql, original migration) --
-- verified before this migration was written, not assumed.
--
-- Checked before writing this: 33 policyholders rows exist, all under
-- "Demo Insurance A.S." (the documented seed/demo insurer), all carrying
-- obviously fixture/test full_name values ("... (fixture, fake)", "Test
-- Package Policy", etc.), and national_id_hash was NULL on every one. No
-- real data is lost.

ALTER TABLE policyholders
  DROP COLUMN full_name,
  DROP COLUMN national_id_hash;
