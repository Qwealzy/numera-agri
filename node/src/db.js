import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// A connection that ends while idle in the pool (Postgres restarted, its
// backend terminated) is dropped by pg-pool, which then emits 'error' on the
// pool; unheard, that is an uncaught exception and the process exits. Logged
// here, the next query opens a new connection.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export async function withTransaction(fn) {
  const client = await pool.connect();
  // A client taken out of the pool has no pool listener until it is released,
  // and a connection that ends emits 'error' on it even when the query that
  // was running is rejected for the same reason.
  const onError = (err) => console.error('[db] transaction client error:', err.message);
  client.on('error', onError);
  // Set when ROLLBACK itself fails: the connection's transaction state is then
  // unknown, and release(err) makes pg-pool destroy it rather than reuse it.
  let rollbackErr;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (e) {
      rollbackErr = e;
      console.error('[db] ROLLBACK failed after', err.message, '--', rollbackErr.message);
    }
    throw err;
  } finally {
    client.removeListener('error', onError);
    client.release(rollbackErr);
  }
}
