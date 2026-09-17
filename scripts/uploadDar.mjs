// Uploads a DAR to both LocalNet participants' JSON APIs.
// The Canton Builder Tool's own `canton builder deploy` has a JWT-helper bug
// (base64 without -w 0) that corrupts the token on longer payloads, so this
// posts the bytes directly with a correctly generated HS256 token.
import fs from 'node:fs';
import crypto from 'node:crypto';

const ENV_PATH = new URL('../node/.env', import.meta.url).pathname.replace(/^\//, '');
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']/, '').replace(/["']$/, '');
}

const dar = process.argv[2];
if (!dar) { console.error('usage: node uploadDar.mjs <path-to-dar>'); process.exit(1); }
const bytes = fs.readFileSync(dar);

const b64u = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function jwt(secret, sub) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ sub, aud: 'https://canton.network.global', exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${h}.${p}.${sig}`;
}
const token = process.env.DAML_LEDGER_TOKEN
  || jwt(process.env.DAML_UNSAFE_JWT_SECRET ?? 'unsafe', process.env.DAML_UNSAFE_JWT_SUB ?? 'ledger-api-user');

const base = process.env.DAML_JSON_API_URL ?? 'http://localhost:3975';
const other = base.replace(/:\d+/, ':2975');

for (const url of [...new Set([base, other])]) {
  try {
    const res = await fetch(`${url}/v2/packages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    console.log(`${url}  ->  ${res.status}  ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    console.log(`${url}  ->  ERR ${e.message}`);
  }
}
