import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AiAssistBody, FeedbackBody, Events } from '@meetpilot/shared';
import { requireUser } from '../app.js';
import { HttpError } from '../errors.js';
import { toInsight } from '../insights/format.js';
import { canReadConversation, participation } from '../services/access.js';

const ListQuery = z.object({
  tier: z.enum(['feed', 'interrupt']).optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function insightRoutes(app: FastifyInstance) {
  // AI Assistance is one shared switch per meeting; any participant in the call can flip it (F5.1).
  app.put<{ Params: { id: string } }>('/meetings/:id/ai-assist', async (req, reply) => {
    const me = await requireUser(app, req);
    const { enabled } = AiAssistBody.parse(req.body);
    const m = await participation(app, req.params.id, me);
    if (m.status !== 'active' || !m.last_session_started_at) throw new HttpError(409, 'not_in_call', 'join the active meeting first');
    await app.db.query('update meetings set ai_assist = $2 where id = $1', [m.id, enabled]);
    app.io.to(`meeting:${m.id}`).emit(Events.aiAssist, { enabled });
    if (enabled) app.insights.brief(m.id).catch((e) => app.log.error(e, 'brief failed'));
    return reply.status(204).send();
  });

  // AI Notes: newest first, audience-filtered in SQL so private insights only reach their owner (F5.13).
  app.get<{ Params: { id: string } }>('/meetings/:id/insights', async (req) => {
    const me = await requireUser(app, req);
    const q = ListQuery.parse(req.query);
    const m = await participation(app, req.params.id, me);
    if (!canReadConversation(m, me)) throw new HttpError(403, 'forbidden', 'AI notes are not shared for this meeting');
    const { rows } = await app.db.query(
      `select * from insights
       where meeting_id = $1 and (audience_user_id is null or audience_user_id = $2)
         and ($3::text is null or tier = $3) and ($4::timestamptz is null or created_at < $4)
       order by created_at desc limit $5`,
      [m.id, me.id, q.tier ?? null, q.before ?? null, q.limit]);
    return rows.map(toInsight);
  });

  app.post<{ Params: { id: string } }>('/insights/:id/feedback', async (req, reply) => {
    const me = await requireUser(app, req);
    const { value } = FeedbackBody.parse(req.body);
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(404, 'not_found', 'insight not found');
    const { rows } = await app.db.query(
      `select i.* from insights i
       join meeting_participants p on p.meeting_id = i.meeting_id and p.user_id = $2
       where i.id = $1 and (i.audience_user_id is null or i.audience_user_id = $2)`, [req.params.id, me.id]);
    const i = rows[0];
    if (!i) throw new HttpError(404, 'not_found', 'insight not found');
    if (['brief', 'answer', 'recap'].includes(i.kind)) throw new HttpError(400, 'invalid_request', 'no feedback on this kind of card');
    await app.db.query('update insights set feedback = $2 where id = $1', [i.id, value]);
    app.insights.feedback(i.meeting_id, i.kind, i.topic_key, value);
    return reply.status(204).send();
  });
}
