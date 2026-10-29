// Smoke test: communication agent drafts a threaded reply from the user's mailbox; sending is explicit, permissioned,
// confirmed, audited and duplicate-proof. Uses a FAKE Google. Start (same DATABASE_URL / INTERNAL_SECRET):
//   AI service:  AGENTS_MODE=mock uvicorn main:app --port 5001
//   connector:   (env as in smoke-connector.mjs, with GOOGLE_REDIRECT_URI pointing at the backend callback)
//   backend:     INSIGHTS_LLM=off INSIGHT_TICK_MS=300 JOBS_TICK_MS=300 npm start -w @meetpilot/backend
// Then: npm run smoke:send -w @meetpilot/connector
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const B = 'http://localhost:4000';
const api = async (path, user, method = 'GET', json) => {
  const r = await fetch(B + '/api' + path, { method, redirect: 'manual', headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const text = r.status === 204 || r.status === 302 ? null : await r.text();
  return { status: r.status, location: r.headers.get('location'), body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
};
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '').slice(0, 400)); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };
const b64 = (s) => Buffer.from(s).toString('base64url');

// ---------------- fake Google ----------------
const G = { sent: [], failNextSend: false, tokens: 0 };
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); let body = ''; for await (const c of req) body += c;
  const form = new URLSearchParams(body);
  if (u.pathname === '/token') { G.tokens++; return form.get('code') === 'send-code' ? json(res, 200, { access_token: `AT-send-${G.tokens}`, refresh_token: `RT-send-${G.tokens}`, expires_in: 3600 }) : json(res, 200, { access_token: `AT-read-${G.tokens}`, refresh_token: `RT-read-${G.tokens}`, expires_in: 3600 }); }
  if (u.pathname === '/revoke') return json(res, 200, {});
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer AT-')) return json(res, 401, {});
  if (u.pathname === '/oauth2/v3/userinfo') return json(res, 200, { email: 'alice@example.com' });
  if (u.pathname === '/gmail/v1/users/me/labels') return json(res, 200, { labels: [{ id: 'Label_1', name: 'Finance', type: 'user' }] });
  if (u.pathname === '/gmail/v1/users/me/messages/send') {
    if (!auth.startsWith('Bearer AT-send-')) return json(res, 403, { error: 'insufficientPermissions' });
    if (G.failNextSend) { G.failNextSend = false; return json(res, 500, {}); }
    const p = JSON.parse(body); G.sent.push({ raw: Buffer.from(p.raw, 'base64url').toString('utf8'), threadId: p.threadId }); return json(res, 200, { id: `sent-${G.sent.length}`, threadId: p.threadId ?? `new-${G.sent.length}` });
  }
  if (u.pathname === '/gmail/v1/users/me/messages') return json(res, 200, { messages: [{ id: 'm1' }] });
  if (u.pathname === '/gmail/v1/users/me/messages/m1') return json(res, 200, { id: 'm1', threadId: 'T-dana', payload: { headers: [
    { name: 'From', value: '"Dana Lee" <dana@example.com>' }, { name: 'Subject', value: 'Q3 budget' }, { name: 'Message-ID', value: '<dana-1@mail.example.com>' }, { name: 'Date', value: new Date().toUTCString() }],
    mimeType: 'text/plain', body: { data: b64('Can you confirm the Q3 budget for marketing?') } } });
  json(res, 404, {});
});
await new Promise((r) => server.listen(9095, r));

// ---------------- scenario ----------------
const U = ['sue', 'mallory'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'sue', 'POST', { name: 'Send' })).body;
const oauth = async (body, code) => { const s = await api(`/projects/${P.id}/connections/google/start`, 'sue', 'POST', body); if (!s.body?.url) return { start: s }; const cb = await api(`/connections/google/callback?code=${code}&state=${new URL(s.body.url).searchParams.get('state')}`); return { start: s, cb }; };

// mailbox with a thread from Dana
const first = await oauth({ services: ['gmail'] }, 'good-code');
const gm = (await api(`/projects/${P.id}/connections`, 'sue')).body[0];
await api(`/connections/${gm.id}`, 'sue', 'PUT', { labels: ['Label_1'], lookbackDays: 30 });
await waitFor(async () => (await db.query('select 1 from external_items where connection_id=$1', [gm.id])).rowCount === 1);
const meta = (await db.query('select meta from external_items where connection_id=$1', [gm.id])).rows[0]?.meta;
ok('mail sync keeps sender address, thread id and Message-ID', meta?.fromEmail === 'dana@example.com' && meta?.threadId === 'T-dana' && meta?.messageId === '<dana-1@mail.example.com>', meta);

// meeting -> tasks -> agents
const M = (await api(`/projects/${P.id}/meetings`, 'sue', 'POST', { title: 'Follow-ups' })).body.id;
await api(`/meetings/${M}/join`, 'sue', 'POST');
const seg = (seq, text) => db.query("insert into transcript_segments(meeting_id, user_id, speaker_name, text, seq) values ($1,$2,'Sue',$3,$4)", [M, id('sue'), text, seq]);
await seg(1, 'Can you reply to Dana about the budget?');
await seg(2, 'Can you email Zed about the party?');
await waitFor(async () => (await db.query('select 1 from tasks where meeting_id=$1', [M])).rowCount === 2);
await api(`/meetings/${M}/end`, 'sue', 'POST');
const execs = await waitFor(async () => { const r = (await api('/reviews?scope=needs_review', 'sue')).body; return r.length === 2 && r; });
const dana = execs.find((e) => /Dana/.test(e.taskTitle)), zed = execs.find((e) => /Zed/.test(e.taskTitle));
const det = async (e, user = 'sue') => (await api(`/executions/${e.id}`, user)).body;
const draftOf = (d) => d.artifacts.find((a) => a.type === 'email_draft');
let dDana = await det(dana), dZed = await det(zed);
ok('reply goes to the real address of the person named, in their thread', JSON.stringify(draftOf(dDana).payload.to) === '["dana@example.com"]' && draftOf(dDana).payload.subject === 'Re: Q3 budget' && draftOf(dDana).payload.thread_id === 'T-dana' && draftOf(dDana).payload.in_reply_to === '<dana-1@mail.example.com>' && draftOf(dDana).payload.missing_recipients === false, draftOf(dDana).payload);
ok('the sources used are cited', draftOf(dDana).payload.sources.some((s) => /Gmail · Dana Lee/.test(s)), draftOf(dDana).payload.sources);
ok('no address is invented when nobody matches', draftOf(dZed).payload.to.length === 0 && draftOf(dZed).payload.missing_recipients === true && draftOf(dZed).payload.open_questions.length > 0);

// sending rules
const send = (e, aid, user = 'sue', confirm = true) => api(`/executions/${e.id}/send-email`, user, 'POST', { artifactId: aid, confirm });
const aDana = draftOf(dDana).id;
ok('cannot send before approval', (await send(dana, aDana)).status === 409);
ok('approve the draft', (await api(`/executions/${dana.id}/review`, 'sue', 'POST', { verdict: 'approve' })).status === 204);
ok('sending needs explicit confirmation', (await send(dana, aDana, 'sue', false)).status === 400 && (await api(`/executions/${dana.id}/send-email`, 'sue', 'POST', { artifactId: aDana })).status === 400);
ok('only the reviewer can send', (await send(dana, aDana, 'mallory')).status === 404);
dDana = await det(dana);
ok('permission state shown: send not yet allowed', dDana.send.granted === false && dDana.send.sent.length === 0, dDana.send);
const noPerm = await send(dana, aDana);
ok('first send asks for the separate send permission', noPerm.status === 409 && noPerm.body.error.code === 'send_permission_required' && G.sent.length === 0, noPerm.body);
ok('failed attempt leaves no send record', (await db.query('select 1 from email_sends es join executions e on e.id = es.execution_id join tasks t on t.id = e.task_id where t.project_id = $1', [P.id])).rowCount === 0);

// request the send permission
const ret = `/reviews/${dana.id}?send=1`;
const ask = await api(`/projects/${P.id}/connections/google/start`, 'sue', 'POST', { services: ['gmail'], sendAccess: true, returnTo: ret });
const scope = new URL(ask.body.url).searchParams.get('scope');
ok('permission request adds gmail.send (and keeps read access)', /gmail\.send/.test(scope) && /gmail\.readonly/.test(scope), scope);
ok('send access cannot be combined with Drive; return path must be in-app', (await api(`/projects/${P.id}/connections/google/start`, 'sue', 'POST', { services: ['gmail', 'drive'], sendAccess: true })).status === 400
  && (await api(`/projects/${P.id}/connections/google/start`, 'sue', 'POST', { services: ['gmail'], sendAccess: true, returnTo: '//evil.example.com' })).status === 400);
const grant = await api(`/connections/google/callback?code=send-code&state=${new URL(ask.body.url).searchParams.get('state')}`);
ok('consent returns the user to the review page', grant.status === 302 && grant.location === `http://localhost:5173${ret}`, grant.location);
const conn = (await api(`/projects/${P.id}/connections`, 'sue')).body.find((c) => c.provider === 'gmail');
ok('existing mail setup is kept (not reset) after granting send', conn.id === gm.id && conn.status === 'connected' && conn.config.labels.length === 1 && conn.itemCount === 1, conn);
dDana = await det(dana);
ok('permission state shown: send allowed for the connected account', dDana.send.granted === true && dDana.send.account === 'alice@example.com', dDana.send);

// the send
const sent = await send(dana, aDana);
ok('approved, confirmed email is sent', sent.status === 200 && sent.body.messageId === 'sent-1' && sent.body.from === 'alice@example.com' && sent.body.to[0] === 'dana@example.com', sent.body);
const raw = G.sent[0]?.raw ?? '';
ok('message is a threaded reply with the approved text', /^From: alice@example.com\r\nTo: dana@example.com\r\nSubject: Re: Q3 budget\r\n/.test(raw) && /In-Reply-To: <dana-1@mail\.example\.com>/.test(raw) && /References: <dana-1@mail\.example\.com>/.test(raw) && G.sent[0].threadId === 'T-dana', raw);
ok('body is exactly the approved draft', Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n') === draftOf(dDana).payload.body);
dDana = await det(dana);
ok('every send is logged on the run (audit)', dDana.send.sent.length === 1 && dDana.send.sent[0].messageId === 'sent-1' && dDana.send.sent[0].to[0] === 'dana@example.com' && dDana.send.sent[0].subject === 'Re: Q3 budget' && dDana.send.sent[0].from === 'alice@example.com', dDana.send);
ok('the same message cannot be sent twice', (await send(dana, aDana)).status === 409 && G.sent.length === 1);

// double click on another draft + limits
const aZed = draftOf(dZed).id;
const draftPut = (to, cc = [], subject = 'Party', body = 'Hi Zed') => api(`/executions/${zed.id}/artifacts/${aZed}`, 'sue', 'PUT', { to, cc, subject, body });
const many = Array.from({ length: 11 }, (_, i) => `u${i}@example.com`);
ok('11 recipients rejected (to + cc counted together)', (await draftPut(many.slice(0, 6), many.slice(6, 11))).status === 400 && (await draftPut(many)).status === 400);
ok('subject with a line break rejected', (await draftPut(['zed@example.com'], [], 'Hi\r\nBcc: evil@example.com')).status === 400);
ok('subject > 300 and body > 50000 rejected', (await draftPut(['zed@example.com'], [], 'x'.repeat(301))).status === 400 && (await draftPut(['zed@example.com'], [], 's', 'x'.repeat(50001))).status === 400);
ok('invalid address rejected', (await draftPut(['zed@@example'])).status === 400);
ok('a valid draft is accepted', (await draftPut(['zed@example.com'])).status === 200);
await api(`/executions/${zed.id}/review`, 'sue', 'POST', { verdict: 'approve' });
const both = await Promise.all([send(zed, aZed), send(zed, aZed)]);
ok('double-click: exactly one send goes out', both.map((r) => r.status).sort().join() === '200,409' && G.sent.length === 2, both.map((r) => r.status));

// a failed send can be retried; nothing is left claimed
const t = (await db.query("insert into tasks(meeting_id, project_id, title, finalized) values ($1,$2,'Email Fay about lunch', true) returning id", [M, P.id])).rows[0].id;
const ex = (await db.query("insert into executions(task_id, agent, status, reviewer_id, revision) values ($1,'communication','approved',$2,0) returning id", [t, id('sue')])).rows[0].id;
const art = (await db.query("insert into execution_artifacts(execution_id, revision, type, title, payload) values ($1,0,'email_draft','Email draft',$2) returning id", [ex, { to: ['fay@example.com'], cc: [], subject: 'Lunch', body: 'Lunch?' }])).rows[0].id;
G.failNextSend = true;
const fail = await send({ id: ex }, art);
ok('Gmail failure is reported and leaves nothing claimed', fail.status === 502 && fail.body.error.code === 'send_failed' && (await db.query('select 1 from email_sends where execution_id=$1', [ex])).rowCount === 0, fail.body);
ok('retry after a definite failure succeeds', (await send({ id: ex }, art)).status === 200 && G.sent.length === 3);

// only email drafts of the communication agent
const research = (await db.query("insert into executions(task_id, agent, status, reviewer_id) values ((select id from tasks where meeting_id=$1 limit 1), 'research', 'approved', $2) on conflict (task_id) do update set agent = 'research' returning id", [M, id('sue')])).rows[0].id;
ok('non-email runs cannot send', (await send({ id: research }, art)).status === 400);
ok('send is logged in the database with a dedupe hash', (await db.query('select 1 from email_sends es join executions e on e.id = es.execution_id join tasks t on t.id = e.task_id where t.project_id = $1 and es.message_hash is not null', [P.id])).rowCount === 3);

server.close();
for (const u of U) await api(`/users/${id(u)}`, u, 'DELETE');
await db.end();
process.exit(process.exitCode ?? 0);
