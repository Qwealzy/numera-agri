import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
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
    // short-lived HS256 token per call -- avoids pasting in a token that
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
  expirySweeper: {
    cron: process.env.EXPIRY_SWEEP_CRON ?? '0 12 * * *',
  },
  // Same reasoning as expirySweeper above -- the schedule is a
  // convenience; correctness comes from the sweeper's own state-test query.
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
};
