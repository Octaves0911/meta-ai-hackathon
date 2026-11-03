// Designer -> Code hand-off with the mock AI (AGENTS_MODE=mock). No GitHub or Modal traffic.
//   BACKEND_PORT=4101 AI_URL=http://localhost:5102 INSIGHTS_LLM=off JOBS_TICK_MS=300 npm start -w @meetpilot/backend
//   BACKEND_URL=http://localhost:4101 DATABASE_URL=... npm run smoke:handoff -w @meetpilot/backend
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const B = process.env.BACKEND_URL ?? 'http://localhost:4101';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const api = async (path, user, method = 'GET', json) => {
  const r = await fetch(B + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, type, disposition: r.headers.get('content-disposition') ?? '', body: r.status === 204 ? null : type.includes('json') ? await r.json().catch(() => null) : Buffer.from(await r.arrayBuffer()) };
};
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '').slice(0, 500)); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };

const U = ['ho_owner', 'ho_dev'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'ho_owner', 'POST', { name: 'Hand-off' })).body;
const M = (await api(`/projects/${P.id}/meetings`, 'ho_owner', 'POST', { title: 'Design sync', inviteeIds: [id('ho_dev')] })).body.id;
const designer = async (title, plan) => {
  const t = (await db.query("insert into tasks(meeting_id, project_id, title, description, finalized, assigned_to) values ($1,$2,$3,$3,true,$4) returning id", [M, P.id, title, id('ho_dev')])).rows[0].id;
  const e = (await db.query("insert into executions(task_id, agent, status, reviewer_id, error, stage, stage_plan) values ($1,'designer','failed',$2,'x',0,$3) returning id", [t, id('ho_dev'), JSON.stringify(plan)])).rows[0].id;
  await api(`/executions/${e}/retry`, 'ho_dev', 'POST');
  const d = await waitFor(async () => { const x = (await api(`/executions/${e}`, 'ho_dev')).body; return x.status === 'awaiting_review' && x; });
  return { t, e, d };
};
const stagesOf = (t) => db.query('select id, agent, status, stage, parent_execution_id from executions where task_id = $1 order by stage', [t]).then((r) => r.rows);
const taskStatus = (t) => db.query('select status from tasks where id = $1', [t]).then((r) => r.rows[0].status);
const BUILD = { stages: [{ agent: 'designer', goal: 'Design the landing page' }, { agent: 'code', goal: 'Build it' }], scope: 'build', webPage: true };

// ---- a web-page design that is planned as design + build: approving it starts the Code stage by itself
const w = await designer('Design the landing page', BUILD);
ok('the design is delivered for review with the pipeline shown', !!w.d && w.d.pipeline?.length === 2 && w.d.pipeline[1].status === 'planned', w.d?.pipeline);
ok('approving a two-direction design needs a choice', (await api(`/executions/${w.e}/review`, 'ho_dev', 'POST', { verdict: 'approve' })).status === 400);
ok('approve direction B', (await api(`/executions/${w.e}/review`, 'ho_dev', 'POST', { verdict: 'approve', choice: 'B' })).status === 204);
const s1 = await waitFor(async () => { const r = await stagesOf(w.t); return r.length === 2 && r[1].status === 'awaiting_review' && r; });
ok('the Code stage started by itself, linked to the approved design', !!s1 && s1[1].agent === 'code' && s1[1].parent_execution_id === w.e && s1[0].status === 'approved', s1);
ok('the task stays in progress until the last stage is approved', (await taskStatus(w.t)) === 'in_progress');
const c1 = (await api(`/executions/${s1[1].id}`, 'ho_dev')).body;
ok('with no repository the Code stage delivers a static site: preview, zip and a static verification', ['markdown', 'html', 'file', 'verification'].every((t) => c1.artifacts.some((a) => a.type === t)) && c1.artifacts.find((a) => a.type === 'verification').payload.mode === 'static', c1.artifacts.map((a) => a.type));
ok('the pipeline shows design done and build waiting', c1.pipeline.map((p) => p.status).join() === 'done,waiting' && c1.pipeline[0].choice === 'B', c1.pipeline);
const zip = c1.artifacts.find((a) => a.type === 'file');
ok('the zip artifact lists its files and has no embedded bytes', zip.payload.files.length === 2 && !zip.payload.file_b64 && zip.payload.mime === 'application/zip' && /\/artifacts\/.+\/file/.test(zip.payload.url), zip.payload);
const dl = await api(zip.payload.url, 'ho_dev');
ok('the zip downloads as an attachment with the right bytes', dl.status === 200 && dl.type.startsWith('application/zip') && /^attachment/.test(dl.disposition) && Buffer.isBuffer(dl.body) && dl.body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])), { s: dl.status, t: dl.type, d: dl.disposition });
ok('approve the build', (await api(`/executions/${s1[1].id}/review`, 'ho_dev', 'POST', { verdict: 'approve' })).status === 204);
await sleep(500);
ok('the task is done only after the final stage', (await taskStatus(w.t)) === 'done' && (await stagesOf(w.t)).length === 2);

// ---- rejecting the design stops the pipeline
const r = await designer('Design another landing page', BUILD);
ok('reject the design', (await api(`/executions/${r.e}/review`, 'ho_dev', 'POST', { verdict: 'reject', comment: 'wrong direction' })).status === 204);
await sleep(600);
ok('no Code stage was started and the pipeline shows it stopped', (await stagesOf(r.t)).length === 1 && (await api(`/executions/${r.e}`, 'ho_dev')).body.pipeline.every((p) => p.status !== 'active'));

// ---- a card or banner is final at the Designer: nothing is handed on
const card = await designer('Design a birthday card', { stages: [{ agent: 'designer', goal: 'Card' }], scope: 'design', webPage: false });
ok('a card has no pipeline', card.d.pipeline.length === 0);
ok('approve the card', (await api(`/executions/${card.e}/review`, 'ho_dev', 'POST', { verdict: 'approve', choice: 'A' })).status === 204);
await sleep(600);
ok('approving a card starts nothing and finishes the task', (await stagesOf(card.t)).length === 1 && (await taskStatus(card.t)) === 'done');
ok('the build button is not offered for a card', (await api(`/executions/${card.e}/handoff`, 'ho_dev', 'POST', { agent: 'code' })).status === 409);

// ---- a web-page design that was planned as design-only can still be built, by the reviewer, once
const m = await designer('Design the pricing page', { stages: [{ agent: 'designer', goal: 'Pricing page' }], scope: 'design', webPage: true });
ok('before approval the build cannot be started', (await api(`/executions/${m.e}/handoff`, 'ho_dev', 'POST', { agent: 'code' })).status === 409);
await api(`/executions/${m.e}/review`, 'ho_dev', 'POST', { verdict: 'approve', choice: 'A' });
await sleep(600);
ok('design-only: approving starts nothing', (await stagesOf(m.t)).length === 1);
ok('only the reviewer can start the build', (await api(`/executions/${m.e}/handoff`, 'ho_owner', 'POST', { agent: 'code' })).status === 403);
const h = await api(`/executions/${m.e}/handoff`, 'ho_dev', 'POST', { agent: 'code' });
ok('the reviewer starts the build', h.status === 202 && !!h.body?.executionId, h);
ok('it cannot be started twice', (await api(`/executions/${m.e}/handoff`, 'ho_dev', 'POST', { agent: 'code' })).status === 409);
const mc = await waitFor(async () => { const x = (await api(`/executions/${h.body.executionId}`, 'ho_dev')).body; return x.status === 'awaiting_review' && x; });
ok('the manual build delivers a static site too', !!mc && mc.artifacts.some((a) => a.type === 'file'), mc?.artifacts.map((a) => a.type));

await db.query('delete from projects where id = $1', [P.id]);
await db.query('delete from users where username = any($1)', [U]);
await db.end();
