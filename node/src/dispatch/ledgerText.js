import crypto from 'node:crypto';

// The insurer's free text -- a bank reference, a failure reason, a closure
// note -- as the ledger carries it. Pure; the route, the dispatcher and the
// tests call it, and it imports only node:crypto.
//
// The raw text stays in SQL. The ledger gets "sha256:" + hex(SHA-256(salt ||
// UTF-8 text)), where the salt is 32 random bytes kept beside the text in the
// same SQL row. Salted, because a short text hashed bare is recovered by
// trying candidates; a digest, not a row id, because it binds to the content.
//
// The salt is drawn when the outbox row is written, never at dispatch, so a
// retried row sends the same value.
export function newTextSalt() {
  return crypto.randomBytes(32).toString('hex');
}

export function saltedDigest(saltHex, text) {
  if (typeof saltHex !== 'string' || !/^[0-9a-f]{64}$/.test(saltHex)) {
    throw new Error('the salt must be 32 bytes as 64 lowercase hex characters');
  }
  if (typeof text !== 'string' || text === '') {
    throw new Error('the text to digest must be a non-empty string');
  }
  return (
    'sha256:' +
    crypto.createHash('sha256').update(Buffer.from(saltHex, 'hex')).update(text, 'utf8').digest('hex')
  );
}

// True when `value` is what saltedDigest gives for this (salt, text): the
// check that the SQL row and the ledger agree. Nothing in production calls
// it: it is for the tests and for checking a row against the ledger by hand.
export function matchesSaltedDigest(saltHex, text, value) {
  return saltedDigest(saltHex, text) === value;
}
