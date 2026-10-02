import { pool } from '../db.js';
import { config } from '../config.js';
import { deriveSecret } from '../notifications/signature.js';
import { isLoopbackHost } from '../notifications/sender.js';

// Admin CLI: an insurer's payout notification address and signing secret.
//
// Usage: npm run set-webhook -- <insurerId> <url>
//        npm run set-webhook -- --rotate <insurerId>
//        npm run set-webhook -- --clear <insurerId>
//
// Setting and rotating print the derived signing secret once. It is not
// stored anywhere -- it is re-derived from WEBHOOK_SIGNING_MASTER_KEY and
// webhook_secret_version -- so this is the moment to hand it to the insurer.
// The address itself is never printed back.
//
// An address that is not loopback is accepted (https only), but the sender
// will not post to it while WEBHOOK_ALLOW_NON_LOOPBACK is not set
// (the standing non-loopback rule).
const USAGE =
  'usage: npm run set-webhook -- <insurerId> <url>\n' +
  '       npm run set-webhook -- --rotate <insurerId>\n' +
  '       npm run set-webhook -- --clear <insurerId>';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Refusals name the rule, never echo the address.
function validateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('the address is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('the address must be http(s)');
  if (url.username || url.password) throw new Error('the address must not carry userinfo (user:password@)');
  if (url.hash || raw.includes('#')) throw new Error('the address must not carry a fragment (#...)');
  const loopback = isLoopbackHost(url.hostname);
  if (!loopback && url.protocol !== 'https:') throw new Error('an address that is not loopback must be https');
  return { loopback };
}

function printSecret(insurerId, version) {
  const secret = deriveSecret(config.notificationSender.signingMasterKey, insurerId, version);
  console.log(`Signing secret v${version} (save this now -- it is derived, never stored, and not shown again): ${secret}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!config.notificationSender.signingMasterKey) {
    throw new Error('WEBHOOK_SIGNING_MASTER_KEY is not set in node/.env; refusing, because no secret can be derived without it');
  }

  if (args[0] === '--rotate' || args[0] === '--clear') {
    const [mode, insurerId] = args;
    if (args.length !== 2 || !UUID.test(insurerId)) throw new Error(USAGE);
    if (mode === '--clear') {
      const { rowCount } = await pool.query('UPDATE insurers SET webhook_url = NULL WHERE id = $1', [insurerId]);
      if (!rowCount) throw new Error(`no insurer ${insurerId}`);
      console.log(`Webhook address cleared for insurer ${insurerId}. Its pending notifications stay pending and are not sent.`);
      return;
    }
    const { rows } = await pool.query(
      `UPDATE insurers SET webhook_secret_version = webhook_secret_version + 1 WHERE id = $1
       RETURNING webhook_secret_version`,
      [insurerId]
    );
    if (!rows.length) throw new Error(`no insurer ${insurerId}`);
    console.log(`Signing secret rotated for insurer ${insurerId}; deliveries from now on are signed with v${rows[0].webhook_secret_version}.`);
    printSecret(insurerId, rows[0].webhook_secret_version);
    return;
  }

  const [insurerId, rawUrl] = args;
  if (args.length !== 2 || !UUID.test(insurerId)) throw new Error(USAGE);
  const { loopback } = validateUrl(rawUrl);
  const { rows } = await pool.query(
    'UPDATE insurers SET webhook_url = $2 WHERE id = $1 RETURNING webhook_secret_version',
    [insurerId, rawUrl]
  );
  if (!rows.length) throw new Error(`no insurer ${insurerId}`);
  console.log(`Webhook address set for insurer ${insurerId} (${loopback ? 'loopback' : 'not loopback'}).`);
  if (!loopback && !config.notificationSender.allowNonLoopback) {
    console.log('The sender will not post to it: WEBHOOK_ALLOW_NON_LOOPBACK is not set.');
  }
  printSecret(insurerId, rows[0].webhook_secret_version);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
