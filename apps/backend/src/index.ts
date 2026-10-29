import { SERVICE_PORTS } from '@meetpilot/shared';
import { createPool } from './db/pool.js';
import { buildApp } from './app.js';

// Fail closed: services must never run without the shared secret (docs/06).
if (!process.env.INTERNAL_SECRET) {
  console.error('INTERNAL_SECRET is not set; refusing to start');
  process.exit(1);
}

const app = buildApp(createPool());
const port = Number(process.env.BACKEND_PORT ?? SERVICE_PORTS.backend);
await app.listen({ port, host: '0.0.0.0' });
