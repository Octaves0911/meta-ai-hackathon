import pg from 'pg';
import { SERVICE_PORTS } from '@meetpilot/shared';
import { buildApp } from './app.js';

// Fail closed: the connector must never run without a (strong, in production) shared secret (docs/06).
const weak = !process.env.INTERNAL_SECRET ? 'INTERNAL_SECRET is not set'
  : process.env.NODE_ENV === 'production' && (process.env.INTERNAL_SECRET.length < 24 || process.env.INTERNAL_SECRET === 'dev-only-change-me') ? 'INTERNAL_SECRET is weak or still the example value' : '';
if (weak) {
  console.error(`${weak}; refusing to start`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set; refusing to start');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, statement_timeout: 30_000 });
const { app, connector } = buildApp(pool);
pool.on('error', (e) => app.log.error({ msg: e.message }, 'postgres pool error'));
await app.listen({ port: Number(process.env.CONNECTOR_PORT ?? SERVICE_PORTS.connector), host: '0.0.0.0' });
if (process.env.CONNECTOR_SYNC !== 'false') connector.startBackground();

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(1), 10_000).unref();
  try { await app.close(); await pool.end(); } finally { clearTimeout(force); }
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('unhandledRejection', (e) => app.log.error({ msg: (e as Error)?.message }, 'unhandled rejection'));
