import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// The delay before each retry, in milliseconds. A value that is not a positive
// integer stops the process here rather than scheduling a retry at NaN.
// The variable's name is passed in so the refusal names the key that is wrong:
// three keys use this format now (WEBHOOK_RETRY_SCHEDULE_MS,
// ORACLE_TRIGGER_RETRY_SCHEDULE_MS and ORACLE_TRIGGER_UNENDED_RETRY_SCHEDULE_MS).
function retrySchedule(name, list) {
  const delays = list.split(',').map((s) => Number(s.trim()));
  if (!delays.length || !delays.every((d) => Number.isInteger(d) && d > 0)) {
    throw new Error(`${name} must be a comma-separated list of positive integers (milliseconds)`);
  }
  return delays;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required('DATABASE_URL'),
  // Optional: the maintenance role, for scripts and tests that create
  // databases. The application never reads it.
  databaseMaintUrl: process.env.DATABASE_MAINT_URL || undefined,
  daml: {
    jsonApiUrl: required('DAML_JSON_API_URL'),
    // Two auth modes: set DAML_LEDGER_TOKEN to a real (e.g. OIDC-issued)
    // bearer token for a production/TestNet participant. For LocalNet's
    // "unsafe-jwt-hmac-256" auth service instead set DAML_UNSAFE_JWT_SECRET
    // (+ optionally DAML_UNSAFE_JWT_SUB) and damlClient.js mints a fresh
    // HS256 token per call (exp 24 hours) -- avoids pasting in a token that
    // expires and needs manual regeneration during local dev.
    ledgerToken: process.env.DAML_LEDGER_TOKEN || undefined,
    unsafeJwtSecret: process.env.DAML_UNSAFE_JWT_SECRET || undefined,
    unsafeJwtSub: process.env.DAML_UNSAFE_JWT_SUB ?? 'ledger-api-user',
    // Raw package-id hash (from the deployed DAR's own manifest), not the
    // package *name*. PV34 networks (Canton 3.4.x, e.g. the Canton Builder
    // Tool's LocalNet) only support id-based template addressing --
    // `#package-name:...` needs PV35. This changes on every DAR rebuild
    // (Daml package ids are content hashes) -- re-deploy and update this
    // whenever the DAR changes.
    packageId: required('DAML_PACKAGE_ID'),
    // The SECOND participant, where the oracle operator parties are hosted
    // and where every submission made as an oracle party goes. Unset or empty
    // is the single-participant configuration this system ran on until now:
    // the oracle lives on the same participant as the insurer and every call
    // uses jsonApiUrl above. There is no half state and no silent fallback --
    // once this is set, an oracle submission goes to this endpoint or fails
    // loudly (damlClient.js oracleEndpoint, dispatcher.js's startup probe
    // announceOracleParticipant and scripts/doctor.mjs all say which endpoint
    // they mean).
    jsonApiUrlOracle: process.env.DAML_JSON_API_URL_ORACLE || undefined,
  },
  // The narrow retry the second-participant configuration needs, and only it:
  // a freshly minted token has to reach the oracle's participant before that
  // participant can be asked to exercise a choice on it, and a two-participant
  // measurement script kept outside this repository measured that this is a RACE, not a fixed
  // latency -- of five runs one was refused 404 CONTRACT_NOT_FOUND at +473ms
  // after the mint and accepted at +1122ms, while the others were accepted
  // first try at +455, +482, +926 and +1046ms. The default schedule below
  // therefore spans that measured window with margin rather than sleeping a
  // fixed amount: attempts at +0, +500, +1500, +3500 and +7500ms. Nothing
  // else in this system retries a ledger submission, except the same trigger
  // re-sent on the schedule below; dispatcher.js states the
  // four conditions that have to hold before this schedule is used at all.
  oracleTrigger: {
    retryScheduleMs: retrySchedule(
      'ORACLE_TRIGGER_RETRY_SCHEDULE_MS',
      process.env.ORACLE_TRIGGER_RETRY_SCHEDULE_MS ?? '500,1000,2000,4000'
    ),
    // A trigger the ledger refused only because its event has not ended yet
    // on the ledger's clock (dispatcher.js, exerciseTriggerWithUnendedRetry).
    // The default is the key above's default, copied: no difference between
    // this process's clock and the ledger's has been measured.
    unendedRetryScheduleMs: retrySchedule(
      'ORACLE_TRIGGER_UNENDED_RETRY_SCHEDULE_MS',
      process.env.ORACLE_TRIGGER_UNENDED_RETRY_SCHEDULE_MS ?? '500,1000,2000,4000'
    ),
  },
  oracle: {
    pollCron: process.env.ORACLE_POLL_CRON ?? '*/15 * * * *',
    climateApiUrl: process.env.CLIMATE_API_URL,
    // MET Norway requires every request to identify its caller with contact
    // details (api.met.no/doc/TermsOfService). No default: a provider that
    // asks who is calling and is told nothing gets no request at all.
    climateApiUserAgent: process.env.CLIMATE_API_USER_AGENT,
  },
  // Default is a convenience, not the source of correctness -- the
  // sweeper's own query (expiry in the past AND still open) is what makes
  // a missed run recoverable simply by running again; the clock only
  // decides how often it gets a chance to.
  // Hourly because a policy held past expiry for its last window should stay
  // open at most an hour, not a day, once that window has closed and been
  // evaluated; the sweeper is a state test, so running it often is harmless.
  expirySweeper: {
    cron: process.env.EXPIRY_SWEEP_CRON ?? '0 * * * *',
  },
  // Same reasoning as expirySweeper above -- the schedule is a
  // convenience; correctness comes from the sweeper's own state-test query.
  // Kept daily in v22: hourly would record a termination sooner, before a late but timely payment report can arrive; a held window then waits up to a day, which delays a payout but loses none.
  graceSweeper: {
    cron: process.env.GRACE_SWEEP_CRON ?? '0 12 * * *',
  },
  // m. 1434(2)'s deemed withdrawal. Same reasoning again -- the schedule is a
  // convenience; correctness comes from the sweeper's own state-test query.
  firstPremiumSweeper: {
    cron: process.env.FIRST_PREMIUM_SWEEP_CRON ?? '0 12 * * *',
  },
  // m. 1434(4)'s deferred effect. Same reasoning a fourth time -- the
  // schedule is a convenience; correctness comes from the sweeper's own
  // state-test query, and the instant it records is frozen on the policy.
  twoNoticeSweeper: {
    cron: process.env.TWO_NOTICE_SWEEP_CRON ?? '0 12 * * *',
  },
  payoutListener: {
    pollMs: Number(process.env.PAYOUT_LISTENER_POLL_MS ?? 10000),
  },
  // Name predates the dispatcher generalization (dispatch/dispatcher.js) --
  // left as-is, not a functional issue, to keep this change to what was asked.
  mintWatcher: {
    pollMs: Number(process.env.MINT_WATCHER_POLL_MS ?? 2000),
  },
  // The payout notification sender (notifications/sender.js).
  // No default for the master key: without it the sender does not start, and
  // there is no unsigned delivery path. The per-insurer secret is derived from
  // it (notifications/signature.js) and never stored.
  // allowNonLoopback makes the loopback-only rule
  // mechanical: only the exact string 'true' opens it, anything else is
  // loopback-only.
  notificationSender: {
    signingMasterKey: process.env.WEBHOOK_SIGNING_MASTER_KEY || undefined,
    pollMs: Number(process.env.WEBHOOK_SENDER_POLL_MS ?? 5000),
    timeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS ?? 10000),
    retryScheduleMs: retrySchedule('WEBHOOK_RETRY_SCHEDULE_MS', process.env.WEBHOOK_RETRY_SCHEDULE_MS ?? '60000,300000,1800000,7200000,43200000'),
    // How long a row may sit in processing before runOnce treats its sender
    // as gone and releases it (sender.js, releaseStale).
    staleProcessingMs: Number(process.env.WEBHOOK_STALE_PROCESSING_MS ?? 120000),
    allowNonLoopback: process.env.WEBHOOK_ALLOW_NON_LOOPBACK === 'true',
  },
  // The /debug routes serve party ids and full contract
  // payloads with no authentication. Kept raw, not as a boolean, so app.js can
  // say at startup when a value was set but not recognised: only the exact
  // string 'true' mounts them; unset, empty or anything else leaves them off.
  // The loopback check inside the routes stays as a second layer.
  debugRoutes: process.env.DEBUG_ROUTES_ENABLED,
};
