import pg from 'pg';

/**
 * Pool PostgreSQL + Transaction Manager.
 * Both executors (`db` and `tx`) share one interface, `query(text, params)`,
 * so repositories never need to know whether they run inside a transaction.
 */
export function createDatabase({ url, poolMax, statementTimeoutMs }, logger) {
  const pool = new pg.Pool({
    connectionString: url,
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeoutMs,
    application_name: 'rajaemas-crm',
  });
  pool.on('error', (err) => logger.error('db.pool_error', { err }));

  return Object.freeze({
    query: (text, params) => pool.query(text, params),

    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    close: () => pool.end(),
  });
}
