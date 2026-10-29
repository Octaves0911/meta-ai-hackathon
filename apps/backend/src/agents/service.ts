import type { FastifyInstance } from 'fastify';
import { Events } from '@meetpilot/shared';
import { buildContext } from '../memory/context.js';
import { createNotification } from '../services/notifications.js';
import { enqueue, JobRunner } from '../services/jobs.js';
import { classifyTask } from './classify.js';

const aiUrl = () => process.env.AI_URL ?? 'http://localhost:5001';

/** Routes finalized tasks to specialist agents, runs them in the background, and hands results to a human reviewer. */
export class AgentService {
  readonly jobs: JobRunner;

  constructor(private app: FastifyInstance) {
    this.jobs = new JobRunner(app.db, { 'agent.run': (p) => this.run(p.executionId) }, app.log,
      (kind, payload, error) => this.fail(payload.executionId, error));
  }
  private get db() { return this.app.db; }

  start() { this.jobs.start(); }
  stop() { this.jobs.stop(); }

  /** One execution per task, ever (unique task_id). Human-only and unmatched tasks are recorded, not run (F8.1). */
  async routeMeeting(meetingId: string) {
    const { rows: tasks } = await this.db.query(
      `select t.id, t.title, t.description, t.assigned_to, m.owner_id from tasks t join meetings m on m.id = t.meeting_id
       where t.meeting_id = $1 and t.finalized and not exists (select 1 from executions e where e.task_id = t.id)`, [meetingId]);
    for (const t of tasks) {
      const c = classifyTask(t.title, t.description);
      await this.db.query('update tasks set category = $2 where id = $1', [t.id, c.category]);
      const reviewer = t.assigned_to ?? t.owner_id; // no assignee => the meeting owner reviews (PRD §8)
      const { rows } = await this.db.query(
        `insert into executions(task_id, agent, status, reviewer_id, route_reason) values ($1,$2,$3,$4,$5)
         on conflict (task_id) do nothing returning id`,
        [t.id, c.agent, c.agent ? 'routed' : 'skipped_human', reviewer, c.reason]);
      if (rows[0] && c.agent) await enqueue(this.db, 'agent.run', { executionId: rows[0].id });
    }
  }

  private async notifyUpdate(executionId: string) {
    const { rows } = await this.db.query('select reviewer_id, status from executions where id = $1', [executionId]);
    if (rows[0]?.reviewer_id) this.app.emitToUser(rows[0].reviewer_id, 'execution:update', { id: executionId, status: rows[0].status });
  }

  /** Job handler: run (or re-run with reviewer feedback) one execution. Throwing makes the job retry. */
  async run(executionId: string) {
    const { rows } = await this.db.query(
      `select e.*, t.title, t.description, to_char(t.due_date,'YYYY-MM-DD') as due, t.project_id, t.meeting_id, ua.username as assignee
       from executions e join tasks t on t.id = e.task_id left join users ua on ua.id = t.assigned_to where e.id = $1`, [executionId]);
    const e = rows[0];
    if (!e || !e.agent) return;
    if (!['routed', 'changes_requested', 'running', 'failed'].includes(e.status)) return; // already handled (at-least-once safety)
    await this.db.query("update executions set status = 'running', error = null, updated_at = now() where id = $1", [e.id]);
    await this.notifyUpdate(e.id);

    // Project memory shared with the live assistant (F6.6), seen from the reviewer's perspective.
    const pkg = await buildContext(this.db, this.app.embedder, { projectId: e.project_id, viewerId: e.reviewer_id, query: `${e.title} ${e.description ?? ''}` });
    const hits = Object.values(pkg).flat().slice(0, 12);
    const meetingIds = [...new Set(hits.map((h) => h.meetingId).filter(Boolean))];
    const titles = new Map<string, string>();
    if (meetingIds.length) (await this.db.query('select id, title from meetings where id = any($1::uuid[])', [meetingIds])).rows.forEach((r) => titles.set(r.id, r.title));
    const context = hits.map((h) => ({ label: h.sourceType === 'external' ? `${h.provider ?? 'Source'} · ${h.title ?? ''}` : h.meetingId ? `Meeting “${titles.get(h.meetingId) ?? ''}” (${h.sourceType})` : `Project ${h.sourceType}`, text: h.text }));

    let feedback: object | undefined;
    if (e.revision > 0) {
      const { rows: r } = await this.db.query(
        "select comment, line_comments from execution_reviews where execution_id = $1 and verdict = 'changes' order by created_at desc limit 1", [e.id]);
      feedback = { comment: r[0]?.comment ?? null, line_comments: r[0]?.line_comments ?? [], previous_summary: e.summary };
    }

    const res = await fetch(`${aiUrl()}/agents/${e.agent}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
      body: JSON.stringify({ task: { title: e.title, description: e.description, due_date: e.due, assignee: e.assignee }, context, feedback, revision: e.revision }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`agent service responded ${res.status}`);
    const out = (await res.json()) as { summary: string; notes: string; artifacts: any[]; consultations: any[] };

    const c = await this.db.connect();
    try {
      await c.query('begin');
      for (const a of out.artifacts) {
        await c.query('insert into execution_artifacts(execution_id, revision, type, title, payload) values ($1,$2,$3,$4,$5)',
          [e.id, e.revision, a.type, a.title, a.content != null ? { content: a.content } : a.payload]);
      }
      // The collaboration log shows what this revision's work was built on, not an accumulation of earlier passes.
      await c.query('delete from agent_consultations where execution_id = $1', [e.id]);
      for (const k of out.consultations) {
        await c.query('insert into agent_consultations(execution_id, from_agent, to_agent, question, answer, depth) values ($1,$2,$3,$4,$5,$6)',
          [e.id, k.from_agent, k.to_agent, k.question, k.answer, Math.min(Math.max(k.depth, 1), 2)]);
      }
      await c.query("update executions set status = 'awaiting_review', summary = $2, notes = $3, updated_at = now() where id = $1", [e.id, out.summary, out.notes || null]);
      await c.query('commit');
    } catch (err) {
      await c.query('rollback');
      throw err;
    } finally {
      c.release();
    }
    await createNotification(this.app, e.reviewer_id, 'review_ready', { executionId: e.id, taskTitle: e.title, agent: e.agent, revision: e.revision });
    await this.notifyUpdate(e.id);
  }

  /** After the last retry: surface the error in Reviews instead of dropping the work silently (PRD §8). */
  private async fail(executionId: string, error: string) {
    await this.db.query("update executions set status = 'failed', error = $2, updated_at = now() where id = $1", [executionId, error.slice(0, 500)]);
    await this.notifyUpdate(executionId);
  }

  retry(executionId: string) { return enqueue(this.db, 'agent.run', { executionId }); }
}
