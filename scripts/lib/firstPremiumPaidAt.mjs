// When the first premium is reported paid, for scripts/setupDemo.mjs.
//
// Pure on purpose -- no database, no network, no clock of its own -- so the
// rule can be tested without a stack. `now` and `policyCreatedAt` are passed
// in; nothing here reads either.
//
// WHY IT IS ASKED FOR RATHER THAN CHOSEN. The script used to send the term's
// own start instant every time, silently. Where the setup ran after that
// instant -- which is what a rehearsal against a recorded night does -- the
// payment was dated before the policy existed in the system, and cover with
// it. That is an open legal question.
// So there is no default: the value is the caller's to state.
//
// WHAT THIS DOES NOT DECIDE. Whether a paidAt before the term's start is
// allowed is not ruled on here, because nothing in this system rules on it:
// the route checks only that the date parses (node/src/routes/policies.js),
// the dispatcher only that it parses (handleFirstPremiumPaid), and
// PolicyToken_RecordFirstPremiumPaid asserts only the direction guard for a
// cover start ALREADY agreed. Inventing a period or a bound here would be
// inventing a rule. That case is passed through, and named in the notes so
// the run says what it is doing.
//
// A paidAt in the future IS ruled on since v22: the ledger refuses one
// after its own time, and the route one after the server's clock, both with
// no margin. So it is refused here too, before the route is called.

export const BACKDATED_FLAG = '--allow-backdated-payment';

// Two refusals: a payment dated before the policy was made, and one dated in
// the future. Everything else is a note, printed and passed on.
export class PaidAtRefused extends Error {}

// paidAtArg is the --paid-at value: an ISO instant, or the word 'now' for the
// instant this step is sent. Returns { paidAt, notes } -- paidAt as an ISO
// string, notes as sentences for the caller to print.
//
// policyCreatedAt is policies.created_at, the instant the check measures against;
// termStart is the policy's own term start, reported on only.
export function resolvePaidAt({ paidAtArg, now, policyCreatedAt, termStart, allowBackdated = false }) {
  if (paidAtArg === undefined || paidAtArg === '') {
    throw new PaidAtRefused(
      '--paid-at is required and has no default: give an ISO instant, or "now" for the moment this ' +
        'step is sent. Sending the term start silently is what dated a payment before the policy ' +
        'existed (an open legal question)'
    );
  }
  const instant = paidAtArg === 'now' ? new Date(now) : new Date(paidAtArg);
  if (Number.isNaN(instant.getTime())) {
    throw new PaidAtRefused(`--paid-at ${JSON.stringify(paidAtArg)} is neither "now" nor a date this platform can read`);
  }

  const notes = [];
  const created = policyCreatedAt === null || policyCreatedAt === undefined ? null : new Date(policyCreatedAt);
  if (created !== null && !Number.isNaN(created.getTime()) && instant.getTime() < created.getTime()) {
    const line =
      `--paid-at ${instant.toISOString()} is BEFORE the policy was made in this system ` +
      `(${created.toISOString()}), so cover would begin before the contract existed. That is ` +
      `an open legal question: the m. 1458 check runs only at ` +
      `mint and only on an agreed start, so it would not run on this payment at all.`;
    if (!allowBackdated) {
      throw new PaidAtRefused(`${line} Nothing was sent. ${BACKDATED_FLAG} sends it anyway, knowingly.`);
    }
    notes.push(`${line} Sent anyway: ${BACKDATED_FLAG} was given.`);
  }

  // Reported, never refused: no rule in this system bounds this case, and
  // this is not the place to write one. (A future instant is refused above.)
  const start = termStart === null || termStart === undefined ? null : new Date(termStart);
  if (start !== null && !Number.isNaN(start.getTime()) && instant.getTime() < start.getTime()) {
    notes.push(
      `--paid-at ${instant.toISOString()} is before the term's own start (${start.toISOString()}). ` +
        `Nothing in this system refuses that: the route and the dispatcher check only that the date ` +
        `parses, and the ledger's guard bites only where a cover start was already agreed. ` +
        `coverageBeganAt will be the reported instant.`
    );
  }
  if (instant.getTime() > new Date(now).getTime()) {
    throw new PaidAtRefused(
      `--paid-at ${instant.toISOString()} is in the future (now is ${new Date(now).toISOString()}). ` +
        `The route and the ledger both refuse a first premium reported paid before it was paid ` +
        `(v22). Nothing was sent.`
    );
  }
  return { paidAt: instant.toISOString(), notes };
}
