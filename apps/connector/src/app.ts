import Fastify from 'fastify';
import type pg from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Health } from '@meetpilot/shared';
import { Connector, ConnectorError } from './service.js';

const Services = z.array(z.enum(['gmail', 'drive'])).min(1).max(2);
const uuid = z.string().uuid();

export function buildApp(db: pg.Pool, connector = new Connector(db)) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  // Every route except /health needs the shared secret; this service fails closed without one (docs/06).
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const given = String(req.headers['x-internal-secret'] ?? ''), want = process.env.INTERNAL_SECRET ?? '';
    if (!want || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want))) return reply.status(401).send({ error: { code: 'unauthorized', message: 'invalid internal secret' } });
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ConnectorError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'invalid_request', message: err.issues.map((i) => i.message).join('; ') } });
    app.log.error({ msg: (err as Error).message }, 'request failed'); // never log tokens or request bodies
    return reply.status(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  app.get('/health', async (): Promise<Health> => ({ service: 'connector', status: 'ok' }));

  app.post('/oauth/start', async (req) => connector.start(z.object({ projectId: uuid, userId: uuid, services: Services, visibility: z.enum(['private', 'project']).default('private'), sendAccess: z.boolean().optional(), returnTo: z.string().max(200).optional() }).parse(req.body)));
  app.post('/oauth/complete', async (req) => { const b = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(req.body); return connector.complete(b.code, b.state); });
  app.get('/gmail/send-access', async (req) => { const q = z.object({ projectId: uuid, userId: uuid }).parse(req.query); return connector.sendAccess(q.projectId, q.userId); });
  app.post('/gmail/send', async (req) => connector.sendMail(z.object({
    projectId: uuid, userId: uuid, to: z.array(z.string().max(320)).max(10), cc: z.array(z.string().max(320)).max(10).optional(),
    subject: z.string().max(1000), body: z.string().max(200_000), threadId: z.string().max(200).nullish(), inReplyTo: z.string().max(500).nullish(), references: z.string().max(2000).nullish(),
  }).parse(req.body)));
  app.get('/connections', async (req) => { const q = z.object({ projectId: uuid, userId: uuid }).parse(req.query); return connector.list(q.projectId, q.userId); });
  app.put<{ Params: { id: string } }>('/connections/:id', async (req, reply) => {
    const b = z.object({
      userId: uuid, visibility: z.enum(['private', 'project']).optional(), confirmShare: z.boolean().optional(),
      labels: z.array(z.string().max(200)).max(50).optional(), lookbackDays: z.number().optional(),
      folderIds: z.array(z.string().max(200)).max(50).optional(), includeSubfolders: z.boolean().optional(),
    }).parse(req.body);
    const { userId, ...patch } = b;
    await connector.update(uuid.parse(req.params.id), userId, patch);
    return reply.status(204).send();
  });
  app.post<{ Params: { id: string } }>('/connections/:id/sync', async (req, reply) => {
    const { userId } = z.object({ userId: uuid }).parse(req.body);
    await connector.sync(uuid.parse(req.params.id), userId);
    return reply.status(204).send();
  });
  app.get<{ Params: { id: string } }>('/connections/:id/gmail/labels', async (req) => connector.gmailLabels(uuid.parse(req.params.id), z.object({ userId: uuid }).parse(req.query).userId));
  app.get<{ Params: { id: string } }>('/connections/:id/drive/folders', async (req) => {
    const q = z.object({ userId: uuid, parent: z.string().max(200).optional() }).parse(req.query);
    return connector.driveFolders(uuid.parse(req.params.id), q.userId, q.parent ?? 'root');
  });
  app.delete<{ Params: { id: string } }>('/connections/:id', async (req, reply) => {
    await connector.disconnect(uuid.parse(req.params.id), z.object({ userId: uuid }).parse(req.query).userId);
    return reply.status(204).send();
  });
  app.post<{ Params: { id: string } }>('/projects/:id/purge', async (req, reply) => { await connector.purgeProject(uuid.parse(req.params.id)); return reply.status(204).send(); });
  app.post<{ Params: { id: string } }>('/users/:id/purge', async (req, reply) => { await connector.purgeUser(uuid.parse(req.params.id)); return reply.status(204).send(); });

  app.addHook('onClose', async () => connector.stop());
  return { app, connector };
}
