// A FAKE insurer on this machine: it receives payout notifications, checks
// them the way the contract says a receiver must (scripts/lib/webhookVerify.mjs),
// reads each new payout with the insurer's API key, and optionally reports it
// settled. The standing rule: until the lawyer
// answers, the demo posts only to a fake receiver on this machine, with
// invented data. So this binds to 127.0.0.1 and nothing else.
//
// Node built-ins and global fetch only; it is a separate process and shares
// no code with the platform.
//
//   MOCK_INSURER_API_KEY=... MOCK_INSURER_WEBHOOK_SECRET=... node scripts/mock-insurer.mjs [--auto-settle]
//
// MOCK_INSURER_WEBHOOK_SECRET is the secret `npm run set-webhook` printed once.
// MOCK_INSURER_PORT (default 9099), PLATFORM_BASE_URL (default
// http://localhost:8080), MOCK_INSURER_SETTLE_DELAY_MS (default 3000).
// Nothing is written to disk. The key, the secret and signatures are never
// logged or served; what it holds lives in memory and is gone on exit.
//
//   GET /         one page, no external assets, refreshed every 2 seconds
//   GET /events   the same data as JSON
//   POST /webhook the receiver

import http from 'node:http';
import { handleWebhook } from './lib/webhookVerify.mjs';

const API_KEY = process.env.MOCK_INSURER_API_KEY;
const SECRET = process.env.MOCK_INSURER_WEBHOOK_SECRET;
const PORT = Number(process.env.MOCK_INSURER_PORT ?? 9099);
const PLATFORM = (process.env.PLATFORM_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const SETTLE_DELAY_MS = Number(process.env.MOCK_INSURER_SETTLE_DELAY_MS ?? 3000);
const AUTO_SETTLE = process.argv.includes('--auto-settle');

if (!API_KEY || !SECRET) {
  console.error('mock-insurer: MOCK_INSURER_API_KEY and MOCK_INSURER_WEBHOOK_SECRET must both be set in the environment; refusing to start');
  process.exit(1);
}

const state = { notifications: [], records: {}, actions: [], duplicates: 0 };
const seen = new Set();

async function platform(method, path, body) {
  const res = await fetch(`${PLATFORM}/api/v1${path}`, {
    method,
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: parsed };
}

// The mock's own "payment": an obviously fake reference, today's date as the
// reported settlement date, and the role the platform routed the payout to.
async function settle(record) {
  const payload = {
    bankReference: `MOCK-${record.payoutId.slice(0, 8)}`,
    settledAt: new Date().toISOString(),
    paidRole: record.recipientRole,
  };
  const action = { at: new Date().toISOString(), payoutId: record.payoutId, action: 'settle', bankReference: payload.bankReference, result: null };
  state.actions.push(action);
  try {
    const r = await platform('POST', `/payouts/${record.payoutId}/settle`, payload);
    action.result = r.status === 202 ? `202 ${r.body?.action ?? ''}`.trim() : `${r.status} ${r.body?.error ?? ''}`.trim();
  } catch (err) {
    action.result = `request failed: ${err.cause?.code ?? err.name}`;
  }
}

async function onNew(envelope) {
  const r = await platform('GET', `/payouts/${envelope.payoutId}`);
  if (r.status !== 200) throw new Error(`GET /payouts/${envelope.payoutId} answered ${r.status}`);
  state.records[envelope.payoutId] = r.body;
  if (AUTO_SETTLE && envelope.type === 'payout.approved') {
    setTimeout(() => settle(r.body), SETTLE_DELAY_MS);
  } else if (envelope.type === 'payout.review_required') {
    state.actions.push({ at: new Date().toISOString(), payoutId: envelope.payoutId, action: 'none (review required: shown only)', result: 'n/a' });
  }
}

function record(event) {
  state.notifications.push(event);
  if (event.duplicate) state.duplicates += 1;
  console.log(`[mock-insurer] ${event.receivedAt} ${event.type ?? '-'} payout ${event.payoutId ?? '-'} signature ${event.signatureValid ? 'valid' : 'INVALID'}${event.duplicate ? ' REPEAT' : ''} -> ${event.answer}${event.reason ? ` (${event.reason})` : ''}`);
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fake insurer</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--warn:#9a2b00;--warnbg:#fff1e8}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--muted:#aaa;--line:#333;--warn:#ffb38a;--warnbg:#3a1d0e}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px}
.banner{background:var(--warnbg);color:var(--warn);border:2px solid var(--warn);padding:12px;font-weight:700;font-size:18px;margin-bottom:16px}
h2{font-size:15px;margin:20px 0 6px}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;white-space:nowrap}
th{color:var(--muted);font-weight:600}
.muted{color:var(--muted)}
</style></head><body>
<div class="banner">FAKE INSURER — on this machine, with invented data</div>
<div class="muted" id="meta"></div>
<h2>Notifications received</h2><div class="wrap"><table id="n"></table></div>
<h2>Records fetched</h2><div class="wrap"><table id="r"></table></div>
<h2>Actions taken</h2><div class="wrap"><table id="a"></table></div>
<script>
function fill(id, head, rows){
  var t=document.getElementById(id); t.textContent='';
  var tr=t.insertRow(); head.forEach(function(h){var th=document.createElement('th');th.textContent=h;tr.appendChild(th);});
  if(!rows.length){var e=t.insertRow().insertCell();e.colSpan=head.length;e.className='muted';e.textContent='none yet';return;}
  rows.forEach(function(r){var x=t.insertRow();r.forEach(function(v){x.insertCell().textContent=v==null?'—':String(v);});});
}
function tick(){
  fetch('/events').then(function(r){return r.json();}).then(function(s){
    document.getElementById('meta').textContent='auto-settle: '+(s.autoSettle?'on':'off')+' · repeats seen: '+s.duplicates+' · last refresh: '+new Date().toLocaleTimeString();
    fill('n',['time','type','payout','signature valid','repeat','answer','reason'],s.notifications.slice().reverse().map(function(e){return [e.receivedAt,e.type,e.payoutId,e.signatureValid?'yes':'NO',e.duplicate?'yes':'no',e.answer,e.reason];}));
    fill('r',['payout','amount','currency','recipient role','coverage','approved at','status'],Object.values(s.records).map(function(p){return [p.payoutId,p.amount,p.currency,p.recipientRole,p.coverageCode,p.approvedAt,p.status];}));
    fill('a',['time','payout','action','reference','result'],s.actions.slice().reverse().map(function(a){return [a.at,a.payoutId,a.action,a.bankReference,a.result==null?'waiting':a.result];}));
  }).catch(function(){document.getElementById('meta').textContent='could not read /events';});
}
tick(); setInterval(tick, 2000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (req.method === 'POST' && path === '/webhook') {
    handleWebhook(req, res, { secret: SECRET, seen, onNew, record }).catch((err) => {
      console.error(`[mock-insurer] receiver error: ${err.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  } else if (req.method === 'GET' && path === '/events') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify({ autoSettle: AUTO_SETTLE, ...state }));
  } else if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE);
  } else {
    res.writeHead(404).end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-insurer] FAKE insurer listening on 127.0.0.1:${PORT} (POST /webhook, GET /, GET /events); auto-settle ${AUTO_SETTLE ? `on, after ${SETTLE_DELAY_MS}ms` : 'off'}`);
});
