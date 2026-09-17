// What counts as a leftover in the test database, defined once for the two
// places that look: npm test's leak gate (test/leakGate.test.mjs) and doctor's
// testdb line (scripts/doctor.mjs). Every table in the public schema is
// counted, payout_tiers included: scripts/setupTestDb.mjs applies
// sql/schema.sql and no seed, so an empty table is the only state a clean run
// leaves behind.
//
// Tables are listed from pg_tables, not information_schema, which hides the
// tables the current role holds no privilege on. It takes a client the caller
// has connected, opens nothing and changes nothing.
export async function leftoverRows(client) {
  const { rows: [{ d: database }] } = await client.query('SELECT current_database() AS d');
  const { rows } = await client.query("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
  const tables = rows.map((r) => r.t);
  const leftovers = [];
  for (const table of tables) {
    const { rows: [{ n }] } = await client.query(`SELECT count(*)::int AS n FROM public.${client.escapeIdentifier(table)}`);
    if (n > 0) leftovers.push({ table, n });
  }
  return { database, tables, leftovers };
}
