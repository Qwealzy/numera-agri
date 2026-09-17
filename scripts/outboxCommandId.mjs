// The command id a `processing` row's ledger submission carries, if it made
// one -- what to look for on the ledger to tell whether it landed. The
// dispatcher seeds it with the outbox row's id (damlClient.js commandIdFor).
// The prefix is read from the dispatcher's handlers, not assumed:
// handleActivation and handleRenewal call createContract (`create-`); every
// other handler in EVENT_HANDLERS calls exerciseChoice or, in handleTrigger,
// commandIdFor('exercise', ...) (`exercise-`). `release` is notImplemented
// and `suspension` has no handler, so neither submits anything. doctor only
// prints the id; it never asks the ledger for it.
//
// The one copy of this mapping: scripts/doctor.mjs and
// scripts/findOutboxCommand.mjs both import it. It imports nothing and does
// nothing when imported.
const CREATE_EVENT_TYPES = new Set(['activation', 'renewal']);
const NO_COMMAND_EVENT_TYPES = new Set(['release', 'suspension']);
export function ledgerCommandId({ id, event_type }) {
  if (NO_COMMAND_EVENT_TYPES.has(event_type)) return null;
  return `${CREATE_EVENT_TYPES.has(event_type) ? 'create' : 'exercise'}-${id}`;
}
