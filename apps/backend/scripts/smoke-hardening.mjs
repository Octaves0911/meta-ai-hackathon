// Smoke test for rate limits, request ids, security headers, metrics, readiness and analytics.
// Start the backend with a low limit:  RATE_LIMIT_PER_MIN=20 INSIGHTS_LLM=off INSIGHT_TICK_MS=300 AGENTS_ENABLED=false npm start
// Then: npm run smoke:hardening -w @meetpilot/backend   (needs DATABASE_URL and INTERNAL_SECRET in the environment)
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const B = 'http://localhost:4000';
const SECRET = process.env.INTERNAL_SECRET;
const raw = (path, user, method = 'GET', json, headers = {}) =>
  fetch(B + path, { method, headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}), ...headers }, body: json !== undefined ? JSON.stringify(json) : undefined });
const api = async (path, user, method = 'GET', json) => { const r = await raw('/api' + path, user, method, json); const t = r.status === 204 ? null : await r.text(); return { status: r.status, headers: r.headers, body: (() => { try { return JSON.parse(t); } catch { return t; } })() }; };
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '').slice(0, 300)); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };
const metrics = async () => (await raw('/metrics', null, 'GET', undefined, { 'x-internal-secret': SECRET })).text();

const U = ['hq', 'hr', 'hs', 'ha', 'hother'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;

// ---- request ids + security headers ----
const r1 = await raw('/api/users', null, 'GET', undefined, { 'x-request-id': 'trace-abc.123' });
ok('a caller-supplied x-request-id is echoed', r1.headers.get('x-request-id') === 'trace-abc.123');
const r2 = await raw('/api/users', null, 'GET', undefined, { 'x-request-id': 'bad id with spaces <script>' });
ok('unsafe request ids are replaced by a generated uuid', /^[0-9a-f-]{36}$/.test(r2.headers.get('x-request-id')), r2.headers.get('x-request-id'));
ok('every response has a request id', /^[0-9a-f-]{36}$/.test((await raw('/api/users')).headers.get('x-request-id')));
ok('security headers on API responses', r1.headers.get('x-content-type-options') === 'nosniff' && r1.headers.get('x-frame-options') === 'DENY' && r1.headers.get('referrer-policy') === 'no-referrer' && r1.headers.get('cache-control') === 'no-store');

// ---- health ----
const live = await raw('/health'); const ready = await raw('/health/ready');
const rb = await ready.json();
ok('liveness is trivial and ready checks the database and dependencies', live.status === 200 && ready.status === 200 && rb.db === 'ok' && ['ok', 'degraded'].includes(rb.status) && 'ai' in rb && 'connector' in rb && rb.uptimeSec >= 0, rb);

// ---- general rate limit ----
const statuses = [];
for (let i = 0; i < 30; i++) statuses.push((await raw('/api/projects', 'hq')).status);
const first429 = statuses.indexOf(429);
ok('requests beyond the per-user limit get 429', first429 > 0 && first429 <= 21 && statuses.slice(first429).every((s) => s === 429), statuses);
const limited = await raw('/api/projects', 'hq'); const lb = await limited.json();
ok('429 carries Retry-After and the standard error envelope', limited.status === 429 && Number(limited.headers.get('retry-after')) >= 1 && lb.error.code === 'rate_limited' && limited.headers.get('x-ratelimit-limit') === '20', [limited.headers.get('retry-after'), lb]);
ok('other users are unaffected and health checks are exempt', (await raw('/api/projects', 'hother')).status === 200 && (await raw('/health')).status === 200 && (await raw('/health/ready')).status === 200);

// ---- per-route budget (send-email: 6/min) ----
const sendStatuses = [];
const fake = '00000000-0000-4000-8000-000000000000';
for (let i = 0; i < 9; i++) sendStatuses.push((await raw(`/api/executions/${fake}/send-email`, 'hr', 'POST', { artifactId: fake, confirm: true })).status);
ok('sensitive endpoints have a stricter budget (6/min)', sendStatuses.slice(0, 6).every((s) => s !== 429) && sendStatuses.slice(6).every((s) => s === 429), sendStatuses);

// ---- body limit ----
const big = await raw('/api/users', 'hs', 'POST', { username: 'x'.repeat(3 * 1024 * 1024) });
ok('oversized request bodies are refused with 413', big.status === 413 && (await big.json()).error.code, big.status);
const badJson = await fetch(B + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
ok('malformed JSON is a 400, not a server error', badJson.status === 400 && !!(await badJson.json()).error, badJson.status);

// ---- analytics + metrics ----
const P = (await api('/projects', 'ha', 'POST', { name: 'Ops' })).body;
const M = (await api(`/projects/${P.id}/meetings`, 'ha', 'POST', { title: 'Secret roadmap meeting' })).body.id;
await api(`/meetings/${M}/join`, 'ha', 'POST');
await api(`/meetings/${M}/ai-assist`, 'ha', 'PUT', { enabled: true });
await api(`/meetings/${M}/messages`, 'ha', 'POST', { body: '@ai what is our confidential launch date?' });
await db.query("insert into transcript_segments(meeting_id, user_id, speaker_name, text, seq) values ($1,$2,'ha','I will send the confidential budget report by Friday.',1)", [M, id('ha')]);
await waitFor(async () => (await db.query("select 1 from events where name='task_created' and meeting_id=$1", [M])).rowCount);
await api(`/meetings/${M}/end`, 'ha', 'POST');
await waitFor(async () => (await db.query("select 1 from events where name='meeting_closed' and meeting_id=$1", [M])).rowCount);
const ev = (await db.query('select name, props, user_id, project_id from events where meeting_id=$1 order by id', [M])).rows;
const names = ev.map((e) => e.name);
ok('product events are recorded for the whole journey', ['meeting_created', 'meeting_joined', 'ai_assist_toggled', 'ai_question_asked', 'task_created', 'meeting_closed'].every((n) => names.includes(n)), names);
ok('events hold ids and categories only: no chat, transcript or meeting titles', !JSON.stringify(ev).match(/confidential|roadmap|budget report/i), ev);
ok('properties are allow-listed and typed (e.g. duration, enabled)', ev.find((e) => e.name === 'meeting_closed').props.durationSec >= 0 && ev.find((e) => e.name === 'ai_assist_toggled').props.enabled === true);
ok('insight events carry kind and tier', (await db.query("select props from events where name='insight_posted' and meeting_id=$1", [M])).rows.every((r) => r.props.kind && r.props.tier));
ok('metrics endpoint refuses callers without the internal secret', (await raw('/metrics')).status === 401 && (await raw('/metrics', null, 'GET', undefined, { 'x-internal-secret': 'wrong' })).status === 401);
const m = await metrics();
ok('HTTP counters use route templates (no ids in labels)', /http_requests_total\{method="GET",route="\/api\/projects",status="200"\} \d+/.test(m) && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(m.split('\n').filter((l) => l.startsWith('http_requests_total')).join('\n')), m.split('\n').filter((l) => l.startsWith('http_requests_total')).slice(0, 5));
ok('latency histogram, gauges and runtime stats are exposed', /http_request_duration_seconds_bucket\{.*le="0.1"\}/.test(m) && /meetpilot_websocket_clients \d+/.test(m) && /meetpilot_db_pool_connections\{state="total"\}/.test(m) && /process_uptime_seconds [\d.]+/.test(m) && /meetpilot_jobs/.test(m));
ok('rate-limit rejections are counted per scope', /meetpilot_rate_limited_total\{scope="general"\} [1-9]/.test(m) && /meetpilot_rate_limited_total\{scope="send_email"\} [1-9]/.test(m));
ok('analytics counters are exposed', /meetpilot_events_total\{event="meeting_created"\} [1-9]/.test(m) && /meetpilot_events_total\{event="insight_posted"/.test(m) || /meetpilot_events_total\{event="task_created"\} [1-9]/.test(m));
ok('pipeline timing is exposed', /meetpilot_insight_pass_seconds_count \d+/.test(m), m.split('\n').filter((l) => /insight_pass/.test(l)).slice(0, 2));

// events outlive the people and projects they describe (no foreign keys)
await api(`/projects/${P.id}`, 'ha', 'DELETE'); await api(`/users/${id('ha')}`, 'ha', 'DELETE');
ok('analytics survive deletion of the user/project', (await db.query('select 1 from events where meeting_id=$1', [M])).rowCount >= 6);

// ---- startup safety ----
const child = spawnSync('npx', ['tsx', 'src/index.ts'], { env: { ...process.env, NODE_ENV: 'production', INTERNAL_SECRET: 'dev-only-change-me', BACKEND_PORT: '4999' }, encoding: 'utf8', timeout: 30000 });
ok('production refuses to start with the example secret', child.status === 1 && /refusing to start/.test(child.stderr), [child.status, child.stderr.slice(0, 200)]);

for (const u of U.filter((x) => x !== 'ha')) await api(`/users/${id(u)}`, u, 'DELETE').catch(() => {});
await db.end();
process.exit(process.exitCode ?? 0);
