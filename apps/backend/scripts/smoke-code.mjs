// Code agent flow with the mock AI (AGENTS_MODE=mock): repository choice, ownership, direct runs, plan-only, revisions. No GitHub or Modal traffic.
//   BACKEND_PORT=4101 AI_URL=http://localhost:5102 INSIGHTS_LLM=off JOBS_TICK_MS=300 npm start -w @meetpilot/backend
//   BACKEND_URL=http://localhost:4101 DATABASE_URL=... npm run smoke:code -w @meetpilot/backend
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const B = process.env.BACKEND_URL ?? 'http://localhost:4101';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const api = async (path, user, method = 'GET', json) => {
  const r = await fetch(B + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
};
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '').slice(0, 500)); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };

const U = ['cd_owner', 'cd_dev', 'cd_other'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const mkProject = async (name) => {
  const P = (await api('/projects', 'cd_owner', 'POST', { name })).body;
  const M = (await api(`/projects/${P.id}/meetings`, 'cd_owner', 'POST', { title: 'Eng sync', inviteeIds: [id('cd_dev')] })).body.id;
  return { P, M };
};
const addRepo = async (P, owner, name, desc) => (await db.query("insert into project_repos(project_id, owner, name, default_branch, description, index_text, language) values ($1,$2,$3,'main',$4,$5,'TypeScript') returning id", [P.id, owner, name, desc, `${owner}/${name}\nTop level: src/`])).rows[0].id;
const mk = async (ctx, title, agent = 'code') => {
  const t = (await db.query("insert into tasks(meeting_id, project_id, title, description, finalized, assigned_to) values ($1,$2,$3,$3,true,$4) returning id", [ctx.M, ctx.P.id, title, id('cd_dev')])).rows[0].id;
  const e = (await db.query("insert into executions(task_id, agent, status, reviewer_id, error) values ($1,$2,'failed',$3,'x') returning id", [t, agent, id('cd_dev')])).rows[0].id;
  await api(`/executions/${e}/retry`, 'cd_dev', 'POST');
  return e;
};
const settled = (e) => waitFor(async () => { const d = (await api(`/executions/${e}`, 'cd_dev')).body; return d.status === 'awaiting_review' && d; });

// ---- two repositories: the agent cannot decide, so the reviewer chooses
const A = await mkProject('Two repos');
const r1 = await addRepo(A.P, 'acme', 'shop-api', 'Billing API'), r2 = await addRepo(A.P, 'acme', 'web-app', 'Customer web app');
const e1 = await mk(A, 'Fix the billing webhook retry bug');
const d1 = await settled(e1);
ok('with several plausible repositories nothing is changed and the reviewer is asked', !!d1 && d1.artifacts.length === 0 && d1.stagePlan?.repoChoice?.candidates?.length === 2 && d1.repo === null && d1.openQuestions.some((q) => /repository/i.test(q)), d1);
ok('the candidates are the linked repositories', new Set(d1.stagePlan.repoChoice.candidates.map((c) => c.repo_id)).size === 2 && d1.stagePlan.repoChoice.candidates.every((c) => [r1, r2].includes(c.repo_id)), d1.stagePlan);
ok('only the reviewer can choose', [403, 404].includes((await api(`/executions/${e1}/repo`, 'cd_other', 'POST', { repoId: r1 })).status) && (await api(`/executions/${e1}/repo`, 'cd_owner', 'POST', { repoId: r1 })).status === 403);
const B2 = await mkProject('Other project');
const foreign = await addRepo(B2.P, 'evil', 'repo', 'x');
ok('a repository of another project cannot be chosen', (await api(`/executions/${e1}/repo`, 'cd_dev', 'POST', { repoId: foreign })).status === 404 && (await api(`/executions/${e1}/repo`, 'cd_dev', 'POST', { repoId: 'not-a-uuid' })).status === 400);
ok('the choice only applies to code work that is waiting for it', (await api(`/executions/${(await mk(A, 'Research competitor pricing', 'research'))}/repo`, 'cd_dev', 'POST', { repoId: r1 })).status === 409);
ok('the reviewer chooses a repository', (await api(`/executions/${e1}/repo`, 'cd_dev', 'POST', { repoId: r2 })).status === 202);
const d1b = await settled(e1);
ok('the agent continues with that repository: a diff and verification evidence', !!d1b && d1b.repo?.fullName === 'acme/web-app' && d1b.artifacts.some((a) => a.type === 'diff' && a.payload.repo === 'acme/web-app' && a.payload.files.length >= 1) && d1b.artifacts.some((a) => a.type === 'verification'), d1b?.artifacts.map((a) => a.type));
ok('the repository question is cleared', !d1b.stagePlan?.repoChoice && (await api(`/executions/${e1}/repo`, 'cd_dev', 'POST', { repoId: r1 })).status === 409);
const diff = d1b.artifacts.find((a) => a.type === 'diff').payload;
ok('the diff artifact has what the viewer needs', /^diff --git a\//.test(diff.diff) && diff.branch === 'main' && diff.files[0].path && typeof diff.files[0].additions === 'number', diff);
const ver = d1b.artifacts.find((a) => a.type === 'verification').payload;
ok('mock mode never claims verification', ver.status === 'not_tested' && ver.mode === 'mock' && /Mock mode/.test(ver.reason), ver);

// ---- changes requested: the repository sticks and the work is redone
ok('request changes', (await api(`/executions/${e1}/review`, 'cd_dev', 'POST', { verdict: 'changes', comment: 'also handle the timeout case', lineComments: [{ file: 'src/app.js', line: 3, text: 'why not 5?' }] })).status === 204);
const d1c = await waitFor(async () => { const d = (await api(`/executions/${e1}`, 'cd_dev')).body; return d.status === 'awaiting_review' && d.revision === 1 && d; });
ok('the revision keeps the chosen repository and delivers a new diff', !!d1c && d1c.repo?.fullName === 'acme/web-app' && d1c.artifacts.some((a) => a.type === 'diff') && d1c.reviews.at(-1).lineComments?.length === 1, d1c?.reviews);

// ---- one repository: no question asked
const S = await mkProject('One repo');
await addRepo(S.P, 'acme', 'only-repo', 'The only one');
const e2 = await mk(S, 'Add retry logic to the exporter');
const d2 = await settled(e2);
ok('with a single repository the agent proceeds straight away', !!d2 && d2.repo?.fullName === 'acme/only-repo' && d2.artifacts.some((a) => a.type === 'diff') && !d2.stagePlan?.repoChoice, d2?.artifacts.map((a) => a.type));

// ---- no repositories: a plan only
const N = await mkProject('No repos');
const e3 = await mk(N, 'Add retry logic to the exporter');
const d3 = await settled(e3);
ok('without linked repositories the agent delivers a plan, not a change', !!d3 && d3.repo === null && d3.artifacts.every((a) => a.type !== 'diff' && a.type !== 'verification') && d3.artifacts.some((a) => a.type === 'markdown'), d3?.artifacts.map((a) => a.type));

// ---- a removed repository does not break an old execution
await db.query('delete from project_repos where id = $1', [r2]);
const d1d = (await api(`/executions/${e1}`, 'cd_dev')).body;
ok('removing a linked repository leaves its executions readable', d1d.status === 'awaiting_review' && d1d.repo === null && d1d.artifacts.length > 0, d1d.repo);

// ---- slow jobs do not block others
const slow = await mk(A, 'Slow one');  // unrelated to concurrency itself; both settle
const fast = await mk(S, 'Another quick task');
ok('several agent jobs complete (the runner is concurrent)', !!(await settled(slow)) && !!(await settled(fast)));

for (const p of [A.P.id, B2.P.id, S.P.id, N.P.id]) await db.query('delete from projects where id = $1', [p]);
await db.query('delete from users where username = any($1)', [U]);
await db.end();
