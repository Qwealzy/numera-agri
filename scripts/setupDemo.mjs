// Demo setup: one insurer's demo configuration and one demo policy, through
// the platform's own paths, so a recorded night can be replayed against it
// (scripts/replayRecordedResponses.mjs).
//
// What it does, in order, printing each step and whether it wrote anything:
//   0. The demo insurer itself, with --demo-insurer-name <legal name>: if no
//      active insurer has the key in DEMO_INSURER_API_KEY, one is onboarded
//      with that name through node/src/scripts/onboardInsurer.js as it stands,
//      and the key from the environment is then the one that reaches it -- the
//      random key that script printed to this process is replaced and never
//      used. A key is never printed by this script and never read from an
//      argument. Without the flag, an existing insurer must already hold the
//      key, which is how this script always worked.
//
//      WHY a demo insurer of its own. The demo policy used to live under the
//      same insurer the verify scripts use. scripts/verify-notification.mjs
//      repoints THAT insurer's webhook_url at its own receiver for the length
//      of its run, and every notification of that insurer still waiting for an
//      address is delivered there while it is pointed away -- which is how the
//      demo's own payout notification left for a receiver that had nothing to
//      do with the demo. A separate insurer, whose key the verify scripts are
//      never given, is not repointed at all.
//   1. A second insurer ("outsider", for the roles page's fourth column): if no
//      other insurer holds an allocated party, it is onboarded by running
//      node/src/scripts/onboardInsurer.js as it stands. That script prints the
//      new insurer's API key and party ids; they are read here for the id
//      only and never printed. The outsider never calls the API.
//   2. The demo insurer's default event window and aggregation: a NULL field
//      is written from the arguments; a set field that differs stops the run
//      unless --force. default_grace_period_days is NULL on an insurer
//      onboarded just now: it is a legally constrained period with no default
//      anywhere, so the run stops and asks for --grace-period-days, and writes
//      only the number given. A value already set is read, never overwritten.
//   3. The demo product's payout tiers from --tiers <json>: inserted when the
//      insurer has no row for that product code; left alone when the rows
//      already equal the file; a difference stops the run. The file's tiers
//      are checked first for overlap (matchTier takes the first match, both
//      ends inclusive).
//   4. The policy, through the HTTP API (never SQL): create, activate, then
//      first premium reported paid at the --paid-at instant. After each step it
//      waits on GET /api/v1/policies/:policyId until that outbox row is done;
//      a failed row prints its reason code and stops the run. A policy with
//      the same policyholder reference, product, cell and dates is recognised
//      and not created twice; --skip-policy skips the step.
//   5. The policy id, the replay command and the debug page addresses.
//
// --teardown <policyId>: the one-policy counterpart of the teardown in
// scripts/runVerifications.mjs, through the same scripts/lib/policyTeardown.mjs.
// A response held by attested_evidence is left where it is and named.
//
// What it does not touch: other products' tiers, any grace or notice period
// but a NULL default_grace_period_days (step 2 writes that one),
// the recordings, the running API, the ledger beyond the calls the API itself
// makes (and, on --teardown, archiving this policy's own contracts).
//
// The demo terms (the tiers file under scripts/demo/) are SYNTHETIC: set by
// the demo insurer for a demonstration, not an actuarial figure.
//
// Nothing has a default. Every value comes from an argument, or for the API
// key from the environment (DEMO_INSURER_API_KEY). The API key, webhook
// secrets and party ids are never printed. Run it from node/, where config.js
// finds .env:
//
//   node ../scripts/setupDemo.mjs --outsider-name <legal name> \
//     [--demo-insurer-name <legal name>] [--grace-period-days <n>] \
//     --window-timezone <IANA zone> --window-start-hour <0-23> --aggregation <min|max|mean> [--force] \
//     --tiers <json> --policyholder-ref <ref> --mortgagee-ref <ref> --coverage-code <code> --cell <cellId> \
//     --metric <code> --payout-basis <PB_RemainingLimit|PB_SumInsured> \
//     --sum-insured <n> --mortgagee-claim <n> --premium <n> --currency <code> --document-text <text> \
//     --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD> --paid-at <ISO instant | now> [--allow-backdated-payment] --wait-seconds <n> \
//     --recordings <dir> --night-from <instant> --night-to <instant> [--allow-gaps] [--skip-policy]
//   node ../scripts/setupDemo.mjs --teardown <policyId>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pool } from '../node/src/db.js';
import { config } from '../node/src/config.js';
import { exerciseChoice, queryActiveContracts } from '../node/src/damlClient.js';
import { assertMaintSameServer } from '../node/test-support/testDbGuard.mjs';
import { archiveContract, deletePolicyRows } from './lib/policyTeardown.mjs';
import { BACKDATED_FLAG, PaidAtRefused, resolvePaidAt } from './lib/firstPremiumPaidAt.mjs';

const NODE_DIR = fileURLToPath(new URL('../node/', import.meta.url));
const FLAGS = new Set(['--force', '--allow-gaps', '--skip-policy', BACKDATED_FLAG]);
const say = (s) => console.log(`[setupDemo] ${s}`);
const stop = (s) => { throw Object.assign(new Error(s), { stop: true }); };
const mask = (s) => String(s).replace(/([A-Za-z0-9_.-]*)::[0-9a-f]{16,}/g, '$1::…');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) stop(`unexpected argument ${a}`);
    if (FLAGS.has(a)) { args[a.slice(2)] = true; continue; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) stop(`${a} needs a value`);
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

function need(args, names) {
  const missing = names.filter((n) => args[n] === undefined || args[n] === '');
  if (missing.length) stop(`missing ${missing.map((n) => `--${n}`).join(', ')} -- there is no default`);
}

function apiKey() {
  const key = process.env.DEMO_INSURER_API_KEY;
  if (!key) stop('DEMO_INSURER_API_KEY is not set in the environment -- the demo insurer\'s API key, never printed');
  return key;
}

async function demoInsurer(key) {
  const { rows: [insurer] } = await pool.query(
    `SELECT id, legal_name, canton_party_id, default_grace_period_days, default_event_window_timezone,
            default_event_window_start_hour, default_event_aggregation
       FROM insurers WHERE api_key_hash = encode(sha256($1::bytea), 'hex') AND is_active`,
    [key]
  );
  if (!insurer) stop('no active insurer has the API key in DEMO_INSURER_API_KEY');
  return insurer;
}

// --- 0. the demo's own insurer -----------------------------------------------

// Onboards one through the existing script, then makes the environment's key
// the key that reaches it. onboardInsurer.js generates a random key of its own
// and prints it; that key is never used here and does not survive this call,
// so the only key that opens this insurer is the one already in the
// environment -- which is why nothing has to be printed or typed back.
async function onboardDemoInsurer(key, name) {
  say(`0. demo insurer: no active insurer holds the key in DEMO_INSURER_API_KEY -- onboarding "${name}"`);
  const r = spawnSync(process.execPath, [path.join('src', 'scripts', 'onboardInsurer.js'), name], {
    cwd: NODE_DIR, encoding: 'utf8',
  });
  const id = /^Insurer onboarded: ([0-9a-f-]{36})$/m.exec(r.stdout ?? '')?.[1];
  if (r.status !== 0 || !id) {
    stop(`onboardInsurer.js exited ${r.status}: ${mask(r.stderr ?? '').slice(0, 400)}`);
  }
  await pool.query(
    `UPDATE insurers SET api_key_hash = encode(sha256($1::bytea), 'hex') WHERE id = $2`,
    [key, id]
  );
  say(`   onboarded ${id.slice(0, 8)}… and set its key to DEMO_INSURER_API_KEY; the key that script printed is now dead`);
  say('   this insurer is the demo\'s alone: give its key to no verify script, and verify-notification will not repoint it');
  return demoInsurer(key);
}

// A legally constrained period with no default anywhere in this system, so it
// is asked for rather than chosen. Written only when the column is NULL and
// only from the argument; a value already there is left exactly as it is.
async function ensureGracePeriod(insurer, args) {
  if (insurer.default_grace_period_days !== null) {
    say(`   default_grace_period_days: already set -- read only, not overwritten`);
    return;
  }
  if (args['grace-period-days'] === undefined) {
    stop('default_grace_period_days is NULL for the demo insurer: a legally constrained period, ' +
      'not chosen by this script -- pass --grace-period-days <n> with the value you want, or set it yourself');
  }
  const days = Number(args['grace-period-days']);
  if (!Number.isInteger(days) || days < 0) stop('--grace-period-days must be a whole number of days, 0 or more');
  await pool.query('UPDATE insurers SET default_grace_period_days = $1 WHERE id = $2', [days, insurer.id]);
  insurer.default_grace_period_days = days;
  say(`   default_grace_period_days: was NULL, wrote ${days} from --grace-period-days`);
}

// --- 1. the outsider ---------------------------------------------------------

async function ensureOutsider(insurer, name) {
  // The roles page's own choice of "another insurer" (readPolicyAsRoles in
  // node/src/routes/debug.js), so what exists here is what the page will show.
  const { rows: [outsider] } = await pool.query(
    `SELECT id, legal_name FROM insurers
      WHERE id <> $1 AND canton_party_status = 'ALLOCATED' AND canton_party_id IS NOT NULL
        AND canton_party_id <> $2
      ORDER BY (legal_name LIKE '%Outsider%') DESC, created_at, id LIMIT 1`,
    [insurer.id, insurer.canton_party_id ?? '']
  );
  if (outsider) {
    say(`1. outsider: exists (${outsider.id.slice(0, 8)}…, "${outsider.legal_name}") -- nothing written`);
    return;
  }
  say(`1. outsider: none -- onboarding "${name}" with node/src/scripts/onboardInsurer.js`);
  const r = spawnSync(process.execPath, [path.join('src', 'scripts', 'onboardInsurer.js'), name], {
    cwd: NODE_DIR, encoding: 'utf8',
  });
  const id = /^Insurer onboarded: ([0-9a-f-]{36})$/m.exec(r.stdout ?? '')?.[1];
  if (r.status !== 0 || !id) {
    stop(`onboardInsurer.js exited ${r.status}: ${mask(r.stderr ?? '').slice(0, 400)}`);
  }
  say(`   onboarded ${id.slice(0, 8)}… (its API key and party ids were printed by that script to this process only, and discarded)`);
}

// --- 2. the event window -----------------------------------------------------

async function ensureWindow(insurer, args) {
  const wanted = {
    default_event_window_timezone: args['window-timezone'],
    default_event_window_start_hour: Number(args['window-start-hour']),
    default_event_aggregation: args.aggregation,
  };
  if (!Number.isInteger(wanted.default_event_window_start_hour)) stop('--window-start-hour must be an integer');
  const before = Object.fromEntries(Object.keys(wanted).map((k) => [k, insurer[k]]));
  say(`2. event window before: ${JSON.stringify(before)}`);
  await ensureGracePeriod(insurer, args);
  const differs = Object.keys(wanted).filter((k) => before[k] !== null && before[k] !== wanted[k]);
  if (differs.length && !args.force) {
    stop(`the demo insurer already has ${differs.map((k) => `${k}=${JSON.stringify(before[k])}`).join(', ')}, ` +
      `not ${differs.map((k) => JSON.stringify(wanted[k])).join(', ')} -- nothing written; --force writes it`);
  }
  const toWrite = Object.keys(wanted).filter((k) => before[k] !== wanted[k]);
  if (!toWrite.length) {
    say('   already as asked -- nothing written');
    return;
  }
  await pool.query(
    `UPDATE insurers SET ${toWrite.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [insurer.id, ...toWrite.map((k) => wanted[k])]
  );
  const { rows: [after] } = await pool.query(
    `SELECT default_event_window_timezone, default_event_window_start_hour, default_event_aggregation
       FROM insurers WHERE id = $1`,
    [insurer.id]
  );
  say(`   wrote ${toWrite.join(', ')}${differs.length ? ' (--force)' : ''}`);
  say(`   event window after:  ${JSON.stringify(after)}`);
}

// --- 3. the tiers ------------------------------------------------------------

const bound = (v) => (v === null || v === undefined ? null : Number(v));

function checkTiers(file) {
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!spec.productCode || !spec.perilType) stop(`${file}: productCode and perilType are required`);
  if (!Array.isArray(spec.tiers) || !spec.tiers.length) stop(`${file}: tiers must be a non-empty array`);
  const orders = new Set();
  for (const t of spec.tiers) {
    if (!Number.isInteger(t.tierOrder) || orders.has(t.tierOrder)) stop(`${file}: tierOrder ${t.tierOrder} missing or repeated`);
    orders.add(t.tierOrder);
    if (!t.label) stop(`${file}: tier ${t.tierOrder} has no label`);
    const [min, max, pct] = [bound(t.thresholdMin), bound(t.thresholdMax), Number(t.payoutPercentage)];
    if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) stop(`${file}: tier ${t.tierOrder} has a non-numeric bound`);
    if (min !== null && max !== null && min > max) stop(`${file}: tier ${t.tierOrder} has thresholdMin above thresholdMax`);
    // v22: the tier's shape is stated, never assumed, and held to the
    // rules payout_tiers' CHECKs and Types.daml's validTier hold it to.
    const [pLo, pHi] = [bound(t.pctAtMin), bound(t.pctAtMax)];
    if (t.shape === 'TS_Step') {
      if (pLo !== null || pHi !== null) stop(`${file}: tier ${t.tierOrder} is TS_Step and carries pctAtMin/pctAtMax`);
      if (!(pct > 0 && pct <= 100)) stop(`${file}: tier ${t.tierOrder} payoutPercentage must be in (0, 100]`);
    } else if (t.shape === 'TS_Linear') {
      if (min === null || max === null || !(min < max)) stop(`${file}: tier ${t.tierOrder} is TS_Linear and needs thresholdMin below thresholdMax`);
      if (pLo === null || pHi === null || pLo < 0 || pLo > 100 || pHi < 0 || pHi > 100) {
        stop(`${file}: tier ${t.tierOrder} is TS_Linear and needs pctAtMin and pctAtMax in [0, 100]`);
      }
      if (pct !== Math.max(pLo, pHi)) stop(`${file}: tier ${t.tierOrder} is TS_Linear and its payoutPercentage must equal the larger end percentage`);
    } else {
      stop(`${file}: tier ${t.tierOrder} has shape ${JSON.stringify(t.shape)}, neither TS_Step nor TS_Linear`);
    }
  }
  // Both ends inclusive, as matchTier reads them: two tiers that share an end
  // point overlap at that point.
  for (let i = 0; i < spec.tiers.length; i += 1) {
    for (let j = i + 1; j < spec.tiers.length; j += 1) {
      const [a, b] = [spec.tiers[i], spec.tiers[j]];
      const lowOk = bound(a.thresholdMin) === null || bound(b.thresholdMax) === null || bound(a.thresholdMin) <= bound(b.thresholdMax);
      const highOk = bound(b.thresholdMin) === null || bound(a.thresholdMax) === null || bound(b.thresholdMin) <= bound(a.thresholdMax);
      if (lowOk && highOk) stop(`${file}: tiers ${a.tierOrder} and ${b.tierOrder} overlap (ends inclusive)`);
    }
  }
  return spec;
}

async function ensureTiers(insurer, file) {
  const spec = checkTiers(file);
  say(`3. tiers ${spec.productCode}/${spec.perilType} from ${file}: ${spec.tiers.length} tier(s), no overlap, ends inclusive`);
  const { rows } = await pool.query(
    `SELECT peril_type, tier_order, label, threshold_min, threshold_max, payout_percentage, shape, pct_at_min, pct_at_max
       FROM payout_tiers WHERE insurer_id = $1 AND product_code = $2 ORDER BY tier_order`,
    [insurer.id, spec.productCode]
  );
  const key = (peril, t) => JSON.stringify([peril, t.tierOrder, t.label, bound(t.thresholdMin), bound(t.thresholdMax), Number(t.payoutPercentage),
    t.shape, bound(t.pctAtMin), bound(t.pctAtMax)]);
  const want = spec.tiers.map((t) => key(spec.perilType, t)).sort();
  if (rows.length) {
    const have = rows.map((r) => key(r.peril_type, {
      tierOrder: r.tier_order, label: r.label, thresholdMin: r.threshold_min, thresholdMax: r.threshold_max, payoutPercentage: r.payout_percentage,
      shape: r.shape, pctAtMin: r.pct_at_min, pctAtMax: r.pct_at_max,
    })).sort();
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      stop(`payout_tiers already holds ${rows.length} row(s) for ${spec.productCode} that differ from ${file} -- nothing written, nothing overwritten`);
    }
    say(`   already present and equal -- nothing written`);
    return spec;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of spec.tiers) {
      await client.query(
        `INSERT INTO payout_tiers (insurer_id, product_code, peril_type, tier_order, label, threshold_min, threshold_max, payout_percentage,
           shape, pct_at_min, pct_at_max)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [insurer.id, spec.productCode, spec.perilType, t.tierOrder, t.label, t.thresholdMin ?? null, t.thresholdMax ?? null, t.payoutPercentage,
          t.shape, t.pctAtMin ?? null, t.pctAtMax ?? null]
      );
      say(`   inserted tier ${t.tierOrder} "${t.label}" ${t.shape} [${t.thresholdMin ?? '-inf'}, ${t.thresholdMax ?? '+inf'}] -> ${t.payoutPercentage}%`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return spec;
}

// --- 4. the policy -----------------------------------------------------------

function api(key) {
  const base = `http://localhost:${config.port}/api/v1`;
  return async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) stop(`${method} /api/v1${p} -> ${res.status} ${mask(text).slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  };
}

async function waitFor(call, policyId, eventType, seconds) {
  for (let i = 0; i <= seconds; i += 1) {
    const record = await call('GET', `/policies/${policyId}`);
    const event = record.events.find((e) => e.eventType === eventType);
    if (event?.status === 'done') {
      say(`   outbox ${eventType}: done (${event.processedAt})`);
      return record;
    }
    if (event?.status === 'failed') {
      stop(`outbox ${eventType} for ${policyId} FAILED: ${event.failure.code} -- ${event.failure.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop(`outbox ${eventType} for ${policyId} not done after ${seconds}s -- is the API (and its dispatcher) running?`);
}

async function ensurePolicy(insurer, spec, args, call) {
  const seconds = Number(args['wait-seconds']);
  if (!Number.isInteger(seconds) || seconds < 1) stop('--wait-seconds must be a positive integer');
  const { rows: [existing] } = await pool.query(
    `SELECT p.id FROM policies p
       JOIN policyholders ph ON ph.id = p.policyholder_id
       JOIN policy_coverages c ON c.policy_id = p.id
      WHERE p.insurer_id = $1 AND ph.external_ref = $2 AND c.product_code = $3 AND c.cell_ids ? $4
        AND p.start_date = $5::date AND p.end_date = $6::date
      ORDER BY p.created_at LIMIT 1`,
    [insurer.id, args['policyholder-ref'], spec.productCode, args.cell, args['start-date'], args['end-date']]
  );
  let policyId = existing?.id;
  if (policyId) {
    say(`4. policy: recognised ${policyId} (same policyholder reference, product, cell and dates) -- not created again`);
  } else {
    const created = await call('POST', '/policies', {
      policyholder: { externalRef: args['policyholder-ref'] },
      mortgagee: { externalRef: args['mortgagee-ref'] },
      documentHash: crypto.createHash('sha256').update(args['document-text']).digest('hex'),
      policyTerms: {
        premiumAmount: Number(args.premium), currency: args.currency,
        startDate: args['start-date'], endDate: args['end-date'],
      },
      coverages: [{
        coverageCode: args['coverage-code'],
        productCode: spec.productCode,
        perilType: spec.perilType,
        cellIds: [args.cell],
        sumInsured: Number(args['sum-insured']),
        mortgageeClaimAmount: Number(args['mortgagee-claim']),
        // v22: required by the API, with no default here either.
        metric: args.metric,
        payoutBasis: args['payout-basis'],
      }],
    });
    policyId = created.policy.id;
    say(`4. policy: created ${policyId} through POST /api/v1/policies`);
  }
  let record = await call('GET', `/policies/${policyId}`);
  if (record.onLedger) {
    say(`   activation: already on the ledger -- nothing sent`);
  } else {
    await call('POST', `/policies/${policyId}/activate`, {});
    say('   activation: POST /activate sent');
    record = await waitFor(call, policyId, 'activation', seconds);
  }
  say(`   term: start ${record.termStart}, expiry ${record.expiry}`);
  if (record.coverageBegun) {
    say(`   first premium: cover already began ${record.coverageBeganAt} -- nothing sent`);
  } else {
    // When the premium was paid is the caller's to state, never this script's:
    // the instant decides when cover begins (m. 1421), and sending the term
    // start silently is what dated a payment before the policy existed
    // (an open legal question). policies.created_at is the
    // instant it is measured against, read here rather than derived.
    const { rows: [made] } = await pool.query('SELECT created_at FROM policies WHERE id = $1', [policyId]);
    const { paidAt, notes } = resolvePaidAt({
      paidAtArg: args['paid-at'],
      now: new Date().toISOString(),
      policyCreatedAt: made?.created_at ?? null,
      termStart: record.termStart,
      allowBackdated: Boolean(args[BACKDATED_FLAG.slice(2)]),
    });
    for (const note of notes) say(`   NOTE: ${note}`);
    await call('POST', `/policies/${policyId}/first-premium-paid`, { paidAt });
    say(`   first premium: POST /first-premium-paid sent, paidAt ${paidAt}` +
      `${args['paid-at'] === 'now' ? ' (--paid-at now)' : ''}`);
    record = await waitFor(call, policyId, 'first_premium_paid', seconds);
  }
  say(`   state: status ${record.status}, defaultState ${record.defaultState}, cover began ${record.coverageBeganAt}`);
  return policyId;
}

// --- --teardown ----------------------------------------------------------------

async function teardown(policyId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(policyId)) stop('--teardown needs a policy UUID');
  const insurer = await demoInsurer(apiKey());
  const { rows: [policy] } = await pool.query(
    `SELECT id, policyholder_id, mortgagee_policyholder_id, insured_policyholder_id, beneficiary_policyholder_id
       FROM policies WHERE id = $1 AND insurer_id = $2`,
    [policyId, insurer.id]
  );
  if (!policy) stop(`policy ${policyId} is not the demo insurer's, or does not exist`);
  const maintUrl = config.databaseMaintUrl;
  if (!maintUrl) stop('DATABASE_MAINT_URL not set: needed for the row cleanup (the application role cannot delete)');
  await assertMaintSameServer({ maintUrl, workingUrl: config.databaseUrl });
  if (new URL(maintUrl).pathname !== new URL(config.databaseUrl).pathname) {
    stop('DATABASE_MAINT_URL and DATABASE_URL name different databases -- the row cleanup would delete somewhere else');
  }

  let archived = 0;
  for (const [moduleName, entityName, field] of [
    ['Insurance.PolicyToken', 'PolicyToken', 'policyNo'],
    ['Insurance.PayoutBridge', 'PayoutApproved', 'policyId'],
    ['Insurance.PayoutBridge', 'ManualReviewRequired', 'policyId'],
    // v22: the records a settlement or a close-unpaid leaves.
    ['Insurance.PayoutBridge', 'PayoutSettled', 'policyId'],
    ['Insurance.PayoutBridge', 'PayoutClosedUnpaid', 'policyId'],
  ]) {
    const entries = await queryActiveContracts({ moduleName, entityName, parties: [insurer.canton_party_id] });
    for (const c of entries.map((e) => e.contractEntry?.JsActiveContract?.createdEvent).filter((c) => c?.createArgument?.[field] === policyId)) {
      await archiveContract({
        exerciseChoice, contractId: c.contractId, templateId: c.templateId, signatories: c.signatories,
        createArgument: c.createArgument, fallbackActAs: [insurer.canton_party_id],
      });
      archived += 1;
      say(`archived ${entityName} ${c.contractId.slice(0, 12)}…`);
    }
  }

  const { rows: [ae] } = await pool.query('SELECT count(*)::int AS n FROM attested_evidence WHERE policy_id = $1', [policyId]);
  const people = [policy.policyholder_id, policy.mortgagee_policyholder_id, policy.insured_policyholder_id, policy.beneficiary_policyholder_id].filter(Boolean);
  const { Client } = createRequire(path.join(NODE_DIR, 'package.json'))('pg');
  const client = new Client({ connectionString: maintUrl, connectionTimeoutMillis: 3000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    const rows = await deletePolicyRows(client, 'SELECT id FROM policies WHERE id = $1', [policyId]);
    const gone = await client.query(
      `DELETE FROM policyholders ph WHERE ph.id = ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM policies p WHERE ph.id IN (p.policyholder_id, p.mortgagee_policyholder_id,
               p.insured_policyholder_id, p.beneficiary_policyholder_id, p.superseded_policyholder_id))`,
      [people]
    );
    await client.query('COMMIT');
    say(`archived ${archived} contract(s); deleted ${rows.policies} policy, ${gone.rowCount} policyholder row(s), ${rows.rawResponsesDeleted} unattested raw response(s)`);
    say(`kept: ${ae.n} attested_evidence row(s) for this policy and ${rows.rawResponsesKept.length} raw response(s) they hold` +
      (rows.rawResponsesKept.length ? ` (sha256 ${rows.rawResponsesKept.map((s) => s.slice(0, 12)).join(', ')}…)` : '') +
      ' -- append-only outside a test database; not forced');
    say('kept: the policyholder and mortgagee ledger parties (a party is never deleted)');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

// --- main ------------------------------------------------------------------------

async function main(argv) {
  const args = parseArgs(argv);
  if (args.teardown) return teardown(args.teardown);
  need(args, ['outsider-name', 'window-timezone', 'window-start-hour', 'aggregation', 'tiers']);
  if (!args['skip-policy']) {
    need(args, ['policyholder-ref', 'mortgagee-ref', 'coverage-code', 'cell', 'metric', 'payout-basis', 'sum-insured', 'mortgagee-claim', 'premium',
      'currency', 'document-text', 'start-date', 'end-date', 'paid-at', 'wait-seconds', 'recordings', 'night-from', 'night-to']);
    for (const n of ['premium', 'sum-insured', 'mortgagee-claim']) {
      if (!/^\d+(\.\d{1,2})?$/.test(args[n])) stop(`--${n} must be a plain decimal amount (e.g. 40000 or 40000.00), got ${JSON.stringify(args[n])}`);
    }
  }
  const key = apiKey();
  const { rows: [held] } = await pool.query(
    `SELECT id FROM insurers WHERE api_key_hash = encode(sha256($1::bytea), 'hex') AND is_active`,
    [key]
  );
  if (!held && args['demo-insurer-name']) {
    const { rows: [inactive] } = await pool.query(
      `SELECT id FROM insurers WHERE api_key_hash = encode(sha256($1::bytea), 'hex') AND NOT is_active`,
      [key]
    );
    if (inactive) stop(`insurer ${inactive.id.slice(0, 8)}… already holds DEMO_INSURER_API_KEY but is inactive (is_active = false) -- reactivate it or use a different key before onboarding a new one`);
  }
  // No insurer for this key and a name given: onboard the demo's own. No name:
  // demoInsurer stops with the message it always did.
  const insurer = held ? await demoInsurer(key)
    : args['demo-insurer-name'] ? await onboardDemoInsurer(key, args['demo-insurer-name'])
      : await demoInsurer(key);
  say(`demo insurer: ${insurer.id.slice(0, 8)}… "${insurer.legal_name}"`);
  await ensureOutsider(insurer, args['outsider-name']);
  await ensureWindow(insurer, args);
  const spec = await ensureTiers(insurer, args.tiers);
  if (args['skip-policy']) {
    say('4. policy: --skip-policy -- nothing sent');
    return;
  }
  const policyId = await ensurePolicy(insurer, spec, args, api(key));
  say(`5. policy id: ${policyId}`);
  say('   replay (from node/):');
  say(`   node ../scripts/replayRecordedResponses.mjs --dir ${args.recordings} --cell ${args.cell} ` +
    `--from ${args['night-from']} --to ${args['night-to']} --policy ${policyId} --coverage ${args['coverage-code']}` +
    `${args['allow-gaps'] ? ' --allow-gaps' : ''}`);
  say(`   story: http://localhost:${config.port}/debug/story`);
  say(`   roles: http://localhost:${config.port}/debug/roles  (policy ${policyId})`);
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`[setupDemo] ${err.stop || err instanceof PaidAtRefused ? 'STOPPED: ' : ''}${mask(err.message)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
