// End-to-end smoke test of the golden scenario (PRD §F5) using the rules fallback (no LLM).
// Start the backend first:  INSIGHTS_LLM=off INSIGHT_TICK_MS=300 npm start -w @meetpilot/backend
// Then: npm run smoke:insights -w @meetpilot/backend   (needs DATABASE_URL in the environment)
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
const seg = async (m, seq, who, text) => db.query('insert into transcript_segments(meeting_id, speaker_name, text, seq) values ($1,$2,$3,$4)', [m, who, text, seq]);
const chatCards = async (m, user) => (await api(`/meetings/${m}/messages?limit=50`, user)).body.filter((x) => x.kind === 'ai_insight');

const U = ['n1', 'n2', 'n3'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'n1', 'POST', { name: 'Insights' })).body;
const mk = async (title) => (await api(`/projects/${P.id}/meetings`, 'n1', 'POST', { title, inviteeIds: [id('n2')] })).body.id;
const join = async (m) => { for (const u of ['n1', 'n2']) await api(`/meetings/${m}/join`, u, 'POST'); };

// ---- Meeting 1: decide the deployment date; it is recorded as a decision ----
const M1 = await mk('Release planning'); await join(M1);
await api(`/meetings/${M1}/ai-assist`, 'n1', 'PUT', { enabled: true });
await seg(M1, 1, 'n1', 'We decided to deploy on August 1.');
ok('decision recorded from speech', await waitFor(async () => (await db.query("select 1 from decisions where meeting_id=$1 and entity_key='deployment_date' and value='August 1'", [M1])).rowCount));
ok('knowledge event stored', (await db.query('select 1 from knowledge_events where meeting_id=$1', [M1])).rowCount === 1);
await sleep(1200);
ok('no re-processing: still 1 event', (await db.query('select 1 from knowledge_events where meeting_id=$1', [M1])).rowCount === 1);
await api(`/meetings/${M1}/end`, 'n1', 'POST'); await sleep(500);

// ---- Meeting 2 ----
const M2 = await mk('Sprint sync'); await join(M2);
const s1 = io(B, { auth: { username: 'n1' } }); const s2 = io(B, { auth: { username: 'n2' } });
await Promise.all([new Promise((r) => s1.on('connect', r)), new Promise((r) => s2.on('connect', r))]);
for (const s of [s1, s2]) await new Promise((r) => s.emit('room:join', { meetingId: M2 }, r));
const seen = []; s2.on('insight:new', (p) => seen.push(p)); const aiState = []; s2.on('ai:assist', (p) => aiState.push(p.enabled));
const working = []; s2.on('ai:working', (p) => working.push(p.done));

await api(`/meetings/${M2}/ai-assist`, 'n2', 'PUT', { enabled: true });
const brief = await waitFor(async () => (await chatCards(M2, 'n1')).find((c) => c.insight.kind === 'brief'));
ok('AI switch broadcast to the room', aiState[0] === true);
ok('brief posted with prior decision', brief && /deployment date August 1/.test(brief.insight.body), brief);
await api(`/meetings/${M2}/ai-assist`, 'n1', 'PUT', { enabled: true });
await sleep(300);
ok('brief is not repeated', (await chatCards(M2, 'n1')).filter((c) => c.insight.kind === 'brief').length === 1);

await seg(M2, 1, 'n2', "Let's ship on September 5.");
const conflict = await waitFor(async () => (await chatCards(M2, 'n1')).find((c) => c.insight.kind === 'conflict'));
ok('conflict card in chat', !!conflict);
ok('conflict names its source and value', conflict && /Release planning/.test(conflict.insight.sourceLabel) && /decided deployment on August 1\./.test(conflict.insight.body), conflict?.insight);
ok('conflict delivered live to the room', seen.some((p) => p.insight.kind === 'conflict' && p.tier === 'interrupt'));
ok('old decision superseded by the new one', (await db.query("select 1 from decisions where meeting_id=$1 and superseded_by is not null", [M1])).rowCount === 1);

// "as we agreed" with no record -> silent AI Notes only
await seg(M2, 2, 'n2', 'As we agreed last week, budget is 40k.');
const norec = await waitFor(async () => (await api(`/meetings/${M2}/insights?tier=feed`, 'n1')).body.find((i) => i.kind === 'no_record'));
ok('no_record goes to AI Notes feed', !!norec && norec.deliveredToChat === false);
ok('no_record is not in the chat', !(await chatCards(M2, 'n1')).some((c) => c.insight.kind === 'no_record'));

// @ai
const asked = await api(`/meetings/${M2}/messages`, 'n1', 'POST', { body: '@ai when is the deployment date?' });
ok('@ai message accepted', asked.status === 201);
const answer = await waitFor(async () => (await chatCards(M2, 'n2')).find((c) => c.insight.kind === 'answer'));
ok('@ai answer cites memory (August 1)', answer && /August 1/.test(answer.insight.body), answer?.insight);
ok('answer quotes the question', answer && /deployment date/.test(answer.insight.quote ?? ''));
ok('spinner events: working then done', working[0] === false && working.at(-1) === true, working);

// feedback
ok('feedback accepted', (await api(`/insights/${conflict.insight.id}/feedback`, 'n1', 'POST', { value: 'dismissed' })).status === 204);
ok('no feedback on a brief', (await api(`/insights/${brief.insight.id}/feedback`, 'n1', 'POST', { value: 'helpful' })).status === 400);
ok('feedback stored', (await db.query("select feedback from insights where id=$1", [conflict.insight.id])).rows[0].feedback === 'dismissed');

// access
ok('outsider cannot read AI notes', (await api(`/meetings/${M2}/insights`, 'n3')).status === 404);
await db.query("insert into insights(meeting_id, project_id, kind, tier, title, body, audience_user_id) values ($1,$2,'external','feed','private','secret',$3)", [M2, P.id, id('n1')]);
ok('private insight hidden from others', !(await api(`/meetings/${M2}/insights`, 'n2')).body.some((i) => i.title === 'private'));
ok('private insight visible to its owner', (await api(`/meetings/${M2}/insights`, 'n1')).body.some((i) => i.title === 'private' && i.private));

// AI off: pipeline silent, @ai gets a gentle notice
await api(`/meetings/${M2}/ai-assist`, 'n1', 'PUT', { enabled: false });
const before = (await db.query('select count(*)::int n from insights where meeting_id=$1', [M2])).rows[0].n;
await seg(M2, 3, 'n2', "Let's ship on October 1.");
const notice = new Promise((r) => s2.once('insight:new', (p) => p.ephemeral && r(p)));
await api(`/meetings/${M2}/messages`, 'n2', 'POST', { body: '@ai anything?' });
ok('@ai while off => notice only to asker', /off/i.test((await Promise.race([notice, sleep(2000).then(() => ({ insight: { title: '' } }))])).insight.title));
await sleep(1000);
ok('AI off => no new insights generated', (await db.query('select count(*)::int n from insights where meeting_id=$1', [M2])).rows[0].n === before);

// recap at the end
await api(`/meetings/${M2}/ai-assist`, 'n1', 'PUT', { enabled: true });
await api(`/meetings/${M2}/end`, 'n1', 'POST');
const recap = await waitFor(async () => (await chatCards(M2, 'n1')).find((c) => c.insight.kind === 'recap'));
ok('recap lists the quiet no_record note', recap && /No record found/.test(recap.insight.body), recap?.insight);
await sleep(500);
ok('recap posted once', (await chatCards(M2, 'n1')).filter((c) => c.insight.kind === 'recap').length === 1);

s1.disconnect(); s2.disconnect();
for (const u of U) await api(`/users/${id(u)}`, u, 'DELETE');
await db.end();
process.exit(process.exitCode ?? 0);
