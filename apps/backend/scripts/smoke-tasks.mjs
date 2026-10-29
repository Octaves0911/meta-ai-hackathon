// Smoke test: tasks from speech (AI off), idempotency, paging, edits, end-of-meeting finalize, transcript import.
// Start the backend first:  INSIGHTS_LLM=off INSIGHT_TICK_MS=300 npm start -w @meetpilot/backend
// Then: npm run smoke:tasks -w @meetpilot/backend   (needs DATABASE_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const pg = require('pg');
const B = 'http://localhost:4000';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const api = async (path, user, method = 'GET', json) => {
  const r = await fetch(B + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '')); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };

// dates the way the server resolves them (UTC)
// "today" in the server's time zone, the same way the server resolves it
const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.MEETING_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const today = new Date(`${localToday}T00:00:00Z`); const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + n)); return iso(d); };
const nextWeekday = (dow) => addDays(((dow - today.getUTCDay() + 7) % 7) || 7);
const oct31 = (() => { const t = new Date(Date.UTC(today.getUTCFullYear(), 9, 31)); const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())); return iso(t < base ? new Date(Date.UTC(today.getUTCFullYear() + 1, 9, 31)) : t); })();

const U = ['tessa', 'omar', 'zane', 'outsider'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'tessa', 'POST', { name: 'Tasks' })).body;
const mk = async (title) => (await api(`/projects/${P.id}/meetings`, 'tessa', 'POST', { title, inviteeIds: [id('omar'), id('zane')] })).body.id;
const join = async (m) => { for (const u of ['tessa', 'omar', 'zane']) await api(`/meetings/${m}/join`, u, 'POST'); };
const seg = (m, seq, who, text) => db.query('insert into transcript_segments(meeting_id, user_id, speaker_name, text, seq) values ($1,$2,$3,$4,$5)', [m, id(who.toLowerCase()), who, text, seq]);
const list = async (m, q = '', user = 'tessa') => (await api(`/meetings/${m}/tasks${q}`, user)).body;

const M = await mk('Planning'); await join(M);
const s = io(B, { auth: { username: 'tessa' } }); await new Promise((r) => s.on('connect', r));
await new Promise((r) => s.emit('room:join', { meetingId: M }, r));
const upserts = []; s.on('task:upserted', (t) => upserts.push(t));
let ready = null; s.on('meeting:tasks_ready', (p) => (ready = p));

// AI Assistance stays OFF
await seg(M, 1, 'Tessa', 'Omar will update the pricing page by Friday.');
await seg(M, 2, 'Omar', 'I will send the report by October 31.');
await seg(M, 3, 'Tessa', 'Can you draft the launch email tomorrow?');
await seg(M, 4, 'Omar', 'Nice weather today.');
const got = await waitFor(async () => { const l = await list(M); return l.tasks.length === 3 && l; });
ok('3 tasks created from speech with AI off', !!got, got);
const by = Object.fromEntries((got?.tasks ?? []).map((t) => [t.title, t]));
const pricing = by['Update the pricing page'], report = by['Send the report'], email = by['Draft the launch email'];
ok('title cleaned of commitment phrasing', !!pricing && !!report && !!email, Object.keys(by));
ok('assignee + assigner (the speaker) + resolved weekday due', pricing?.assignedTo?.username === 'omar' && pricing?.assignedBy?.username === 'tessa' && pricing?.dueDate === nextWeekday(5), pricing);
ok('volunteer is assigned by themselves; month-day due', report?.assignedTo?.username === 'omar' && report?.assignedBy?.username === 'omar' && report?.dueDate === oct31, report);
ok('"can you" has no assignee, "tomorrow" resolved', email?.assignedTo === null && email?.assignedBy?.username === 'tessa' && email?.dueDate === addDays(1), email);
ok('description keeps the spoken sentence; creation date set', /Omar will update/.test(pricing?.description ?? '') && !!pricing?.createdAt);
ok('small talk made no task', got.tasks.length === 3);
ok('live task:upserted for each task', upserts.length === 3, upserts.length);
await sleep(1200);
ok('idempotent: re-ticks create no duplicates', (await list(M)).tasks.length === 3);
ok('AI off: no insights and only task events stored', (await db.query('select 1 from insights where meeting_id=$1', [M])).rowCount === 0 && (await db.query('select 1 from knowledge_events where meeting_id=$1', [M])).rowCount === 3);

// listing: newest first, paging, status filter + counts
const p1 = await list(M, '?limit=2'); const p2 = await list(M, `?limit=2&before=${encodeURIComponent(p1.tasks.at(-1).createdAt)}`);
ok('paging newest first', p1.tasks.length === 2 && p2.tasks.length === 1 && p1.tasks[0].createdAt >= p1.tasks[1].createdAt, [p1.tasks.length, p2.tasks.length]);
ok('counts include total', p1.counts.total === 3 && p1.counts.open === 3, p1.counts);
ok('outsider cannot list', (await api(`/meetings/${M}/tasks`, 'outsider')).status === 404);

// edits
ok('assignee marks done', (await api(`/tasks/${pricing.id}`, 'omar', 'PATCH', { status: 'done' })).body.status === 'done');
ok('history logged', (await db.query("select 1 from task_history where task_id=$1 and field='status' and old='open' and new='done'", [pricing.id])).rowCount === 1);
ok('owner assigns an unassigned task', (await api(`/tasks/${email.id}`, 'tessa', 'PATCH', { assignedTo: id('zane'), dueDate: '2030-01-02' })).body.assignedTo.username === 'zane');
ok('unrelated participant forbidden', (await api(`/tasks/${report.id}`, 'zane', 'PATCH', { title: 'hijack' })).status === 403);
ok('assignee must belong to the project/meeting', (await api(`/tasks/${report.id}`, 'tessa', 'PATCH', { assignedTo: id('outsider') })).status === 400);
ok('bad date rejected', (await api(`/tasks/${report.id}`, 'tessa', 'PATCH', { dueDate: 'soon' })).status === 400);
ok('status filter + counts after edit', (await list(M, '?status=done')).tasks.length === 1 && (await list(M)).counts.done === 1);

// a commitment spoken right before the end is still captured by the final pass
await seg(M, 5, 'Tessa', 'Zane will review the budget tomorrow.');
ok('end meeting', (await api(`/meetings/${M}/end`, 'tessa', 'POST')).status === 204);
await waitFor(() => ready);
ok('meeting:tasks_ready broadcast with all tasks', ready?.tasks?.length === 4 && ready.tasks.every((t) => t.finalized), ready);
const late = ready?.tasks?.find((t) => t.title === 'Review the budget');
ok('late commitment captured; assignee resolved', late?.assignedTo?.username === 'zane' && late?.dueDate === addDays(1), late);
ok('tasks finalized in the database', (await db.query('select 1 from tasks where meeting_id=$1 and not finalized', [M])).rowCount === 0);

// import creates tasks too
const M2 = await mk('Imported'); await join(M2); await api(`/meetings/${M2}/end`, 'tessa', 'POST');
const imp = await api(`/meetings/${M2}/transcript/import`, 'tessa', 'POST', { text: 'Tessa: Omar will book the venue by Monday.\nOmar: Sounds good.' });
ok('import accepted', imp.status === 201);
const imported = await waitFor(async () => { const l = await list(M2); return l.tasks.length === 1 && l.tasks[0]; });
ok('task extracted from imported transcript', imported && imported.title === 'Book the venue' && imported.assignedTo?.username === 'omar' && imported.assignedBy?.username === 'tessa' && imported.dueDate === nextWeekday(1), imported);

s.disconnect();
for (const u of U) await api(`/users/${id(u)}`, u, 'DELETE');
await db.end();
process.exit(process.exitCode ?? 0);
