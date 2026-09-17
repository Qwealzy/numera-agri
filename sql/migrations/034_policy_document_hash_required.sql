-- 034: every policy carries the hash of its policy document (decided
-- 2026-09-13).
--
-- The insurer produces the policy document in its own systems and sends only
-- its SHA-256; the platform never holds the document, which names the people
-- on it (the no-PII decision of migration 028 stands). A policy without a
-- hash is not created, and so never minted.
--
-- The API refuses a missing or malformed hash before any write
-- (node/src/routes/policies.js, requireDocumentHash). The table refuses it
-- too, because not every write goes through the API: test fixtures and
-- a scale-measuring script kept outside this repository insert into policies directly.
--
-- Checked before writing this, read-only: policies holds 0 rows in the
-- working database and 0 in the test database, so no row has a NULL or
-- malformed document_hash for these to reject.
--
-- policies_document_hash_not_empty stays; every value this CHECK admits
-- satisfies it.

ALTER TABLE policies ALTER COLUMN document_hash SET NOT NULL;

ALTER TABLE policies ADD CONSTRAINT policies_document_hash_is_sha256_hex
  CHECK (document_hash ~ '^[0-9a-f]{64}$');
