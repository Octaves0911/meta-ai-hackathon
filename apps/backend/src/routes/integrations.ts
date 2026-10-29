import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../app.js';
import { HttpError } from '../errors.js';
import { connector } from '../services/connector.js';

const Start = z.object({ services: z.array(z.enum(['gmail', 'drive'])).min(1).max(2), visibility: z.enum(['private', 'project']).default('private') });
const Update = z.object({
  visibility: z.enum(['private', 'project']).optional(), confirmShare: z.boolean().optional(),
  labels: z.array(z.string().max(200)).max(50).optional(), lookbackDays: z.number().int().min(7).max(365).optional(),
  folderIds: z.array(z.string().max(200)).max(50).optional(), includeSubfolders: z.boolean().optional(),
});

// Absolute, so the browser lands on the web app even if Google was configured to call the backend directly.
const web = (path: string) => `${process.env.WEB_URL ?? 'http://localhost:5173'}${path}`;

export async function integrationRoutes(app: FastifyInstance) {
  async function member(projectId: string, userId: string) {
    if (!z.string().uuid().safeParse(projectId).success) throw new HttpError(404, 'not_found', 'project not found');
    const { rows } = await app.db.query('select 1 from project_members where project_id = $1 and user_id = $2', [projectId, userId]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'project not found');
  }

  app.get<{ Params: { id: string } }>('/projects/:id/connections', async (req) => {
    const me = await requireUser(app, req);
    await member(req.params.id, me.id);
    return connector(`/connections?projectId=${req.params.id}&userId=${me.id}`);
  });

  // Connecting is private by default; sharing is a separate, confirmed step (F9.3).
  app.post<{ Params: { id: string } }>('/projects/:id/connections/google/start', async (req) => {
    const me = await requireUser(app, req);
    const b = Start.parse(req.body);
    await member(req.params.id, me.id);
    return connector('/oauth/start', { method: 'POST', json: { projectId: req.params.id, userId: me.id, ...b } });
  });

  // Google redirects the browser here. The signed state (not a session) says who is connecting.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/connections/google/callback', async (req, reply) => {
    const { code, state, error } = req.query;
    if (error || !code || !state) return reply.redirect(web('/dashboard/integrations?error=cancelled'));
    try {
      await connector('/oauth/complete', { method: 'POST', json: { code, state } });
      return reply.redirect(web('/dashboard/integrations?connected=1'));
    } catch (e) {
      return reply.redirect(web(`/dashboard/integrations?error=${encodeURIComponent(e instanceof HttpError ? e.code : 'failed')}`));
    }
  });

  app.put<{ Params: { id: string } }>('/connections/:id', async (req, reply) => {
    const me = await requireUser(app, req);
    await connector(`/connections/${req.params.id}`, { method: 'PUT', json: { userId: me.id, ...Update.parse(req.body) } });
    return reply.status(204).send();
  });
  app.post<{ Params: { id: string } }>('/connections/:id/sync', async (req, reply) => {
    const me = await requireUser(app, req);
    await connector(`/connections/${req.params.id}/sync`, { method: 'POST', json: { userId: me.id } });
    return reply.status(204).send();
  });
  app.get<{ Params: { id: string } }>('/connections/:id/gmail/labels', async (req) => {
    const me = await requireUser(app, req);
    return connector(`/connections/${req.params.id}/gmail/labels?userId=${me.id}`);
  });
  app.get<{ Params: { id: string }; Querystring: { parent?: string } }>('/connections/:id/drive/folders', async (req) => {
    const me = await requireUser(app, req);
    return connector(`/connections/${req.params.id}/drive/folders?userId=${me.id}&parent=${encodeURIComponent(req.query.parent ?? 'root')}`);
  });
  app.delete<{ Params: { id: string } }>('/connections/:id', async (req, reply) => {
    const me = await requireUser(app, req);
    await connector(`/connections/${req.params.id}?userId=${me.id}`, { method: 'DELETE' });
    return reply.status(204).send();
  });
}
