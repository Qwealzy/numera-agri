// The receiving side of a payout notification, as docs/api/notifications-v1.openapi.json
// describes it: raw body first, timestamp freshness, the signature over
// `${timestamp}.${rawBody}` compared in constant time, then repeats discarded
// by X-Webhook-Id. Shared by scripts/mock-insurer.mjs and
// scripts/verify-notification.mjs, so the receiver the live run proves is the
// receiver the demo runs.
//
// Node built-ins only, and nothing from node/src: the signature is computed
// here from the contract's recipe, not with the sender's own code, so a sender
// that drifted from the contract would fail here.
//
// Nothing here logs the secret, the signature or the body.

import crypto from 'node:crypto';

// How old a timestamp may be is the receiver's choice (the contract says so);
// this receiver's is five minutes.
export const MAX_AGE_SECONDS = 300;

export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// { ok: true } or { ok: false, status, reason }. Status is the answer to give:
// 400 for a stale or missing timestamp, 401 for a signature that does not match.
export function verifyWebhook({ secret, headers, rawBody, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const timestamp = headers['x-webhook-timestamp'];
  if (typeof timestamp !== 'string' || !/^[0-9]+$/.test(timestamp)) {
    return { ok: false, status: 400, reason: 'missing or malformed X-Webhook-Timestamp' };
  }
  if (nowSeconds - Number(timestamp) > MAX_AGE_SECONDS) {
    return { ok: false, status: 400, reason: `X-Webhook-Timestamp older than ${MAX_AGE_SECONDS}s` };
  }
  const expected = Buffer.from(
    `v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
  );
  const got = Buffer.from(String(headers['x-webhook-signature'] ?? ''));
  // timingSafeEqual throws on unequal lengths; a length mismatch is a mismatch.
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    return { ok: false, status: 401, reason: 'signature does not match' };
  }
  return { ok: true };
}

// One POST, start to finish. `seen` is the caller's Set of X-Webhook-Ids
// already handled. onNew(envelope) runs once per new id, after the signature
// has verified; if it throws, the answer is 500 and the id is forgotten, so
// the sender's retry is handled as new. Every request, accepted or not, is
// handed to record() with what was decided about it.
export async function handleWebhook(req, res, { secret, seen, onNew, record }) {
  const rawBody = await readRawBody(req);
  const event = {
    receivedAt: new Date().toISOString(),
    webhookId: req.headers['x-webhook-id'] ?? null,
    type: null,
    payoutId: null,
    signatureValid: false,
    duplicate: false,
    answer: null,
    reason: null,
  };
  const answer = (status, reason = null) => {
    event.answer = status;
    event.reason = reason;
    record(event);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(reason ? { error: reason } : {}));
  };

  const v = verifyWebhook({ secret, headers: req.headers, rawBody });
  if (!v.ok) return answer(v.status, v.reason);
  event.signatureValid = true;

  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return answer(400, 'body is not JSON');
  }
  event.type = envelope.type ?? null;
  event.payoutId = envelope.payoutId ?? null;
  if (envelope.id !== event.webhookId) return answer(400, 'X-Webhook-Id is not the body id');

  if (seen.has(event.webhookId)) {
    event.duplicate = true;
    return answer(200);
  }
  seen.add(event.webhookId);
  try {
    await onNew(envelope, event);
  } catch (err) {
    seen.delete(event.webhookId);
    return answer(500, `handling failed: ${err.message.slice(0, 120)}`);
  }
  return answer(200);
}
