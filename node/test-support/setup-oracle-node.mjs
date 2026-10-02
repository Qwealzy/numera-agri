// Points DAML_JSON_API_URL_ORACLE at the second participant the TEST
// environment names, for the one test file that needs two of them.
//
// It is a module rather than a line in that file for the same reason
// setup-test-db.mjs is: config.js reads the key once, at load, and ESM
// evaluates every static import before the first statement of the file that
// imports them -- so an assignment written in the test file itself would run
// after config.js had already read the key. Imported second, right after the
// database guard, it runs before config.js is reached.
//
// The address is NEVER hardcoded: it comes from TEST_DAML_JSON_API_URL_ORACLE,
// which the person running the tests is expected to set in the shell (LocalNet's
// App User participant is http://localhost:2975). Because setup-test-db.mjs is
// imported first and its own first import is dotenv/config, a value placed in
// node/.env would also be picked up (ESM import order runs that load before
// this one). With the key unset nothing is changed and the test file skips
// itself, so a machine with one participant runs the suite exactly as before.
//
// It imports nothing and touches no database, no ledger and no file.
export const oracleNodeUrl = process.env.TEST_DAML_JSON_API_URL_ORACLE || null;

if (oracleNodeUrl) {
  process.env.DAML_JSON_API_URL_ORACLE = oracleNodeUrl;
}
