// Looks a policy_events row's ledger command id up on the ledger, for a human
// deciding what to do with a row left in `processing`. The dispatcher never
// takes such a row back and the table's trigger lets it move only to done or
// failed, so whether its ledger call landed is the question to answer first.
//
// IT WRITES NOTHING. The SQL session is opened read-only
// (default_transaction_read_only), and the ledger is only read: its end
// offset, then /v2/updates. Marking a row failed, and whether anything is
// submitted again, stay with the human.
//
//   node scripts/findOutboxCommand.mjs <policy_events.id>   that row, whatever its status
//   node scripts/findOutboxCommand.mjs                      every `processing` row
//     --from-offset N   start the window after offset N (exclusive)
//     --max-offsets N   the window's size; default 100000
//
// Each row ends in exactly one of three results, never merged:
//   FOUND          a transaction in the scanned range carries the command id
//   NOT FOUND      none in the scanned range does -- which says nothing about
//                  offsets outside it
//   CANNOT SEARCH  the search did not run: the event type submits no command,
//                  the insurer has no party to read as, or the ledger did not
//                  answer
// Exit 0 when every row was searched, 1 when any row could not be, 2 when the
// arguments or the database stopped the run before any row.
//
// The command id comes from scripts/outboxCommandId.mjs, the mapping doctor
// prints from. The method is POST /v2/updates, TRANSACTION_SHAPE_LEDGER_EFFECTS,
// filtered by the row's insurer and oracle operator parties together: a
// transaction's commandId is present only in a view that includes a party
// that submitted it (measured 2026-09-13: two oracle operator parties saw 504
// transactions and 84 carried a commandId), and every handler submits as one
// of those two. Paged with ?limit, since the JSON API refuses a list longer
// than its element limit, and a window counts as read only once a page comes
// back empty or reaches the window's end -- never because a page was short.
// A 1 ms stream_idle_timeout_ms did not cut a bounded window short either: the
// first element still came back after 199,000 offsets the party could not see.
//
// Cost follows the transactions the parties can see, not the window's size.
// Measured on LocalNet on 2026-09-13, over the whole ledger (216,023 offsets):
// 3.2 s in 26 pages as demo-insurer-1 (2,516 visible transactions), 0.6 s as
// two oracle operators (504).
//
// The window ends at the ledger end read at the start of the run, unless
// --from-offset anchors its start. 100,000 is the default because the command
// cannot be on the ledger before its row existed -- the id is the row's own
// id -- and a row doctor warns about is minutes to days old: on this
// participant 100,000 offsets were about three days of that week's traffic
// (offset 123,062 at 2026-09-11T00:28Z, 216,038 at 2026-09-13T18:34Z). That
// rate is this participant's, so a NOT FOUND prints the row's created_at next
// to the earliest transaction the window showed, to say whether it reached
// back that far.
//
// node/.env is read here, with the process environment winning where it
// defines a key -- the precedence config.js gets from dotenv -- so a test can
// point DATABASE_URL at the test database.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ledgerCommandId } from './outboxCommandId.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_MAX_OFFSETS = 100000;
const PAGE = 100;
const REQUEST_TIMEOUT_MS = 30000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'usage: node scripts/findOutboxCommand.mjs [policy_events.id] [--from-offset N] [--max-offsets N]';

for (const line of fs.readFileSync(path.join(ROOT, 'node', '.env'), 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
}

// Why a search did not run. Anything else thrown is a bug in this script and
// stops it.
class CannotSearch extends Error {}

function parseArgs(argv) {
  const out = { id: null, fromOffset: null, maxOffsets: DEFAULT_MAX_OFFSETS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-offset' || a === '--max-offsets') {
      const v = argv[++i];
      if (!/^\d+$/.test(v ?? '')) throw new Error(`${a} needs a non-negative integer, got ${JSON.stringify(v)}`);
      if (a === '--from-offset') out.fromOffset = Number(v);
      else out.maxOffsets = Number(v);
    } else if (!a.startsWith('--') && out.id === null) {
      if (!UUID.test(a)) throw new Error(`not a policy_events id: ${JSON.stringify(a)}`);
      out.id = a;
    } else {
      throw new Error(`unexpected argument ${JSON.stringify(a)}`);
    }
  }
  if (out.maxOffsets < 1) throw new Error('--max-offsets must be at least 1');
  return out;
}

function ledgerToken() {
  if (process.env.DAML_LEDGER_TOKEN) return process.env.DAML_LEDGER_TOKEN;
  if (!process.env.DAML_UNSAFE_JWT_SECRET) {
    throw new CannotSearch('neither DAML_LEDGER_TOKEN nor DAML_UNSAFE_JWT_SECRET is set, so no ledger read can be authorised');
  }
  const b64u = (s) => Buffer.from(s).toString('base64url');
  const unsigned = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({
    sub: process.env.DAML_UNSAFE_JWT_SUB,
    aud: 'https://canton.network.global',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }))}`;
  return `${unsigned}.${crypto.createHmac('sha256', process.env.DAML_UNSAFE_JWT_SECRET).update(unsigned).digest('base64url')}`;
}

async function ledger(method, apiPath, body) {
  if (!process.env.DAML_JSON_API_URL) throw new CannotSearch('DAML_JSON_API_URL is not set');
  let res;
  try {
    res = await fetch(`${process.env.DAML_JSON_API_URL}${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${ledgerToken()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof CannotSearch) throw err;
    throw new CannotSearch(`the ledger did not answer ${method} ${apiPath} (${err.cause?.code ?? err.name})`);
  }
  const text = await res.text();
  if (!res.ok) throw new CannotSearch(`the ledger refused ${method} ${apiPath}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Every transaction in the window visible to `parties`, page by page, keeping
// those whose commandId is the one looked for.
async function scan(window, parties, commandId) {
  const filtersByParty = Object.fromEntries(parties.map((p) => [p, { cumulative: [] }]));
  const matches = [];
  let visible = 0;
  let earliest = null;
  let from = window.begin;
  for (;;) {
    const page = await ledger('POST', `/v2/updates?limit=${PAGE}`, {
      beginExclusive: from,
      endInclusive: window.endInclusive,
      updateFormat: {
        includeTransactions: {
          eventFormat: { filtersByParty, verbose: false },
          transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
        },
      },
    });
    if (!page.length) break;
    let last = from;
    for (const element of page) {
      const [kind, wrapped] = Object.entries(element.update ?? {})[0] ?? [];
      const value = wrapped?.value;
      if (typeof value?.offset !== 'number') {
        throw new CannotSearch(`an update came back without an offset, so how far the window was read is unknown: ${JSON.stringify(element).slice(0, 200)}`);
      }
      last = Math.max(last, value.offset);
      if (kind !== 'Transaction') continue;
      visible++;
      earliest ??= value;
      if (value.commandId === commandId) matches.push(value);
    }
    if (last >= window.endInclusive) break;
    if (last <= from) throw new CannotSearch(`a page did not move past offset ${from}, so the window cannot be read to its end`);
    from = last;
  }
  return { matches, visible, earliest };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }

  const { Client } = createRequire(path.join(ROOT, 'node', 'package.json'))('pg');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: 5000,
  });
  let database;
  let rows;
  try {
    await client.connect();
    database = (await client.query('SELECT current_database() AS d')).rows[0].d;
    ({ rows } = await client.query(
      `SELECT e.id, e.event_type::text AS event_type, e.status::text AS status, e.created_at, e.policy_no,
              i.canton_party_id AS insurer_party, i.oracle_operator_party
       FROM policy_events e JOIN policies p ON p.id = e.policy_no JOIN insurers i ON i.id = p.insurer_id
       WHERE ${args.id ? 'e.id = $1' : "e.status = 'processing'"}
       ORDER BY e.created_at`,
      args.id ? [args.id] : []
    ));
  } catch (err) {
    console.error(`the database could not be read, so no row was looked up: ${err.message}`);
    return 2;
  } finally {
    await client.end().catch(() => {});
  }

  let window = null;
  let windowProblem = null;
  try {
    const { offset: end } = await ledger('GET', '/v2/state/ledger-end');
    const begin = args.fromOffset ?? Math.max(0, end - args.maxOffsets);
    const endInclusive = Math.min(end, begin + args.maxOffsets);
    if (begin >= endInclusive) windowProblem = `the window (${begin}, ${endInclusive}] is empty: --from-offset is not below the ledger end ${end}`;
    else window = { begin, endInclusive, ledgerEnd: end };
  } catch (err) {
    if (!(err instanceof CannotSearch)) throw err;
    windowProblem = err.message;
  }

  console.log('findOutboxCommand: looks policy_events rows\' command ids up on the ledger. It writes nothing, to SQL or to the ledger.');
  console.log('  FOUND          a transaction in the scanned range carries the command id: that submission is on the ledger');
  console.log('  NOT FOUND      no transaction in the scanned range carries it. That is not "it never reached the ledger": offsets outside the range were not read');
  console.log('  CANNOT SEARCH  the search did not run, so nothing is known about the submission');
  console.log(`database ${database}; ` + (window
    ? `ledger end ${window.ledgerEnd}; scanned range (${window.begin}, ${window.endInclusive}], --max-offsets ${args.maxOffsets}; ` +
      `POST /v2/updates, TRANSACTION_SHAPE_LEDGER_EFFECTS, as each row's insurer and oracle operator, ${PAGE} per page`
    : `no range: ${windowProblem}`));

  if (!rows.length) {
    console.log(args.id ? `no policy_events row ${args.id} in ${database}` : `no processing rows in ${database}`);
    return args.id ? 2 : 0;
  }

  const counts = { found: 0, notFound: 0, cannot: 0 };
  for (const row of rows) {
    console.log('');
    console.log(`row ${row.id}`);
    console.log(`  ${row.event_type}, status ${row.status}, created_at ${row.created_at.toISOString()}, policy ${row.policy_no}`);
    const next = (text) =>
      console.log(row.status === 'processing' ? `  next: ${text}` : `  next: none given -- the row is ${row.status}, not processing`);
    const cannot = (why) => {
      counts.cannot++;
      console.log(`  CANNOT SEARCH: ${why}`);
    };

    const commandId = ledgerCommandId(row);
    if (!commandId) {
      cannot(`event type ${row.event_type} submits no ledger command, so there is no command id to look for`);
      continue;
    }
    console.log(`  command id ${commandId}`);
    const parties = [...new Set([row.insurer_party, row.oracle_operator_party].filter(Boolean))];
    if (!parties.length) {
      cannot('its insurer has no Canton party to read the ledger as');
      continue;
    }
    if (!window) {
      cannot(windowProblem);
      continue;
    }
    console.log(`  read as ${parties.join(', ')}`);

    let result;
    try {
      result = await scan(window, parties, commandId);
    } catch (err) {
      if (!(err instanceof CannotSearch)) throw err;
      cannot(err.message);
      continue;
    }
    if (result.matches.length) {
      counts.found++;
      for (const tx of result.matches) {
        console.log(`  FOUND at offset ${tx.offset}, updateId ${tx.updateId}, recordTime ${tx.recordTime}`);
        const created = tx.events.map((e) => e.CreatedEvent).filter(Boolean);
        for (const c of created) console.log(`    created ${c.contractId} ${c.templateId}`);
        if (!created.length) console.log('    created no contract');
      }
      next('the contract is on the ledger. Mark the row failed and write the commandId and the contractId into error; do not mark it done');
    } else {
      counts.notFound++;
      console.log(`  NOT FOUND in scanned range (${window.begin}, ${window.endInclusive}]: ${result.visible} transaction(s) in it visible to these parties, none with this command id`);
      console.log(`    earliest of them: ${result.earliest ? `offset ${result.earliest.offset}, recordTime ${result.earliest.recordTime}` : 'none'}; ` +
        `the row was created at ${row.created_at.toISOString()} (the database's clock, not the ledger's)`);
      next('widen the range (--from-offset, --max-offsets) or mark the row failed; whether to submit it again is your decision');
    }
  }

  console.log('');
  console.log(`${rows.length} row(s): ${counts.found} FOUND, ${counts.notFound} NOT FOUND, ${counts.cannot} CANNOT SEARCH`);
  return counts.cannot ? 1 : 0;
}

const code = await main();
// fetch keeps its own connection pool open; closed so the process ends on its
// own, the way scripts/doctor.mjs does it, with the code set rather than
// process.exit() called.
await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.().catch(() => {});
process.exitCode = code;
