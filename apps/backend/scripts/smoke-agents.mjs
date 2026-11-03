// Smoke test: finalized tasks -> routing -> agent run -> human review -> revisions -> approval.
// Needs: Postgres, AI service with AGENTS_MODE=mock on :5001 (same INTERNAL_SECRET), and the backend:
//   INSIGHTS_LLM=off INSIGHT_TICK_MS=300 JOBS_TICK_MS=300 npm start -w @meetpilot/backend
// Then: npm run smoke:agents -w @meetpilot/backend   (needs DATABASE_URL)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const B = process.env.BACKEND_URL ?? 'http://localhost:4000';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const api = async (path, user, method = 'GET', json) => {
  const r = await fetch(B + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '')); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };

const U = ['rita', 'dev', 'mallory'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'rita', 'POST', { name: 'Agents' })).body;
const M = (await api(`/projects/${P.id}/meetings`, 'rita', 'POST', { title: 'Kickoff', inviteeIds: [id('dev')] })).body.id;
for (const u of ['rita', 'dev']) await api(`/meetings/${M}/join`, u, 'POST');
const seg = (seq, who, text) => db.query('insert into transcript_segments(meeting_id, user_id, speaker_name, text, seq) values ($1,$2,$3,$4,$5)', [M, id(who.toLowerCase()), who, text, seq]);
await seg(1, 'Rita', 'Dev will research competitor pricing by Friday.');
await seg(2, 'Rita', 'I will design the launch banner by tomorrow.');
await seg(3, 'Rita', 'Can you reply to Dana about the budget?');
await seg(4, 'Rita', 'Dev will call the vendor by Monday.');
await seg(5, 'Rita', 'Dev will water the plants.');
await waitFor(async () => (await db.query('select 1 from tasks where meeting_id=$1', [M])).rowCount === 5);
await api(`/meetings/${M}/end`, 'rita', 'POST');

const execs = await waitFor(async () => { const r = await db.query(`select e.*, t.title from executions e join tasks t on t.id = e.task_id where t.meeting_id=$1`, [M]); return r.rowCount === 5 && r.rows.filter((x) => x.status === 'awaiting_review').length === 3 && r.rows; });
ok('every task has exactly one execution', !!execs && execs.length === 5, execs?.map((e) => e.status));
const by = (t) => execs.find((e) => e.title === t);
const research = by('Research competitor pricing'), design = by('Design the launch banner'), comm = by('Reply to Dana about the budget'), call = by('Call the vendor'), plants = by('Water the plants');
ok('doable tasks awaiting review with the right specialist', research?.agent === 'research' && design?.agent === 'designer' && comm?.agent === 'communication' && [research, design, comm].every((e) => e.status === 'awaiting_review'), execs.map((e) => [e.title, e.agent, e.status]));
ok('human-only and unmatched work left alone with a reason', call?.status === 'skipped_human' && /person/.test(call.route_reason) && plants?.status === 'skipped_human' && plants.agent === null, [call, plants]);
ok('reviewer is the assignee, else the meeting owner', research.reviewer_id === id('dev') && design.reviewer_id === id('rita') && comm.reviewer_id === id('rita'));
ok('category recorded on tasks', (await db.query("select category from tasks where meeting_id=$1 and title='Design the launch banner'", [M])).rows[0].category === 'design');
ok('duplicate execution for a task is impossible', await db.query('insert into executions(task_id) values ($1)', [research.task_id]).then(() => false, () => true));

// notifications + lists
const notes = (await api('/notifications', 'dev')).body.filter((n) => n.type === 'review_ready');
ok('review_ready notification for the reviewer', notes.length === 1 && notes[0].payload.executionId === research.id, notes);
ok('needs-review list per reviewer', (await api('/reviews?scope=needs_review', 'dev')).body.length === 1 && (await api('/reviews?scope=needs_review', 'rita')).body.length === 2);
const all = (await api('/reviews', 'dev')).body; // dev is assigned the research task and both human-only tasks
ok('"all" list shows pending reviews first, then work left for a human', all.length === 3 && all[0].status === 'awaiting_review' && all.slice(1).every((x) => x.status === 'skipped_human' && x.routeReason), all.map((x) => x.status));

// detail + typed deliverables + collaboration
const dDesign = (await api(`/executions/${design.id}`, 'rita')).body;
ok('designer: brief + image, consulted marketing', dDesign.artifacts.some((a) => a.type === 'markdown') && dDesign.artifacts.some((a) => a.type === 'image' && /<svg/.test(a.payload.svg)) && dDesign.consultations.some((c) => c.fromAgent === 'designer' && c.toAgent === 'marketing' && c.depth <= 2), dDesign);
const dComm = (await api(`/executions/${comm.id}`, 'rita')).body;
const draft = dComm.artifacts.find((a) => a.type === 'email_draft');
ok('communication: email draft flags missing recipients (no invented addresses)', draft && draft.payload.to.length === 0 && draft.payload.missing_recipients === true, draft);
ok('detail knows who can review', dComm.canReview === true && (await api(`/executions/${research.id}`, 'rita')).body.canReview === false);
ok('strangers cannot see a review', (await api(`/executions/${research.id}`, 'mallory')).status === 404);

// email draft editing
ok('invalid recipient rejected', (await api(`/executions/${comm.id}/artifacts/${draft.id}`, 'rita', 'PUT', { to: ['not-an-email'], cc: [], subject: 's', body: 'b' })).status === 400);
const edited = await api(`/executions/${comm.id}/artifacts/${draft.id}`, 'rita', 'PUT', { to: ['dana@example.com'], cc: [], subject: 'Budget', body: 'Hi Dana, ...' });
ok('draft edited; recipients no longer missing', edited.status === 200 && edited.body.payload.to[0] === 'dana@example.com' && edited.body.payload.missing_recipients === false, edited.body);

// review rules
ok('only the reviewer can review (owner is not enough)', (await api(`/executions/${research.id}/review`, 'rita', 'POST', { verdict: 'approve' })).status === 403);
ok('request changes needs a comment', (await api(`/executions/${research.id}/review`, 'dev', 'POST', { verdict: 'changes' })).status === 400);
const MAX_REV = 5;
for (let rev = 1; rev <= MAX_REV; rev++) {
  const r = await api(`/executions/${research.id}/review`, 'dev', 'POST', { verdict: 'changes', comment: `round ${rev}: add pricing` });
  ok(`request changes #${rev} accepted`, r.status === 204);
  const d = await waitFor(async () => { const x = (await api(`/executions/${research.id}`, 'dev')).body; return x.status === 'awaiting_review' && x.revision === rev && x; });
  const md = d?.artifacts.find((a) => a.type === 'markdown')?.payload.content ?? '';
  ok(`agent redid the work at revision ${rev} using the feedback`, !!d && md.includes(`round ${rev}: add pricing`) && d.reviews.length === rev, md.slice(0, 200));
}
const afterRevs = (await api(`/executions/${research.id}`, 'dev')).body;
ok('collaboration log is per revision (no duplicates)', new Set(afterRevs.consultations.map((c) => `${c.fromAgent}>${c.toAgent}>${c.question}`)).size === afterRevs.consultations.length, afterRevs.consultations);
ok(`change request #${MAX_REV + 1} refused (max ${MAX_REV} revisions)`, (await api(`/executions/${research.id}/review`, 'dev', 'POST', { verdict: 'changes', comment: 'again' })).status === 409);
ok('approve completes the task', (await api(`/executions/${research.id}/review`, 'dev', 'POST', { verdict: 'approve' })).status === 204
  && (await db.query("select 1 from tasks where id=$1 and status='done'", [research.task_id])).rowCount === 1);
ok('cannot review twice', (await api(`/executions/${research.id}/review`, 'dev', 'POST', { verdict: 'approve' })).status === 409);
ok('approved draft can no longer be edited', (await api(`/executions/${comm.id}/review`, 'rita', 'POST', { verdict: 'approve' })).status === 204
  && (await api(`/executions/${comm.id}/artifacts/${draft.id}`, 'rita', 'PUT', { to: ['x@example.com'], cc: [], subject: 's', body: 'b' })).status === 409);

// generated files: stored, served to the right people, attachable only once approved
const rawGet = (path, user) => fetch(B + '/api' + path, { headers: user ? { 'x-user': user } : {} });
const dApproved = (await api(`/executions/${research.id}`, 'dev')).body;
const pdfArt = dApproved.artifacts.find((x) => x.type === 'pdf');
ok('markdown deliverable also has a PDF artifact with metadata and no raw bytes', !!pdfArt && pdfArt.payload.url === `/artifacts/${pdfArt.id}/file` && pdfArt.payload.size > 500 && pdfArt.payload.pages >= 1 && /\.pdf$/.test(pdfArt.payload.filename) && !('file_b64' in pdfArt.payload), pdfArt);
const fileRes = await rawGet(pdfArt.payload.url, 'dev');
const bytes = Buffer.from(await fileRes.arrayBuffer());
ok('reviewer downloads the real PDF with safe headers', fileRes.status === 200 && fileRes.headers.get('content-type') === 'application/pdf' && fileRes.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(fileRes.headers.get('content-security-policy') ?? '') && bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length === pdfArt.payload.size, { status: fileRes.status, len: bytes.length });
ok('meeting owner can open it; strangers and anonymous cannot', (await rawGet(pdfArt.payload.url, 'rita')).status === 200 && (await rawGet(pdfArt.payload.url, 'mallory')).status === 404 && (await rawGet(pdfArt.payload.url)).status === 401);
ok('approved file is marked attachable', pdfArt.payload.attachable === true, pdfArt.payload);
const designPdf = dDesign.artifacts.find((x) => x.type === 'pdf');
ok('work not yet approved is not attachable', !!designPdf && designPdf.payload.attachable === false, designPdf?.payload);
ok('file bytes follow the artifact (one row per PDF)', (await db.query('select count(*)::int n from execution_files f join execution_artifacts a on a.id = f.artifact_id where a.execution_id = $1', [research.id])).rows[0].n >= 1);

// failed run can be retried
const t = (await db.query("insert into tasks(meeting_id, project_id, title, finalized, assigned_to) values ($1,$2,'Research the market', true, $3) returning id", [M, P.id, id('dev')])).rows[0].id;
const ex = (await db.query("insert into executions(task_id, agent, status, reviewer_id, error) values ($1,'research','failed',$2,'boom') returning id", [t, id('dev')])).rows[0].id;
ok('only failed runs can be retried', (await api(`/executions/${comm.id}/retry`, 'rita', 'POST')).status === 409);
ok('retry accepted', (await api(`/executions/${ex}/retry`, 'dev', 'POST')).status === 204);
ok('failed run recovers and awaits review', !!(await waitFor(async () => (await api(`/executions/${ex}`, 'dev')).body.status === 'awaiting_review')));

// inbox: counts, filters, reject
const counts = (await api('/reviews/counts', 'dev')).body;
ok('sidebar counts: needs-review number', counts.needsReview >= 1 && typeof counts.working === 'number', counts);
const f1 = (await api(`/reviews?group=needs_review&project=${P.id}&agent=research`, 'dev')).body;
ok('filters combine (group + project + agent)', f1.some((x) => x.id === ex) && f1.every((x) => x.status === 'awaiting_review' && x.agent === 'research' && x.projectId === P.id && x.projectName === 'Agents'), f1.map((x) => [x.status, x.agent]));
ok('unknown group / agent / project are refused', (await api('/reviews?group=bogus', 'dev')).status === 400 && (await api('/reviews?agent=bogus', 'dev')).status === 400 && (await api('/reviews?project=nope', 'dev')).status === 404);
ok('reject needs a reason', (await api(`/executions/${ex}/review`, 'dev', 'POST', { verdict: 'reject' })).status === 400);
ok('only the reviewer can reject', (await api(`/executions/${ex}/review`, 'rita', 'POST', { verdict: 'reject', comment: 'no' })).status === 403);
ok('reject accepted', (await api(`/executions/${ex}/review`, 'dev', 'POST', { verdict: 'reject', comment: 'Wrong market entirely' })).status === 204);
const rej = (await api(`/executions/${ex}`, 'dev')).body;
ok('rejected: status, reason in history, no longer reviewable', rej.status === 'rejected' && rej.reviews.at(-1).verdict === 'reject' && rej.reviews.at(-1).comment === 'Wrong market entirely' && rej.canReview === false, rej.status);
ok('rejecting hands the task back to a person (open)', (await db.query("select 1 from tasks where id=$1 and status='open'", [t])).rowCount === 1);
ok('rejected work shows under failed/rejected, and cannot be reviewed again', (await api('/reviews?group=problem', 'dev')).body.some((x) => x.id === ex) && (await api(`/executions/${ex}/review`, 'dev', 'POST', { verdict: 'approve' })).status === 409);

// live chat with the agent, then Apply & rerun
const t2 = (await db.query("insert into tasks(meeting_id, project_id, title, description, finalized, assigned_to) values ($1,$2,'Research the market', 'Dev will research the market', true, $3) returning id", [M, P.id, id('dev')])).rows[0].id;
const ex2 = (await db.query("insert into executions(task_id, agent, status, reviewer_id, error) values ($1,'research','failed',$2,'boom') returning id", [t2, id('dev')])).rows[0].id;
await api(`/executions/${ex2}/retry`, 'dev', 'POST');
await waitFor(async () => (await api(`/executions/${ex2}`, 'dev')).body.status === 'awaiting_review');
ok('chat starts empty', (await api(`/executions/${ex2}/messages`, 'dev')).body.length === 0);
ok('only the reviewer can talk to the agent', (await api(`/executions/${ex2}/messages`, 'rita', 'POST', { text: 'hi there friend' })).status === 403);
ok('empty and oversized messages are refused', (await api(`/executions/${ex2}/messages`, 'dev', 'POST', { text: '   ' })).status === 400 && (await api(`/executions/${ex2}/messages`, 'dev', 'POST', { text: 'x'.repeat(2001) })).status === 400);
const q = await api(`/executions/${ex2}/messages`, 'dev', 'POST', { text: 'Where does this come from?' });
ok('a question gets an answer and changes nothing', q.status === 201 && q.body.length === 2 && q.body[0].role === 'user' && q.body[1].role === 'agent' && q.body[1].kind === 'ask' && q.body[1].proposedChange === null, q.body);
ok('rerun with nothing to change is refused', (await api(`/executions/${ex2}/rerun`, 'dev', 'POST', {})).status === 400);
const ch = await api(`/executions/${ex2}/messages`, 'dev', 'POST', { text: 'Add a section about pricing tiers' });
ok('a change request gets a stated plan', ch.status === 201 && ch.body[1].kind === 'change' && /pricing tiers/.test(ch.body[1].proposedChange ?? ''), ch.body);
ok('the owner can read the conversation but not rerun', (await api(`/executions/${ex2}/messages`, 'rita')).body.length === 4 && (await api(`/executions/${ex2}/rerun`, 'rita', 'POST', {})).status === 403);
ok('conversation is private to people on the task', (await api(`/executions/${ex2}/messages`, 'mallory')).status === 404);
const spend0 = (await db.query("select coalesce((usage->>'cost_usd')::numeric,0) c from executions where id=$1", [ex2])).rows[0].c;
const rr = await api(`/executions/${ex2}/rerun`, 'dev', 'POST', { comment: 'Keep it under one page.' });
ok('Apply & rerun accepted', rr.status === 202, rr);
const rerun = await waitFor(async () => { const x = (await api(`/executions/${ex2}`, 'dev')).body; return x.status === 'awaiting_review' && x.revision === 1 && x; });
const md2 = rerun?.artifacts.find((a) => a.type === 'markdown')?.payload.content ?? '';
ok('the agent redid the work with the chat request and the note', !!rerun && md2.includes('Add a section about pricing tiers') && md2.includes('Keep it under one page.'), md2.slice(0, 300));
ok('rerun is recorded as a changes review with the compiled request', rerun.reviews.some((r) => r.verdict === 'changes' && /Changes requested in chat/.test(r.comment)), rerun.reviews);
const old = (await api(`/executions/${ex2}?revision=0`, 'dev')).body;
ok('an earlier revision can be fetched for comparison', old.artifacts.length > 0 && !old.artifacts.find((a) => a.type === 'markdown').payload.content.includes('Keep it under one page.') && old.revision === 1, old.artifacts.map((a) => a.type));
ok('the next rerun does not replay the old request', (await api(`/executions/${ex2}/rerun`, 'dev', 'POST', {})).status === 400);
ok('chat is closed while the agent is working or after approval', (await api(`/executions/${ex2}/review`, 'dev', 'POST', { verdict: 'approve' })).status === 204 && (await api(`/executions/${ex2}/messages`, 'dev', 'POST', { text: 'one more thing please' })).status === 409);

for (const u of U) await api(`/users/${id(u)}`, u, 'DELETE');
await db.end();
process.exit(process.exitCode ?? 0);
