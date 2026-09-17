-- Stage 1 addendum: one document mechanism (not one per Turkish document
-- name), plus the three token fields renewal/notice/release will need
-- later. No handling logic for any document type is implemented here.

CREATE TYPE document_type AS ENUM ('offer', 'endorsement', 'renewal', 'release', 'formal_notice');

-- Only applicable when document_type = 'endorsement'. A reduction of sum
-- insured is not its own document type -- it's an endorsement with this
-- reason code.
CREATE TYPE endorsement_reason AS ENUM (
  'sum_insured_increase',
  'sum_insured_reduction',
  'insured_object_change',
  'tier_change',
  'correction'
);

-- Off-ledger only. Never store document content, a signature, a name, or
-- a national id here or anywhere on the ledger -- content_hash +
-- storage_reference are pointers, not the document itself. A row here
-- does not by itself change policy state; state changes come from an
-- outbox row (policy_activated today), and a document row is evidence
-- attached to one, not a driver of anything on its own.
CREATE TABLE policy_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id           UUID NOT NULL REFERENCES policies(id),
  document_type       document_type NOT NULL,
  endorsement_reason  endorsement_reason,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_at        TIMESTAMPTZ NOT NULL,
  content_hash        TEXT NOT NULL,
  storage_reference   TEXT NOT NULL,
  -- Which outbox row (if any) produced this document. policy_activated is
  -- the only outbox table that exists today; a later stage that adds
  -- outbox tables for amendment/renewal requests will need to generalize
  -- this rather than add a same-shaped column per table.
  produced_by_activation UUID REFERENCES policy_activated(policy_id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (document_type = 'endorsement' OR endorsement_reason IS NULL)
);

CREATE INDEX idx_policy_documents_policy ON policy_documents(policy_id);
CREATE INDEX idx_policy_documents_type ON policy_documents(document_type);
