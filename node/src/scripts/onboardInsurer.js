import crypto from 'node:crypto';
import { pool } from '../db.js';
import { allocateParty } from '../damlClient.js';

// One-off admin CLI: onboard a new insurer client onto the platform.
// This is the prerequisite step for Module 1 -- POST /api/v1/policies
// refuses to mint until the insurer has an allocated Canton party.
//
// Usage: node src/scripts/onboardInsurer.js "Acme Insurance A.S." [commissionBps]
async function main() {
  const legalName = process.argv[2];
  const commissionBps = Number(process.argv[3] ?? 0);
  if (!legalName) {
    console.error('usage: node src/scripts/onboardInsurer.js "<legal name>" [commissionBps]');
    process.exit(1);
  }

  const apiKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  // Two distinct parties on purpose: the insurer itself (signatory on every
  // PolicyToken it mints) and a platform-controlled oracle operator (the
  // only party allowed to exercise PolicyToken_EvaluateTrigger). Keeping
  // them separate stops the insurer from ever being able to trigger --
  // and thereby approve -- its own payout.
  const insurerPartyId = await allocateParty(legalName, `insurer-${Date.now()}`, { grantActAs: true });
  const oracleOperatorPartyId = await allocateParty(
    `${legalName} -- Oracle Operator`,
    `oracle-${Date.now()}`,
    { grantActAs: true }
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
  console.log(`API key (save this now -- it is only ever stored hashed): ${apiKey}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
