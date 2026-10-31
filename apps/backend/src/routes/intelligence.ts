import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectIntelligence } from '@meetpilot/shared';
import { requireUser } from '../app.js';
import { HttpError } from '../errors.js';
import { computeIntelligence } from '../analytics/compute.js';
import { todayInTz } from '../services/due.js';

const Query = z.object({ weeks: z.coerce.number().int().min(4).max(26).default(12) });

export async function intelligenceRoutes(app: FastifyInstance) {
  // Project-wide analytics. Scoped to meetings the caller took part in, and never includes private (audience-bound) insights.
  app.get<{ Params: { id: string } }>('/projects/:id/intelligence', async (req): Promise<ProjectIntelligence> => {
    const me = await requireUser(app, req);
    const { weeks } = Query.parse(req.query);
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(404, 'not_found', 'project not found');
    const member = await app.db.query('select 1 from project_members where project_id = $1 and user_id = $2', [req.params.id, me.id]);
    if (!member.rowCount) throw new HttpError(404, 'not_found', 'project not found');

    const meetings = (await app.db.query(
      `select m.id, m.title, m.created_at, m.ended_at from meetings m
       join meeting_participants p on p.meeting_id = m.id and p.user_id = $2 where m.project_id = $1 order by m.created_at`, [req.params.id, me.id])).rows;
    const ids = meetings.map((m) => m.id);
    const [tasks, events, decisions, conflicts] = await Promise.all([
      app.db.query(
        `select t.id, t.meeting_id, t.title, u.username as assignee, to_char(t.due_date, 'YYYY-MM-DD') as due, t.priority, t.category, t.status, t.created_at, t.event_id,
                (select max(changed_at) from task_history h where h.task_id = t.id and h.field = 'status' and h.new = 'done') as completed_at,
                (select max(changed_at) from task_history h where h.task_id = t.id and h.field = 'status') as last_status_at,
                (select count(*)::int from task_history h where h.task_id = t.id and h.field = 'due_date' and h.old is not null) as reschedules
         from tasks t left join users u on u.id = t.assigned_to where t.project_id = $1 and t.finalized and t.meeting_id = any($2)`, [req.params.id, ids]),
      app.db.query('select id, meeting_id, type, entity_key, summary, who, due_at, created_at from knowledge_events where project_id = $1 and meeting_id = any($2)', [req.params.id, ids]),
      app.db.query(
        `select d.id, d.entity_key, d.value, d.meeting_id, d.created_at, e.who from decisions d left join knowledge_events e on e.id = d.event_id
         where d.project_id = $1 and (d.meeting_id is null or d.meeting_id = any($2))`, [req.params.id, ids]),
      app.db.query(
        `select id, meeting_id, title, body, source_label, created_at from insights
         where project_id = $1 and kind = 'conflict' and audience_user_id is null and meeting_id = any($2)`, [req.params.id, ids]),
    ]);
    return computeIntelligence({ today: todayInTz(), weeks, meetings, tasks: tasks.rows, events: events.rows, decisions: decisions.rows, conflicts: conflicts.rows });
  });
}
