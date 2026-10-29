import pg from 'pg';

/** Pool with sane limits. An idle client erroring (e.g. Postgres restart) must be logged, never crash the process. */
export function createPool(log: (msg: string, err: unknown) => void = (m, e) => console.error(m, (e as Error).message)): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX ?? 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30_000), // a runaway query cannot hold a connection forever
  });
  pool.on('error', (e) => log('postgres pool error', e));
  return pool;
}
