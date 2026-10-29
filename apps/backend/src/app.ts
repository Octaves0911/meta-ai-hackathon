import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ZodError } from 'zod';
import type { Health } from '@meetpilot/shared';
import { HttpError } from './errors.js';
import { userRoutes } from './routes/users.js';
import { projectRoutes } from './routes/projects.js';
import { meetingRoutes } from './routes/meetings.js';
import { notificationRoutes } from './routes/notifications.js';
import { roomRoutes } from './routes/room.js';
import { transcriptRoutes } from './routes/transcript.js';
import { attachRealtime } from './realtime.js';
import { attachStt } from './stt.js';
import { memoryRoutes } from './routes/memory.js';
import { createEmbedder, type Embedder } from './memory/embedder.js';

declare module 'fastify' {
  interface FastifyInstance { db: pg.Pool; embedder: Embedder }
}

export interface AuthUser { id: string; username: string }

/** Resolve the caller from the x-user header (username-only identity; see docs/06). */
export async function requireUser(app: FastifyInstance, req: FastifyRequest): Promise<AuthUser> {
  const name = req.headers['x-user'];
  if (typeof name !== 'string' || !name) throw new HttpError(401, 'unauthenticated', 'x-user header required');
  const { rows } = await app.db.query('select id, username from users where username = $1', [name.toLowerCase()]);
  if (!rows[0]) throw new HttpError(401, 'unknown_user', 'unknown user');
  return rows[0];
}

export function buildApp(db: pg.Pool): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.decorate('db', db);
  app.decorate('embedder', createEmbedder());
  attachRealtime(app);
  attachStt(app);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'invalid_request', message: err.issues.map((i) => i.message).join('; ') } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  app.get('/health', async (): Promise<Health> => ({ service: 'backend', status: 'ok' }));
  app.register(userRoutes, { prefix: '/api' });
  app.register(projectRoutes, { prefix: '/api' });
  app.register(meetingRoutes, { prefix: '/api' });
  app.register(notificationRoutes, { prefix: '/api' });
  app.register(roomRoutes, { prefix: '/api' });
  app.register(transcriptRoutes, { prefix: '/api' });
  app.register(memoryRoutes, { prefix: '/api' });
  return app;
}
