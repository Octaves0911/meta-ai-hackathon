import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { searchMemory } from '../memory/search.js';

const Body = z.object({
  project_id: z.string().uuid(),
  tool: z.enum(['search_project', 'list_decisions', 'list_tasks']),
  args: z.record(z.string(), z.unknown()).default({}),
});
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Lookup tools for the live assistant's function calling (Meta tool calling): the AI service calls these, with the shared secret, while it answers an `@ai` question.
 * They read shared project data only (no private mail or files, no per-user data), so an answer built from them is safe to show the whole meeting.
 */
export async function aiToolRoutes(app: FastifyInstance) {
  app.post('/internal/ai-tools', async (req) => {
    const given = String(req.headers['x-internal-secret'] ?? ''), want = process.env.INTERNAL_SECRET ?? '';
    if (!want || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want))) throw new HttpError(401, 'unauthorized', 'invalid internal secret');
    const { project_id: projectId, tool, args } = Body.parse(req.body);

    if (tool === 'search_project') {
      const query = str(args.query, 300);
      if (!query) return [];
      const hits = await searchMemory(app.db, app.embedder, { projectId, query, k: 6 });
      return hits.slice(0, 6).map((h) => ({ type: h.sourceType, text: h.text.slice(0, 400), score: Math.round(h.score * 100) / 100 }));
    }
    if (tool === 'list_decisions') {
      const topic = str(args.topic, 80).toLowerCase();
      const { rows } = await app.db.query(
        `select d.entity_key, d.value, to_char(d.created_at, 'YYYY-MM-DD') as decided_on,
                (select array_agg(o.value order by o.created_at desc) from decisions o where o.project_id = d.project_id and o.entity_key = d.entity_key and o.superseded_by is not null) as earlier
         from decisions d where d.project_id = $1 and d.superseded_by is null and ($2 = '' or lower(d.entity_key) like '%' || $2 || '%' or lower(d.value) like '%' || $2 || '%')
         order by d.created_at desc limit 15`, [projectId, topic]);
      return rows.map((r) => ({ topic: r.entity_key, current: r.value, decided_on: r.decided_on, earlier_values: (r.earlier ?? []).slice(0, 3) }));
    }
    const status = ['open', 'done', 'all'].includes(str(args.status, 8)) ? str(args.status, 8) : 'open';
    const { rows } = await app.db.query(
      `select t.title, t.status, to_char(t.due_date, 'YYYY-MM-DD') as due, u.username as owner from tasks t left join users u on u.id = t.assigned_to
       where t.project_id = $1 and t.finalized and ($2 = 'all' or ($2 = 'done' and t.status = 'done') or ($2 = 'open' and t.status <> 'done')) order by t.created_at desc limit 20`, [projectId, status]);
    return rows;
  });
}
