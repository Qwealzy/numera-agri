-- 033: an index for the foreign key that holds attested responses.
--
-- attested_evidence's primary key is (policy_event_id, raw_response_id), and
-- a lookup by raw_response_id alone cannot use it: the column is second. Every
-- DELETE on oracle_raw_responses runs the foreign-key check against
-- attested_evidence by raw_response_id, and without this index that check
-- reads the whole table, which is kept indefinitely and only grows.

CREATE INDEX idx_attested_evidence_raw_response ON attested_evidence(raw_response_id);
