-- ============================================================================
-- Drop eft_transactions, the last remnant of the abandoned Stage 1 EFT design.
--
-- It was declared in the original schema and NEVER had a writer: no INSERT,
-- UPDATE or SELECT targeting it exists anywhere in node/src, and the live
-- table held zero rows when this ran. Its `destination_iban TEXT NOT NULL`
-- contradicts the standing rule that this platform holds no funds,
-- instructs no payments, and stores no account numbers -- there is no IBAN
-- anywhere else in the system, and none may be added.
--
-- Left in the tree it is an invitation to resurrect the design by accident:
-- a table with an IBAN column reads as an unimplemented feature rather than
-- an abandoned one. Deleted outright, with no stub and no commented-out
-- copy. The repository is under git as of the initial commit; the history is
-- where a deleted design belongs.
--
-- The payout side that DID survive lives on payout_events (bank_reference,
-- settled_at, paid_role) and records what the insurer says it did, after the
-- fact. It instructs nothing.
-- ============================================================================

DROP INDEX IF EXISTS idx_eft_transactions_payout_event;
DROP TABLE IF EXISTS eft_transactions;
