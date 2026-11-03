// Live check of the agent core with the REAL model: brief (what was said + current decision), confidence, steps, cost,
// override of a task left for a human, and the internal step endpoint's auth.
// Needs Postgres + AI service (real LLM key) + backend, all on matching ports, and only ONE backend using this database:
//   BACKEND_PORT=4100 AI_URL=http://localhost:5101 npm start -w @meetpilot/backend
//   BACKEND_URL=http://localhost:4100 DATABASE_URL=... npm run smoke:agent-core -w @meetpilot/backend
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const B = process.env.BACKEND_URL ?? 'http://localhost:4000';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const api = async (path, user, method = 'GET', json, extra = {}) => {
  const r = await fetch(B + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}), ...extra }, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
};
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '').slice(0, 400)); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 120000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(1000); } return null; };

const U = ['core_priya', 'core_omar'];
for (const u of U) await api('/api/users', null, 'POST', { username: u });
const users = (await api('/api/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/api/projects', 'core_priya', 'POST', { name: 'Agent core' })).body;
const M = (await api(`/api/projects/${P.id}/meetings`, 'core_priya', 'POST', { title: 'Launch sync', inviteeIds: [id('core_omar')] })).body.id;
for (const u of U) await api(`/api/meetings/${M}/join`, u, 'POST');
const say = (seq, who, text) => db.query('insert into transcript_segments(meeting_id, user_id, speaker_name, text, seq) values ($1,$2,$3,$4,$5)', [M, id(who), who, text, seq]);
await say(1, 'core_omar', "Let's launch the product on November 15.");
await say(2, 'core_omar', 'Actually the build slipped, so we are moving the launch to November 22.');
await say(3, 'core_priya', 'I will email leadership the new launch date by tomorrow.');
await say(4, 'core_omar', 'Omar will water the plants by Friday.');
// The extractor works while the meeting is live: wait until it has produced the tasks, then end the meeting (which finalizes and routes them).
const extracted = await waitFor(async () => (await db.query('select count(*)::int n from tasks where meeting_id = $1', [M])).rows[0].n >= 2, 90000);
ok('tasks were extracted from the transcript', !!extracted, (await db.query('select title from tasks where meeting_id=$1', [M])).rows);
await api(`/api/meetings/${M}/end`, 'core_priya', 'POST');

const email = await waitFor(async () => {
  const r = await db.query(`select e.*, t.title from executions e join tasks t on t.id = e.task_id where t.meeting_id = $1 and e.agent = 'communication' and e.status = 'awaiting_review'`, [M]);
  return r.rows[0];
});
ok('the email task was routed to communication and reached review', !!email, (await db.query('select t.title, e.status, e.agent, e.error from executions e join tasks t on t.id=e.task_id where t.meeting_id=$1', [M])).rows);
if (email) {
  const d = (await api(`/api/executions/${email.id}`, 'core_priya')).body;
  const art = d.artifacts.find((a) => a.type === 'email_draft');
  const body = `${art?.payload?.subject ?? ''}\n${art?.payload?.body ?? ''}`;
  ok('router recorded its confidence and plan', d.routeConfidence != null && d.routeConfidence >= 0.6 && d.stagePlan?.stages?.[0]?.agent === 'communication', { rc: d.routeConfidence, sp: d.stagePlan });
  // The new date must appear, and the old one only as history ("originally", "moved from", "changed", "instead of"…).
  const oldOnlyAsHistory = [...body.matchAll(/november 15/gi)].every((m) => /(originally|previous|earlier|moved|changed|rescheduled|instead|slip|from|was)/i.test(body.slice(Math.max(0, m.index - 80), m.index + 80)));
  ok('draft uses the CURRENT launch date (22nd); the old date only as history', /november 22|22(?:nd)? nov/i.test(body) && oldOnlyAsHistory, body);
  ok('no invented recipient (nobody gave an address)', Array.isArray(art?.payload?.to) && art.payload.to.length === 0 && art.payload.missing_recipients === true, art?.payload);
  ok('confidence is recorded (0..1)', typeof d.confidence === 'number' && d.confidence > 0 && d.confidence <= 1, d.confidence);
  ok('needs-your-input lists the missing recipient', d.openQuestions.some((q) => /receive|recipient|address/i.test(q)), d.openQuestions);
  ok('step trace recorded (read, draft, check)', ['read', 'draft', 'check'].every((k) => d.steps.some((s) => s.kind === k && s.status === 'done')), d.steps.map((s) => `${s.kind}:${s.status}`));
  ok('usage and cost recorded', d.usage?.calls >= 2 && d.usage.costUsd > 0 && d.usage.models.length > 0, d.usage);
  const dup = (await db.query('select count(*)::int n from execution_steps where execution_id=$1 and revision=$2', [email.id, email.revision])).rows[0].n;
  ok('streamed and final steps are one row each (no duplicates)', dup === d.steps.length, { dup, steps: d.steps.length });
}

// the internal step endpoint accepts only the shared secret
const bad = await api(`/api/internal/executions/${email?.id ?? '00000000-0000-0000-0000-000000000000'}/steps`, null, 'POST', { revision: 0, seq: 9, kind: 'tool', label: 'x', status: 'done' }, { 'x-internal-secret': 'wrong-secret' });
ok('step endpoint rejects a wrong secret', bad.status === 401, bad);

// a task left for a human can be run by the reviewer anyway
const plants = await waitFor(async () => (await db.query(`select e.id, e.status, e.reviewer_id from executions e join tasks t on t.id = e.task_id where t.meeting_id = $1 and e.status = 'skipped_human'`, [M])).rows[0], 15000);
ok('"water the plants" is left for a human', !!plants);
if (plants) {
  const stranger = await api(`/api/executions/${plants.id}/run-with`, 'core_omar', 'POST', { agent: 'research' });
  const reviewerName = (await db.query('select username from users where id=$1', [plants.reviewer_id])).rows[0].username;
  ok('only the reviewer may override', [403, 404].includes(stranger.status) || reviewerName === 'core_omar', stranger);
  const run = await api(`/api/executions/${plants.id}/run-with`, reviewerName, 'POST', { agent: 'research' });
  ok('reviewer can run a specialist anyway', run.status === 202, run);
  const again = await api(`/api/executions/${plants.id}/run-with`, reviewerName, 'POST', { agent: 'research' });
  ok('cannot override twice', again.status === 409, again);
  const done = await waitFor(async () => (await db.query("select status, confidence from executions where id=$1 and status in ('awaiting_review','failed')", [plants.id])).rows[0], 150000);
  ok('overridden run completes with a confidence score', done?.status === 'awaiting_review' && done.confidence != null, done);
}

// Research uses the web (real search) and never the project's private terms; the owner's switch turns the web off.
const runResearch = async (title, description) => {
  const t = (await db.query("insert into tasks(meeting_id, project_id, title, description, finalized, assigned_to) values ($1,$2,$3,$4,true,$5) returning id", [M, P.id, title, description, id('core_priya')])).rows[0].id;
  const x = (await db.query("insert into executions(task_id, agent, status, reviewer_id, error) values ($1,'research','failed',$2,'x') returning id", [t, id('core_priya')])).rows[0].id;
  await api(`/api/executions/${x}/retry`, 'core_priya', 'POST');
  return waitFor(async () => { const d = (await api(`/api/executions/${x}`, 'core_priya')).body; return ['awaiting_review', 'failed'].includes(d.status) && d; }, 170000);
};
const on = await runResearch('Compare Slack and Microsoft Teams pricing', 'Compare the paid pricing of Slack and Microsoft Teams');
ok('research searched the web and listed verified sources', on?.status === 'awaiting_review' && on.usage?.searches >= 1 && on.artifacts.some((x) => x.type === 'link' && x.payload.items?.length >= 1), { status: on?.status, searches: on?.usage?.searches, types: on?.artifacts.map((x) => x.type), q: on?.openQuestions });
ok('sources are web pages and the report names the search date', !!on && on.artifacts.filter((x) => x.type === 'link').every((x) => x.payload.items.every((i) => /^https?:\/\//.test(i.url))) && /searched on \d{4}-\d{2}-\d{2}/.test(on.artifacts.find((x) => x.type === 'markdown').payload.content), on?.artifacts.map((x) => x.title));
ok('search cost is part of the run cost and confidence is recorded', on?.usage?.costUsd > 0 && typeof on.confidence === 'number', on?.usage);
const hasSteps = on?.steps.some((x) => x.kind === 'search' && x.status === 'done');
ok('the trace shows the search step', !!hasSteps, on?.steps.map((x) => `${x.kind}:${x.status}`));
await api(`/api/projects/${P.id}/settings`, 'core_priya', 'PATCH', { noExternalLookups: true });
const off = await runResearch('Compare Slack and Microsoft Teams pricing again', 'Compare the paid pricing of Slack and Microsoft Teams');
ok('with external lookups off there is no web search and the report says so', off?.status === 'awaiting_review' && !(off.usage?.searches > 0) && !off.artifacts.some((x) => x.type === 'link') && /No web search was used/.test(off.artifacts.find((x) => x.type === 'markdown').payload.content) && off.openQuestions.some((q) => /off for this project/.test(q)), { status: off?.status, searches: off?.usage?.searches, q: off?.openQuestions });

await db.query('delete from projects where id = $1', [P.id]);
await db.query('delete from users where username = any($1)', [U]);
await db.end();
