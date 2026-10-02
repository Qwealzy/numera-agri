import { pathToFileURL } from 'node:url';
import { pool } from '../db.js';
import { config } from '../config.js';
import { queryActiveContracts } from '../damlClient.js';
import { enqueuePayoutNotification } from '../notifications/enqueue.js';

// Polls the ledger for PayoutApproved contracts (the on-chain
// "Payout_Approved" signal). Stage 2 Part 1: this no longer exercises
// anything itself -- dispatch/dispatcher.js's handleTrigger already writes
// the payout_events row directly, in
// the same transaction as the exercise that created the PayoutApproved
// contract (it already holds the contract id then; no reason to wait for
// a poll to discover it). This listener is now the defensive safety net
// for the one case that doesn't cover: the ledger exercise succeeded but
// that write-back transaction failed, leaving a real PayoutApproved with
// nothing in SQL. On the normal path, it finds everything already written
// and does nothing.
async function pollOnce(insurers) {
  for (const insurer of insurers) {
    let activeContracts;
    try {
      activeContracts = await queryActiveContracts({
        moduleName: 'Insurance.PayoutBridge',
        entityName: 'PayoutApproved',
        parties: [insurer.canton_party_id],
      });
    } catch (err) {
      console.error(`[payoutListener] query failed for insurer ${insurer.id}:`, err.message);
      continue;
    }

    for (const contract of extractActiveContracts(activeContracts)) {
      await ensureTracked(contract, insurer.id);
    }
  }
}

async function ensureTracked(contract, insurerId) {
  const { contractId, payload } = contract;
  if (!payload) return;

  // ON CONFLICT DO NOTHING -- the normal path already has this row
  // (written by handleTrigger's write-back), so this is a no-op
  // almost always. UNIQUE(daml_contract_id) is what makes this safe to
  // attempt unconditionally rather than needing to check existence first.
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO payout_events
       (policy_id, coverage_code, tier_label, payout_percentage, payout_amount, currency,
        is_full_settlement, status, daml_contract_id, recipient, record_kind, approved_at,
        event_start, event_end, evidence_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',$8,$9,'payout',$10,$11,$12,$13)
     ON CONFLICT (daml_contract_id) DO NOTHING
     RETURNING id`,
    [
      payload.policyId,
      payload.coverageCode,
      payload.tierLabel,
      payload.payoutPercentage,
      payload.amount,
      payload.currency,
      payload.isFullSettlement,
      contractId,
      // Mirrored from the contract, not defaulted: since v17 a PayoutApproved
      // is owed to ONE recipient, and a row reconciled by this listener with
      // recipient NULL would be missing the only field that says who. Always
      // a 'payout' -- an unrouted remainder has no PayoutApproved for this
      // listener to have found in the first place.
      payload.recipient,
      // The ledger's own approval instant, the same value handleTrigger
      // mirrors. This path exists because that write-back may never have run,
      // so the value is taken from the contract rather than from a clock here.
      payload.approvedAt,
      // v22: the event and the evidence digest the payout was
      // approved on, from the contract, as handleTrigger writes them.
      payload.eventStart,
      payload.eventEnd,
      payload.evidenceDigest,
    ]
  );

  // Only when this INSERT actually added the row. On the normal path it
  // conflicts -- handleTrigger already wrote the payout AND queued its
  // notification in one transaction -- and queueing here would be a second
  // notification for a payout that already has one.
  if (inserted) {
    await enqueuePayoutNotification(pool, {
      payoutEventId: inserted.id,
      insurerId,
      kind: 'payout_approved',
    });
  }

  // Stage 4: this used to queue a `settlement` outbox row too, which the
  // dispatcher then turned into an unconditional MarkFailed. Removed --
  // settlement is now reported by the insurer, never inferred from the mere
  // existence of a PayoutApproved. What remains below is the defensive
  // payout_events insert only: this listener's job is to make sure a
  // PayoutApproved that reached the ledger is VISIBLE in SQL even if
  // handleTrigger's write-back failed after its exercise succeeded. It
  // decides nothing about how the payout ends.
}

// Confirmed against a live Canton 3.4.12 / JSON API v2 response:
// entry.contractEntry.JsActiveContract.createdEvent, payload under
// `createArgument` (singular). damlClient.js's queryActiveContracts
// already returns this array pre-filtered by templateId.
function extractActiveContracts(entries) {
  return entries
    .map((e) => e.contractEntry?.JsActiveContract?.createdEvent)
    .filter(Boolean)
    .map((created) => ({
      contractId: created.contractId,
      payload: created.createArgument,
    }));
}

async function tick({ insurerIds } = {}) {
  // insurerIds is for tests, which pass their own fixture insurers. Production
  // passes nothing, and the query is then exactly what it always was.
  const { rows: insurers } = await pool.query(
    "SELECT * FROM insurers WHERE is_active = true AND canton_party_status = 'ALLOCATED'" +
      (insurerIds === undefined ? '' : ' AND id = ANY($1)'),
    insurerIds === undefined ? undefined : [insurerIds]
  );
  await pollOnce(insurers);
}

export function startPayoutListener({ insurerIds } = {}) {
  console.log(`[payoutListener] polling every ${config.payoutListener.pollMs}ms`);
  setInterval(() => {
    tick({ insurerIds }).catch((err) => console.error('[payoutListener] tick failed:', err));
  }, config.payoutListener.pollMs);
}

// See oracleBot.js for why pathToFileURL is used here instead of manual
// string concatenation (Windows path-format mismatch made that dead code).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPayoutListener();
  tick().catch((err) => console.error('[payoutListener] initial tick failed:', err));
}
