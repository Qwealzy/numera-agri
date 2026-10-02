import crypto from 'node:crypto';

// Stage 2 Part 2: the webhook signature. Pure; the sender and the CLI both
// call it, and neither logs what it returns.
//
// The per-insurer secret is DERIVED, never stored: HMAC of the insurer id and
// its webhook_secret_version under one master key from the environment. A
// database dump therefore carries no signing secret, and rotating one insurer
// is a version bump rather than a new column value.
export function deriveSecret(masterKey, insurerId, version) {
  if (!masterKey) throw new Error('webhook signing master key is not set');
  return crypto.createHmac('sha256', masterKey).update(`${insurerId}:${version}`).digest('hex');
}

// Over "<timestamp>.<raw body>", so a captured body cannot be replayed under a
// fresh timestamp. rawBody must be the exact string that is sent.
export function sign(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
