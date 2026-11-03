import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ChatBody, EmailDraftBody, MAX_CHAT_MESSAGES, MAX_REVISIONS, RerunBody, ReviewBody, RunWithBody, SendEmailBody, type ExecutionDetail, type ExecutionMessage, type ExecutionSummary, type ExecutionUsage, type ReviewCounts } from '@meetpilot/shared';
import { connector } from '../services/connector.js';
import { requireUser, type AuthUser } from '../app.js';
import { HttpError } from '../errors.js';
import { TASK_SELECT, toTask } from '../insights/tasksFormat.js';

const SUMMARY_SELECT = `select e.*, t.title as task_title, t.meeting_id, m.title as meeting_title, to_char(t.due_date,'YYYY-MM-DD') as due,
    t.assigned_to, t.project_id, t.description as task_description, p.name as project_name, ua.username as assignee_name, e.reviewer_id, ur.username as reviewer_name
  from executions e join tasks t on t.id = e.task_id join meetings m on m.id = t.meeting_id join projects p on p.id = t.project_id
  left join users ua on ua.id = t.assigned_to left join users ur on ur.id = e.reviewer_id`;

const toSummary = (r: any): ExecutionSummary => ({
  id: r.id, taskId: r.task_id, taskTitle: r.task_title, meetingId: r.meeting_id, meetingTitle: r.meeting_title, projectId: r.project_id, projectName: r.project_name,
  agent: r.agent, status: r.status, revision: r.revision, summary: r.summary, error: r.error, routeReason: r.route_reason,
  reviewer: r.reviewer_id ? { id: r.reviewer_id, username: r.reviewer_name } : null,
  assignee: r.assigned_to ? { id: r.assigned_to, username: r.assignee_name } : null, dueDate: r.due, updatedAt: r.updated_at,
  confidence: r.confidence ?? null, routeConfidence: r.route_confidence ?? null, stagePlan: r.stage_plan ?? null,
});

const toUsage = (u: any): ExecutionUsage | null => u ? ({ calls: u.calls ?? 0, promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, costUsd: u.cost_usd ?? 0, models: u.models ?? [] }) : null;

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

  const GROUPS: Record<string, string[]> = {
    needs_review: ['awaiting_review'], working: ['routed', 'running', 'changes_requested'], done: ['approved'],
    human: ['skipped_human'], problem: ['failed', 'rejected'],
  };
  /** The reviewer's inbox. `scope=needs_review` (legacy) or `group` = needs_review|working|done|human|problem; optional project and agent filters. */
  app.get<{ Querystring: { scope?: string; group?: string; project?: string; agent?: string } }>('/reviews', async (req) => {
    const me = await requireUser(app, req);
    const group = req.query.group ?? (req.query.scope === 'needs_review' ? 'needs_review' : '');
    if (group && !GROUPS[group]) throw new HttpError(400, 'invalid_request', 'unknown group');
    if (req.query.project) uuid(req.query.project);
    if (req.query.agent && !['research', 'marketing', 'designer', 'communication', 'code'].includes(req.query.agent)) throw new HttpError(400, 'invalid_request', 'unknown agent');
    const { rows } = await app.db.query(
      `${SUMMARY_SELECT} where e.reviewer_id = $1 and ($2::text[] is null or e.status = any($2))
         and ($3::uuid is null or t.project_id = $3) and ($4::text is null or e.agent = $4)
       order by (e.status = 'awaiting_review') desc, e.updated_at desc limit 200`,
      [me.id, group ? GROUPS[group] : null, req.query.project ?? null, req.query.agent ?? null]);
    return rows.map(toSummary);
  });

  /** Badge numbers for the sidebar. */
  app.get('/reviews/counts', async (req): Promise<ReviewCounts> => {
    const me = await requireUser(app, req);
    const { rows } = await app.db.query(
      `select count(*) filter (where status = 'awaiting_review')::int as needs, count(*) filter (where status in ('routed','running','changes_requested'))::int as working
       from executions where reviewer_id = $1`, [me.id]);
    return { needsReview: rows[0].needs, working: rows[0].working };
  });

  app.get<{ Params: { id: string }; Querystring: { revision?: string } }>('/executions/:id', async (req): Promise<ExecutionDetail> => {
    const me = await requireUser(app, req);
    const e = await load(req.params.id, me);
    // `?revision=n` shows an earlier revision's deliverables (to compare with the current one).
    const rev = req.query.revision !== undefined ? Math.min(Math.max(parseInt(req.query.revision, 10) || 0, 0), e.revision) : e.revision;
    const [task, arts, cons, revs, steps] = await Promise.all([
      app.db.query(`${TASK_SELECT} where t.id = $1`, [e.task_id]),
      app.db.query('select id, type, title, uri, payload, revision from execution_artifacts where execution_id = $1 and revision = $2 order by type, title', [e.id, rev]),
      app.db.query('select id, from_agent, to_agent, question, answer, depth from agent_consultations where execution_id = $1 order by created_at', [e.id]),
      app.db.query(`select r.revision, r.verdict, r.comment, r.line_comments, r.created_at, u.username from execution_reviews r left join users u on u.id = r.reviewer_id
                    where r.execution_id = $1 order by r.created_at`, [e.id]),
      app.db.query('select seq, revision, kind, label, detail, status, started_at, ended_at from execution_steps where execution_id = $1 and revision = $2 order by seq', [e.id, e.revision]),
    ]);
    let send: ExecutionDetail['send'] = null;
    if (e.agent === 'communication') {
      const sent = await app.db.query('select sent_at, recipients from email_sends where execution_id = $1 order by sent_at', [e.id]);
      // Only the reviewer needs the permission state; ask the connector, but never fail the page if it is down.
      const access = e.reviewer_id === me.id ? await connector<{ granted: boolean; account: string | null }>(`/gmail/send-access?projectId=${e.project_id}&userId=${me.id}`).catch(() => null) : null;
      send = {
        granted: access ? access.granted : null, account: access?.account ?? null,
        sent: sent.rows.filter((r) => r.recipients.messageId).map((r) => ({ sentAt: r.sent_at, from: r.recipients.from ?? null, to: r.recipients.to ?? [], cc: r.recipients.cc ?? [], subject: r.recipients.subject ?? '', messageId: r.recipients.messageId ?? null })),
      };
    }
    return {
      ...toSummary(e), send, task: toTask(task.rows[0]), notes: e.notes, openQuestions: Array.isArray(e.open_questions) ? e.open_questions : [], usage: toUsage(e.usage),
      steps: steps.rows.map((r) => ({ seq: r.seq, revision: r.revision, kind: r.kind, label: r.label, detail: r.detail ?? {}, status: r.status, startedAt: r.started_at, endedAt: r.ended_at })),
      artifacts: arts.rows, canReview: e.reviewer_id === me.id && e.status === 'awaiting_review',
      consultations: cons.rows.map((c) => ({ id: c.id, fromAgent: c.from_agent, toAgent: c.to_agent, question: c.question, answer: c.answer, depth: c.depth })),
      reviews: revs.rows.map((r) => ({ revision: r.revision, verdict: r.verdict, comment: r.comment, lineComments: r.line_comments, reviewer: r.username, createdAt: r.created_at })),
    };
  });

  /** Bytes of a generated file for the people who can see the execution. Never executable in our origin: nosniff + sandboxing CSP. */
  app.get<{ Params: { id: string } }>('/artifacts/:id/file', async (req, reply) => {
    const me = await requireUser(app, req);
    uuid(req.params.id);
    const { rows } = await app.db.query(
      `select f.filename, f.mime, f.data, a.execution_id from execution_files f join execution_artifacts a on a.id = f.artifact_id where f.artifact_id = $1`, [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'file not found');
    await load(rows[0].execution_id, me); // same visibility as the review itself: reviewer, assignee or meeting owner
    return reply.header('content-type', rows[0].mime).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=0')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('content-disposition', `inline; filename="${String(rows[0].filename).replace(/["\r\n]/g, '_')}"`).send(rows[0].data);
  });

  /** Reviewer overrides "left for a human": run a specialist anyway. */
  app.post<{ Params: { id: string } }>('/executions/:id/run-with', async (req, reply) => {
    const me = await requireUser(app, req);
    const e = await load(req.params.id, me);
    if (e.reviewer_id !== me.id) throw new HttpError(403, 'forbidden', 'only the reviewer can run an agent on this task');
    const { agent } = RunWithBody.parse(req.body);
    if (!(await app.agents.runWith(e.id, agent))) throw new HttpError(409, 'not_skipped', 'this task was already routed to an agent');
    return reply.status(202).send({ ok: true });
  });

  /** Live progress from the AI service (shared secret, not a user). */
  app.post<{ Params: { id: string } }>('/internal/executions/:id/steps', async (req, reply) => {
    const given = String(req.headers['x-internal-secret'] ?? ''), want = process.env.INTERNAL_SECRET ?? '';
    if (!want || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want))) throw new HttpError(401, 'unauthorized', 'invalid internal secret');
    uuid(req.params.id);
    const b = z.object({
      revision: z.number().int().min(0).max(10), seq: z.number().int().min(0).max(50),
      kind: z.enum(['plan', 'search', 'read', 'consult', 'tool', 'draft', 'check']), label: z.string().max(200),
      detail: z.record(z.string(), z.any()).optional(), status: z.enum(['running', 'done', 'failed']),
      started_at: z.string().max(40).optional(), ended_at: z.string().max(40).nullable().optional(),
    }).parse(req.body);
    const { rows } = await app.db.query('select 1 from executions where id = $1', [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'execution not found');
    await app.agents.recordStep(req.params.id, b.revision, b);
    return reply.status(204).send();
  });

  /** Records a verdict and moves the execution on: approve completes the task, reject hands it back, changes starts a new revision. */
  async function applyReview(e: any, me: AuthUser, body: { verdict: 'approve' | 'changes' | 'reject'; comment?: string; lineComments?: unknown[] }) {
    const c = await app.db.connect();
    try {
      await c.query('begin');
      await c.query('insert into execution_reviews(execution_id, revision, reviewer_id, verdict, comment, line_comments) values ($1,$2,$3,$4,$5,$6)',
        [e.id, e.revision, me.id, body.verdict, body.comment ?? null, body.lineComments ? JSON.stringify(body.lineComments) : null]);
      if (body.verdict === 'approve') {
        await c.query("update executions set status = 'approved', updated_at = now() where id = $1", [e.id]);
        await c.query("update tasks set status = 'done' where id = $1", [e.task_id]);
        // Only approved files can be attached to an email or shared on (docs/09 §1.8).
        await c.query(`update execution_artifacts set payload = payload || '{"attachable": true}'::jsonb where execution_id = $1 and revision = $2 and type in ('pdf', 'file')`, [e.id, e.revision]);
      } else if (body.verdict === 'reject') {
        // Stop here: the task goes back to a human, the reason stays in the review history.
        await c.query("update executions set status = 'rejected', updated_at = now() where id = $1", [e.id]);
        await c.query("update tasks set status = 'open' where id = $1", [e.task_id]);
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
    app.analytics.track('execution_review', { verdict: body.verdict }, { userId: me.id, projectId: e.project_id, meetingId: e.meeting_id });
    if (body.verdict === 'changes') await app.agents.retry(e.id);
    emitUpdate(e, body.verdict === 'approve' ? 'approved' : body.verdict === 'reject' ? 'rejected' : 'changes_requested');
  }

  // Approve completes the task; Request changes sends feedback to the agent for another pass, up to MAX_REVISIONS times (F8.6).
  app.post<{ Params: { id: string } }>('/executions/:id/review', async (req, reply) => {
    const me = await requireUser(app, req);
    const body = ReviewBody.parse(req.body);
    const e = await load(req.params.id, me);
    if (e.reviewer_id !== me.id) throw new HttpError(403, 'forbidden', 'only the reviewer can review this work');
    if (e.status !== 'awaiting_review') throw new HttpError(409, 'not_reviewable', 'this work is not waiting for review');
    if (body.verdict === 'reject' && !body.comment) throw new HttpError(400, 'invalid_request', 'say why you are rejecting this work');
    if (body.verdict === 'changes') {
      if (!body.comment && !body.lineComments?.length) throw new HttpError(400, 'invalid_request', 'add a comment or at least one line comment');
      if (e.revision >= MAX_REVISIONS) throw new HttpError(409, 'max_revisions', `at most ${MAX_REVISIONS} revisions are allowed`);
    }
    await applyReview(e, me, body);
    return reply.status(204).send();
  });

  // ---- live chat with the agent while reviewing (docs/09 §1.11)
  const toMessage = (r: any): ExecutionMessage => ({ id: r.id, revision: r.revision, role: r.role, kind: r.kind, text: r.text, proposedChange: r.proposed_change, author: r.username ?? null, createdAt: r.created_at });
  const MESSAGES = `select m.id, m.revision, m.role, m.kind, m.text, m.proposed_change, m.created_at, u.username from execution_messages m left join users u on u.id = m.author_id`;

  app.get<{ Params: { id: string } }>('/executions/:id/messages', async (req) => {
    const me = await requireUser(app, req);
    const e = await load(req.params.id, me);
    const { rows } = await app.db.query(`${MESSAGES} where m.execution_id = $1 order by m.created_at, m.role desc limit 300`, [e.id]);
    return rows.map(toMessage);
  });

  /** One turn: the reviewer says something, the agent answers (question), plans a change, or asks back. Nothing is changed until Apply & rerun. */
  app.post<{ Params: { id: string } }>('/executions/:id/messages', async (req, reply) => {
    const me = await requireUser(app, req);
    const { text } = ChatBody.parse(req.body);
    const e = await load(req.params.id, me);
    if (e.reviewer_id !== me.id) throw new HttpError(403, 'forbidden', 'only the reviewer can talk to the agent');
    if (e.status !== 'awaiting_review' || !e.agent) throw new HttpError(409, 'not_reviewable', 'the agent can only be asked while the work is waiting for your review');
    const { rows: cnt } = await app.db.query('select count(*)::int n from execution_messages where execution_id = $1', [e.id]);
    if (cnt[0].n >= MAX_CHAT_MESSAGES) throw new HttpError(429, 'chat_limit', 'this conversation is full; apply the changes or approve');
    if (await app.agents.overCap(e.project_id)) throw new HttpError(429, 'spend_cap', 'the daily agent spend cap for this project has been reached');
    const { rows: hist } = await app.db.query('select role, text from execution_messages where execution_id = $1 order by created_at desc, role asc limit 12', [e.id]);
    let out;
    try { out = await app.agents.chat({ ...e, task_id: e.task_id, title: e.task_title, due: e.due, assignee: e.assignee_name, description: e.task_description }, text, hist.reverse()); }
    catch (err) { app.log.warn({ err: (err as Error).message }, 'agent chat failed'); throw new HttpError(502, 'agent_unavailable', 'the agent could not answer right now; try again'); }
    const c = await app.db.connect();
    let inserted: any[];
    try {
      await c.query('begin');
      const u = await c.query('insert into execution_messages(execution_id, revision, role, kind, text, author_id) values ($1,$2,$3,$4,$5,$6) returning id', [e.id, e.revision, 'user', out.kind, text, me.id]);
      const a = await c.query('insert into execution_messages(execution_id, revision, role, kind, text, proposed_change, usage) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [e.id, e.revision, 'agent', out.kind, out.reply, out.proposed_change || null, JSON.stringify(out.usage ?? {})]);
      await c.query('commit');
      inserted = [u.rows[0].id, a.rows[0].id];
    } catch (err) { await c.query('rollback'); throw err; } finally { c.release(); }
    await app.agents.addCost(e.id, Number(out.usage?.cost_usd ?? 0));
    const { rows } = await app.db.query(`${MESSAGES} where m.id = any($1::uuid[]) order by m.created_at, m.role desc`, [inserted]);
    const msgs = rows.map(toMessage);
    app.emitToUser(e.reviewer_id, 'execution:message', { id: e.id });
    return reply.status(201).send(msgs);
  });

  /** Apply & rerun: everything asked for in this revision's chat (plus an optional note) goes to the agent as one request for changes. */
  app.post<{ Params: { id: string } }>('/executions/:id/rerun', async (req, reply) => {
    const me = await requireUser(app, req);
    const body = RerunBody.parse(req.body ?? {});
    const e = await load(req.params.id, me);
    if (e.reviewer_id !== me.id) throw new HttpError(403, 'forbidden', 'only the reviewer can rerun this work');
    if (e.status !== 'awaiting_review') throw new HttpError(409, 'not_reviewable', 'this work is not waiting for review');
    if (e.revision >= MAX_REVISIONS) throw new HttpError(409, 'max_revisions', `at most ${MAX_REVISIONS} revisions are allowed`);
    const { rows } = await app.db.query(
      `select role, kind, text, proposed_change from execution_messages where execution_id = $1 and revision = $2 and (role = 'user' and kind in ('change', 'clarify') or role = 'agent' and kind = 'clarify') order by created_at, role desc`, [e.id, e.revision]);
    const asked = rows.filter((r) => r.role === 'user').map((r) => `- ${r.text}`);
    const answers = rows.filter((r) => r.role === 'agent' && r.kind === 'clarify').map((r) => `  (you asked: ${r.text})`);
    const parts = [...(asked.length ? [`Changes requested in chat:\n${asked.join('\n')}${answers.length ? `\n${answers.join('\n')}` : ''}`] : []), ...(body.comment ? [body.comment] : [])];
    if (!parts.length) throw new HttpError(400, 'invalid_request', 'ask for a change in the chat (or add a note) before rerunning');
    await applyReview(e, me, { verdict: 'changes', comment: parts.join('\n\n').slice(0, 3900) });
    return reply.status(202).send({ ok: true });
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

  // Sending is always an explicit, confirmed human action on approved work (F9.9, F9.10). Recipients and text are exactly what
  // the reviewer approved; the same message can only ever be sent once.
  app.post<{ Params: { id: string } }>('/executions/:id/send-email', async (req) => {
    const me = await requireUser(app, req);
    const body = SendEmailBody.parse(req.body);
    const e = await load(req.params.id, me);
    if (e.reviewer_id !== me.id) throw new HttpError(403, 'forbidden', 'only the reviewer can send this email');
    if (e.agent !== 'communication') throw new HttpError(400, 'invalid_request', 'this run has no email to send');
    if (e.status !== 'approved') throw new HttpError(409, 'not_approved', 'approve the draft before sending it');
    const { rows } = await app.db.query("select id, payload from execution_artifacts where id = $1 and execution_id = $2 and type = 'email_draft' and revision = $3", [body.artifactId, e.id, e.revision]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'draft not found');
    const p = rows[0].payload ?? {};
    const draft = EmailDraftBody.safeParse({ to: p.to ?? [], cc: p.cc ?? [], subject: p.subject ?? '', body: p.body ?? '' });
    if (!draft.success) throw new HttpError(400, 'invalid_email', draft.error.issues.map((i) => i.message).join('; '));
    if (draft.data.to.length === 0) throw new HttpError(400, 'invalid_email', 'add at least one recipient before sending');
    const d = draft.data;
    const hash = createHash('sha256').update(JSON.stringify([rows[0].id, [...d.to].sort(), [...d.cc].sort(), d.subject, d.body, p.thread_id ?? null])).digest('hex');
    // Claim the send first: the unique (execution, hash) makes double-clicks and retries safe.
    const claim = await app.db.query(
      'insert into email_sends(execution_id, artifact_id, message_hash, recipients) values ($1,$2,$3,$4) on conflict do nothing returning id, sent_at',
      [e.id, rows[0].id, hash, { to: d.to, cc: d.cc, subject: d.subject, pending: true }]);
    if (!claim.rows[0]) throw new HttpError(409, 'already_sent', 'this email has already been sent');
    try {
      const sent = await connector<{ messageId: string; threadId: string | null; from: string }>('/gmail/send', { method: 'POST', json: {
        projectId: e.project_id, userId: me.id, to: d.to, cc: d.cc, subject: d.subject, body: d.body, threadId: p.thread_id ?? null, inReplyTo: p.in_reply_to ?? null, references: p.references ?? null } });
      await app.db.query('update email_sends set recipients = $2 where id = $1', [claim.rows[0].id, { from: sent.from, to: d.to, cc: d.cc, subject: d.subject, messageId: sent.messageId, threadId: sent.threadId }]);
      emitUpdate(e, 'approved');
      app.analytics.track('email_sent', {}, { userId: me.id, projectId: e.project_id, meetingId: e.meeting_id });
      return { sentAt: claim.rows[0].sent_at, messageId: sent.messageId, from: sent.from, to: d.to, cc: d.cc };
    } catch (err) {
      // If we could not even tell whether Gmail got the request, keep the claim: a blind retry could send twice.
      if (err instanceof HttpError && err.code === 'connector_unavailable') {
        await app.db.query('update email_sends set recipients = recipients || $2::jsonb where id = $1', [claim.rows[0].id, { unconfirmed: true }]);
        throw new HttpError(502, 'send_unconfirmed', "We couldn't confirm whether the email was sent. Check your Gmail Sent folder before trying again.");
      }
      await app.db.query('delete from email_sends where id = $1', [claim.rows[0].id]); // definitely not sent: allow a retry
      throw err;
    }
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
