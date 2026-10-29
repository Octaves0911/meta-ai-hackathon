import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Events, TaskStatus, UpdateTaskBody, type Task } from '@meetpilot/shared';
import { requireUser } from '../app.js';
import { HttpError } from '../errors.js';
import { TASK_SELECT, toTask } from '../insights/tasksFormat.js';
import { participation } from '../services/access.js';

const ListQuery = z.object({
  status: TaskStatus.optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(15),
});

export async function taskRoutes(app: FastifyInstance) {
  // Newest first, 15 per page by default, with per-status counts for the filter chips (F7.3).
  app.get<{ Params: { id: string } }>('/meetings/:id/tasks', async (req): Promise<{ tasks: Task[]; counts: Record<string, number> }> => {
    const me = await requireUser(app, req);
    const q = ListQuery.parse(req.query);
    const m = await participation(app, req.params.id, me);
    const [list, counts] = await Promise.all([
      app.db.query(
        `${TASK_SELECT} where t.meeting_id = $1 and ($2::text is null or t.status = $2) and ($3::timestamptz is null or t.created_at < $3)
         order by t.created_at desc, t.id limit $4`, [m.id, q.status ?? null, q.before ?? null, q.limit]),
      app.db.query('select status, count(*)::int n from tasks where meeting_id = $1 group by status', [m.id]),
    ]);
    const c: Record<string, number> = { open: 0, in_progress: 0, review: 0, done: 0, total: 0 };
    for (const r of counts.rows) { c[r.status] = r.n; c.total += r.n; }
    return { tasks: list.rows.map(toTask), counts: c };
  });

  // Edits are limited to the meeting owner, the assignee and whoever assigned the task; every change is logged.
  app.patch<{ Params: { id: string } }>('/tasks/:id', async (req) => {
    const me = await requireUser(app, req);
    const body = UpdateTaskBody.parse(req.body);
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(404, 'not_found', 'task not found');
    const { rows } = await app.db.query(
      `select t.*, m.owner_id from tasks t join meetings m on m.id = t.meeting_id
       join meeting_participants p on p.meeting_id = t.meeting_id and p.user_id = $2 where t.id = $1`, [req.params.id, me.id]);
    const t = rows[0];
    if (!t) throw new HttpError(404, 'not_found', 'task not found');
    if (![t.owner_id, t.assigned_to, t.assigned_by].includes(me.id)) throw new HttpError(403, 'forbidden', 'not allowed to edit this task');
    if (body.assignedTo) {
      const { rowCount } = await app.db.query(
        `select 1 from users u where u.id = $2 and (exists (select 1 from project_members pm where pm.project_id = $1 and pm.user_id = u.id)
           or exists (select 1 from meeting_participants p where p.meeting_id = $3 and p.user_id = u.id))`, [t.project_id, body.assignedTo, t.meeting_id]);
      if (!rowCount) throw new HttpError(400, 'invalid_request', 'assignee is not part of this project or meeting');
    }
    const cols: Record<string, [string, unknown, unknown]> = {
      title: ['title', body.title, t.title], description: ['description', body.description, t.description],
      assignedTo: ['assigned_to', body.assignedTo, t.assigned_to], dueDate: ['due_date', body.dueDate, t.due_date?.toISOString?.().slice(0, 10) ?? t.due_date],
      status: ['status', body.status, t.status],
    };
    const c = await app.db.connect();
    try {
      await c.query('begin');
      for (const [, [col, next, prev]] of Object.entries(cols)) {
        if (next === undefined || String(next ?? '') === String(prev ?? '')) continue;
        await c.query(`update tasks set ${col} = $2 where id = $1`, [t.id, next]);
        await c.query('insert into task_history(task_id, field, old, new) values ($1,$2,$3,$4)', [t.id, col, prev == null ? null : String(prev), next == null ? null : String(next)]);
      }
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
    const { rows: out } = await app.db.query(`${TASK_SELECT} where t.id = $1`, [t.id]);
    const task = toTask(out[0]);
    app.io.to(`meeting:${t.meeting_id}`).emit(Events.taskUpserted, task);
    return task;
  });
}
