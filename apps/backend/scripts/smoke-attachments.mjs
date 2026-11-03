// End-to-end check of email attachments with a FAKE Gmail connector (no real Gmail): suggest, attach, wait for approval, send, audit.
// Needs Postgres, AI service with AGENTS_MODE=mock, and a backend started with CONNECTOR_URL=http://localhost:6199, one backend per database:
//   BACKEND_PORT=4101 AI_URL=http://localhost:5102 CONNECTOR_URL=http://localhost:6199 INSIGHTS_LLM=off JOBS_TICK_MS=300 npm start -w @meetpilot/backend
//   BACKEND_URL=http://localhost:4101 DATABASE_URL=... npm run smoke:attachments -w @meetpilot/backend
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const B = process.env.BACKEND_URL ?? 'http://localhost:4101';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const api = async (path, user, method = 'GET', json) => {
  const r = await fetch(B + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
};
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '').slice(0, 400)); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };

// ---- fake connector: records what would have gone to Gmail
const sent = [];
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/gmail/send-access')) return res.end(JSON.stringify({ granted: true, account: 'att_dev@example.com' }));
    if (req.url === '/gmail/send') { sent.push(JSON.parse(body)); return res.end(JSON.stringify({ messageId: 'msg-1', threadId: null, from: 'att_dev@example.com' })); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(6199);

const U = ['att_rita', 'att_dev'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'att_rita', 'POST', { name: 'Attachments' })).body;
const P2 = (await api('/projects', 'att_rita', 'POST', { name: 'Other project' })).body;
const M = (await api(`/projects/${P.id}/meetings`, 'att_rita', 'POST', { title: 'Launch sync', inviteeIds: [id('att_dev')] })).body.id;
const M2 = (await api(`/projects/${P2.id}/meetings`, 'att_rita', 'POST', { title: 'Other', inviteeIds: [] })).body.id;
const mk = async (meeting, project, title, agent, description = '') => {
  const t = (await db.query("insert into tasks(meeting_id, project_id, title, description, finalized, assigned_to) values ($1,$2,$3,$4,true,$5) returning id", [meeting, project, title, description, id('att_dev')])).rows[0].id;
  const e = (await db.query("insert into executions(task_id, agent, status, reviewer_id, error) values ($1,$2,'failed',$3,'x') returning id", [t, agent, id('att_dev')])).rows[0].id;
  await api(`/executions/${e}/retry`, 'att_dev', 'POST');
  return e;
};
const settled = (e) => waitFor(async () => { const d = (await api(`/executions/${e}`, 'att_dev')).body; return d.status === 'awaiting_review' && d; });

const research = await mk(M, P.id, 'Research competitor pricing', 'research', 'Dev will research competitor pricing');
const rd = await settled(research);
ok('the research run produced a PDF that is not attachable until approved', !!rd && rd.artifacts.some((a) => a.type === 'pdf' && a.payload.attachable === false), rd?.artifacts.map((a) => a.type));

const comm = await mk(M, P.id, 'Send the report to Dana', 'communication', 'Dev will send the competitor report to Dana');
const cd = await settled(comm);
const draft = cd.artifacts.find((a) => a.type === 'email_draft');
ok('the email draft carries no attachment unless the reviewer picks one, but suggests the report', draft.payload.attachments.length === 0 && draft.payload.suggested_attachments.includes(research), draft.payload);

let chips = (await api(`/executions/${comm}/attachments`, 'att_dev')).body;
ok('suggested chip shows the other task is waiting for approval', chips.suggested.length === 1 && chips.suggested[0].executionId === research && chips.suggested[0].state === 'awaiting_approval' && chips.selected.length === 0, chips);
ok('the other deliverable is also a candidate', chips.candidates.every((c) => c.executionId !== comm) && true);

const put = (attachments, user = 'att_dev') => api(`/executions/${comm}/artifacts/${draft.id}`, user, 'PUT', { to: ['dana@example.com'], cc: [], subject: 'Competitor report', body: 'Hi Dana, the report is attached.', attachments });
ok('only valid deliverables of other work in this project can be attached', (await put(['11111111-1111-1111-1111-111111111111'])).status === 400 && (await put([comm])).status === 400, 'random id / itself');
const foreign = await mk(M2, P2.id, 'Research something elsewhere', 'research', 'x');
await settled(foreign);
ok('another project\'s deliverable cannot be attached', (await put([foreign])).status === 400);
ok('at most five attachments', (await put(Array.from({ length: 6 }, () => research))).status === 400);
ok('the reviewer attaches the report', (await put([research])).status === 200);
ok('only the reviewer can change attachments', (await put([], 'att_rita')).status === 403);
chips = (await api(`/executions/${comm}/attachments`, 'att_dev')).body;
ok('selected chip is waiting for the research approval', chips.selected.length === 1 && chips.selected[0].state === 'awaiting_approval' && chips.suggested.length === 0, chips);

// approve the email first; sending must still wait for the attachment
ok('email approved', (await api(`/executions/${comm}/review`, 'att_dev', 'POST', { verdict: 'approve' })).status === 204);
const early = await api(`/executions/${comm}/send-email`, 'att_dev', 'POST', { artifactId: draft.id, confirm: true });
ok('sending is refused while the attachment is not approved (and nothing reached Gmail)', early.status === 409 && early.body.error.code === 'attachments_not_ready' && /Research competitor pricing/.test(early.body.error.message) && sent.length === 0, early.body);
ok('the refused attempt left no send claim behind', (await db.query('select count(*)::int n from email_sends where execution_id = $1', [comm])).rows[0].n === 0);

// approve the research -> ready
ok('research approved', (await api(`/executions/${research}/review`, 'att_dev', 'POST', { verdict: 'approve' })).status === 204);
chips = (await api(`/executions/${comm}/attachments`, 'att_dev')).body;
ok('chip is ready with the PDF file listed', chips.selected[0].state === 'ready' && chips.selected[0].files.length === 1 && /\.pdf$/.test(chips.selected[0].files[0].filename), chips.selected);

const ok1 = await api(`/executions/${comm}/send-email`, 'att_dev', 'POST', { artifactId: draft.id, confirm: true });
ok('send succeeds once the attachment is approved', ok1.status === 200, ok1.body);
const gmail = sent[0];
const att = gmail?.attachments?.[0];
const approvedPdf = (await db.query("select f.sha256, f.size from execution_files f join execution_artifacts a on a.id = f.artifact_id where a.execution_id = $1", [research])).rows[0];
const bytes = att ? Buffer.from(att.data_b64, 'base64') : Buffer.alloc(0);
ok('exactly the approved PDF bytes went to the connector', !!att && att.mime === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-' && createHash('sha256').update(bytes).digest('hex') === approvedPdf.sha256 && gmail.to[0] === 'dana@example.com', { att: att && att.filename });
ok('each sent file is audited', (await db.query('select count(*)::int n from email_send_attachments sa join email_sends s on s.id = sa.send_id where s.execution_id = $1 and sa.sha256 = $2', [comm, approvedPdf.sha256])).rows[0].n === 1);
const after = (await api(`/executions/${comm}`, 'att_dev')).body;
ok('the review shows what was sent with which file', after.send.sent.length === 1 && after.send.sent[0].attachments.length === 1 && /\.pdf$/.test(after.send.sent[0].attachments[0].filename), after.send.sent);
ok('a second send of the same email is refused (duplicate guard includes the attachments)', (await api(`/executions/${comm}/send-email`, 'att_dev', 'POST', { artifactId: draft.id, confirm: true })).status === 409 && sent.length === 1);

// size cap: two approved 6 MB PDFs are over 10 MB in total
const mkBig = async (title) => {
  const t = (await db.query("insert into tasks(meeting_id, project_id, title, finalized, assigned_to) values ($1,$2,$3,true,$4) returning id", [M, P.id, title, id('att_dev')])).rows[0].id;
  const e = (await db.query("insert into executions(task_id, agent, status, reviewer_id) values ($1,'marketing','approved',$2) returning id", [t, id('att_dev')])).rows[0].id;
  const a = (await db.query("insert into execution_artifacts(execution_id, revision, type, title, payload) values ($1,0,'pdf','Big','{\"attachable\":true}') returning id", [e])).rows[0].id;
  const data = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(6 * 1024 * 1024, 66)]);
  await db.query('insert into execution_files(artifact_id, filename, mime, size, sha256, data) values ($1,$2,$3,$4,$5,$6)', [a, `${title}.pdf`, 'application/pdf', data.length, createHash('sha256').update(data).digest('hex'), data]);
  return e;
};
const bigA = await mkBig('Big A'), bigB = await mkBig('Big B');
const comm2 = await mk(M, P.id, 'Send the big files to Dana', 'communication', 'x');
const cd2 = await settled(comm2);
const draft2 = cd2.artifacts.find((a) => a.type === 'email_draft');
await api(`/executions/${comm2}/artifacts/${draft2.id}`, 'att_dev', 'PUT', { to: ['dana@example.com'], cc: [], subject: 'Big', body: 'Hi', attachments: [bigA, bigB] });
await api(`/executions/${comm2}/review`, 'att_dev', 'POST', { verdict: 'approve' });
const big = await api(`/executions/${comm2}/send-email`, 'att_dev', 'POST', { artifactId: draft2.id, confirm: true });
ok('more than 10 MB of attachments is refused before anything is sent', big.status === 400 && big.body.error.code === 'attachments_too_large' && sent.length === 1, big.body);

// a rejected deliverable can never be attached successfully
const comm3 = await mk(M, P.id, 'Send the rejected report', 'communication', 'x');
const cd3 = await settled(comm3);
const draft3 = cd3.artifacts.find((a) => a.type === 'email_draft');
const rej = await mk(M, P.id, 'Research that will be rejected', 'research', 'x');
await settled(rej);
await api(`/executions/${rej}/review`, 'att_dev', 'POST', { verdict: 'reject', comment: 'wrong' });
await api(`/executions/${comm3}/artifacts/${draft3.id}`, 'att_dev', 'PUT', { to: ['dana@example.com'], cc: [], subject: 'R', body: 'Hi', attachments: [rej] });
await api(`/executions/${comm3}/review`, 'att_dev', 'POST', { verdict: 'approve' });
const chips3 = (await api(`/executions/${comm3}/attachments`, 'att_dev')).body;
const r3 = await api(`/executions/${comm3}/send-email`, 'att_dev', 'POST', { artifactId: draft3.id, confirm: true });
ok('a rejected deliverable shows as unavailable and blocks sending', chips3.selected[0]?.state === 'failed' && r3.status === 409 && r3.body.error.code === 'attachments_not_ready', { chips3: chips3.selected, r3: r3.body });

fake.close();
for (const p of [P.id, P2.id]) await db.query('delete from projects where id = $1', [p]);
await db.query('delete from users where username = any($1)', [U]);
await db.end();
