import pg from 'pg';
import { SERVICE_PORTS } from '@meetpilot/shared';
import { buildApp } from './app.js';

// Fail closed: the connector must never run without the shared secret (docs/06).
if (!process.env.INTERNAL_SECRET) {
  console.error('INTERNAL_SECRET is not set; refusing to start');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set; refusing to start');
  process.exit(1);
}

const { app, connector } = buildApp(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
await app.listen({ port: Number(process.env.CONNECTOR_PORT ?? SERVICE_PORTS.connector), host: '0.0.0.0' });
if (process.env.CONNECTOR_SYNC !== 'false') connector.startBackground();
