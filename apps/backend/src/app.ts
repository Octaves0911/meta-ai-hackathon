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
import { insightRoutes } from './routes/insights.js';
import { taskRoutes } from './routes/tasks.js';
import { executionRoutes } from './routes/executions.js';
import { integrationRoutes } from './routes/integrations.js';
import { AgentService } from './agents/service.js';
import { WorkspaceService } from './workspace/service.js';
import { workspaceRoutes } from './routes/workspace.js';
import multipart from '@fastify/multipart';
import { InsightService } from './insights/service.js';
import { createEmbedder, type Embedder } from './memory/embedder.js';
import { registerOps } from './ops/plugin.js';
import { randomUUID } from 'node:crypto';

declare module 'fastify' {
  interface FastifyInstance { db: pg.Pool; embedder: Embedder; insights: InsightService; agents: AgentService; workspace: WorkspaceService }
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
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024, // text edits can be up to ~1 MB of content plus JSON escaping
    // Accept a caller's x-request-id only if it is a short, harmless token; it is echoed back and forwarded to internal services.
    genReqId: (req) => { const h = req.headers['x-request-id']; return typeof h === 'string' && /^[\w.-]{1,64}$/.test(h) ? h : randomUUID(); },
    // Query strings can carry OAuth codes; never write them to logs.
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info', serializers: { req: (r) => ({ method: r.method, url: r.url?.split('?')[0], hostname: r.hostname }) } },
  });
  app.decorate('db', db);
  app.decorate('embedder', createEmbedder());
  attachRealtime(app);
  registerOps(app);
  attachStt(app);
  app.decorate('insights', new InsightService(app));
  app.addHook('onClose', async () => app.insights.stop());
  app.decorate('workspace', new WorkspaceService(app));
  app.addHook('onClose', async () => app.workspace.stop());
  app.register(multipart, { throwFileSizeLimit: false, limits: { fileSize: Number(process.env.WORKSPACE_MAX_UPLOAD_MB ?? 50) * 1024 * 1024, files: 50 } });
  app.decorate('agents', new AgentService(app));
  app.addHook('onClose', async () => app.agents.stop());

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'invalid_request', message: err.issues.map((i) => i.message).join('; ') } });
    }
    // Framework client errors (malformed JSON, body too large, unsupported media type…) keep their 4xx status.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: String((err as { code?: string }).code ?? 'bad_request').toLowerCase().replace(/^fst_err_/, ''), message: status === 413 ? 'request body is too large' : 'the request could not be processed' } });
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
  app.register(insightRoutes, { prefix: '/api' });
  app.register(taskRoutes, { prefix: '/api' });
  app.register(executionRoutes, { prefix: '/api' });
  app.register(workspaceRoutes, { prefix: '/api' });
  app.register(integrationRoutes, { prefix: '/api' });
  return app;
}
