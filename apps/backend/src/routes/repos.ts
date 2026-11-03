import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AddRepoBody, GithubTokenBody, MAX_PROJECT_REPOS, UpdateRepoBody, parseGithubRepo, type GithubStatus, type ProjectRepo } from '@meetpilot/shared';
import { requireUser } from '../app.js';
import { HttpError } from '../errors.js';
import { connector } from '../services/connector.js';

const toRepo = (r: any): ProjectRepo => ({
  id: r.id, owner: r.owner, name: r.name, fullName: `${r.owner}/${r.name}`, url: `https://github.com/${r.owner}/${r.name}`, defaultBranch: r.default_branch,
  description: r.description, githubDescription: r.github_description, isPrivate: r.is_private, canPush: r.can_push, language: r.language,
  languages: r.languages ?? {}, indexedAt: r.indexed_at, createdAt: r.created_at,
});
interface Inspection { meta: { owner: string; name: string; defaultBranch: string; description: string | null; isPrivate: boolean; canPush: boolean; language: string | null }; languages: Record<string, number>; indexText: string }

/** Owner-managed GitHub repositories of a project and the optional GitHub token (sealed in the connector). */
export async function repoRoutes(app: FastifyInstance) {
  const uuid = (id: string) => { if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'not_found', 'not found'); return id; };
  async function role(projectId: string, userId: string): Promise<'owner' | 'member'> {
    const { rows } = await app.db.query('select role from project_members where project_id = $1 and user_id = $2', [uuid(projectId), userId]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'project not found');
    return rows[0].role;
  }
  const ownerOnly = async (projectId: string, userId: string) => { if ((await role(projectId, userId)) !== 'owner') throw new HttpError(403, 'forbidden', 'only the project owner can change repositories'); };
  const inspect = (projectId: string, owner: string, name: string) => connector<Inspection>('/github/inspect', { method: 'POST', json: { projectId, owner, name } });
  const apply = (id: string, i: Inspection) => app.db.query(
    `update project_repos set default_branch = $2, github_description = $3, is_private = $4, can_push = $5, language = $6, languages = $7, index_text = $8, indexed_at = now() where id = $1 returning *`,
    [id, i.meta.defaultBranch, i.meta.description, i.meta.isPrivate, i.meta.canPush, i.meta.language, JSON.stringify(i.languages ?? {}), i.indexText]);

  app.get<{ Params: { id: string } }>('/projects/:id/repos', async (req) => {
    const me = await requireUser(app, req);
    await role(req.params.id, me.id);
    const { rows } = await app.db.query('select * from project_repos where project_id = $1 order by created_at', [req.params.id]);
    return rows.map(toRepo);
  });

  app.post<{ Params: { id: string } }>('/projects/:id/repos', async (req, reply) => {
    const me = await requireUser(app, req);
    await ownerOnly(req.params.id, me.id);
    const body = AddRepoBody.parse(req.body);
    const ref = parseGithubRepo(body.url);
    if (!ref) throw new HttpError(400, 'invalid_repo', 'use a GitHub repository link such as https://github.com/owner/name');
    const { rows: cnt } = await app.db.query('select count(*)::int n from project_repos where project_id = $1', [req.params.id]);
    if (cnt[0].n >= MAX_PROJECT_REPOS) throw new HttpError(409, 'too_many_repos', `a project can link at most ${MAX_PROJECT_REPOS} repositories`);
    const found = await inspect(req.params.id, ref.owner, ref.name); // validates that it exists and the token (if any) can see it
    const { rows } = await app.db.query(
      `insert into project_repos(project_id, owner, name, description, added_by) values ($1,$2,$3,$4,$5) on conflict do nothing returning id`,
      [req.params.id, found.meta.owner, found.meta.name, body.description ?? null, me.id]);
    if (!rows[0]) throw new HttpError(409, 'already_added', 'this repository is already linked to the project');
    const { rows: done } = await apply(rows[0].id, found);
    app.analytics.track('repo_added', { kind: found.meta.isPrivate ? 'private' : 'public' }, { userId: me.id, projectId: req.params.id });
    return reply.status(201).send(toRepo(done[0]));
  });

  app.patch<{ Params: { id: string; repoId: string } }>('/projects/:id/repos/:repoId', async (req) => {
    const me = await requireUser(app, req);
    await ownerOnly(req.params.id, me.id);
    const { description } = UpdateRepoBody.parse(req.body);
    const { rows } = await app.db.query('update project_repos set description = $3 where id = $2 and project_id = $1 returning *', [req.params.id, uuid(req.params.repoId), description?.trim() || null]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'repository not found');
    return toRepo(rows[0]);
  });

  /** Refresh GitHub's view of the repository (branch, languages, README, tree) and its push permission. */
  app.post<{ Params: { id: string; repoId: string } }>('/projects/:id/repos/:repoId/reindex', async (req) => {
    const me = await requireUser(app, req);
    await ownerOnly(req.params.id, me.id);
    const { rows } = await app.db.query('select * from project_repos where id = $2 and project_id = $1', [req.params.id, uuid(req.params.repoId)]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'repository not found');
    const { rows: done } = await apply(rows[0].id, await inspect(req.params.id, rows[0].owner, rows[0].name));
    return toRepo(done[0]);
  });

  app.delete<{ Params: { id: string; repoId: string } }>('/projects/:id/repos/:repoId', async (req, reply) => {
    const me = await requireUser(app, req);
    await ownerOnly(req.params.id, me.id);
    const r = await app.db.query('delete from project_repos where id = $2 and project_id = $1', [req.params.id, uuid(req.params.repoId)]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'repository not found');
    return reply.status(204).send();
  });

  // ---- GitHub token (optional: public repositories work without one)
  app.get<{ Params: { id: string } }>('/projects/:id/github', async (req): Promise<GithubStatus> => {
    const me = await requireUser(app, req);
    await role(req.params.id, me.id);
    return connector<GithubStatus>(`/github/status?projectId=${req.params.id}`).catch(() => ({ connected: false, account: null }));
  });
  app.put<{ Params: { id: string } }>('/projects/:id/github', async (req) => {
    const me = await requireUser(app, req);
    await ownerOnly(req.params.id, me.id);
    const { token } = GithubTokenBody.parse(req.body);
    const r = await connector<{ account: string }>('/github/token', { method: 'PUT', json: { projectId: req.params.id, userId: me.id, token } });
    app.analytics.track('github_token_saved', {}, { userId: me.id, projectId: req.params.id });
    return { connected: true, account: r.account } satisfies GithubStatus;
  });
  app.delete<{ Params: { id: string } }>('/projects/:id/github', async (req, reply) => {
    const me = await requireUser(app, req);
    await ownerOnly(req.params.id, me.id);
    await connector(`/github/token?projectId=${req.params.id}`, { method: 'DELETE' });
    return reply.status(204).send();
  });
}
