import type { FastifyInstance } from 'fastify';
import { Events } from '@meetpilot/shared';
import { createNotification } from '../services/notifications.js';
import { enqueue, JobRunner } from '../services/jobs.js';
import { buildBrief } from './brief.js';
import { MAX_FILES_PER_RUN, prepareFile } from './files.js';
import { routeTask } from './router.js';

const aiUrl = () => process.env.AI_URL ?? 'http://localhost:5001';
const selfUrl = () => `http://localhost:${process.env.BACKEND_PORT ?? 4000}`;
const headers = () => ({ 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' });
/** Daily spend cap per project in USD (docs/09 §1.6). 0 disables it. */
export const dailyCapUsd = () => Number(process.env.AGENT_DAILY_CAP_USD ?? 5);

export interface StepIn { seq: number; kind: string; label: string; detail?: Record<string, unknown>; status: string; started_at?: string; ended_at?: string | null }

/** Routes finalized tasks to specialist agents, runs them in the background, and hands results to a human reviewer. */
export class AgentService {
  readonly jobs: JobRunner;

  constructor(private app: FastifyInstance) {
    this.jobs = new JobRunner(app.db, { 'agent.run': (p) => this.run(p.executionId) }, app.log,
      (kind, payload, error) => { app.metrics.inc('meetpilot_job_failures_total', 'Jobs that exhausted their retries', { kind }); return this.fail(payload.executionId, error); });
  }
  private get db() { return this.app.db; }

  start() { this.jobs.start(); }
  stop() { this.jobs.stop(); }

  /** Ask the AI service's model router; throws when it is unavailable so the caller falls back to the rules. */
  private async askRouter(t: { title: string; description: string | null; quote: string | null; meeting_title: string }) {
    const res = await fetch(`${aiUrl()}/route`, {
      method: 'POST', headers: headers(), signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({ task: { title: t.title, description: t.description }, quote: t.quote, meeting: { title: t.meeting_title } }),
    });
    if (!res.ok) throw new Error(`router responded ${res.status}`);
    return (await res.json()) as any;
  }

  /** One execution per task, ever (unique task_id). Human-only, unsure and unmatched tasks are recorded, not run (F8.1). */
  async routeMeeting(meetingId: string) {
    const { rows: tasks } = await this.db.query(
      `select t.id, t.title, t.description, t.assigned_to, m.owner_id, m.title as meeting_title, ev.quote
       from tasks t join meetings m on m.id = t.meeting_id left join knowledge_events ev on ev.id = t.event_id
       where t.meeting_id = $1 and t.finalized and not exists (select 1 from executions e where e.task_id = t.id)`, [meetingId]);
    for (const t of tasks) {
      const plan = await routeTask(t, () => this.askRouter(t));
      await this.db.query('update tasks set category = $2 where id = $1', [t.id, plan.category]);
      const reviewer = t.assigned_to ?? t.owner_id; // no assignee => the meeting owner reviews (PRD §8)
      const { rows } = await this.db.query(
        `insert into executions(task_id, agent, status, reviewer_id, route_reason, route_confidence, stage_plan) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (task_id) do nothing returning id`,
        [t.id, plan.agent, plan.agent ? 'routed' : 'skipped_human', reviewer, plan.reason, plan.confidence, plan.stagePlan ? JSON.stringify(plan.stagePlan) : null]);
      if (rows[0]) this.app.analytics.track('execution_routed', { category: plan.category, agent: plan.agent ?? 'none' }, { meetingId });
      if (rows[0] && plan.agent) await enqueue(this.db, 'agent.run', { executionId: rows[0].id });
    }
  }

  /** The reviewer overrides a "left for a human" routing and runs a specialist anyway (docs/09 §1.3). */
  async runWith(executionId: string, agent: string) {
    const { rowCount } = await this.db.query(
      `update executions set agent = $2, status = 'routed', route_reason = $3, updated_at = now() where id = $1 and status = 'skipped_human'`,
      [executionId, agent, `Run manually with the ${agent} agent`]);
    if (!rowCount) return false;
    await enqueue(this.db, 'agent.run', { executionId });
    await this.notifyUpdate(executionId);
    return true;
  }

  /** Progress steps arrive live from the AI service and again in its final response; both write the same (execution, revision, seq). */
  async recordStep(executionId: string, revision: number, s: StepIn) {
    const { rows } = await this.db.query(
      `insert into execution_steps(execution_id, revision, seq, kind, label, detail, status, started_at, ended_at)
       values ($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz, now()),$9)
       on conflict (execution_id, revision, seq) do update set kind = excluded.kind, label = excluded.label, detail = excluded.detail, status = excluded.status, ended_at = excluded.ended_at
       returning (select reviewer_id from executions where id = $1) as reviewer_id`,
      [executionId, revision, s.seq, s.kind, String(s.label).slice(0, 200), JSON.stringify(s.detail ?? {}), s.status, s.started_at ?? null, s.ended_at ?? null]);
    if (rows[0]?.reviewer_id) this.app.emitToUser(rows[0].reviewer_id, 'execution:step', { id: executionId, revision, seq: s.seq, kind: s.kind, label: s.label, status: s.status });
  }

  private async spentToday(projectId: string): Promise<number> {
    const { rows } = await this.db.query(
      `select coalesce(sum((e.usage->>'cost_usd')::numeric), 0)::float as usd from executions e join tasks t on t.id = e.task_id
       where t.project_id = $1 and e.updated_at >= date_trunc('day', now())`, [projectId]);
    return rows[0].usd;
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
    const t0 = performance.now();
    await this.db.query("update executions set status = 'running', error = null, updated_at = now() where id = $1", [e.id]);
    await this.notifyUpdate(e.id);

    const cap = dailyCapUsd();
    if (cap > 0 && (await this.spentToday(e.project_id)) >= cap) {
      await this.fail(e.id, `Daily agent spend cap of $${cap.toFixed(2)} reached for this project. Retry tomorrow or raise AGENT_DAILY_CAP_USD.`);
      return;
    }

    // The brief: the task, what was said around it, current decisions, sibling tasks, earlier approved work and project memory.
    const brief = await buildBrief(this.db, this.app.embedder, e);

    let feedback: object | undefined;
    if (e.revision > 0) {
      const { rows: r } = await this.db.query(
        "select comment, line_comments from execution_reviews where execution_id = $1 and verdict = 'changes' order by created_at desc limit 1", [e.id]);
      feedback = { comment: r[0]?.comment ?? null, line_comments: r[0]?.line_comments ?? [], previous_summary: e.summary };
    }

    await this.db.query('delete from execution_steps where execution_id = $1 and revision = $2', [e.id, e.revision]); // a retry starts a fresh trace
    const res = await fetch(`${aiUrl()}/agents/${e.agent}/run`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ ...brief, feedback, revision: e.revision, execution_id: e.id, callback_url: selfUrl() }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`agent service responded ${res.status}`);
    const out = (await res.json()) as { summary: string; notes: string; artifacts: any[]; consultations: any[]; confidence?: number | null; open_questions?: string[]; usage?: object; steps?: StepIn[] };
    for (const st of out.steps ?? []) await this.recordStep(e.id, e.revision, st).catch(() => undefined);

    const c = await this.db.connect();
    try {
      await c.query('begin');
      let files = 0;
      for (const a of out.artifacts) {
        const { file_b64: _drop, ...rest } = (a.payload ?? {}) as Record<string, any>;
        let prepared: ReturnType<typeof prepareFile> | null = null;
        if (a.payload?.file_b64) {
          try { if (files >= MAX_FILES_PER_RUN) throw new Error('too many files'); prepared = prepareFile(a.payload); files++; }
          catch (err) { this.app.log.warn({ err: (err as Error).message, title: a.title }, 'agent file rejected'); continue; } // the rest of the work is still delivered
        }
        const { rows: ins } = await c.query('insert into execution_artifacts(execution_id, revision, type, title, payload) values ($1,$2,$3,$4,$5) returning id',
          [e.id, e.revision, a.type, a.title, a.content != null ? { content: a.content } : (prepared ? { ...rest, filename: prepared.filename, mime: prepared.mime, size: prepared.size, sha256: prepared.sha256, attachable: false } : a.payload)]);
        if (prepared) {
          await c.query('insert into execution_files(artifact_id, filename, mime, size, sha256, data) values ($1,$2,$3,$4,$5,$6)', [ins[0].id, prepared.filename, prepared.mime, prepared.size, prepared.sha256, prepared.data]);
          await c.query("update execution_artifacts set payload = payload || $2::jsonb where id = $1", [ins[0].id, JSON.stringify({ url: `/artifacts/${ins[0].id}/file` })]);
        }
      }
      // The collaboration log shows what this revision's work was built on, not an accumulation of earlier passes.
      await c.query('delete from agent_consultations where execution_id = $1', [e.id]);
      for (const k of out.consultations) {
        await c.query('insert into agent_consultations(execution_id, from_agent, to_agent, question, answer, depth) values ($1,$2,$3,$4,$5,$6)',
          [e.id, k.from_agent, k.to_agent, k.question, k.answer, Math.min(Math.max(k.depth, 1), 2)]);
      }
      await c.query(
        `update executions set status = 'awaiting_review', summary = $2, notes = $3, confidence = $4, open_questions = $5, usage = $6, updated_at = now() where id = $1`,
        [e.id, out.summary, out.notes || null, out.confidence ?? null, JSON.stringify((out.open_questions ?? []).slice(0, 8)), out.usage ? JSON.stringify(out.usage) : null]);
      await c.query('commit');
    } catch (err) {
      await c.query('rollback');
      throw err;
    } finally {
      c.release();
    }
    this.app.metrics.observe('meetpilot_agent_run_seconds', 'Agent run duration', (performance.now() - t0) / 1000, { agent: e.agent }, [1, 5, 15, 30, 60, 120, 180]);
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
