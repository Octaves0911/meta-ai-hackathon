import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EmailDraftBody, MAX_REVISIONS, ReviewBody, type ExecutionDetail, type ExecutionSummary } from '@meetpilot/shared';
import { requireUser, type AuthUser } from '../app.js';
import { HttpError } from '../errors.js';
import { TASK_SELECT, toTask } from '../insights/tasksFormat.js';

const SUMMARY_SELECT = `select e.*, t.title as task_title, t.meeting_id, m.title as meeting_title, to_char(t.due_date,'YYYY-MM-DD') as due,
    t.assigned_to, ua.username as assignee_name, e.reviewer_id, ur.username as reviewer_name
  from executions e join tasks t on t.id = e.task_id join meetings m on m.id = t.meeting_id
  left join users ua on ua.id = t.assigned_to left join users ur on ur.id = e.reviewer_id`;

const toSummary = (r: any): ExecutionSummary => ({
  id: r.id, taskId: r.task_id, taskTitle: r.task_title, meetingId: r.meeting_id, meetingTitle: r.meeting_title,
  agent: r.agent, status: r.status, revision: r.revision, summary: r.summary, error: r.error, routeReason: r.route_reason,
  reviewer: r.reviewer_id ? { id: r.reviewer_id, username: r.reviewer_name } : null,
  assignee: r.assigned_to ? { id: r.assigned_to, username: r.assignee_name } : null, dueDate: r.due, updatedAt: r.updated_at,
});

export async function executionRoutes(app: FastifyInstance) {
  const uuid = (id: string) => { if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'not_found', 'not found'); };

  /** Visible to the reviewer, the task assignee and the meeting owner. */
  async function load(id: string, me: AuthUser) {
    uuid(id);
    const { rows } = await app.db.query(`${SUMMARY_SELECT} where e.id = $1 and ($2 in (e.reviewer_id, t.assigned_to, m.owner_id))`, [id, me.id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'review not found');
    return rows[0];
  }
  const emitUpdate = (r: any, status: string) => r.reviewer_id && app.emitToUser(r.reviewer_id, 'execution:update', { id: r.id, status });

  app.get<{ Querystring: { scope?: string } }>('/reviews', async (req) => {
    const me = await requireUser(app, req);
    const needs = req.query.scope === 'needs_review';
    const { rows } = await app.db.query(
      `${SUMMARY_SELECT} where e.reviewer_id = $1 and ($2::boolean is false or e.status = 'awaiting_review')
       order by (e.status = 'awaiting_review') desc, e.updated_at desc limit 200`, [me.id, needs]);
    return rows.map(toSummary);
  });

  app.get<{ Params: { id: string } }>('/executions/:id', async (req): Promise<ExecutionDetail> => {
    const me = await requireUser(app, req);
    const e = await load(req.params.id, me);
    const [task, arts, cons, revs] = await Promise.all([
      app.db.query(`${TASK_SELECT} where t.id = $1`, [e.task_id]),
      app.db.query('select id, type, title, uri, payload, revision from execution_artifacts where execution_id = $1 and revision = $2 order by type, title', [e.id, e.revision]),
      app.db.query('select id, from_agent, to_agent, question, answer, depth from agent_consultations where execution_id = $1 order by created_at', [e.id]),
      app.db.query(`select r.revision, r.verdict, r.comment, r.line_comments, r.created_at, u.username from execution_reviews r left join users u on u.id = r.reviewer_id
                    where r.execution_id = $1 order by r.created_at`, [e.id]),
    ]);
    return {
      ...toSummary(e), task: toTask(task.rows[0]), notes: e.notes,
      artifacts: arts.rows, canReview: e.reviewer_id === me.id && e.status === 'awaiting_review',
      consultations: cons.rows.map((c) => ({ id: c.id, fromAgent: c.from_agent, toAgent: c.to_agent, question: c.question, answer: c.answer, depth: c.depth })),
      reviews: revs.rows.map((r) => ({ revision: r.revision, verdict: r.verdict, comment: r.comment, lineComments: r.line_comments, reviewer: r.username, createdAt: r.created_at })),
    };
  });

  // Approve completes the task; Request changes sends feedback to the agent for another pass, up to 3 times (F8.6).
  app.post<{ Params: { id: string } }>('/executions/:id/review', async (req, reply) => {
    const me = await requireUser(app, req);
    const body = ReviewBody.parse(req.body);
    const e = await load(req.params.id, me);
    if (e.reviewer_id !== me.id) throw new HttpError(403, 'forbidden', 'only the reviewer can review this work');
    if (e.status !== 'awaiting_review') throw new HttpError(409, 'not_reviewable', 'this work is not waiting for review');
    if (body.verdict === 'changes') {
      if (!body.comment && !body.lineComments?.length) throw new HttpError(400, 'invalid_request', 'add a comment or at least one line comment');
      if (e.revision >= MAX_REVISIONS) throw new HttpError(409, 'max_revisions', `at most ${MAX_REVISIONS} revisions are allowed`);
    }
    const c = await app.db.connect();
    try {
      await c.query('begin');
      await c.query('insert into execution_reviews(execution_id, revision, reviewer_id, verdict, comment, line_comments) values ($1,$2,$3,$4,$5,$6)',
        [e.id, e.revision, me.id, body.verdict, body.comment ?? null, body.lineComments ? JSON.stringify(body.lineComments) : null]);
      if (body.verdict === 'approve') {
        await c.query("update executions set status = 'approved', updated_at = now() where id = $1", [e.id]);
        await c.query("update tasks set status = 'done' where id = $1", [e.task_id]);
      } else {
        await c.query("update executions set status = 'changes_requested', revision = revision + 1, updated_at = now() where id = $1", [e.id]);
      }
      await c.query('commit');
    } catch (err) {
      await c.query('rollback');
      throw err;
    } finally {
      c.release();
    }
    if (body.verdict === 'changes') await app.agents.retry(e.id);
    emitUpdate(e, body.verdict === 'approve' ? 'approved' : 'changes_requested');
    return reply.status(204).send();
  });

  // Email drafts stay editable until approved; after that the text is fixed (F8.5, §7.4).
  app.put<{ Params: { id: string; aid: string } }>('/executions/:id/artifacts/:aid', async (req) => {
    const me = await requireUser(app, req);
    const body = EmailDraftBody.parse(req.body);
    const e = await load(req.params.id, me);
    uuid(req.params.aid);
    if (e.reviewer_id !== me.id) throw new HttpError(403, 'forbidden', 'only the reviewer can edit the draft');
    if (e.status !== 'awaiting_review') throw new HttpError(409, 'not_editable', 'the draft can no longer be edited');
    const { rows } = await app.db.query(
      `update execution_artifacts set payload = coalesce(payload, '{}'::jsonb) || $3::jsonb
       where id = $1 and execution_id = $2 and type = 'email_draft' and revision = $4 returning id, type, title, uri, payload, revision`,
      [req.params.aid, e.id, JSON.stringify({ ...body, missing_recipients: body.to.length === 0 }), e.revision]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'draft not found');
    return rows[0];
  });

  app.post<{ Params: { id: string } }>('/executions/:id/retry', async (req, reply) => {
    const me = await requireUser(app, req);
    const e = await load(req.params.id, me);
    if (e.status !== 'failed') throw new HttpError(409, 'not_failed', 'only failed runs can be retried');
    await app.db.query("update executions set status = 'routed', error = null, updated_at = now() where id = $1", [e.id]);
    await app.agents.retry(e.id);
    emitUpdate(e, 'routed');
    return reply.status(204).send();
  });
}
