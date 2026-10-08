import axios from 'axios';
import { pathToFileURL } from 'node:url';
import { pool } from '../db.js';
import { config } from '../config.js';
import { buildEnvelope } from './envelope.js';
import { deriveSecret, sign } from './signature.js';

// Drains payout_notifications (migration 035). One POST per
// due row, of the thin envelope (envelope.js), signed (signature.js), to the
// address the insurer set with `npm run set-webhook`.
//
// Loopback only unless WEBHOOK_ALLOW_NON_LOOPBACK is 'true'. This is
// a rule made mechanical: nothing is delivered to a real insurer
// address until a legal review is complete. A row whose
// address is not loopback is marked failed WITHOUT a request.
//
// last_error records a classification only -- 'http ' and the response code,
// or an error code. Never the receiver's body, headers or the address: what a
// receiver says back is not ours to keep (a legal observation),
// and an axios error message carries the host and port. The secret and the
// signature are never logged.
//
// Payment does not wait on any of this: /settle and /fail are separate, and a
// failed notification is a row a human reads, not a held payout.

export const NON_LOOPBACK_ERROR = 'destination is not loopback and WEBHOOK_ALLOW_NON_LOOPBACK is not set';

// localhost, 127.0.0.0/8 and ::1, on a hostname as WHATWG URL gives it: IPv4
// already normalized (127.1 -> 127.0.0.1), IPv6 in brackets. Anything else,
// including localhost. and *.localhost, is not loopback -- fail closed.
export function isLoopbackHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '[::1]') return true;
  const m = h.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(m) && m.slice(1).every((o) => Number(o) <= 255);
}

// Oldest due row whose insurer has an address, claimed in the same statement
// that reads the address and secret version, so a concurrent set-webhook
// cannot leave a claimed row without one. SKIP LOCKED so a second sender
// process, if one is ever run, can't claim the same row twice (the
// dispatcher's claimNext pattern). Rows of insurers with no address are not
// claimed at all: they wait, pending, until one is set.
async function claimNext(now) {
  const { rows } = await pool.query(
    `UPDATE payout_notifications n SET status = 'processing'
       FROM insurers i
      WHERE i.id = n.insurer_id
        AND n.id = (
          SELECT pn.id FROM payout_notifications pn JOIN insurers pi ON pi.id = pn.insurer_id
           WHERE pn.status = 'pending' AND pn.next_attempt_at <= $1 AND pi.webhook_url IS NOT NULL
           ORDER BY pn.created_at ASC
           LIMIT 1
           FOR UPDATE OF pn SKIP LOCKED
        )
      RETURNING n.id, n.payout_event_id, n.insurer_id, n.kind::text AS kind, n.created_at, n.attempt_count,
                i.webhook_url, i.webhook_secret_version`,
    [now]
  );
  return rows[0] ?? null;
}

// 'http ' and the response code when the receiver answered, its error code
// when the transport failed. Nothing else from the error is read.
function classify(err) {
  if (err.response) return { statusCode: err.response.status, error: `http ${err.response.status}` };
  return { statusCode: null, error: err.code ?? 'unclassified transport error' };
}

async function markFailedUnsent(row, error) {
  await pool.query(`UPDATE payout_notifications SET status = 'failed', last_error = $1 WHERE id = $2`, [error, row.id]);
  console.error(`[notificationSender] notification ${row.id} failed without a request: ${error}`);
}

async function deliver(row, now) {
  const { signingMasterKey, timeoutMs, retryScheduleMs, allowNonLoopback } = config.notificationSender;

  let url;
  try {
    url = new URL(row.webhook_url);
  } catch {
    await markFailedUnsent(row, 'destination is not a valid URL');
    return;
  }
  if (!isLoopbackHost(url.hostname) && !allowNonLoopback) {
    await markFailedUnsent(row, NON_LOOPBACK_ERROR);
    return;
  }

  const body = buildEnvelope(row);
  // The wall clock, not `now`: this is a freshness claim to the receiver,
  // while `now` decides what is due, when the next attempt is, and the
  // delivered_at written below -- the instant this run started, not the
  // instant of delivery.
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign(deriveSecret(signingMasterKey, row.insurer_id, row.webhook_secret_version), timestamp, body);

  let outcome;
  try {
    const res = await axios.post(row.webhook_url, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Id': row.id,
        'X-Webhook-Timestamp': String(timestamp),
        'X-Webhook-Signature': `v1=${signature}`,
      },
      // Send the string as it is: the bytes signed are the bytes sent.
      transformRequest: [(data) => data],
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: (code) => code >= 200 && code < 300,
      // An HTTP(S)_PROXY in the environment would otherwise carry the request
      // to a host the loopback check above never saw.
      proxy: false,
      transitional: { clarifyTimeoutError: true },
    });
    outcome = { delivered: true, statusCode: res.status };
  } catch (err) {
    outcome = { delivered: false, ...classify(err) };
  }

  if (outcome.delivered) {
    await pool.query(
      `UPDATE payout_notifications
          SET status = 'delivered', delivered_at = $1, last_status_code = $2, last_error = NULL
        WHERE id = $3`,
      [now, outcome.statusCode, row.id]
    );
    console.log(`[notificationSender] notification ${row.id} delivered (http ${outcome.statusCode})`);
    return;
  }

  // The trigger admits processing -> pending only with attempt_count raised,
  // so the attempt is always counted, retried or not.
  const attempt = row.attempt_count + 1;
  const delay = retryScheduleMs[attempt - 1];
  if (delay === undefined) {
    await pool.query(
      `UPDATE payout_notifications
          SET status = 'failed', attempt_count = $1, last_status_code = $2, last_error = $3
        WHERE id = $4`,
      [attempt, outcome.statusCode, outcome.error, row.id]
    );
    console.error(`[notificationSender] notification ${row.id} failed after ${attempt} attempts (${outcome.error})`);
  } else {
    await pool.query(
      `UPDATE payout_notifications
          SET status = 'pending', attempt_count = $1, next_attempt_at = $2, last_status_code = $3, last_error = $4
        WHERE id = $5`,
      [attempt, new Date(now.getTime() + delay), outcome.statusCode, outcome.error, row.id]
    );
    console.warn(`[notificationSender] notification ${row.id} attempt ${attempt} failed (${outcome.error}); retry in ${delay}ms`);
  }
}

export const STALE_RELEASE_ERROR = 'released: stale processing';

// A row claimed by a sender that then exited stays in processing: claimNext
// takes only pending rows, so nothing would ever move it again. Older than
// WEBHOOK_STALE_PROCESSING_MS, it is handed back to pending with the attempt
// counted -- the trigger admits processing -> pending only with attempt_count
// raised -- or failed if the schedule has no retry left for that attempt.
//
// Retrying here is safe, unlike in the dispatcher. The dispatcher's "never
// retry automatically" rule is for ledger work: a create or an exercise that
// may already have landed must not be submitted twice. A webhook that may
// already have landed can be sent twice: every attempt carries the same
// X-Webhook-Id, and discarding repeats by it is the receiver's side of the
// contract (docs/api/notifications-v1.openapi.json).
async function releaseStale(now) {
  const { staleProcessingMs, retryScheduleMs } = config.notificationSender;
  const { rows } = await pool.query(
    `UPDATE payout_notifications n
        SET attempt_count = n.attempt_count + 1,
            status = CASE WHEN n.attempt_count + 1 > $3 THEN 'failed' ELSE 'pending' END::notification_status,
            next_attempt_at = $1,
            last_error = $4
      WHERE n.id IN (
        SELECT id FROM payout_notifications
         WHERE status = 'processing' AND updated_at < $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING n.id, n.status::text AS status, n.attempt_count`,
    [now, new Date(now.getTime() - staleProcessingMs), retryScheduleMs.length, STALE_RELEASE_ERROR]
  );
  for (const r of rows) {
    console.warn(`[notificationSender] notification ${r.id} was stale in processing; ${r.status} after ${r.attempt_count} attempts`);
  }
}

// `now` is the seam tests use to step through the retry schedule. Production
// passes nothing. Without a master key nothing is claimed and nothing is sent.
export async function runOnce({ now = new Date() } = {}) {
  if (!config.notificationSender.signingMasterKey) return;
  await releaseStale(now);
  for (;;) {
    const row = await claimNext(now);
    if (!row) break;
    await deliver(row, now);
  }
}

export function startNotificationSender() {
  if (!config.notificationSender.signingMasterKey) {
    console.error('[notificationSender] WEBHOOK_SIGNING_MASTER_KEY is not set; the sender does not start');
    return;
  }
  const scope = config.notificationSender.allowNonLoopback ? 'any address' : 'loopback addresses only';
  console.log(`[notificationSender] polling every ${config.notificationSender.pollMs}ms, ${scope}`);
  setInterval(() => {
    runOnce().catch((err) => console.error('[notificationSender] run failed:', err));
  }, config.notificationSender.pollMs);
}

// See oracleBot.js for why pathToFileURL is used here instead of manual
// string concatenation (Windows path-format mismatch made that dead code).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startNotificationSender();
  if (config.notificationSender.signingMasterKey) {
    runOnce().catch((err) => console.error('[notificationSender] initial run failed:', err));
  }
}
