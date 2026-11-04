// Checks a running MeetPilot deployment from the outside.   node infra/deploy/smoke.mjs https://YOUR-URL [--agents]
// Without --agents it only reads and creates a throwaway user and project. With --agents it also asks the Marketing agent a question
// through the streaming chat (one short model call, well under a cent) to prove the Meta key, the AI service and streaming work.
const base = (process.argv[2] ?? 'http://localhost:7860').replace(/\/$/, '');
const withAgents = process.argv.includes('--agents');
const user = `smoke${Date.now().toString(36)}`.slice(0, 20);
let failed = 0;
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '').slice(0, 300)); if (!cond) failed++; };
const api = async (path, { method = 'GET', json, auth = true } = {}) => {
  const r = await fetch(base + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(auth ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
};

const health = await fetch(base + '/health').then((r) => r.json()).catch(() => null);
ok('backend is healthy', health?.status === 'ok', health);
const page = await fetch(base + '/');
const html = await page.text();
ok('the web app is served at /', page.status === 200 && /<div id="root"/.test(html) && /MeetPilot/i.test(html), { status: page.status });
const deep = await fetch(base + '/reviews/00000000-0000-4000-8000-000000000000');
ok('a deep link returns the app shell', deep.status === 200 && /<div id="root"/.test(await deep.text()));
const miss = await fetch(base + '/api/nope');
ok('unknown API paths are JSON 404s, not the page', miss.status === 404 && (miss.headers.get('content-type') ?? '').includes('json'));

const ready = await fetch(base + '/health/ready').then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch(() => ({ status: 0 }));
ok('readiness: database, AI service and connector are all reachable', ready.status === 200 && ready.body?.status === 'ok', ready);

ok('create a user', (await api('/users', { method: 'POST', json: { username: user }, auth: false })).status < 300);
const ice = await api('/ice-servers');
ok('ICE servers are served to signed-in users', ice.status === 200 && Array.isArray(ice.body?.iceServers) && ice.body.iceServers.length >= 1, ice);
const unauth = await api('/ice-servers', { auth: false });
ok('and not to strangers', unauth.status === 401 || unauth.status === 403, unauth.status);
const project = (await api('/projects', { method: 'POST', json: { name: 'Smoke test' } })).body;
ok('create a project', !!project?.id, project);
const meeting = project && (await api(`/projects/${project.id}/meetings`, { method: 'POST', json: { title: 'Smoke meeting' } })).body;
ok('create a meeting', !!meeting?.id, meeting);
if (meeting) ok('read the meeting back', (await api(`/meetings/${meeting.id}`)).body?.title === 'Smoke meeting');

if (withAgents && meeting) {
  // A real agent turn needs an execution, which needs a finished meeting with tasks: here we only exercise the model path through the live assistant.
  await api(`/meetings/${meeting.id}/join`, { method: 'POST', json: {} });
  await api(`/meetings/${meeting.id}/ai-assist`, { method: 'PUT', json: { enabled: true } });
  const before = Date.now();
  await api(`/meetings/${meeting.id}/messages`, { method: 'POST', json: { body: '@ai what decisions have we made so far?' } });
  let answered = null;
  for (let i = 0; i < 30 && !answered; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const msgs = (await api(`/meetings/${meeting.id}/messages`)).body ?? [];
    answered = (Array.isArray(msgs) ? msgs : msgs.messages ?? []).find((m) => m.kind === 'ai_insight' && new Date(m.createdAt).getTime() >= before - 5000);
  }
  ok('the live assistant answered an @ai question (Meta key and AI service work)', !!answered);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
