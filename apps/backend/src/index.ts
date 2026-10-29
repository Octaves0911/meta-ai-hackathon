import { SERVICE_PORTS } from '@meetpilot/shared';
import { createPool } from './db/pool.js';
import { buildApp } from './app.js';
import { secretProblems } from './startupChecks.js';

// Fail closed: services must never run without a (strong, in production) shared secret (docs/06).
const problems = secretProblems();
if (problems.length) {
  for (const p of problems) console.error(`${p}; refusing to start`);
  process.exit(1);
}

const pool = createPool();
const app = buildApp(pool);
pool.on('error', (e) => app.log.error(e, 'postgres pool error'));
const port = Number(process.env.BACKEND_PORT ?? SERVICE_PORTS.backend);
await app.listen({ port, host: '0.0.0.0' });
if (process.env.INSIGHTS_ENABLED !== 'false') app.insights.start();
if (process.env.AGENTS_ENABLED !== 'false') app.agents.start();
void app.workspace.start(); // re-attach watchers for connected local folders

// Graceful shutdown: stop accepting work, let hooks stop workers/watchers, then close the pool.
let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000).unref();
  try { await app.close(); await pool.end(); } finally { clearTimeout(force); }
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
// A stray rejected promise should be visible, not take the whole meeting server down.
process.on('unhandledRejection', (e) => app.log.error(e, 'unhandled rejection'));
