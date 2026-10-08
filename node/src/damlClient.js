import axios from 'axios';
import crypto from 'node:crypto';
import { config } from './config.js';

// Thin wrapper over Canton's JSON Ledger API (v2 shape: POST /v2/commands/...,
// POST /v2/state/active-contracts, POST /v2/parties). Endpoint paths and
// field casing can differ slightly by Canton/Daml SDK patch version -- the
// two reference sources given for this project (dev-hub.canton.foundation,
// github.com/canton-network-devs/Canton-Builder-Tool) confirm the LocalNet
// *ports* (App Provider :3975 / App User :2975) and the dpm-build-then-deploy
// flow, but the dev hub itself is a JS app that renders no static
// documentation content a fetch can read. Within the service (node/src) the
// REQUEST side of everything version-sensitive (endpoint paths, request
// bodies, auth) is isolated in this one file on purpose. Outside the service
// it is not: findOutboxCommand, uploadDar and several maintenance and
// wire-check scripts kept outside this repository call the JSON API with their own paths, bodies and
// tokens, doctor.mjs and runVerifications.mjs probe GET /v2/version, and
// dispatcher.test.mjs and oracleWindow.test.mjs POST /v2/updates themselves.
// The RESPONSE side is isolated only partly: createContract
// reads its contract id here, but queryActiveContracts and exerciseChoice
// hand back the participant's raw shapes
// (JsActiveContract, CreatedEvent, ExercisedEvent), and dispatcher.js,
// routes/debug.js, listeners/payoutListener.js, oracle/oracleBot.js and many
// scripts under scripts/ parse them themselves. Verify against your
// participant's own served OpenAPI spec (usually at `<jsonApiUrl>/docs`)
// before relying on it in production, and if it differs adjust it here, at
// those parsing sites and in those scripts and tests.

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Mints an "unsafe-jwt-hmac-256" token matching the Canton Builder Tool's
// LocalNet auth service -- HS256, secret "unsafe" by default, `sub` is
// treated as an admin-level ledger-api-user: it can allocate any party, but
// may actAs only a party it holds a CanActAs right for (grantUserRights
// below; allocateParty grants one only when asked with grantActAs: true).
// Never use this scheme against a real network.
function generateUnsafeJwt(secret, sub) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub,
      aud: 'https://canton.network.global',
      exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

function authToken() {
  if (config.daml.ledgerToken) return config.daml.ledgerToken;
  if (config.daml.unsafeJwtSecret) {
    return generateUnsafeJwt(config.daml.unsafeJwtSecret, config.daml.unsafeJwtSub);
  }
  throw new Error('No Daml auth configured: set DAML_LEDGER_TOKEN or DAML_UNSAFE_JWT_SECRET');
}

// ONE AXIOS INSTANCE PER PARTICIPANT, not one per process. This used to be a
// single module-scope instance bound to config.daml.jsonApiUrl, and that was
// correct while every party lived on one participant. It no longer is: the
// oracle operator can be hosted on a participant of its own
// (DAML_JSON_API_URL_ORACLE), and which participant a call goes to must never
// be implicit -- a submission whose actAs party the receiving participant does
// not host is refused 403, measured in
// a two-participant check kept outside this repository.
//
// Every exported function below takes an optional `endpoint`. With none it
// goes to the INSURER's participant, which is what every caller written before
// this meant and still means. Auth is unchanged and shared: the same token,
// from the same DAML_LEDGER_TOKEN or the same DAML_UNSAFE_JWT_SECRET, for
// both endpoints -- no second secret and no second user exists.
const clientsByEndpoint = new Map();

function clientFor(baseURL) {
  const existing = clientsByEndpoint.get(baseURL);
  if (existing) return existing;
  const http = axios.create({
    baseURL,
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  http.interceptors.request.use((requestConfig) => {
    requestConfig.headers.Authorization = `Bearer ${authToken()}`;
    return requestConfig;
  });

  // Canton returns a structured error body ({ code, cause, correlationId, ... })
  // that axios's own message throws away, leaving only "Request failed with
  // status code 400" -- useless in a failed outbox row, where the whole point
  // is that a human can later read WHY a ledger action was refused. The
  // premium-default flow depends on this directly: a trigger against a terminated policy is
  // required to leave a failed row stating the reason, and the reason lives
  // in `cause`. Enrich the message in place and leave err.response intact for
  // anything that wants the raw body.
  http.interceptors.response.use(undefined, (err) => {
    const body = err.response?.data;
    if (body?.code || body?.cause) {
      const parts = [body.code, body.cause].filter(Boolean).join(': ');
      err.message = `${err.message} -- ${parts}`;
      if (body.correlationId) {
        err.message += ` (correlationId=${body.correlationId})`;
      }
    }
    return Promise.reject(err);
  });

  clientsByEndpoint.set(baseURL, http);
  return http;
}

// The insurer's participant: every party but the oracle operator, and the
// default for every call that names no endpoint.
export function insurerEndpoint() {
  return config.daml.jsonApiUrl;
}

// The participant that hosts the oracle operator parties. Equal to
// insurerEndpoint() when DAML_JSON_API_URL_ORACLE is unset or empty -- that is
// the single-participant configuration, not a fallback. When the key IS set
// this returns it unconditionally, reachable or not: a caller that cannot
// reach it fails loudly rather than sending an oracle command to the
// insurer's participant, which would be exactly the boundary this exists to
// keep.
export function oracleEndpoint() {
  return config.daml.jsonApiUrlOracle ?? config.daml.jsonApiUrl;
}

// Whether the oracle really is somewhere else. The one place that question is
// answered, because several callers ask it and they must all get the same
// answer.
export function oracleIsOnItsOwnParticipant() {
  return oracleEndpoint() !== insurerEndpoint();
}

function resolveEndpoint(endpoint) {
  return endpoint ?? config.daml.jsonApiUrl;
}

function templateId(moduleName, entityName) {
  return `${config.daml.packageId}:${moduleName}:${entityName}`;
}

// The command id is the ledger's own identity for a submission, and it has
// to be unique across every process that submits. It used to be
// `${prefix}-${Date.now()}-${counter}` with the counter a module-level
// variable starting at 0 in each process: two dispatchers advancing in
// lockstep produced identical ids whenever they submitted in the same
// millisecond, and the participant rejected the second with 409
// SUBMISSION_ALREADY_IN_FLIGHT. Measured, not supposed -- every parallel run
// in the project's own scale measurements lost events that way and no single-worker run did.
//
// Seeded with the outbox row id, the id becomes unique across processes AND
// stable for a given event, so the ledger sees two submissions for the same
// row as ONE command rather than two. One submission is retried today: the
// trigger, which dispatcher.js re-sends under this same id on the two
// schedules in config.js's oracleTrigger (a token not yet visible on the
// oracle's participant, and an event the ledger says has not ended yet). How
// long the participant will still recognise the id is its own deduplication
// setting, which is not measured here. Callers with no outbox row behind
// them -- scripts, wire checks, the measurement harness -- pass no seed and
// get a random UUID.
export function commandIdFor(prefix, seed) {
  return `${prefix}-${seed ?? crypto.randomUUID()}`;
}

// Grants the given Ledger API user CanActAs rights for a party. Allocating
// a party and being authorized to actAs it are SEPARATE grants -- a
// ParticipantAdmin user (like LocalNet's "unsafe" ledger-api-user) can
// allocate any party but cannot submit commands as it until this is called.
export async function grantUserRights(userId, party, { endpoint } = {}) {
  await clientFor(resolveEndpoint(endpoint)).post(`/v2/users/${userId}/rights`, {
    userId,
    rights: [{ kind: { CanActAs: { value: { party } } } }],
  });
}

// The read side of grantUserRights: every right the user holds, CanActAs
// and otherwise.
export async function listUserRights(userId, { endpoint } = {}) {
  const { data } = await clientFor(resolveEndpoint(endpoint)).get(`/v2/users/${userId}/rights`);
  return data.rights;
}

// A CanReadAs for one party: the user may read as it and submit nothing. The
// participant answers with what it newly granted -- empty when the user
// already held that right -- so a caller that revokes afterwards revokes only
// what this call added, never a right that was there before it. Used by
// /debug/roles-data, which reads a role party's view and takes the right back
// within the same request.
export async function grantReadAs(userId, party, { endpoint } = {}) {
  const { data } = await clientFor(resolveEndpoint(endpoint)).post(`/v2/users/${userId}/rights`, {
    userId,
    rights: [{ kind: { CanReadAs: { value: { party } } } }],
  });
  return data.newlyGrantedRights ?? [];
}

// Takes back the given rights, in the shape listUserRights returns them. PATCH,
// the same call a maintenance script kept outside this repository makes: /rights/delete 404s. The
// participant answers with what it actually revoked, which the caller compares
// against what it asked for.
export async function revokeUserRights(userId, rights, { endpoint } = {}) {
  const { data } = await clientFor(resolveEndpoint(endpoint)).patch(`/v2/users/${userId}/rights`, { userId, rights });
  return data.newlyRevokedRights ?? [];
}

// Allocates a fresh Canton Party (used for both insurers and
// policyholders -- the caller decides the display name / hint).
export async function allocateParty(displayName, partyIdHint, { grantActAs, endpoint } = {}) {
  const { data } = await clientFor(resolveEndpoint(endpoint)).post('/v2/parties', {
    partyIdHint,
    displayName,
  });
  // Adjust this destructure if your participant's allocate-party response
  // nests the party id differently.
  const party = data.partyDetails?.party ?? data.party;

  // LocalNet's unsafe-JWT scheme routes every command through one fixed
  // admin user (config.daml.unsafeJwtSub) that does not automatically gain
  // actAs rights for parties it allocates. Grant one ONLY when the caller
  // asks with grantActAs: true -- for a party the platform submits commands
  // as, which is an insurer and its oracle operator. A role party
  // (policyholder, insured, mortgagee, beneficiary) is only ever an observer
  // and needs none: the 2026-09-11 wire check minted, triggered and archived
  // against an ungranted policyholder, and only READING as that party was
  // refused (403). No grant is the default so a caller that forgets is
  // refused on its first command, instead of silently spending one of the
  // user's 1000 rights. Real OIDC deployments manage per-party rights
  // through their own identity provider instead, so skip this there.
  if (grantActAs === true && config.daml.unsafeJwtSecret) {
    await grantUserRights(config.daml.unsafeJwtSub, party, { endpoint });
  }

  return party;
}

// Returns { contractId, commandId } -- callers that write the result back
// to an outbox table for reconciliation purposes need the commandId too,
// not just the contractId (see dispatcher.js's write-back-failure handling).
export async function createContract({ moduleName, entityName, payload, actAs, readAs = [], commandSeed, endpoint }) {
  const commandId = commandIdFor('create', commandSeed);
  const { data } = await clientFor(resolveEndpoint(endpoint)).post('/v2/commands/submit-and-wait-for-transaction', {
    commands: {
      commandId,
      actAs,
      readAs,
      commands: [
        {
          CreateCommand: {
            templateId: templateId(moduleName, entityName),
            createArguments: payload,
          },
        },
      ],
    },
    transactionFormat: {
      eventFormat: { filtersByParty: { [actAs[0]]: { cumulative: [] } }, verbose: true },
      transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
    },
  });
  return { contractId: extractCreatedContractId(data, entityName), commandId };
}

export async function exerciseChoice({
  moduleName,
  entityName,
  contractId,
  choice,
  argument,
  actAs,
  readAs = [],
  commandSeed,
  commandId = commandIdFor('exercise', commandSeed),
  endpoint,
}) {
  const { data } = await clientFor(resolveEndpoint(endpoint)).post('/v2/commands/submit-and-wait-for-transaction', {
    commands: {
      commandId,
      actAs,
      readAs,
      commands: [
        {
          ExerciseCommand: {
            templateId: templateId(moduleName, entityName),
            contractId,
            choice,
            choiceArgument: argument,
          },
        },
      ],
    },
    transactionFormat: {
      eventFormat: { filtersByParty: { [actAs[0]]: { cumulative: [] } }, verbose: true },
      transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
    },
  });
  // Caller pulls out the choice's return value (dispatcher.js reads it as
  // ExercisedEvent.exerciseResult, e.g. in readReMintResult) and/or any
  // created-contract ids from the raw response.
  return data;
}

// The package ids this participant has vetted. Confirmed against this PV34
// participant: the body is `{ packageIds: [<64-hex hash>, ...] }`, and each
// participant answers for itself -- LocalNet's app provider and app user are
// two participants, and a DAR uploaded to one is not on the other.
export async function listPackageIds({ endpoint } = {}) {
  const { data } = await clientFor(resolveEndpoint(endpoint)).get('/v2/packages');
  return data.packageIds;
}

// `activeAtOffset` is mandatory: omitting it doesn't error, it silently
// returns []. Confirmed live -- fetch the current ledger end first.
export async function getLedgerEnd({ endpoint } = {}) {
  const { data } = await clientFor(resolveEndpoint(endpoint)).get('/v2/state/ledger-end');
  return data.offset;
}

// The server's per-template `templateFilter` didn't actually narrow results
// in testing (all of a party's active contracts came back regardless) --
// filter client-side on templateId as a defensive belt-and-suspenders,
// rather than trusting the server-side filter alone.
export async function queryActiveContracts({ moduleName, entityName, parties, endpoint }) {
  // The offset has to come from the SAME participant the read is made
  // against: two participants are at two different ledger ends.
  const activeAtOffset = await getLedgerEnd({ endpoint });
  const wantedTemplateId = templateId(moduleName, entityName);
  const { data } = await clientFor(resolveEndpoint(endpoint)).post('/v2/state/active-contracts', {
    filter: {
      filtersByParty: Object.fromEntries(
        parties.map((p) => [
          p,
          { cumulative: [{ templateFilter: { templateId: wantedTemplateId } }] },
        ])
      ),
    },
    verbose: true,
    activeAtOffset,
  });
  const entries = Array.isArray(data) ? data : [];
  return entries.filter(
    (e) => e.contractEntry?.JsActiveContract?.createdEvent?.templateId === wantedTemplateId
  );
}

// Confirmed against a live Canton 3.4.12 / JSON API v2 response (LocalNet,
// TRANSACTION_SHAPE_LEDGER_EFFECTS): `transaction.events[].CreatedEvent`,
// with the create payload under `createArgument` (singular).
function extractCreatedContractId(responseData, entityName) {
  const events = responseData?.transaction?.events ?? [];
  for (const event of events) {
    const created = event.CreatedEvent;
    if (created && created.templateId?.endsWith(`:${entityName}`)) {
      return created.contractId;
    }
  }
  throw new Error(`No CreatedEvent for ${entityName} found in submit response`);
}
