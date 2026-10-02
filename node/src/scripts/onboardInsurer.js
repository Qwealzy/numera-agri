import crypto from 'node:crypto';
import { pool } from '../db.js';
import { allocateParty, insurerEndpoint, oracleEndpoint, oracleIsOnItsOwnParticipant } from '../damlClient.js';

// One-off admin CLI: onboard a new insurer client onto the platform.
// This is the prerequisite step for Module 1 -- POST /api/v1/policies/:policyId/activate
// and /renew refuse to mint (and the lifecycle and payout reports refuse to
// queue) until the insurer has an allocated Canton party.
//
// Usage: node src/scripts/onboardInsurer.js "Acme Insurance A.S." [commissionBps]
async function main() {
  const legalName = process.argv[2];
  const commissionBps = Number(process.argv[3] ?? 0);
  if (!legalName || legalName.trim() === '') {
    console.error('usage: node src/scripts/onboardInsurer.js "<legal name>" [commissionBps]');
    process.exit(1);
  }
  // Checked before the two allocations below, since the insurers row is
  // written only after both: an input that row refuses would cost two parties
  // and two user rights. commission_bps is an INTEGER with CHECK 0..10000.
  if (!/^\d+$/.test(process.argv[3] ?? '0') || commissionBps > 10000) {
    console.error(
      `commissionBps must be a whole number of basis points from 0 to 10000, got ${JSON.stringify(process.argv[3])}`
    );
    process.exit(1);
  }

  const apiKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  // Two distinct parties on purpose: the insurer itself (signatory on every
  // PolicyToken it mints) and a platform-controlled oracle operator (the
  // only party allowed to exercise PolicyToken_EvaluateTrigger). Keeping
  // them separate stops the insurer from ever being able to trigger --
  // and thereby approve -- its own payout.
  //
  // The two parties are allocated on two participants when
  // DAML_JSON_API_URL_ORACLE is set: a party is hosted by the participant that
  // allocates it, and the CanActAs right is granted PER PARTICIPANT -- the
  // insurer's participant is never told about the oracle party, and a
  // submission as the oracle party sent there is refused 403 (measured,
  // a two-participant check kept outside this repository, phases 2 and 5). With the key
  // unset both calls go to the one participant, exactly as before.
  //
  // Which participant an oracle party is hosted on is NOT recorded on the
  // insurers row, and no column is added for it: the endpoint is one piece of
  // process configuration for the whole platform, not a per-insurer fact, and
  // the dispatcher reads it from the same config this script does. What can be
  // asked of the network instead is whether a participant holds a right for
  // the party, which is what scripts/doctor.mjs prints per insurer.
  const insurerPartyId = await allocateParty(legalName, `insurer-${Date.now()}`, { grantActAs: true });
  const oracleOperatorPartyId = await allocateParty(
    `${legalName} -- Oracle Operator`,
    `oracle-${Date.now()}`,
    { grantActAs: true, endpoint: oracleEndpoint() }
  );

  const { rows } = await pool.query(
    `INSERT INTO insurers
       (legal_name, api_key_hash, canton_party_id, canton_party_status,
        oracle_operator_party, commission_bps)
     VALUES ($1,$2,$3,'ALLOCATED',$4,$5) RETURNING id`,
    [legalName, apiKeyHash, insurerPartyId, oracleOperatorPartyId, commissionBps]
  );

  console.log(`Insurer onboarded: ${rows[0].id}`);
  console.log(`Canton party:      ${insurerPartyId}`);
  console.log(`Oracle operator:   ${oracleOperatorPartyId}`);
  console.log(
    oracleIsOnItsOwnParticipant()
      ? `  insurer participant ${insurerEndpoint()}, oracle participant ${oracleEndpoint()} (DAML_JSON_API_URL_ORACLE)`
      : `  both parties on ${insurerEndpoint()}: DAML_JSON_API_URL_ORACLE is unset, so the oracle shares the insurer's participant`
  );
  console.log(`API key (save this now -- it is only ever stored hashed): ${apiKey}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
