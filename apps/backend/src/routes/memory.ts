import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../app.js';
import { HttpError } from '../errors.js';
import { buildContext } from '../memory/context.js';

const Query = z.object({ q: z.string().trim().min(1).max(500), exclude: z.string().uuid().optional() });

export async function memoryRoutes(app: FastifyInstance) {
  // Semantic search + context package for a project, as seen by the caller (their private sources included).
  app.get<{ Params: { id: string } }>('/projects/:id/memory/search', async (req) => {
    const me = await requireUser(app, req);
    const { q, exclude } = Query.parse(req.query);
    const { rows } = await app.db.query('select 1 from project_members where project_id = $1 and user_id = $2', [req.params.id, me.id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'project not found');
    return buildContext(app.db, app.embedder, { projectId: req.params.id, viewerId: me.id, query: q, excludeMeetingId: exclude });
  });
}
