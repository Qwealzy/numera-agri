# Parametric Insurance Tokenization & Automation Infrastructure

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
| `daml/daml/Insurance/PayoutBridge.daml` | Daml | `PayoutApproved` (the payout obligation) + `ManualReviewRequired` |
| `daml-tests/daml/InsuranceTests.daml` | Daml | 106 Script tests: the full lifecycle, every `ensure` clause, and every authorization boundary as a `submitMustFail` with a matching control assertion |
| `node/src/routes/policies.js` | Node.js | The whole HTTP API (see below) |
| `node/src/dispatch/dispatcher.js` | Node.js | Sole reader of `policy_events` and the **only** code path that touches the ledger. One handler per `event_type` |
| `node/src/oracle/oracleBot.js` | Node.js | Scheduled oracle bot: reads external data, writes a `trigger` outbox row |
| `node/src/listeners/payoutListener.js` | Node.js | Polls the ledger for `PayoutApproved` and writes a settlement-tracking row. **Instructs no payment** |
| `node/src/sweepers/expirySweeper.js` | Node.js | Finds policies past their term end, queues `expiry` |
| `node/src/sweepers/graceSweeper.js` | Node.js | Two phases: notice period elapsed → `termination`; terminated with all payouts closed → `termination_archive` |
| `node/src/sweepers/firstPremiumSweeper.js` | Node.js | m. 1434(2)'s deemed withdrawal — window elapsed with no suit or enforcement reported. A separate mechanism from the above, not a phase of it |
| `node/src/sweepers/twoNoticeSweeper.js` | Node.js | m. 1434(4)'s deferred effect — an elected termination reaching the end of its insurance period. The third premium-default mechanism, and the third separate file |
| `node/src/routes/debug.js`, `node/public/` | Node.js | Read-only reconciliation dashboards (SQL mirror vs. the live ledger) |
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
POST /api/v1/policies/:id/activate                 queue the mint
POST /api/v1/policies/:id/endorse                  amend an in-force policy
POST /api/v1/policies/:id/renew                    open a new period (new policy, linked back)
     body requires the new period's own documentHash, in the same form
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
GET  /debug/contracts, /debug/dashboard            read-only reconciliation
```

Every one of these writes a `policy_events` row and returns. None of them
calls Canton.

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
psql insurance -f sql/schema.sql
psql insurance -f sql/seed.sql   # optional demo insurer + tiers. Do NOT run this
                                 # against anything real: it seeds a known API key.
# An EXISTING database from an earlier revision is brought forward by running
# the migrations it has not had yet, in order -- never by re-applying
# schema.sql over it:
for f in sql/migrations/*.sql; do psql insurance -f "$f"; done
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
canton builder deploy daml/.daml/dist/insurance-tokenization-v21-1.0.0.dar
# canton builder deploy's own JWT helper has a bug (base64 without -w 0
# corrupts the token on longer payloads) that broke this for us -- if the
# deploy 400s, POST the DAR to :3975/v2/packages and :2975/v2/packages
# yourself with a correctly-generated HS256 token instead.

# 4. Node.js
cd node
cp .env.example .env         # fill in DATABASE_URL, DAML_PACKAGE_ID, etc.
npm install
npm run onboard-insurer "Acme Insurance A.S." 1000   # allocates real Canton parties
npm start                    # the API and seven background loops: dispatcher, oracle bot, payout listener,
                             # and the expiry, grace, first-premium and two-notice sweepers
# or as separate processes:
npm run dispatch / oracle / listener / expiry-sweeper / grace-sweeper / first-premium-sweeper / two-notice-sweeper
node ../scripts/setupTestDb.mjs   # once: builds and marks the TEST_DATABASE_URL database
npm test                     # the files it runs are in package.json scripts; here only
                             # what needs LocalNet or DATABASE_MAINT_URL.
                             # half 1: read-only against DATABASE_URL; needs DATABASE_MAINT_URL for
                             # the drift test's throwaway.
                             # half 2: the tests that write, against TEST_DATABASE_URL.
                             # It must be marked, DATABASE_URL must be reachable for the
                             # guard's check, and the dispatcher and oracle-window tests
                             # need LocalNet -- then the leak gate, in a process of its own
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
| `npm run test:db` | enumOrdering and eventHandlers read; the guard's identity check; the guard cases connect as this role | — | CREATE/DROP DATABASE, the marker; evidenceLock's `schema.sql`, `roles.sql` and CREATE ROLE |
| `npm test` half 1 | enumOrdering, eventHandlers; drift as above | — | drift as above |
| `npm test` half 2 | the guard's identity check, then replaced by TEST_DATABASE_URL | every write and teardown DELETE, as `insurance_app` | — |
| `psql ... -f sql/roles.sql` | — | — | the maintenance user |

`DAML_PACKAGE_ID` must match the deployed DAR. Read it from that DAR's
`META-INF/MANIFEST.MF` `Main-Dalf` filename — **it changes on every
rebuild**, and a stale value produces contracts nothing can read.

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
  `endorsement`, `renewal`, the two mortgagee events, and `release`.
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
  the SQL write time. Nothing sends anything yet: the webhook will carry a
  thin envelope only, with every other field behind an authenticated GET
  (the standing rule of 2026-09-18).
- **The outbox is a queue, never permission.** What actually authorizes a
  ledger change is the `insurer` Party's own signature on the create/exercise;
  the Daml signatory/controller check is the last line of defence and is not
  weakened anywhere just because the dispatcher already validated the row.
- **Optimistic concurrency via `expected_version`, enforced by refusing,
  never by rebasing.** A mismatch fails the row with a conflict error for a
  human. It is never auto-rebased — an endorsement prepared before a payout
  landed, applied blindly afterward, would silently corrupt the remaining
  limit.
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
- **Two independent status axes.** `status` is the claim/term axis
  (`active`, `partially_paid`, `expired`, `cancelled`, `claimed_and_closed`,
  `manual_review`); `default_state` is the premium-default axis (`none`,
  `grace_period`, `terminated`). They were one field until a live run proved
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
- **The tiered payout matrix lives on-chain**, snapshotted onto each
  `PolicyToken` at mint time, so a payout is auditable from the ledger alone.
  `payout_tiers` in SQL is the editable source; changing a tier only affects
  policies minted afterward.
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
  decrements as it is paid down, to zero and never back to null — "charged and
  exhausted" and "never charged" route differently.
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

## Verification status

The pipeline is **live-verified end to end**, not merely reviewed: `dpm build
--all` and `dpm test` (SDK 3.5.1, 106 Script tests) plus `npm test` (39 +
194 tests and the leak gate), counted on 2026-09-17; `npm run
test:db` (63) and `npm run verify-all` (6/6) were run on 2026-09-17 in this
commit's working tree, the Daml side not re-run because it did not change,
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
  operator are granted one, and nothing revokes them. Until a fix every
  activation granted one to each role party it allocated, which is how a
  development participant reached the cap; now what accumulates is the test
  insurer/oracle pair each `npm test` run allocates. A grant past the cap
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

## Legal

A reading of Law No. 5684 and TTK 6102 Book Six against the implemented
lifecycle was made during development; it is not part of this repository.
**It is a reading of statute texts, not a compliance opinion**, and it says so
throughout — it names conflicts and gaps rather than certifying anything.
Several findings are open. The official consolidated texts of the statutes are
at mevzuat.gov.tr; they are not part of this repository. The approved *genel
şartlar*, the *bilgilendirme yönetmeliği*, Law No. 5363 (TARSİM) and the Türk
Borçlar Kanunu are not in this repository either, and several questions cannot
be closed without them.
