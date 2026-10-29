import Fastify from 'fastify';
import { SERVICE_PORTS, type Health } from '@meetpilot/shared';

// Fail closed: services must never run without the shared secret (docs/06).
if (!process.env.INTERNAL_SECRET) {
  console.error('INTERNAL_SECRET is not set; refusing to start');
  process.exit(1);
}

const app = Fastify({ logger: true });

app.get('/health', async (): Promise<Health> => ({ service: 'backend', status: 'ok' }));

const port = Number(process.env.BACKEND_PORT ?? SERVICE_PORTS.backend);
await app.listen({ port, host: '0.0.0.0' });
