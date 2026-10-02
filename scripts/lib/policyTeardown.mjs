// The teardown shared by scripts/runVerifications.mjs (every policy a run
// created) and scripts/setupDemo.mjs --teardown (one demo policy). One copy,
// so the two cannot drift on FK order or on what a stale archive means.
//
// The caller says which policies: `mine` is a SQL subquery selecting their
// ids, `params` its parameters. The caller owns the client, the transaction
// and the policyholder rows; this owns the order.

import crypto from 'node:crypto';

// Archives one contract. An archive that comes back "not active" is counted as
// archived: the state asked for is the state it is in. Anything else throws.
//
// A PayoutApproved is never archived with a bare two-signatory Archive.
// With the oracle on a participant of its own, neither participant can submit
// as both signatories (403 from both ends), so it is closed
// through PayoutApproved_ConfirmSettlement, the insurer's choice alone, from
// the insurer's participant -- on one participant as on two. The
// record that leaves since v22, PayoutSettled, is signed by the insurer alone
// and archived here too. `createArgument` supplies the insurer and the leg's
// recipient. What this reports is a teardown's, on a run's own synthetic
// payout: the bank reference is the digest of a fixed teardown text and the
// settlement instant is now.
export async function archiveContract({ exerciseChoice, withRetry = (fn) => fn(), contractId, templateId, signatories, createArgument, fallbackActAs }) {
  const [, moduleName, entityName] = templateId.split(':');
  try {
    if (entityName === 'PayoutApproved') {
      const insurer = createArgument?.insurer ?? fallbackActAs?.[0];
      if (!insurer || !createArgument?.recipient) {
        throw new Error(`PayoutApproved ${contractId.slice(0, 16)}...: no insurer or recipient to close it with`);
      }
      const data = await withRetry(() => exerciseChoice({
        moduleName, entityName, contractId, choice: 'PayoutApproved_ConfirmSettlement',
        argument: {
          bankReference: `sha256:${crypto.createHash('sha256').update(`teardown ${contractId}`).digest('hex')}`,
          settledAt: new Date().toISOString(),
          paidRole: createArgument.recipient,
        },
        actAs: [insurer],
      }));
      const record = (data?.transaction?.events ?? [])
        .find((e) => e.ExercisedEvent?.choice === 'PayoutApproved_ConfirmSettlement')?.ExercisedEvent?.exerciseResult;
      if (!record) throw new Error(`PayoutApproved ${contractId.slice(0, 16)}...: ConfirmSettlement returned no PayoutSettled id`);
      await withRetry(() => exerciseChoice({
        moduleName, entityName: 'PayoutSettled', contractId: record, choice: 'Archive', argument: {}, actAs: [insurer],
      }));
      return;
    }
    await withRetry(() => exerciseChoice({
      moduleName, entityName, contractId, choice: 'Archive', argument: {},
      // Every signatory acts (fallbackActAs when they are not known), as
      // Archive needs. PayoutApproved, the one template with two, returns
      // above and never reaches this Archive.
      actAs: signatories?.length ? signatories : fallbackActAs,
    }));
  } catch (err) {
    if (/NOT_ACTIVE|CONTRACT_NOT_FOUND|NOT_FOUND/i.test(err.message ?? '')) return;
    throw err;
  }
}

// Deletes the rows of the policies `mine` selects, in FK order, inside the
// caller's transaction. A response whose hash reached the ledger is held by
// attested_evidence and is NOT deleted -- the table refuses it outside a test
// database, and nothing here tries to get round that; those rows are counted
// and returned so the caller can say what stayed.
export async function deletePolicyRows(client, mine, params) {
  await client.query(`UPDATE policies SET renewed_by_policy_id = NULL, predecessor_policy_id = NULL WHERE id IN (${mine})`, params);
  await client.query(`DELETE FROM payout_notifications WHERE payout_event_id IN (SELECT id FROM payout_events WHERE policy_id IN (${mine}))`, params);
  await client.query(`DELETE FROM payout_events WHERE policy_id IN (${mine})`, params);
  await client.query(`DELETE FROM policy_events WHERE policy_no IN (${mine})`, params);
  await client.query(`DELETE FROM trigger_windows WHERE policy_id IN (${mine})`, params);
  const { rows: raw } = await client.query(
    `SELECT DISTINCT r.raw_response_id AS id, (ae.raw_response_id IS NOT NULL) AS attested, rr.sha256
       FROM oracle_readings r
       JOIN oracle_raw_responses rr ON rr.id = r.raw_response_id
       LEFT JOIN attested_evidence ae ON ae.raw_response_id = r.raw_response_id
      WHERE r.policy_id IN (${mine})`,
    params
  );
  for (const t of ['policy_documents', 'policy_status_history', 'policy_coverages', 'oracle_readings']) {
    await client.query(`DELETE FROM ${t} WHERE policy_id IN (${mine})`, params);
  }
  const deletable = raw.filter((r) => !r.attested).map((r) => r.id);
  const rawDeleted = deletable.length
    ? (await client.query(
      `DELETE FROM oracle_raw_responses
        WHERE id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM oracle_readings r WHERE r.raw_response_id = oracle_raw_responses.id)`,
      [deletable]
    )).rowCount
    : 0;
  const policies = await client.query(`DELETE FROM policies WHERE id IN (${mine})`, params);
  return {
    policies: policies.rowCount,
    rawResponsesDeleted: rawDeleted,
    rawResponsesKept: raw.filter((r) => r.attested).map((r) => r.sha256),
  };
}

// verify-all's teardown (scripts/runVerifications.mjs): scoped to the
// run's own insurers and, within them, to the policies the run created. The
// run's policies are those of `insurerIds` created at or after `runStart`. A
// contract is archived only if it is new since the run started (not in
// `before`) AND belongs to one of those policies (PolicyToken's policyNo, the
// payout contracts' policyId); rows only of those policies, and policyholders
// of those insurers created during the run. A contract of another insurer is
// never listed, since `after` is read over the run's insurers' parties; a new
// contract of an older policy of the run's own insurer -- a demo re-minted by
// the live oracle while the run was going -- is counted as `leftAlone` and
// not touched, and the caller's before/after count then shows it.
//
// `before` and `after` map contract id -> { templateId, signatories,
// createArgument, entity }. `client` is a connection that may delete (the
// maintenance role); the transaction for the rows is opened here.
export async function teardownRun({ exerciseChoice, withRetry, client, runStart, insurerIds, before, after, fallbackActAs, log = console.log }) {
  const mine = 'SELECT id FROM policies WHERE created_at >= $1 AND insurer_id = ANY($2::uuid[])';
  const params = [runStart, insurerIds];
  const runPolicies = new Set((await client.query(mine, params)).rows.map((r) => r.id));
  const result = { archived: 0, failed: 0, leftAlone: 0, rows: null };
  for (const [contractId, c] of after) {
    if (before.has(contractId)) continue; // older than this run
    const policy = c.createArgument?.policyNo ?? c.createArgument?.policyId;
    if (!runPolicies.has(policy)) {
      result.leftAlone += 1;
      continue;
    }
    try {
      await archiveContract({
        exerciseChoice, withRetry, contractId, templateId: c.templateId, signatories: c.signatories,
        createArgument: c.createArgument, fallbackActAs,
      });
      result.archived += 1;
    } catch (err) {
      result.failed += 1;
      log(`  could not archive ${contractId.slice(0, 16)}... (${c.entity}): ${err.message.slice(0, 140)}`);
    }
  }
  await client.query('BEGIN');
  try {
    const policies = await deletePolicyRows(client, mine, params);
    const people = await client.query(
      'DELETE FROM policyholders WHERE created_at >= $1 AND insurer_id = ANY($2::uuid[])', params
    );
    await client.query('COMMIT');
    result.rows = { policies: policies.policies, policyholders: people.rowCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return result;
}
