import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ChatBody, ChooseRepoBody, EmailDraftBody, HandoffBody, PrBody, type PipelineStage, type PrState, type EmailAttachments, MAX_CHAT_MESSAGES, MAX_REVISIONS, RerunBody, ReviewBody, RunWithBody, SendEmailBody, type ExecutionDetail, type ExecutionMessage, type ExecutionSummary, type ExecutionUsage, type ReviewCounts } from '@meetpilot/shared';
import { connector } from '../services/connector.js';
import { requireUser, type AuthUser } from '../app.js';
import { HttpError } from '../errors.js';
import { TASK_SELECT, toTask } from '../insights/tasksFormat.js';
import { AttachmentError, candidatesFor, chipsFor, filesForSend, invalidAttachmentIds } from '../agents/attachments.js';
import { branchName, defaultPrBody, prChecks } from '../agents/pr.js';

const SUMMARY_SELECT = `select e.*, pr.owner as repo_owner, pr.name as repo_name, t.title as task_title, t.meeting_id, m.title as meeting_title, to_char(t.due_date,'YYYY-MM-DD') as due,
    t.assigned_to, t.project_id, t.description as task_description, p.name as project_name, ua.username as assignee_name, e.reviewer_id, ur.username as reviewer_name
  from executions e join tasks t on t.id = e.task_id join meetings m on m.id = t.meeting_id join projects p on p.id = t.project_id left join project_repos pr on pr.id = e.repo_id
  left join users ua on ua.id = t.assigned_to left join users ur on ur.id = e.reviewer_id`;

const toSummary = (r: any): ExecutionSummary => ({
  id: r.id, taskId: r.task_id, taskTitle: r.task_title, meetingId: r.meeting_id, meetingTitle: r.meeting_title, projectId: r.project_id, projectName: r.project_name,
  agent: r.agent, status: r.status, revision: r.revision, summary: r.summary, error: r.error, routeReason: r.route_reason,
  reviewer: r.reviewer_id ? { id: r.reviewer_id, username: r.reviewer_name } : null,
  assignee: r.assigned_to ? { id: r.assigned_to, username: r.assignee_name } : null, dueDate: r.due, updatedAt: r.updated_at,
  confidence: r.confidence ?? null, routeConfidence: r.route_confidence ?? null, stagePlan: r.stage_plan ?? null, approvedChoice: r.approved_choice ?? null, stage: r.stage ?? 0,
  repo: r.repo_id ? { id: r.repo_id, fullName: `${r.repo_owner}/${r.repo_name}` } : null,
});

const toUsage = (u: any): ExecutionUsage | null => u ? ({ calls: u.calls ?? 0, searches: u.searches ?? 0, sandboxCostUsd: u.sandbox_cost_usd ?? 0, promptTokens: u.prompt_tokens ?? 0, cachedTokens: u.cached_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, costUsd: u.cost_usd ?? 0, models: u.models ?? [] }) : null;

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

  /** The agents of this task in order and where each one is. Empty for ordinary single-stage work. */
  async function pipelineFor(e: any): Promise<PipelineStage[]> {
    const { rows } = await app.db.query('select id, stage, agent, status, approved_choice from executions where task_id = $1 order by stage', [e.task_id]);
    const planned: { agent: PipelineStage['agent'] }[] = Array.isArray(e.stage_plan?.stages) ? e.stage_plan.stages : [];
    const n = Math.max(rows.length, planned.length);
    if (n < 2) return [];
    const out: PipelineStage[] = [];
    let stopped = false;
    for (let i = 0; i < n; i++) {
      const r = rows.find((x) => x.stage === i);
      const agent = (r?.agent ?? planned[i]?.agent) as PipelineStage['agent'];
      let status: PipelineStage['status'] = 'planned';
      if (r) status = r.status === 'approved' ? 'done' : ['rejected', 'failed', 'skipped_human'].includes(r.status) ? 'stopped' : r.status === 'awaiting_review' ? 'waiting' : 'active';
      else if (stopped) status = 'stopped';
      if (status === 'stopped') stopped = true;
      out.push({ stage: i, agent, executionId: r?.id ?? null, status, current: r?.id === e.id, choice: r?.approved_choice ?? null });
    }
    return out;
  }

  /** Creates the next stage's execution: same task and reviewer, linked to the approved stage so its output becomes the next agent's brief. */
  async function insertNextStage(q: { query: (sql: string, p?: any[]) => Promise<any> }, e: any, plan: any, agent: string, reason: string): Promise<string | null> {
    const { rows } = await q.query(
      `insert into executions(task_id, agent, status, reviewer_id, route_reason, route_confidence, stage_plan, stage, parent_execution_id) values ($1,$2,'routed',$3,$4,$5,$6,$7,$8)
       on conflict (task_id, stage) do nothing returning id`, [e.task_id, agent, e.reviewer_id, reason, e.route_confidence ?? null, JSON.stringify(plan), (e.stage ?? 0) + 1, e.id]);
    return rows[0]?.id ?? null;
  }

  /** The verified file contents a pull request commits stay on the server; the browser only needs the diff. */
  const forBrowser = (a: any) => (a.type === 'diff' && a.payload?.commit_files ? { ...a, payload: (({ commit_files: _drop, ...rest }) => rest)(a.payload) } : a);

  /** Is this approved code change eligible for a pull request, and what would it say? Only for code work; everyone who can see the review sees the state. */
  async function prStateFor(e: any, arts: any[]): Promise<PrState | null> {
    if (e.agent !== 'code') return null;
    const diff = arts.find((a) => a.type === 'diff' && a.revision === e.revision)?.payload ?? null;
    const verification = arts.find((a) => a.type === 'verification' && a.revision === e.revision)?.payload ?? null;
    const [repo, gh, pr] = await Promise.all([
      e.repo_id ? app.db.query('select owner, name, default_branch, can_push from project_repos where id = $1', [e.repo_id]).then((r) => r.rows[0] ?? null) : Promise.resolve(null),
      connector<{ connected: boolean }>(`/github/status?projectId=${e.project_id}`).catch(() => ({ connected: false })),
      app.db.query('select * from pull_requests where execution_id = $1 and revision = $2', [e.id, e.revision]).then((r) => r.rows[0] ?? null),
    ]);
    const files = Array.isArray(diff?.files) ? diff.files : [];
    const checks = prChecks({ status: e.status, verification, repoId: repo ? e.repo_id : null, canPush: repo ? !!repo.can_push : null, githubConnected: !!gh.connected,
      hasFiles: Array.isArray(diff?.commit_files) && diff.commit_files.length > 0, baseSha: diff?.base_sha ?? null, alreadyOpened: !!pr });
    return {
      allowed: checks.every((c) => c.ok), checks, files, repo: repo ? `${repo.owner}/${repo.name}` : null, baseBranch: diff?.branch ?? repo?.default_branch ?? null,
      branch: branchName(e.task_title, e.id, e.revision), defaultTitle: String(e.task_title).slice(0, 200), defaultBody: defaultPrBody({ summary: e.summary, files, verification }),
      pullRequest: pr ? { number: pr.number, url: pr.url, branch: pr.branch, baseBranch: pr.base_branch, draft: pr.draft, status: pr.status, createdAt: pr.created_at } : null,
    };
  }

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
        sent: sent.rows.filter((r) => r.recipients.messageId).map((r) => ({ sentAt: r.sent_at, from: r.recipients.from ?? null, to: r.recipients.to ?? [], cc: r.recipients.cc ?? [], subject: r.recipients.subject ?? '', messageId: r.recipients.messageId ?? null, attachments: r.recipients.attachments ?? [] })),
      };
    }
    return {
      ...toSummary(e), send, pr: await prStateFor(e, arts.rows), pipeline: await pipelineFor(e), task: toTask(task.rows[0]), notes: e.notes, openQuestions: Array.isArray(e.open_questions) ? e.open_questions : [], usage: toUsage(e.usage),
      steps: steps.rows.map((r) => ({ seq: r.seq, revision: r.revision, kind: r.kind, label: r.label, detail: r.detail ?? {}, status: r.status, startedAt: r.started_at, endedAt: r.ended_at })),
      artifacts: arts.rows.map(forBrowser), canReview: e.reviewer_id === me.id && e.status === 'awaiting_review',
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
      .header('content-disposition', `${rows[0].mime === 'application/pdf' ? 'inline' : 'attachment'}; filename="${String(rows[0].filename).replace(/["\r\n]/g, '_')}"`).send(rows[0].data);
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

  /** Code work with several plausible repositories: the reviewer picks one and the agent continues. */
  app.post<{ Params: { id: string } }>('/executions/:id/repo', async (req, reply) => {
    const me = await requireUser(app, req);
    const e = await load(req.params.id, me);
    if (e.reviewer_id !== me.id) throw new HttpError(403, 'forbidden', 'only the reviewer can choose the repository');
    const { repoId } = ChooseRepoBody.parse(req.body);
    if (e.agent !== 'code' || e.status !== 'awaiting_review' || !e.stage_plan?.repoChoice) throw new HttpError(409, 'not_choosing', 'this work is not waiting for a repository choice');
    const { rows } = await app.db.query('select id from project_repos where id = $1 and project_id = $2', [repoId, e.project_id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'that repository is not linked to this project');
    await app.agents.chooseRepo(e.id, repoId);
    return reply.status(202).send({ ok: true });
  });

  /** A web-page design that was planned as design-only can still be built: the reviewer starts the Code stage with the approved direction. Never offered for cards, banners and other designs. */
  app.post<{ Params: { id: string } }>('/executions/:id/handoff', async (req, reply) => {
    const me = await requireUser(app, req);
    HandoffBody.parse(req.body);
    const e = await load(req.params.id, me);
    if (e.reviewer_id !== me.id) throw new HttpError(403, 'forbidden', 'only the reviewer can start the next stage');
    const plan = e.stage_plan;
    if (e.agent !== 'designer' || e.status !== 'approved' || !plan?.webPage) throw new HttpError(409, 'not_buildable', 'only an approved web-page design can be built with the Code agent');
    const { rows: existing } = await app.db.query('select 1 from executions where task_id = $1 and stage = $2', [e.task_id, (e.stage ?? 0) + 1]);
    if (existing[0]) throw new HttpError(409, 'already_started', 'the Code stage was already started');
    const merged = { ...plan, stages: [...(plan.stages ?? [{ agent: 'designer', goal: e.task_title }]), { agent: 'code', goal: `Implement the approved design: ${e.task_title}`.slice(0, 200) }], scope: 'build' };
    const c = await app.db.connect();
    let id: string | null = null;
    try {
      await c.query('begin');
      id = await insertNextStage(c, e, merged, 'code', 'Started by you after approving the design');
      if (id) {
        await c.query("update executions set stage_plan = $2 where id = $1", [e.id, JSON.stringify(merged)]);
        await c.query("update tasks set status = 'in_progress' where id = $1", [e.task_id]);
      }
      await c.query('commit');
    } catch (err) { await c.query('rollback'); throw err; } finally { c.release(); }
    if (!id) throw new HttpError(409, 'already_started', 'the Code stage was already started');
    await app.agents.retry(id);
    emitUpdate({ ...e, id }, 'routed');
    return reply.status(202).send({ executionId: id });
  });

  /** Opens a pull request from an approved, verified code change. A deliberate, confirmed click: never automatic, never to the default branch, never merged. */
  app.post<{ Params: { id: string } }>('/executions/:id/pr', async (req, reply) => {
    const me = await requireUser(app, req);
    const body = PrBody.parse(req.body);
    const e = await load(req.params.id, me);
    if (e.reviewer_id !== me.id) throw new HttpError(403, 'forbidden', 'only the reviewer can open a pull request');
    if (e.agent !== 'code') throw new HttpError(400, 'invalid_request', 'this work has no code change');
    const { rows: arts } = await app.db.query('select type, revision, payload from execution_artifacts where execution_id = $1 and revision = $2 and type in (\'diff\', \'verification\')', [e.id, e.revision]);
    const st = await prStateFor(e, arts);
    const failed = st?.checks.filter((c) => !c.ok) ?? [];
    if (!st || failed.length) throw new HttpError(409, 'pr_not_allowed', `a pull request cannot be opened yet: ${failed.map((c) => c.detail ?? c.label).join(' ')}`);
    const diff = arts.find((a) => a.type === 'diff')!.payload;
    const { rows: repoRows } = await app.db.query('select owner, name from project_repos where id = $1', [e.repo_id]);
    const repo = repoRows[0];
    const title = body.title ?? st.defaultTitle, prBody = body.body ?? st.defaultBody;
    let branch = st.branch;
    // Claim first: the unique (execution, revision) makes a double click, a retry or a second tab safe.
    const claim = await app.db.query(
      `insert into pull_requests(execution_id, revision, repo_id, repo_full_name, base_branch, base_sha, branch, draft, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing returning id`,
      [e.id, e.revision, e.repo_id, `${repo.owner}/${repo.name}`, diff.branch, diff.base_sha, branch, body.draft, me.id]);
    if (!claim.rows[0]) throw new HttpError(409, 'already_opened', 'a pull request was already opened (or is being opened) for this change');
    const send = (b: string) => connector<{ number: number; url: string; branch: string; headSha: string }>('/github/pr', { method: 'POST', json: {
      projectId: e.project_id, owner: repo.owner, name: repo.name, baseBranch: diff.branch, baseSha: diff.base_sha, branch: b, title, body: prBody, draft: body.draft,
      message: `${title}\n\nPrepared by a MeetPilot agent and approved by a reviewer in MeetPilot.`,
      files: diff.commit_files.map((f: any) => ({ path: f.path, content: f.content, mode: f.mode })) } });
    try {
      let r;
      try { r = await send(branch); }
      catch (err) { // an earlier attempt that failed half-way can have left the branch behind: take a fresh name once
        if (err instanceof HttpError && err.code === 'branch_exists') { branch = `${branch}-${Math.random().toString(36).slice(2, 6)}`; r = await send(branch); } else throw err;
      }
      await app.db.query("update pull_requests set number = $2, url = $3, head_sha = $4, branch = $5, status = 'open' where id = $1", [claim.rows[0].id, r.number, r.url, r.headSha, branch]);
      app.analytics.track('pr_created', { kind: body.draft ? 'draft' : 'ready' }, { userId: me.id, projectId: e.project_id, meetingId: e.meeting_id });
      emitUpdate(e, 'approved');
      return reply.status(201).send({ number: r.number, url: r.url, branch, draft: body.draft });
    } catch (err) {
      if (err instanceof HttpError && err.code === 'connector_unavailable') { // we cannot tell whether GitHub got it: keep the claim so a blind retry cannot open a second one
        await app.db.query("update pull_requests set status = 'unconfirmed' where id = $1", [claim.rows[0].id]);
        throw new HttpError(502, 'pr_unconfirmed', "We couldn't confirm whether the pull request was opened. Check the repository on GitHub before trying again.");
      }
      await app.db.query('delete from pull_requests where id = $1', [claim.rows[0].id]); // definitely not opened: allow a retry
      throw err;
    }
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
  async function applyReview(e: any, me: AuthUser, body: { verdict: 'approve' | 'changes' | 'reject'; comment?: string; lineComments?: unknown[]; choice?: 'A' | 'B' }) {
    let handoff: string | null = null;
    const c = await app.db.connect();
    try {
      await c.query('begin');
      await c.query('insert into execution_reviews(execution_id, revision, reviewer_id, verdict, comment, line_comments) values ($1,$2,$3,$4,$5,$6)',
        [e.id, e.revision, me.id, body.verdict, body.comment ?? null, body.lineComments ? JSON.stringify(body.lineComments) : null]);
      if (body.verdict === 'approve') {
        await c.query("update executions set status = 'approved', approved_choice = $2, updated_at = now() where id = $1", [e.id, body.choice ?? null]);
        // A Designer→Code plan (web pages only): approving the design starts the Code stage with the approved direction; the task is done only after the last stage.
        const plan = e.stage_plan, next = plan?.stages?.[(e.stage ?? 0) + 1];
        if (next && e.agent === 'designer' && next.agent === 'code' && plan.scope === 'build') {
          handoff = await insertNextStage(c, e, plan, 'code', 'Started automatically after you approved the design');
        }
        await c.query("update tasks set status = $2 where id = $1", [e.task_id, handoff ? 'in_progress' : 'done']);
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
    if (handoff) { await app.agents.retry(handoff); emitUpdate({ ...e, id: handoff }, 'routed'); }
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
    if (body.verdict === 'approve') {
      // Design work with two directions: approving means choosing one; the choice is what later stages build on.
      const { rows: dirs } = await app.db.query("select payload->>'direction' as d from execution_artifacts where execution_id = $1 and revision = $2 and type = 'html'", [e.id, e.revision]);
      const offered = new Set(dirs.map((r) => r.d).filter(Boolean));
      if (offered.size >= 2 && !body.choice) throw new HttpError(400, 'choose_direction', 'choose direction A or B to approve this design');
      if (body.choice && !offered.has(body.choice)) throw new HttpError(400, 'invalid_choice', 'that direction was not offered');
    } else if (body.choice) throw new HttpError(400, 'invalid_request', 'a direction can only be chosen when approving');
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
    const bad = await invalidAttachmentIds(app.db, e, body.attachments);
    if (bad.length) throw new HttpError(400, 'invalid_attachment', 'you can only attach deliverables of other agent work in this project');
    const { rows } = await app.db.query(
      `update execution_artifacts set payload = coalesce(payload, '{}'::jsonb) || $3::jsonb
       where id = $1 and execution_id = $2 and type = 'email_draft' and revision = $4 returning id, type, title, uri, payload, revision`,
      [req.params.aid, e.id, JSON.stringify({ ...body, missing_recipients: body.to.length === 0 }), e.revision]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'draft not found');
    return rows[0];
  });

  /** Attachment chips for an email draft: what is attached (with live progress), what the agent suggested, and what else could be. */
  app.get<{ Params: { id: string } }>('/executions/:id/attachments', async (req): Promise<EmailAttachments> => {
    const me = await requireUser(app, req);
    const e = await load(req.params.id, me);
    if (e.agent !== 'communication') return { selected: [], suggested: [], candidates: [] };
    const { rows } = await app.db.query("select payload from execution_artifacts where execution_id = $1 and type = 'email_draft' and revision = $2", [e.id, e.revision]);
    const p = rows[0]?.payload ?? {};
    const selectedIds: string[] = Array.isArray(p.attachments) ? p.attachments : [];
    const suggestedIds: string[] = (Array.isArray(p.suggested_attachments) ? p.suggested_attachments : []).filter((i: string) => !selectedIds.includes(i));
    const [selected, suggested, candidates] = await Promise.all([chipsFor(app.db, e.project_id, selectedIds), chipsFor(app.db, e.project_id, suggestedIds), candidatesFor(app.db, e)]);
    return { selected, suggested, candidates: candidates.filter((c) => !selectedIds.includes(c.executionId)) };
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
    const draft = EmailDraftBody.safeParse({ to: p.to ?? [], cc: p.cc ?? [], subject: p.subject ?? '', body: p.body ?? '', attachments: p.attachments ?? [] });
    if (!draft.success) throw new HttpError(400, 'invalid_email', draft.error.issues.map((i) => i.message).join('; '));
    if (draft.data.to.length === 0) throw new HttpError(400, 'invalid_email', 'add at least one recipient before sending');
    const d = draft.data;
    // Every attached file must be approved work; the bytes that go out are exactly the approved ones.
    let files: Awaited<ReturnType<typeof filesForSend>>;
    try { files = await filesForSend(app.db, e.project_id, d.attachments); }
    catch (err) { if (err instanceof AttachmentError) throw new HttpError(err.code === 'attachments_not_ready' ? 409 : 400, err.code, err.message); throw err; }
    const hash = createHash('sha256').update(JSON.stringify([rows[0].id, [...d.to].sort(), [...d.cc].sort(), d.subject, d.body, p.thread_id ?? null, files.map((f) => f.sha256).sort()])).digest('hex');
    // Claim the send first: the unique (execution, hash) makes double-clicks and retries safe.
    const claim = await app.db.query(
      'insert into email_sends(execution_id, artifact_id, message_hash, recipients) values ($1,$2,$3,$4) on conflict do nothing returning id, sent_at',
      [e.id, rows[0].id, hash, { to: d.to, cc: d.cc, subject: d.subject, pending: true }]);
    if (!claim.rows[0]) throw new HttpError(409, 'already_sent', 'this email has already been sent');
    try {
      const sent = await connector<{ messageId: string; threadId: string | null; from: string }>('/gmail/send', { method: 'POST', json: {
        projectId: e.project_id, userId: me.id, to: d.to, cc: d.cc, subject: d.subject, body: d.body, threadId: p.thread_id ?? null, inReplyTo: p.in_reply_to ?? null, references: p.references ?? null,
        attachments: files.map((f) => ({ filename: f.filename, mime: f.mime, data_b64: f.data.toString('base64') })) } });
      await app.db.query('update email_sends set recipients = $2 where id = $1', [claim.rows[0].id, { from: sent.from, to: d.to, cc: d.cc, subject: d.subject, messageId: sent.messageId, threadId: sent.threadId, attachments: files.map((f) => ({ filename: f.filename, size: f.size })) }]);
      for (const f of files) await app.db.query('insert into email_send_attachments(send_id, artifact_id, filename, mime, size, sha256) values ($1,$2,$3,$4,$5,$6)', [claim.rows[0].id, f.artifactId, f.filename, f.mime, f.size, f.sha256]);
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
