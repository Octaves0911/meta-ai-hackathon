import type { FastifyInstance } from 'fastify';
import { CreateProjectBody, type Project, type ProjectOverview } from '@meetpilot/shared';
import { requireUser } from '../app.js';
import { HttpError } from '../errors.js';
import { connector } from '../services/connector.js';

const toProject = (r: any): Project => ({
  id: r.id, name: r.name, description: r.description, ownerId: r.owner_id,
  shareWorkspace: r.share_workspace, role: r.role, createdAt: r.created_at,
});

export async function projectRoutes(app: FastifyInstance) {
  app.get('/projects', async (req) => {
    const me = await requireUser(app, req);
    const { rows } = await app.db.query(
      `select p.*, m.role from projects p join project_members m on m.project_id = p.id
       where m.user_id = $1 order by p.created_at desc`,
      [me.id],
    );
    return rows.map(toProject);
  });

  app.post('/projects', async (req, reply) => {
    const me = await requireUser(app, req);
    const body = CreateProjectBody.parse(req.body);
    const client = await app.db.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        'insert into projects(name, description, owner_id, share_workspace) values ($1,$2,$3,$4) returning *',
        [body.name, body.description ?? null, me.id, body.shareWorkspace],
      );
      await client.query("insert into project_members values ($1,$2,'owner')", [rows[0].id, me.id]);
      await client.query('commit');
      return reply.status(201).send(toProject({ ...rows[0], role: 'owner' }));
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  });

  async function memberOf(projectId: string, userId: string) {
    const { rows } = await app.db.query(
      'select role from project_members where project_id = $1 and user_id = $2', [projectId, userId]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'project not found');
    return rows[0].role as 'owner' | 'member';
  }

  app.get<{ Params: { id: string } }>('/projects/:id/overview', async (req): Promise<ProjectOverview> => {
    const me = await requireUser(app, req);
    await memberOf(req.params.id, me.id);
    const q = (sql: string) => app.db.query(sql, [req.params.id]);
    const [totals, status, monthly] = await Promise.all([
      q(`select count(*)::int meetings,
                count(*) filter (where created_at > now() - interval '7 days')::int this_week,
                coalesce(avg(total_duration_sec) filter (where total_duration_sec > 0), 0)::int avg_dur,
                count(*) filter (where status = 'active')::int active_now
         from meetings where project_id = $1`),
      q('select status, count(*)::int n from meetings where project_id = $1 group by status'),
      q(`select to_char(date_trunc('month', g), 'YYYY-MM') as month,
                (select count(*)::int from meetings where project_id = $1
                  and date_trunc('month', created_at) = date_trunc('month', g)) as count
         from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), '1 month') g`),
    ]);
    const t = totals.rows[0];
    const byStatus = { scheduled: 0, active: 0, ended: 0, closed: 0 };
    for (const r of status.rows) byStatus[r.status as keyof typeof byStatus] = r.n;
    return { meetings: t.meetings, thisWeek: t.this_week, avgDurationSec: t.avg_dur, activeNow: t.active_now, byStatus, monthly: monthly.rows };
  });

  app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const me = await requireUser(app, req);
    if ((await memberOf(req.params.id, me.id)) !== 'owner') throw new HttpError(403, 'forbidden', 'owner only');
    // Revoke Google access and delete everything indexed from this project's connections before the project goes (F9.7).
    await connector(`/projects/${req.params.id}/purge`, { method: 'POST' }).catch((e) => app.log.error(e, 'connector purge failed'));
    await app.db.query('delete from projects where id = $1', [req.params.id]);
    return reply.status(204).send();
  });
}
