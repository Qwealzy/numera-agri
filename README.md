# Parametric Insurance Tokenization & Automation Infrastructure

## HackCanton Season 3

**Numera: parametric insurance payout infrastructure on Canton.** Parametric policies and their payouts are Daml contracts on Canton; the insurer is notified of each approved payout and pays through its own systems. Track 1.

- **Disclosure.** The Daml contracts and the policy lifecycle existed before the hackathon, up to the tag `hackathon-baseline`. Everything after it is delivery-phase work, shown by `git diff hackathon-baseline HEAD` (this repository has two commits, so `git log hackathon-baseline..HEAD` shows only the one). Among others: the payout notification sender and its HMAC signature, with the `set-webhook` CLI; the insurer's read endpoints `GET /api/v1/payouts` and `GET /api/v1/payouts/:id`; the contract `docs/api/notifications-v1.openapi.json`, held by structural tests; a fake insurer receiver (`scripts/mock-insurer.mjs`) and `scripts/verify-notification.mjs`, run by `npm run verify-all`; the read-only story page `/debug/story`; this section, `LICENSE` and the tool that builds the public copy, which is not part of the copy itself. The Daml package changed in the delivery phase too: v22 added the `PayoutSettled` and `PayoutClosedUnpaid` records, linear payout tiers (`TS_Linear`) and the check that an event has ended on the ledger's clock before it is evaluated.
- **AI disclosure.** Most of the code was written with Claude Code, under human direction. The development process records and the agent configuration are kept private and are not part of this repository.
- **Honest status.** It runs end to end on a Canton LocalNet. The data source today is a temporary forecast service, not a measurement. The platform holds no funds and instructs no payments. Open legal questions are kept in the development process records, which are not part of this repository; nothing here claims legal or regulatory conformity.
- **Public mirror.** This is a new git repository with exactly two commits, taken from a private development repository: a baseline commit holding the project as of 2026-09-18, tagged `hackathon-baseline`, and a submission commit holding it as of 2026-10-02. The history between them is not published. It holds only the product: the README, `LICENSE`, `multi-package.yaml`, the Daml packages and their tests, the Node service, the SQL, the API contract and the demo, verify and maintenance scripts. The development process records, the agent configuration, internal notes and the statute texts are not part of it; where the code or the documents mention them, they are not in this copy.
- **Run it.** Setup below; on Windows the stack runs through WSL2 and Docker Desktop (see Setup and "Running on Windows with a Turkish system locale"). Demo, with `npm start` running in `node/`:

```bash
cd node && npm run set-webhook -- <insurerId> http://127.0.0.1:9099/webhook   # prints the signing secret once
MOCK_INSURER_API_KEY=<insurer-api-key> MOCK_INSURER_WEBHOOK_SECRET=<secret-printed-above> node scripts/mock-insurer.mjs --auto-settle
# story page: http://localhost:8080/debug/story (fake insurer: http://127.0.0.1:9099/)
# roles page: http://localhost:8080/debug/roles (one policy as the insurer's, the policyholder's, the mortgagee's and another insurer's ledger views return it)
# /debug (story page, roles page, dashboard) is off by default: DEBUG_ROUTES_ENABLED=true in node/.env turns it on
```

- **A recorded night.** Provider responses recorded by `scripts/recordProviderResponses.mjs` are replayed, with their recorded times, against a demo policy whose cover began before that night: the policy is made and its first premium reported paid before the first hour you record, the night is recorded, and the recording is replayed once the event window holding it has closed. Cover begins at the reported payment instant, which can be no later than now, and a reading from before cover began is stored but never folded into a window. Start the API with `CLIMATE_API_URL` empty, so the live oracle writes no reading to the demo cell and every reading shown is a replayed one (its source ends in `REPLAY(recorded …)`). The demo terms in `scripts/demo/` are synthetic. From `node/`, with `DEMO_INSURER_API_KEY` set to the demo insurer's key:

  Give the demo an insurer of its own, and give that insurer's key to no verify script. `scripts/verify-notification.mjs` repoints the webhook address of whichever insurer its key names, for the length of its run, and every notification of that insurer still waiting for an address is delivered there while it is pointed away — which is how a demo payout's notification once left for a receiver that had nothing to do with the demo. `--demo-insurer-name` onboards one and gives it the key already in `DEMO_INSURER_API_KEY`; no key is printed or typed back. A freshly onboarded insurer has no `default_grace_period_days`: it is a legally constrained period with no default anywhere here, so the script stops until `--grace-period-days` supplies the value you want.

```bash
# BEFORE the night. DEMO_INSURER_API_KEY holds a key you generated; --demo-insurer-name onboards the demo's own insurer under it
# --paid-at has no default: "now" dates the payment at the moment this step is sent, and cover begins then. An instant before the
# policy was made stops the run (an open legal question); --allow-backdated-payment sends it anyway.
# --metric: TEMPERATURE_C is the only code the oracle supplies. --payout-basis has no default.
# --night-from / --night-to: the first and last hour you will record, UTC; they only print the replay command.
node ../scripts/setupDemo.mjs --demo-insurer-name "Demo Only Insurance A.S." --grace-period-days <days you decide> --outsider-name "Outsider Demo Insurance A.S." --window-timezone Pacific/Auckland --window-start-hour 8 --aggregation min --tiers ../scripts/demo/demo-lowtemp-tiers.json --policyholder-ref DEMO-FARM-0001 --mortgagee-ref DEMO-BANK-0001 --coverage-code LOWTEMP-COVER --cell "metno:-44.26,170.1" --metric TEMPERATURE_C --payout-basis <PB_RemainingLimit or PB_SumInsured, you decide> --sum-insured 100000 --mortgagee-claim 40000 --premium 500 --currency TRY --document-text "demo-lowtemp synthetic policy document" --start-date <YYYY-MM-DD, on or before the night> --end-date <YYYY-MM-DD, after it> --paid-at now --wait-seconds 120 --recordings ../recordings --night-from <first hour, UTC> --night-to <last hour, UTC> --allow-gaps
# DURING the night, until Ctrl+C. The recorder needs CLIMATE_API_URL and CLIMATE_API_USER_AGENT; give
# CLIMATE_API_URL to this command's environment only, not to the API's.
node ../scripts/recordProviderResponses.mjs --out ../recordings metno:-44.26,170.1
# AFTER the window holding the night has closed (08:00 Pacific/Auckland, with the window rule above):
node ../scripts/replayRecordedResponses.mjs --dir ../recordings --cell metno:-44.26,170.1 --from <first hour, UTC> --to <last hour, UTC> --policy <policyId printed above> --coverage LOWTEMP-COVER --allow-gaps
# then http://localhost:8080/debug/story and http://localhost:8080/debug/roles (paste the policy id)
```

  The story page reaches "approved" with the steps above when the night's
  minimum falls inside a tier of the tiers file (the demo file has one, 0.0001
  °C to 1.0 °C); on any other night the window is evaluated and nothing is
  approved. To reach "notified" and
  "settled" as well, point the demo insurer's webhook at the fake receiver and run
  the receiver with `--auto-settle`. `set-webhook` prints the signing secret once,
  to that terminal; pass it and the API key through the environment so neither is
  typed into a command line or a script:

```bash
cd node && npm run set-webhook -- <demo insurerId printed by setupDemo> http://127.0.0.1:9099/webhook
read -rs MOCK_INSURER_WEBHOOK_SECRET   # paste the secret it printed; it is not echoed
read -rs MOCK_INSURER_API_KEY          # the same key as DEMO_INSURER_API_KEY
export MOCK_INSURER_WEBHOOK_SECRET MOCK_INSURER_API_KEY
node ../scripts/mock-insurer.mjs --auto-settle   # fake receiver: http://127.0.0.1:9099/
# the story page then fills "Insurer notified", and "Settled by insurer" a few seconds later
```

---

B2B SaaS bridge between an insurance company's actuarial pipeline and
Canton/Daml. It mints policies as on-ledger NFT-style contracts, evaluates a
tiered parametric payout matrix on-chain, and records the full contract
lifecycle — issue, endorse, renew, notice of premium default, termination,
expiry, payout, settlement — as an auditable chain of ledger transactions.

**Minting a token does not mean the policy is live.** It means the contract
exists. Under TTK 6102 m. 1421 the insurer's liability begins with payment of
the first premium unless the parties agreed otherwise, so a minted policy
carries no cover until that is reported — and a trigger against one is
refused. See the cover-start note below.

**The platform holds no funds, instructs no payments, and stores no account
numbers.** There is no IBAN, no bank account, no EFT call and no Open Banking
integration anywhere in this system, and none may be added. When a payout is
approved the insurer pays through its own systems and then *reports* the
settlement back; the platform records what it was told. Canton is
authorization and ledger-of-record only.

For anything below in detail — how a single request moves through the whole
stack, why each design decision was made, the live verification runs, and the
known gaps — see the system walkthrough, which is not part of this copy.
This file is the short version.

## Layout

| Path | Layer | Covers |
|---|---|---|
| `sql/schema.sql`, `sql/seed.sql`, `sql/migrations/` | PostgreSQL | Off-chain system of record — insurers, policyholders, policy mirror, `policy_events` outbox, payout-tier config, `policy_status_history` audit chain |
| `daml/daml/Insurance/Types.daml` | Daml | Shared data types + the pure tiered-payout-matrix logic |
| `daml/daml/Insurance/PolicyToken.daml` | Daml | The policy token — mint, tier evaluation, endorsement, notice, termination, the two burn paths |
| `daml/daml/Insurance/PayoutBridge.daml` | Daml | `PayoutApproved` (the payout obligation) + `ManualReviewRequired` + `PayoutSettled` / `PayoutClosedUnpaid` (what stays on the ledger once a payout is reported settled or a review item is closed unpaid) |
| `daml-tests/daml/InsuranceTests.daml` | Daml | Script tests: the full lifecycle, `ensure` clauses, and authorization boundaries as `submitMustFail` cases with control assertions |
| `node/src/routes/policies.js` | Node.js | The whole HTTP API (see below) |
| `node/src/dispatch/dispatcher.js` | Node.js | Sole reader of `policy_events` and the **only** code path that touches the ledger. One handler per `event_type` |
| `node/src/oracle/oracleBot.js` | Node.js | Scheduled oracle bot: reads external data, writes a `trigger` outbox row |
| `node/src/listeners/payoutListener.js` | Node.js | Polls the ledger for `PayoutApproved` and writes a settlement-tracking row. **Instructs no payment** |
| `node/src/sweepers/expirySweeper.js` | Node.js | Finds policies past their term end, queues `expiry` |
| `node/src/sweepers/graceSweeper.js` | Node.js | Two phases: notice period elapsed → `termination`; terminated with all payouts closed → `termination_archive` |
| `node/src/sweepers/firstPremiumSweeper.js` | Node.js | m. 1434(2)'s deemed withdrawal — window elapsed with no suit or enforcement reported. A separate mechanism from the above, not a phase of it |
| `node/src/sweepers/twoNoticeSweeper.js` | Node.js | m. 1434(4)'s deferred effect — an elected termination reaching the end of its insurance period. The third premium-default mechanism, and the third separate file |
| `node/src/routes/debug.js`, `node/public/` | Node.js | Read-only reconciliation dashboard (SQL mirror vs. the live ledger); `/debug/story`, one payout's steps from reading to closure, for the demo. Mounted only when `DEBUG_ROUTES_ENABLED=true` |
| `node/public/konsol/` | Browser | Read-only insurer console prototype at `/konsol`: the insurer's own policies and payouts through the four GET endpoints, with the key it pastes (kept in sessionStorage). Not behind `DEBUG_ROUTES_ENABLED` |
| `node/src/scripts/onboardInsurer.js` | Node.js | Admin CLI to onboard an insurer + allocate its two Parties |
| `scripts/` | Node.js | One-off operational scripts — package-migration steps and live-verification runs. Kept in the repo rather than improvised per session, because every one of them has been needed twice |
| `docs/` | — | The walkthrough, the package-migration runbook, and the legal cross-check (not part of this copy) |

## API

Creating a policy and minting it are two separate acts. `POST /policies`
writes SQL only; nothing reaches the ledger until an outbox row exists.

```
POST /api/v1/policies                              create (SQL only, never mints)
     body may name an optional mortgagee and beneficiary, and a
     mortgageeClaimAmount per coverage
     body requires documentHash: the policy document's SHA-256, 64 lowercase hex
     a coverage may send its own payoutTiers (the Tier shape of the terms contract), used
     instead of the configured set; the 201 names each coverage's tiersSource (inline or
     configured) and the gaps between its tiers
     premiumAmount and each sumInsured: a number or numeric string above zero, at most 12
     integer digits and 2 decimals; each coverageCode a non-empty string; else 400 naming the field
POST /api/v1/policies/:id/activate                 queue the mint
POST /api/v1/policies/:id/endorse                  amend an in-force policy
     an added coverage's payoutTiers are held to the tier-set rules and sorted; every sumInsured
     and an added mortgageeClaimAmount follow create's amount rule; payoutDestination and
     remainingLimit are derived, and sending either is 400; a claim needs a mortgagee
     (newMortgagee if the body sends it, else the policy's); a code both removed and added, or
     removing a coverage attached now (m. 1457), is 400. Each refusal comes before any row is written
POST /api/v1/policies/:id/renew                    open a new period (new policy, linked back)
     body requires the new period's own documentHash, in the same form
     payoutTiers and the amount and coverageCode rules as for create; the 202 names each
     coverage's tiersSource and gaps
POST /api/v1/policies/:id/notice                   record a premium-default notice (m. 1434(3))
POST /api/v1/policies/:id/two-notice-election      elect to terminate at the period end (m. 1434(4))
POST /api/v1/policies/:id/premium-due-date         report the first premium due and unpaid (m. 1434(2))
POST /api/v1/policies/:id/enforcement-commenced    report suit or enforcement commenced
POST /api/v1/policies/:id/enforcement-fruitless    report that pursuit came to nothing (m. 1431(4))
POST /api/v1/policies/:id/substitution-notice      report notifying the sigortalı
POST /api/v1/policies/:id/substitute-policyholder  the sigortalı takes over; the contract continues with them
POST /api/v1/policies/:id/first-premium-paid       report receipt; cover begins (m. 1421)
POST /api/v1/policies/:id/withdraw-first-premium   the insurer withdraws within the window
POST /api/v1/policies/:id/reinstate                record that the premium was paid
POST /api/v1/policies/:id/mortgagee-notice         record notifying a real-right holder
POST /api/v1/policies/:id/attachment               record the insured property attached (m. 1457)
POST /api/v1/policies/:id/attachment-lifted        record the attachment lifted
POST /api/v1/policies/:id/mortgagee-info-request   record a m. 1456(6) request made to the insurer
POST /api/v1/policies/:id/mortgagee-info-provided  record that the insurer answered it
POST /api/v1/policies/:id/mortgagee-election       record their election
POST /api/v1/payouts/:id/settle                    insurer reports it paid
POST /api/v1/payouts/:id/fail                      insurer reports it could not
POST /api/v1/payouts/:id/close-unpaid              close a review item unpaid, with a reason
GET  /api/v1/payouts                               the insurer's own payouts, oldest first, by cursor
     query: status, recordKind, after (a nextCursor, unchanged), limit (1..200, default 50)
GET  /api/v1/payouts/:id                           one payout; another insurer's is 404
     contract for both, and for the webhook: docs/api/notifications-v1.openapi.json
GET  /api/v1/policies/:id                          one policy: state, coverages, its events newest first
     (at most 50), a failed one as a reason code; another insurer's is 404. ledgerContractId
     is the CURRENT token and changes on every lifecycle event. Same contract file
GET  /api/v1/policies                              the insurer's own policies, newest first, by cursor: per policy
     its state, term, coverages with remaining limit, and newest event. query: after, limit
     (1..200, default 50). Same contract file
GET  /api/v1/terms                                 the insurer's own periods and event-window rule, null where unset
PUT  /api/v1/terms                                 replace them: every key, null unsets a value
GET  /api/v1/terms/payout-tiers/:productCode/:perilType     one tier set, by tierOrder; none is 404
PUT  /api/v1/terms/payout-tiers/:productCode/:perilType     replace the set; the answer lists its gaps
DELETE /api/v1/terms/payout-tiers/:productCode/:perilType   remove the set; none is 404
     contract: docs/api/terms-v1.openapi.json
GET  /konsol                                       read-only insurer console (prototype, node/public/konsol/): the
     insurer pastes its key, the page sends it as x-api-key to the four payout and policy GETs above, and nothing on it writes
GET  /debug/contracts, /debug/dashboard            read-only reconciliation
GET  /debug/story, /debug/roles                    the demo's story page; one policy as four parties' ledger views return it:
     the insurer, the policyholder, the mortgagee and another insurer
     every /debug route is mounted only when DEBUG_ROUTES_ENABLED=true in node/.env; off by default
```

`POST /api/v1/policies` writes SQL only and answers 201; every other POST
above writes a `policy_events` row and answers 202. The `/api/v1` GETs only
read: they write no row. The terms `PUT` and the tier-set `PUT` and `DELETE`
write SQL only and answer 200. None of the `/api/v1` routes calls Canton. Some
`/debug` routes do: `/debug/contracts` reads the ledger, and the roles page's
`/debug/roles-data` grants the platform's ledger user a temporary read-as
right and revokes it within the request, while its
`POST /debug/roles/try-insurer-trigger` submits one command the ledger is
expected to refuse.

## Setup

**`sql/schema.sql` is the only supported install path.** The numbered
migrations are applied history for databases that already exist — they are
not an install route and cannot be replayed from nothing: migration 001
expects a schema that predates the outbox, and that schema is not in this
repository. Verified, not assumed; run `node scripts/checkMigrationBase.mjs`
to see it fail.

```bash
# 1. Database -- a NEW database is always built from schema.sql
createdb insurance
psql -v ON_ERROR_STOP=1 -d insurance -f sql/schema.sql
psql -v ON_ERROR_STOP=1 -d insurance -f sql/seed.sql   # optional demo insurer + tiers. Do NOT run this
                                                       # against anything real: it seeds a known API key.
# An EXISTING database from an earlier revision is brought forward by running
# the migrations it has not had yet, in order -- never by re-applying
# schema.sql over it, and never by re-running the whole directory: nothing
# records which migrations a database has had, psql commits each statement on
# its own, and several files rewrite existing rows (003, 004 and 036 among
# them). Pick the files by hand and apply each one on its own, as the
# maintenance user, stopping at the first error:
psql -v ON_ERROR_STOP=1 -d insurance -f sql/migrations/<the next file>.sql
# then compare DATABASE_URL's database with schema.sql (exit 0 = no drift; it
# also needs DATABASE_MAINT_URL, on the same server, to build and drop a
# throwaway copy of schema.sql). Run it before a migration too: its "only in
# schema.sql" lines show what the database does not have yet.
node scripts/checkSchemaDrift.mjs
# The application's least-privileged role and its grants, as the maintenance
# user (idempotent; the test database gets mode=test once setupTestDb has built it):
psql -v ON_ERROR_STOP=1 -v app_role=insurance_app -v app_password=... -v mode=working -d insurance -f sql/roles.sql
psql -v ON_ERROR_STOP=1 -v app_role=insurance_app -v app_password=... -v mode=test -d insurance_test -f sql/roles.sql
# node/.env then holds two kinds of URL: DATABASE_URL and TEST_DATABASE_URL
# connect as insurance_app (what the application and the tests use);
# DATABASE_MAINT_URL connects as the maintenance user (createdb, schema.sql,
# pgcrypto, the test-database marker, roles.sql).

# 2. Daml (requires the Canton `dpm` SDK: https://github.com/digital-asset/dpm/releases,
#    plus a JDK 17+ on JAVA_HOME -- dpm's Script Service needs it)
dpm install 3.5.1
dpm build --all                      # from the repo root; builds ./daml and ./daml-tests
cd daml-tests && dpm test && cd ..   # dpm test must run from inside the test package

# 3. A real Canton network -- Canton Builder Tool LocalNet
#    (macOS/Linux native, WSL2 on Windows; needs Docker Desktop with WSL
#    integration enabled for your distro):
curl -fsSL https://raw.githubusercontent.com/canton-network-devs/Canton-Builder-Tool/main/install.sh | bash
source ~/.bashrc
canton builder start                 # first run downloads images, ~5 min
canton builder deploy daml/.daml/dist/insurance-tokenization-v22-1.0.0.dar
# canton builder deploy's own JWT helper has a bug (base64 without -w 0
# corrupts the token on longer payloads) that broke this for us -- if the
# deploy 400s, POST the DAR to :3975/v2/packages and :2975/v2/packages
# yourself with a correctly-generated HS256 token instead.

# 4. Node.js
cd node
cp .env.example .env         # fill in DATABASE_URL, DAML_PACKAGE_ID, etc.
npm install
npm run onboard-insurer "Acme Insurance A.S." 1000   # allocates real Canton parties
npm start                    # the API and eight background loops: dispatcher, oracle bot, payout listener,
                             # the expiry, grace, first-premium and two-notice sweepers, and the notification sender
# one loop as a process of its own -- an extra copy next to the one npm start
# runs (there is no API-only mode), not a replacement for it:
npm run dispatch / oracle / listener / expiry-sweeper / grace-sweeper / first-premium-sweeper / two-notice-sweeper / notification-sender
node ../scripts/setupTestDb.mjs   # once: builds and marks the TEST_DATABASE_URL database
npm test                     # the files it runs are in package.json scripts; here only
                             # what needs LocalNet or DATABASE_MAINT_URL.
                             # half 1: read-only against DATABASE_URL; needs DATABASE_MAINT_URL for
                             # the drift test's throwaway.
                             # half 2: the tests that write, against TEST_DATABASE_URL.
                             # It must be marked, DATABASE_URL must be reachable for the
                             # guard's check, and the dispatcher, oracle-window,
                             # replayRecorded and verifyTeardown tests need LocalNet, and so
                             # does twoParticipants when TEST_DAML_JSON_API_URL_ORACLE is
                             # set -- then the leak gate, in a process of its own
npm run test:db              # the files it runs are in package.json scripts. No LocalNet;
                             # needs DATABASE_MAINT_URL, since the guard, drift and evidence-lock
                             # tests create and drop throwaway
                             # databases
```

Which URL each command uses. None of them falls back from DATABASE_MAINT_URL to
DATABASE_URL: without it they stop with `DATABASE_MAINT_URL not set`. Where both
are used, DATABASE_MAINT_URL must reach the same server (same `system_identifier`).

| Command | DATABASE_URL | TEST_DATABASE_URL | DATABASE_MAINT_URL |
|---|---|---|---|
| `npm start`, `npm run dispatch` and the other loops | reads and writes | — | never read |
| `npm run doctor` | read-only: `db` lines, the guard's identity check, the working database's name for drift | read-only: `testdb` lines | read-only `maint` line; the drift check below |
| `node scripts/checkSchemaDrift.mjs` (and `schemaDrift.test.mjs`) | the working database's name; identity check | — | creates, builds and drops the throwaway; reads both catalogs |
| `node scripts/checkSchemaApplies.mjs` | — | — | createdb, `schema.sql`, `seed.sql`, dropdb |
| `node scripts/checkMigrationBase.mjs` | — | — | createdb, `schema.sql`, `seed.sql`, the migrations, dropdb |
| `node scripts/setupTestDb.mjs` | the guard's identity check | probe; identity check | createdb, table count, `schema.sql`, the test-database marker |
| `npm run test:db` | enumOrdering, eventHandlers and notificationsContract read; the guard's identity check; the guard cases connect as this role | — | CREATE/DROP DATABASE, the marker; evidenceLock's `schema.sql`, `roles.sql` and CREATE ROLE |
| `npm test` half 1 | enumOrdering, eventHandlers, notificationsContract; drift as above | — | drift as above |
| `npm test` half 2 | the guard's identity check, then replaced by TEST_DATABASE_URL | every write and teardown DELETE, as `insurance_app` | — |
| `psql ... -f sql/roles.sql` | — | — | the maintenance user |

`DAML_PACKAGE_ID` must match the deployed DAR. Read it from that DAR's
`META-INF/MANIFEST.MF` `Main-Dalf` filename — **it changes on every
rebuild**, and a stale value produces contracts nothing can read.

### Two participants (optional)

`DAML_JSON_API_URL_ORACLE` is the second participant, where the oracle
operator parties are hosted and where the trigger is submitted. Leave it
**empty** for the single-participant configuration this system ran on until
now; nothing changes. Set it (LocalNet's App User participant is
`http://localhost:2975`) and:

- `npm run onboard-insurer` allocates the oracle party there and grants its
  `CanActAs` to **that** participant's ledger user — rights are per
  participant, which is what keeps the insurer's node unable to submit as the
  oracle. The insurer party stays on `DAML_JSON_API_URL`.
- the dispatcher sends `PolicyToken_EvaluateTrigger` there and everything else
  to the insurer's participant. It says which participant it will use at
  startup, and says so loudly if the second one does not answer — nothing
  falls back, so every trigger fails until it does.
- the ledger side has two retries, both of the one trigger submission.
  `ORACLE_TRIGGER_RETRY_SCHEDULE_MS` is the first: a
  trigger refused `CONTRACT_NOT_FOUND` **only** because the freshly minted
  token has not reached the oracle's participant yet is re-submitted on this
  schedule, under the same ledger command id. It is used only in this
  configuration; with one participant a `CONTRACT_NOT_FOUND` fails the outbox
  row at once, as it always has. `ORACLE_TRIGGER_UNENDED_RETRY_SCHEDULE_MS` is
  the second: a trigger refused **only** because its event has not ended yet
  on the ledger's clock is re-submitted on that schedule, under the same
  command id, with one participant or two.
- `npm run doctor` prints an `oracle-node` line per check — whether the
  second participant answers, whether it has `DAML_PACKAGE_ID`, how many
  rights its ledger user holds, and, per insurer, whether its oracle operator
  is on the same participant or a separate one.

The DAR has to be on **both** participants: `scripts/uploadDar.mjs` already
uploads to `:3975` and `:2975`, and a trigger sent to a participant that does
not have the package fails on an unknown template.

`node/test/twoParticipants.test.mjs` runs the whole path against a real second
participant, and skips itself unless `TEST_DAML_JSON_API_URL_ORACLE` names
one in the shell — it is a test variable, never read from `node/.env`:

```bash
cd node && TEST_DAML_JSON_API_URL_ORACLE=http://localhost:2975 \
  node --test --test-concurrency=1 test/twoParticipants.test.mjs
```

## Deploying a change to the Daml package

Read the package-migration runbook (not part of this copy) before you do
this. The short version, learned by burning three package names:

- **A field or choice-signature change needs a package RENAME, not a version
  bump.** Daml's Smart Contract Upgrade check rejects renamed or removed
  fields outright (`NOT_VALID_UPGRADE_PACKAGE`), and Canton will not re-vet
  the same name+version with different content. Plan the rename up front.
- **Wire-check before you commit the name.** Build the DAR once under a
  throwaway name, deploy that, and probe the genuinely new argument shapes
  through `damlClient.js` itself. A decoder surprise then burns the throwaway
  instead of the real name. The check proves *encoding*, not semantics — a
  value can decode perfectly and still be meaningless.
- **Then clean up**, in order: archive contracts, delete SQL rows, and only
  then recompute which parties are unreferenced and revoke their rights.

## Design notes worth knowing before you extend this

- **One outbox for every ledger-changing event, ever — not one per event
  type.** `policy_events` carries `activation`, `trigger`, `settlement`,
  `expiry`, `notice`, `termination`, `termination_archive`, `reinstatement`,
  `endorsement`, `renewal`, the four mortgagee events, `premium_due_date`,
  `enforcement_commenced`, `first_premium_paid`, `first_premium_withdrawal`,
  `first_premium_deemed_withdrawal`, `enforcement_fruitless`,
  `substitution_notice`, `substitution`, `two_notice_election`,
  `two_notice_termination`, `attachment`, `attachment_lifted`, and `release`.
  `dispatch/dispatcher.js` is the **only** code path allowed to touch the
  ledger, dispatching by `event_type` through one small handler map at the top
  of the file. Two types are unimplemented, and both have an entry that
  rejects them loudly (`notImplemented`): `release`, and `suspension`, which
  stays in the `event_type` enum only because Postgres cannot drop an enum value. A stray write to `policies` itself
  cannot cause a ledger action — only a `policy_events` row can.
- **A payout notification is not a `policy_events` row.** `payout_events`
  approvals queue into `payout_notifications` (migration 035), a table of its
  own, run with the same discipline: a status-transition trigger in the table
  and ownership by `SKIP LOCKED`. The outbox deliberately forbids retry,
  because a ledger action that already succeeded must never be attempted
  twice; an HTTPS notification is the opposite kind of work and has to be
  retried until it lands. The row is queued in the **same transaction** as the
  `payout_events` INSERT it belongs to, so a recorded payout and an owed
  notification commit together or not at all. It stores no payload, and
  `approved_at` mirrors the ledger's `PayoutApproved.approvedAt` rather than
  the SQL write time. The sender (`notifications/sender.js`, part of `npm
  start`) posts a signed thin envelope, loopback addresses only, with every
  other field behind an authenticated GET (the standing rule of
  2026-09-18); the only receivers so far are fake ones on
  this machine (`scripts/mock-insurer.mjs`, `scripts/verify-notification.mjs`).
- **One payout record, one contract, held together by a test.** Both GET
  endpoints return the same record, built by
  `notifications/payoutRecord.js` from an explicit whitelist; the webhook body
  is built the same way by `notifications/envelope.js`.
  `docs/api/notifications-v1.openapi.json` describes both, and
  `test/notificationsContract.test.mjs` fails if a builder's keys and the
  contract's differ, if a contract enum differs from the database's or
  `schema.sql`'s, or if any field is named like account data. The list cursor
  carries `created_at` as the microsecond text Postgres produced, never a JS
  `Date`: a `Date` holds milliseconds, so a cursor built from one lands before
  the row it names, and rows sharing that millisecond are repeated or skipped.
- **The outbox is a queue, never permission.** What actually authorizes a
  ledger change is the `insurer` Party's own signature on the create/exercise;
  the Daml signatory/controller check is the last line of defence and is not
  weakened anywhere just because the dispatcher already validated the row.
- **`expected_version` is checked at activation only.** A mismatch there
  fails the row with a conflict error for a human. An endorsement carries no
  version check: it is applied to the token as it stands when the dispatcher
  processes it, so one prepared before a payout landed is applied on top of
  that payout. The remaining limit stays consistent because `PolicyToken_Amend`
  moves it by the delta of a sum-insured change and never resets it.
- **Serialized per policy via a session-level Postgres advisory lock**
  (`pg_advisory_lock(hashtext(policy_no))`, held across the ledger call, not
  transaction-scoped — the work spans a slow network call). Different policies
  process independently.
- **A ledger action that succeeds while the SQL write-back fails ends the row
  in `failed`**, with the commandId and contractId in `error` — never `done`,
  never stuck in `processing`. It is not auto-retried, because retrying a
  successful exercise risks doing it twice; a human reconciles it. The
  `pending → processing → {done, failed}` transitions are enforced by a
  trigger in the table itself, not only by application code.
- **The process is designed to run under a supervisor, and ends itself on an
  uncaught exception.** `uncaughtException` is logged and the process exits
  non-zero, for the supervisor to restart; `unhandledRejection` is logged and
  the process carries on, with `/health` marked `degraded`
  (`unhandledRejections`, `lastUnhandledRejectionAt`) and still answering
  200. No supervisor configuration (pm2, nssm, systemd) is in this
  repository. An exit can leave the row the dispatcher was holding in
  `processing`, where nothing moves it on — whether its ledger call landed
  is unknown, so a human reconciles it, as above.
  `node scripts/findOutboxCommand.mjs` looks that row's command id up on the
  ledger and writes nothing.
  A `failed` row may have reached the ledger too: some handlers check the
  ledger's answer after the call returned and fail the row with a plain
  error, without the command id. Before queueing its work again, run
  `node scripts/findOutboxCommand.mjs <policy_events.id>`.
- **Two independent status axes.** `status` is the claim/term axis
  (`pending_mint`, `active`, `partially_paid`, `expired`, `cancelled`,
  `claimed_and_closed`, `manual_review`); `default_state` is the
  premium-default axis (`none`, `grace_period`, `terminated`,
  `first_premium_unpaid`, `withdrawn_for_first_premium`, `two_notice_elected`,
  `two_notice_terminated`). They were one field until a live run proved
  it broken: a payout during the grace period overwrote the single field and
  silently dropped the policy out of the default flow entirely. Never merge
  them into one derived label.
- **`policy_status_history` is the supersession chain.** With no contract keys
  on this network it is the only audit trail linking a re-minted token to its
  predecessor, and every row carries the `event_type` that caused it. Nothing
  is ever keyed on a `daml_contract_id` (plain `TEXT`, never a foreign key);
  `policy_id` is the stable identity throughout.
- **One Party per policyholder, not one per policy.** Allocated on that
  policyholder's first activation (with the row locked `FOR UPDATE`, so a
  concurrent double-activation cannot allocate twice) and reused thereafter.
  The party hint is an opaque id (`ph-<uuid>`), never a name or policy number
  — party ids are visible to every participant that observes the contract. It
  is a ledger identity the platform allocates and uses as an observer, holding
  no act-as right to it (only the insurer and its oracle operator get one), not a
  user-controlled wallet; avoid that word for it.
- **`oracleOperator` is a Party separate from `insurer` on `PolicyToken`.**
  Deliberately: it stops an insurer from triggering — and thereby effectively
  approving — its own payout. It must also be an **observer**, not merely a
  controller: a party that is neither signatory nor observer cannot fetch or
  exercise the contract at all, and divulgence does not rescue it.
- **`PolicyToken` does NOT use a Daml contract key**, though a stable
  `(insurer, policyId)` key would be convenient. Contract keys need Daml-LF
  2.3 / Protocol Version 35; this deployment is Canton 3.4.12 / PV34, which
  rejected an LF-2.3 DAR outright (`DAR_PARSE_ERROR`). `daml_policy_key` in
  SQL is therefore an off-chain correlation string, not a real Daml key.
- **The tiered payout matrix lives on-chain**, snapshotted at policy creation
  and at the renewal request and carried onto each `PolicyToken`, so a payout
  is auditable from the ledger alone. `payout_tiers` in SQL is the editable
  source; changing a tier only affects a policy created, or a renewal
  requested, afterward.
- **A reading that matches no tier pays nothing.** `sql/seed.sql` inserts only
  the two tiers the brief specified, leaving −4 °C..−2 °C undefined; a reading
  landing there fails closed until a row is added. That is intentional, rather
  than inventing an actuarial number.
- **Minting records that the contract exists, not that cover began.**
  m. 1421: the insurer's liability starts with payment of the first premium
  unless otherwise agreed. `coverageBeganAt` is the missing partner to
  `coverageValidThrough`; `None` means cover has not begun, and a trigger
  against such a policy is refused with its own reason. Cover begins at the
  insurer's *reported* payment instant, or on an agreed date recorded at
  creation — never inferred, and there is no configured period, only a
  direction: an agreed start may be earlier than payment, never later.
- **A late cover start does not move the term.** The policy simply has less
  cover than its term suggests, and the gap between `termStart` and
  `coverageBeganAt` is what makes that legible. The mirror of termination,
  where cover ends early with no extension to compensate.
- **A policy whose cover never began is surfaced, never swept.** Nothing in
  the statute ends a contract merely because cover has not started, so both
  dashboards flag it as inert rather than acting on it. Where the premium is
  reported due and unpaid, m. 1434(2) already provides the ending.
- **Backdating cover is lawful, and checked against the platform's own
  history.** m. 1458 permits it outright, then voids the contract where the
  riziko's occurrence was known at formation — and m. 1486(1) makes that
  sentence unagreeable-around. In a parametric product the danger is real
  rather than theoretical: losses are determined by oracle data, which is
  historical and queryable. So a backdated mint searches `oracle_readings`
  for a **tier-matching** reading between the cover start and contract
  formation — cross-policy, joined by **cell**, since a new policy has no
  readings of its own — and refuses if it finds one. **The check decides
  nothing about knowledge**: it reports what the platform's data shows, and
  the refusal says so in terms. The token carries only a timestamp; the
  window, the cells and the per-cell counts stay off-ledger.
- **A pass over an unobserved cell verified nothing, and must never read as
  if it had.** The platform's history is only as good as the cells it has
  been watching, so `RC_PassedNoDataForCells` is a distinct outcome from
  `RC_PassedWithData`, carries per-cell counts and a written caveat, and is
  indexed. Never collapse them into one "checked" flag. A backdated policy
  naming no cells at all is refused rather than passed vacuously.
- **Premium default is THREE mechanisms, not one.** m. 1434(3) governs
  subsequent premiums — ihtar, ten days (a **floor**), fesih. m. 1434(2)
  governs the first — no notice, three months from the reported due date (a
  **ceiling**, the inverse), and *cayma*. m. 1434(4) is the third: two ihtars
  in one insurance period give the insurer a **discretionary** right to
  terminate with a **deferred** effect, at the end of that period. It is
  reachable only where (3) did *not* fire — where payment arrived inside the
  ten days — so it is the chronically-late-payer provision, and the deferral
  is why: the premium for that period was paid, so ending the contract early
  would take back cover already bought. Three mechanisms, three vocabularies,
  three sweepers. The `ensure` clause (`not (isSome premiumDueDate && isSome
  noticeServiceDate)`) forbids only m. 1434(2) and m. 1434(3) from
  coexisting on one token; m. 1434(4) sits outside that constraint because
  it tracks its own state on `twoNoticeElectionAt` and `twoNoticeEffectiveAt`
  — fields the clause never touches — not on `premiumDueDate` or
  `noticeServiceDate`. Conflating any of the three is the specific failure
  the separation exists to prevent.
- **The insurance period is supplied, never derived.** m. 1411 ties it to how
  the premium is *calculated*, and this system holds no calculation basis —
  the contract term is a different thing that coincides only sometimes. So the
  insurer names it at election and the ledger checks that two recorded notice
  dates actually fall inside it. `noticeCount` counts per token, which equals
  per period only while a term does not exceed one insurance period.
- **Whether withdrawal is retroactive is deliberately not encoded.** The
  statute text does not say, so the token is re-minted into a withdrawn state
  rather than archived, recording the due date, the withdrawal date and which
  route ended it. Archiving would assert an answer.
- **Termination for non-payment is two phases, and the token outlives the
  contract.** TTK 6102 m. 1434(3) terminates the contract at the end of the
  notice period — a consequence, not a discretionary act — so the sweeper
  records it rather than deciding it, and the termination instant is derived
  from the externally supplied notice service date plus the policy's own grace
  period, never from a clock. Cover runs in full through the notice period, so
  a payout raised in that window is an obligation that survives the
  termination: the token is burned only once every payout on it has reached a
  terminal state. The interval between the two is a real, legible state.
- **Statutory periods are configuration, never literals** — but the ten-day
  notice period has a *floor*: a configured value below ten is refused at
  activation, because a shorter period is a variation to the detriment of the
  insured that m. 1452(3) does not permit. No monetary threshold, deadline, or
  conclusion about lateness is computed anywhere.
- **A named mortgagee observes the whole token**, including coverages its
  charge does not reach. That is what a Daml observer is — there is no
  per-field visibility, and a party absent from both signatories and observers
  cannot fetch the contract at all. Stated rather than worked around.
- **A payout is routed to the mortgagee from the coverage its charge sits
  on, and only up to its claim.** m. 1456(1) continues the sınırlı ayni hak
  over the *sigorta tazminatı*, so the bank's entitlement follows the
  indemnity from the encumbered thing — never from the policy as a whole. Each
  recipient gets its **own** `PayoutApproved`: m. 1427 runs maturity and
  default per claim, so paying the bank does not discharge what is owed to the
  insured, and one contract carrying both would lose that. The claim
  decrements only by what a trigger routes to the mortgagee, to zero and never
  back to null — "charged and exhausted" and "never charged" route
  differently. A settlement to the mortgagee reported on the review item a
  charged-and-attached coverage raises does not decrement it today.
- **An attached coverage pays the icra müdürlüğü, and a coverage that is
  both charged and attached pays nobody.** m. 1457 adds a fourth recipient
  that nobody designates — it arises from an attachment, years after the
  policy was written, which is why that role is exempt from the
  recipient-in-`payoutDestination` check. Where a mortgagee's charge and an
  attachment meet on one coverage the Code supplies **no priority rule** —
  they sit as `a)` and `b)` under one heading, two species of one genus — and
  the ranking question belongs to İcra ve İflas Kanunu, which is not here. So
  nothing routes, the claim is not decremented, and a human decides.
- **A payout approved before an attachment is refused, not redirected.** The
  officer's ihtar binds "diğer bir bildirime kadar" and the insurer is freed
  *only* by paying the enforcement office, so settling an earlier payout to
  its original recipient would not discharge. The system declines to record
  it rather than rewriting an obligation already approved.
- **The excess above the secured claim is recorded, not routed.** m. 1456(2)
  forbids paying the *sigortalı* without the real-right holder's izin and its
  only carve-out is repair against security, not a surplus; m. 1456(3) leaves
  an insurer that guesses wrong liable. So the remainder becomes a review item
  carrying the amount, the coverage and the reason, and a human decides.
  Routing it automatically would encode a legal reading the text does not
  settle. The same applies once the claim is exhausted — otherwise the *order*
  of losses would decide what the arithmetic was not allowed to.
- **The sigortalı can become the sigorta ettiren, and nothing else can move a
  party.** m. 1431(4): where insurance is for another's account and pursuit of
  the premium against the sigorta ettiren comes to nothing, the sigortalı —
  on being notified — may take over, and "sözleşme bu kişilerle devam eder".
  So `policyholder` becomes `insured`. Three externally reported facts in one
  order, none inferred from another, enforced by `ensure` clauses as well as
  by the choices. Endorsement is forbidden to touch `policyholder` and stays
  forbidden. The superseded party is recorded and **leaves the observer set**
  — it is no longer a party. It can never happen twice: one person then holds
  both roles, so the paragraph is spent.
- **A substituted policy cannot be terminated for the default that preceded
  it, and that is the only thing the freeze asserts.** m. 1431(4)'s "devam
  eder" cannot coexist with m. 1434(3)'s "feshedilmiş olur". No article says
  the clock stops, resets or runs on, so nothing claims any of those: the
  default state, the notice date and the notice count are all untouched, and
  the premium is as unpaid as it was — an undertaking is not a payment.
  Refused on the ledger and excluded from the sweeper, with the reasoning
  recorded at both sites.
- **The mortgagee could always read the figures; what m. 1456(6) needed was
  the act.** A named mortgagee observes the token, so "sigorta koruması ile
  sigorta bedelinin miktarı" is available to it continuously. But the duty is
  request → response, and standing access cannot evidence a response to a
  request nobody recorded — so the request and the answer are two dated facts,
  and a request stays outstanding until answered. What was disclosed is not
  recorded: the token already carries it, and a second copy could only drift.
- **m. 1456(7) needed nothing built, and that is a finding.** m. 1416 is an
  addressing rule — notices go to the last address *notified to the insurer* —
  which allocates risk to the person who moved without saying so. It requires
  nobody to hold an address, so the standing rule to hold none was never
  in tension with it, and `mortgagee_notified_at` already records the only
  thing a non-insurer can honestly record.
- **One party per person per insurer, across all three roles.** `mortgagee`
  and `beneficiary` resolve through the same registry as the policyholder, so
  a bank named on four hundred policies is one party reused, and a person
  holding two roles on one policy is one party. That reuse is what keeps role
  intake off the participant's 1000-rights ceiling; nothing revokes
  automatically.
- **A beneficiary is named, described, or absent — never two of those.** A
  descriptive designation ("my spouse at the time of loss") identifies no
  specific person, so no Party can exist for it; the token carries
  `beneficiaryDescriptorHash` instead, and only the hash is ever supplied.
  TTK 6102 m. 1494(2) attaches a consequence to naming *no* beneficiary, so
  the ledger has to tell that apart from a designation it cannot name.
- **PII stays off the ledger and out of the database.** `policyholders`
  carries only `external_ref` (the insurer's own customer id) and Canton
  identity — no name, no national id. A name once sat here, and a
  server-side SHA-256 of a raw `nationalId` once sat beside it, but neither
  did anything: party reuse has always run on `external_ref` alone, and a
  ~9x10^8-value keyspace makes an unsalted hash of a national id reversible
  in practice, not a real digest. Both columns were dropped (migration
  028); the API now rejects `fullName`/`nationalId` outright rather than
  silently discarding them. Neither the ledger nor the `PolicyToken`
  payload ever carried a name or a national id, and that was never in
  question — this only closes the gap on the database side.
- **`daml-tests/` is a separate package on purpose** (`multi-package.yaml`
  ties it to `./daml`): `daml-script` must never ship in the production DAR,
  and a test change must not bump the production package's hash.
- **A coverage is evaluated once per event window, never once per reading**
  (migration 030). One frost night of eight readings under the
  threshold used to pay eight times. The window's zone, start hour and
  aggregation (min, max, mean) are product configuration with no default,
  frozen onto the policy at activation and renewal; an unset window refuses the trigger,
  and a second trigger row for one (coverage, cell, window) cannot be created.
- **The provider's answer is the evidence, and its bytes are locked once
  attested** (migrations 031–033). The raw
  response is stored byte for byte with its SHA-256 and cannot be updated;
  `attestationRef` carries that hash, the provider's own update time and the
  request onto the ledger (for min and max; a mean carries one hash over its
  responses' hashes). A response whose hash reached the ledger cannot be
  deleted outside a database marked as a test database.
- **Every policy carries its document's hash** (migration 034). The
  insurer produces the policy document; the platform receives only its
  SHA-256 and holds no document. A policy without one is refused before any
  write and so is never minted; an endorsement's new hash reaches SQL as well
  as the token.
- **The webhook signing secret is derived, not stored, and the sender posts
  to loopback only.** Each insurer's secret is HMAC-SHA256 of its id and
  `webhook_secret_version` under one `WEBHOOK_SIGNING_MASTER_KEY`, so a
  database dump carries no signing secret and rotation is a version bump
  (`npm run set-webhook -- --rotate`); the CLI prints the secret once. The
  body is the thin envelope only. An address that is not loopback is marked
  failed without a request unless `WEBHOOK_ALLOW_NON_LOOPBACK=true`: that
  gate is the standing rule (2026-09-18: nothing to a real
  insurer address before the lawyer answers) made
  mechanical, not a network setting.

## Verification status

The pipeline is **verified end to end against a running Canton LocalNet**, not merely reviewed: `dpm build
--all` and `dpm test` (SDK 3.5.1, 154 Script tests, counted from its raw output on
2026-10-02) plus `npm test` (134 + 438 tests and the leak gate;
the 5 two-participant tests among the 438 skip themselves without
`TEST_DAML_JSON_API_URL_ORACLE`) and `npm run test:db` (161), counted on
2026-10-02, under the v22
package; `npm run
verify-all` (7/7) was run on 2026-09-23 (UTC), after the v21 → v22 switch
merged,
against a real Canton Builder Tool LocalNet — Canton 3.4.12, Protocol Version
34, via WSL2 + Docker Desktop — with real party allocation, real mints,
partial-payout re-mints, endorsement, renewal, settlement, both branches of
premium-default termination, mortgagee/beneficiary role intake, m. 1456 payout
routing with its unrouted remainder, m. 1431(4) policyholder substitution
including the observer set moving with the party, the m. 1456(6) information
request and response, m. 1434(4)'s elected termination landing at the period
end, all three m. 1457 attachment routing cases with a refused settlement, and
the
m. 1458 retroactive-cover check in all four of its outcomes — refused,
passed on data, passed vacuously, not run — driven through the actual HTTP
API with SQL persisted throughout. The runs are
recorded in the system walkthrough (not part of this copy).
Since 2026-09-18 `npm run verify-all` has run seven scripts, the
seventh being `scripts/verify-notification.mjs`: approval → signed webhook to a loopback
receiver → the record read with the insurer's API key → `/settle` → settled,
with no human input; the approval instant in SQL is the ledger's
`PayoutApproved.approvedAt` to the microsecond; the same envelope delivered
again is answered 200 with no second GET, `/settle` or `payout_events`
change; a broken signature is 401 with no action. Its run of 2026-09-23,
under v22, is recorded there too; each run rewrites
its own evidence file under `docs/`, which git does not track.

### PV34 quirks found only by running against a real participant

Fixed in code; worth knowing if you hit them on another network.

- `/v2/commands/submit-and-wait-for-transaction` requires an `eventFormat`
  nested *inside* `transactionFormat` alongside `transactionShape` — omitting
  it fails with `MISSING_FIELD: event_format`.
- `/v2/state/active-contracts` requires `activeAtOffset` (fetch it from
  `/v2/state/ledger-end` first). Omitting it doesn't error — it silently
  returns `[]`.
- The per-template `templateFilter` in that same call did not actually narrow
  results, so `queryActiveContracts` filters client-side on `templateId`.
- **Allocating a party does NOT grant the caller rights to `actAs` it.** Those
  are separate grants, and one is needed only for a party the platform acts
  or reads as: `allocateParty` calls `grantUserRights`
  (`POST /v2/users/{userId}/rights`, `CanActAs`) only when passed
  `grantActAs: true`, which the insurer and its oracle operator are. A
  policyholder that is only an observer needs none: the 2026-09-11 wire
  check minted, triggered and archived against an ungranted one, and only
  reading *as* it was refused, with a `403` ("A security-sensitive error has
  been received").
- **A user is capped at 1000 rights.** Only the insurer and its oracle
  operator are granted a standing one; nothing in the running system revokes
  it, and the read-as right `/debug/roles-data` takes is revoked within the
  request. Until a fix every
  activation granted one to each role party it allocated, which is how a
  development participant reached the cap. Since a later fix the test fixtures
  give back the rights they take, so what accumulates now is each onboarded
  insurer's pair and what a scale-measuring script kept outside this repository grants, which it does
  not give back. A grant past the cap
  fails with `TOO_MANY_USER_RIGHTS` -- onboarding an insurer or the dispatcher
  test's fixture, not a mint, which grants nothing. Revoke with
  `PATCH /v2/users/{userId}/rights`; there is no `/rights/delete`.
- Response event shapes are flat (`transaction.events[].CreatedEvent` /
  `.ExercisedEvent`, payload under singular `createArgument`), not nested
  under a `...TreeEvent.value` wrapper.
- **`show self` does not yield a contract id.** Canton redacts it to the
  literal string `<contract-id>`. Pass ids in as choice arguments instead —
  this cost a package rename to discover.
- `Int` crosses the JSON wire as a **number inbound and a string outbound**.
- **A `None` Optional inside a nested record comes back with the key absent
  entirely**, not as `null` — unlike a `None` at template level, which is
  present and null. Found by a wire check; `pg` coercing `undefined` to NULL
  was masking it.
- **A `None` Optional in an exercise RESULT is also absent, not null.** Same
  shape as the nested-record case and unlike template level. Found by the v17
  wire check, which asserted `=== null` on an empty `unroutedRemainder` and
  failed. Read these with `?? null`; never test for null.
- Template addressing needs the raw package-id hash (`<hash>:<Module>:<Entity>`),
  not `#package-name:...`, which is PV35-only.

### Running on Windows with a Turkish system locale

Two real gotchas, neither a bug in this codebase:

- PostgreSQL's Windows `initdb` rejects the auto-detected locale name
  (`Turkish_Türkiye.1254` contains a non-ASCII `ü`) — force `--locale C` at
  install time.
- The Daml Script Service hits the classic Turkish-İ bug: under a `tr`
  default locale the JVM uppercases `i` to `İ`, corrupting an internal Daml-LF
  name and breaking script-context creation. Set
  `$env:JAVA_TOOL_OPTIONS = "-Duser.language=en -Duser.country=US"` before
  `dpm build` / `dpm test`. It does not persist across terminal windows.

`dpm` also refuses to start when its working directory's path is very long
("Dizin adı geçersiz" / "The directory name is invalid"). To build an
isolated copy, put it under a short path such as `%TEMP%\insb`.

## Known limitations

These come from a code review of the payout event loop made on 2026-09-18, and
each was checked against the code again before it was written here.

- **The evidence shows that a record has not changed, not where it came from.**
  The oracle stores the bytes of the response it received and their SHA-256; the
  hash shows the stored record was not altered afterwards, not that the provider
  sent those bytes. The response is unsigned, and unless `DAML_JSON_API_URL_ORACLE`
  is set the oracle and insurer parties are hosted on the same participant. A
  signed source or a second, independent oracle would address this; neither
  exists.
- **The data source is a temporary forecast service, not an observation.**
  Temperature is the only metric that passes through the pipeline. Each coverage
  on the token names its metric, and the ledger refuses a trigger in another
  one; the oracle can supply only this one. The service is MET Norway's
  Locationforecast 2.0 (`api.met.no`). Data from MET Norway, licensed under the
  Norwegian Licence for Open Government Data (NLOD) 2.0 and Creative Commons 4.0
  BY International (CC BY 4.0): https://api.met.no/doc/License
- **The ledger checks the event time against the cover period, not the data
  behind it.** The trigger carries the event's time span, and the Daml choice
  refuses one that starts before cover began, ends after the contract's end
  (its expiry, or a recorded termination) or has not ended yet. That the span
  matches the readings is the oracle's word.
- **The ledger does not compute a notice deadline itself.** While a m. 1434(3)
  notice's deadline has passed and no termination is recorded yet, Node holds
  every window that ends after the deadline: the oracle does not queue it and
  the dispatcher does not send it, until the sweeper records the termination
  (the window is then clipped at the termination instant) or a payment is
  reported (the full window is sent). The token itself moves its cover end only
  when the termination is recorded, so a caller that bypasses Node could still
  have such a trigger accepted until then. Moving the deadline onto the ledger
  is left for v23.
- **What a tier percentage applies to is chosen per coverage, with no
  default.** Each coverage names the remaining limit or the sum insured; either
  way a payout never exceeds the remaining limit. Coverages that existed before
  this choice were given the remaining limit, which is what they had applied.
- **An endorsement applies from when it is processed.** A change to the terms
  takes no effective time of its own, so an event before it that is evaluated
  after it is judged on the new terms.
- **A payout cannot be reported as paid in parts.** A settlement reports the
  whole amount of a payout as paid; an advance or an instalment has no record
  of its own.
- **A distinct insured does not see its own payout, and no payout is routed to
  a beneficiary.** Besides the insurer and the oracle, the payout contract is
  visible to the policyholder and, on a mortgagee's leg, the mortgagee; an
  insured who is not the policyholder is not among them. No payout is ever
  routed to a beneficiary.
- **Gaps in the data are not repaired.** A missed hour is not backfilled, a window
  with no reading is not evaluated, and a window with a single reading is
  evaluated as a complete one: there is no "enough data" rule.
- **A coverage naming more than one cell is refused**, because what several cells
  mean together is not defined.
- **The insurer sets its own terms through the API:** `GET`/`PUT /api/v1/terms`
  for the periods and the event-window rule, and `GET`/`PUT`/`DELETE
  /api/v1/terms/payout-tiers/:productCode/:perilType` for a payout tier set.
  The mortgagee continuation days and the first-premium withdrawal days are
  frozen onto a policy at its activation, so a terms `PUT` of either affects
  later activations only.
- **The policyholder, the mortgagee, a distinct insured and a beneficiary
  have no node.** They are hosted on the platform's node and have no access
  of their own; `/debug/roles` reads on behalf of the policyholder and the
  mortgagee. The oracle operator is no longer in that list: set
  `DAML_JSON_API_URL_ORACLE` and its parties are allocated on, and submit
  from, a second participant, so the approval carries confirmation from two
  nodes. Measured against LocalNet's App User participant
  (a two-participant wire check kept outside this repository and
  `node/test/twoParticipants.test.mjs`); with the key unset everything is on
  one participant, as before.
- **Every observer sees every field of the token.** There is no field-level
  privacy between observers.
- **The `/debug` routes are off by default, unauthenticated and loopback-only.**
  They must not be turned on in any deployment.
- **LocalNet only, with synthetic insurers, policies and parties.** The API has
  no rate limiting, and API keys cannot be rotated.

## Legal

A reading of Law No. 5684 and TTK 6102 Book Six against the implemented
lifecycle was made during development; it is not part of this repository.
**It is a reading of statute texts, not a compliance opinion**, and it says so
throughout — it names conflicts and gaps rather than certifying anything.
Several findings are open. The statute texts are not part of this repository;
the official consolidated texts are at mevzuat.gov.tr. The reading also used
Law No. 5363 (TARSİM), the *bilgilendirme yönetmeliği*, the approved *genel
şartlar* published by TARSİM and SEDDK, the Türk Borçlar Kanunu (No. 6098),
the İcra ve İflas Kanunu (No. 2004) and Law No. 6698 (KVKK) with the
regulation on transfers abroad, among others; none of these texts is in this
repository. No KVKK regulation or communiqué on processors or sub-processors
was found.
