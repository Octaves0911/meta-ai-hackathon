// Live check of "raised before" cards and spoken-name assignment against a running backend + AI service.
//   BACKEND_URL=http://localhost:4100 DATABASE_URL=... node scripts/smoke-recall.mjs
// One speaker (zed) reads a script; Priya/Sam are project members, Rohit is not. Prints how long each card took.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const B = process.env.BACKEND_URL ?? 'http://localhost:4000';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const api = async (path, user, method = 'GET', json) => {
  const r = await fetch(B + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sfx = Math.random().toString(36).slice(2, 6);
const names = { zed: `zed${sfx}`, priya: `priya_${sfx}`, sam: `sam_${sfx}` };
for (const u of Object.values(names)) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', names.zed, 'POST', { name: `Recall ${sfx}` })).body;
const M = (await api(`/projects/${P.id}/meetings`, names.zed, 'POST', { title: 'Atlas sync', inviteeIds: [id(names.priya), id(names.sam)] })).body.id;
for (const u of Object.values(names)) await api(`/meetings/${M}/join`, u, 'POST');
await api(`/meetings/${M}/ai-assist`, names.zed, 'PUT', { enabled: true });
await db.query('insert into project_members select $1, id, \'member\' from users where username = any($2) on conflict do nothing', [P.id, [names.priya, names.sam]]);

let seq = 0;
const say = async (text) => { await db.query('insert into transcript_segments(meeting_id, speaker_name, user_id, text, seq) values ($1,$2,$3,$4,$5)', [M, names.zed, id(names.zed), text, ++seq]); return Date.now(); };
const cards = async () => (await api(`/meetings/${M}/messages?limit=80`, names.zed)).body.filter((x) => x.kind === 'ai_insight').map((x) => x.insight);
const waitCard = async (kind, ms = 45000) => { const t = Date.now(); while (Date.now() - t < ms) { const c = (await cards()).find((i) => i.kind === kind && !seen.has(i.id)); if (c) { seen.add(c.id); return c; } await sleep(300); } return null; };
const seen = new Set();
let fail = 0;
const check = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, extra ?? ''); if (!cond) fail = 1; };

await say('We decided to launch on November 20.'); await sleep(7000);
await say('Priya will send the pricing deck to leadership by Friday.'); await sleep(7000);
let t0 = await say("Actually, let's push the launch to November 25th.");
let c = await waitCard('conflict');
check('launch date change is flagged as a conflict', !!c && /20/.test(c.body), c && `${((Date.now() - t0) / 1000).toFixed(1)}s: ${c.title} | ${c.body}`);

t0 = await say('Sam, please send the pricing deck to leadership by Friday.');
c = await waitCard('update');
check('same task given to someone else is flagged as an update', !!c && /priya/i.test(c.body), c && `${((Date.now() - t0) / 1000).toFixed(1)}s: ${c.title} | ${c.body}`);

await say('Rohit will draft the support onboarding guide by Monday.'); await sleep(9000);
const tasks = (await api(`/meetings/${M}/tasks`, names.zed)).body.tasks;
const by = (re) => tasks.find((t) => re.test(t.title));
const deck = tasks.filter((t) => /pricing deck/i.test(t.title));
check('first deck task resolved Priya (username priya_xxxx) from the spoken name', deck.some((t) => t.assignedTo?.username === names.priya), deck.map((t) => t.assignedTo?.username));
check('second deck task resolved Sam', deck.some((t) => t.assignedTo?.username === names.sam));
const guide = by(/guide/i);
check('non-member keeps the spoken name', !!guide && !guide.assignedTo && guide.assigneeName === 'Rohit', guide && { assignedTo: guide.assignedTo, assigneeName: guide.assigneeName });
check('assigned-by is the speaker', tasks.every((t) => t.assignedBy?.username === names.zed));
await db.end();
process.exit(fail);
