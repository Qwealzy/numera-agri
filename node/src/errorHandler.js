// The API's last-resort error handler, in a module of its own so it can be
// tested without importing server.js, which listens and starts every loop.
//
// A 4xx carries a message the route wrote for the caller -- a refusal or a
// validation failure -- and it goes out as is. Anything else, with no status
// or a 5xx, is an error the caller did not cause, and its message can be raw
// Postgres or ledger text: 'null value in column "full_name" ...' reached a
// client on 2026-09-11. The caller gets a fixed body; the full error stays in
// the server log.
//
// Four parameters, always: Express recognises error middleware by arity.
export function errorHandler(err, _req, res, _next) {
  console.error(err);
  const httpStatus = err.status ?? 500;
  const forCaller = httpStatus >= 400 && httpStatus <= 499;
  res.status(httpStatus).json({ error: forCaller ? err.message : 'internal server error' });
}
