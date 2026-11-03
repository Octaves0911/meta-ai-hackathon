// Pull requests from verified code changes, with the mock AI and a FAKE GitHub connector (no GitHub traffic).
//   BACKEND_PORT=4101 AI_URL=http://localhost:5102 CONNECTOR_URL=http://localhost:6199 INSIGHTS_LLM=off JOBS_TICK_MS=300 npm start -w @meetpilot/backend
//   BACKEND_URL=http://localhost:4101 DATABASE_URL=... npm run smoke:pr -w @meetpilot/backend
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const B = process.env.BACKEND_URL ?? 'http://localhost:4101';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const api = async (path, user, method = 'GET', json) => {
  const r = await fetch(B + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
};
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '').slice(0, 500)); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };

// ---- fake connector: GitHub status and the PR call, with switchable behaviour
const fake = { connected: false, prCalls: [], mode: 'ok' };
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const send = (status, o) => { res.statusCode = status; res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/github/status')) return send(200, { connected: fake.connected, account: fake.connected ? 'octo' : null });
    if (req.url === '/github/pr') {
      const b = JSON.parse(body); fake.prCalls.push(b);
      if (fake.mode === 'drop') return req.socket.destroy();
      if (fake.mode === 'no_access') return send(403, { error: { code: 'no_write_access', message: 'The GitHub token cannot push to this repository.' } });
      if (fake.mode === 'branch_exists_once') { fake.mode = 'ok'; return send(409, { error: { code: 'branch_exists', message: 'A branch with that name already exists' } }); }
      return send(200, { number: 40 + fake.prCalls.length, url: `https://github.com/${b.owner}/${b.name}/pull/${40 + fake.prCalls.length}`, branch: b.branch, headSha: 'f'.repeat(40) });
    }
    send(404, {});
  });
}).listen(6199);

const U = ['pr_owner', 'pr_dev', 'pr_other'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'pr_owner', 'POST', { name: 'PRs' })).body;
const M = (await api(`/projects/${P.id}/meetings`, 'pr_owner', 'POST', { title: 'Eng sync with secret plans', inviteeIds: [id('pr_dev')] })).body.id;
const repoId = (await db.query("insert into project_repos(project_id, owner, name, default_branch, description, index_text, language, can_push) values ($1,'acme','shop-api','main','Billing API','x','TypeScript', true) returning id", [P.id])).rows[0].id;
const mk = async (title, agent = 'code') => {
  const t = (await db.query("insert into tasks(meeting_id, project_id, title, description, finalized, assigned_to) values ($1,$2,$3,'Priya said fix it in the meeting',true,$4) returning id", [M, P.id, title, id('pr_dev')])).rows[0].id;
  const e = (await db.query("insert into executions(task_id, agent, status, reviewer_id, error) values ($1,$2,'failed',$3,'x') returning id", [t, agent, id('pr_dev')])).rows[0].id;
  await api(`/executions/${e}/retry`, 'pr_dev', 'POST');
  return e;
};
const settled = (e) => waitFor(async () => { const d = (await api(`/executions/${e}`, 'pr_dev')).body; return d.status === 'awaiting_review' && d; });
const verify = (e) => db.query("update execution_artifacts set payload = jsonb_set(jsonb_set(payload, '{status}', '\"verified\"'), '{mode}', '\"modal\"') where execution_id = $1 and type = 'verification'", [e]);
const approve = (e) => api(`/executions/${e}/review`, 'pr_dev', 'POST', { verdict: 'approve' });
const pr = (e, body = { confirm: true }, user = 'pr_dev') => api(`/executions/${e}/pr`, user, 'POST', body);
const check = (d, key) => d.pr.checks.find((c) => c.key === key);

const e1 = await mk('Fix the billing webhook retry bug');
let d = await settled(e1);
ok('a code change has a pull request state with the files and a safe default description', d.pr && d.pr.repo === 'acme/shop-api' && d.pr.baseBranch === 'main' && /^meetpilot\/fix-the-billing-webhook-retry-bug-[0-9a-f]{8}$/.test(d.pr.branch) && d.pr.files.length >= 1 && d.pr.defaultTitle === 'Fix the billing webhook retry bug', d.pr);
ok('the default description holds no meeting content', !/secret plans|Priya|said|meeting/i.test(d.pr.defaultBody) && /Nothing was merged automatically/.test(d.pr.defaultBody), d.pr.defaultBody);
ok('the browser never receives the file contents a PR would commit', d.artifacts.every((a) => a.type !== 'diff' || !('commit_files' in a.payload)) && !JSON.stringify(d).includes('const c = 4;\\nmodule.exports'), d.artifacts.map((a) => Object.keys(a.payload ?? {})));
ok('not approved: not allowed, and it says why', d.pr.allowed === false && check(d, 'approved').ok === false && /Approve/.test(check(d, 'approved').detail), d.pr.checks);
const early = await pr(e1);
ok('opening a PR before approval is refused with the reasons', early.status === 409 && early.body.error.code === 'pr_not_allowed' && /Approve the change first/.test(early.body.error.message) && fake.prCalls.length === 0, early.body);

await approve(e1);
d = (await api(`/executions/${e1}`, 'pr_dev')).body;
ok('approved but only "not tested" (mock): still not allowed, with the rule spelled out', d.pr.allowed === false && check(d, 'verified').ok === false && /only offered for verified changes/.test(check(d, 'verified').detail) && check(d, 'approved').ok === true, d.pr.checks);
ok('a not-tested change can never be opened, even with confirmation', (await pr(e1)).status === 409 && fake.prCalls.length === 0);

await verify(e1);
d = (await api(`/executions/${e1}`, 'pr_dev')).body;
ok('verified but no GitHub token: not allowed, pointing at project settings', d.pr.allowed === false && check(d, 'verified').ok === true && check(d, 'github').ok === false && /Connect a GitHub token/.test(check(d, 'github').detail), d.pr.checks);
fake.connected = true;
d = (await api(`/executions/${e1}`, 'pr_dev')).body;
ok('everything in place: allowed', d.pr.allowed === true && d.pr.checks.every((c) => c.ok), d.pr.checks);

ok('only the reviewer can open it; confirmation is required; other work has no PR', [403, 404].includes((await pr(e1, { confirm: true }, 'pr_other')).status) && (await pr(e1, { draft: true })).status === 400 && (await pr(e1, { confirm: false })).status === 400
  && (await api(`/executions/${(await mk('Research pricing', 'research'))}/pr`, 'pr_dev', 'POST', { confirm: true })).status === 400);
ok('a multi-line title is refused', (await pr(e1, { confirm: true, title: 'a\nb' })).status === 400);

const made = await pr(e1);
ok('opening the pull request', made.status === 201 && made.body.number >= 41 && /^https:\/\/github\.com\/acme\/shop-api\/pull\/\d+$/.test(made.body.url) && made.body.draft === true, made.body);
const call = fake.prCalls[0];
const dbDiff = (await db.query("select payload from execution_artifacts where execution_id = $1 and type = 'diff'", [e1])).rows[0].payload;
ok('the PR is cut from the verified commit with exactly the verified files, as a draft, with a safe branch', call.baseSha === dbDiff.base_sha && call.baseBranch === 'main' && call.draft === true && /^meetpilot\//.test(call.branch)
  && JSON.stringify(call.files) === JSON.stringify(dbDiff.commit_files.map((f) => ({ path: f.path, content: f.content, mode: f.mode }))) && call.owner === 'acme' && call.name === 'shop-api', call);
ok('the commit message and description carry no meeting content and no secrets', !/secret plans|Priya|said/.test(call.body + call.message + call.title) && !('token' in call) && !JSON.stringify(call).includes('ghs_'), call);
d = (await api(`/executions/${e1}`, 'pr_dev')).body;
ok('the review now shows the pull request and cannot open another', d.pr.pullRequest?.url === made.body.url && d.pr.pullRequest.status === 'open' && d.pr.allowed === false && check(d, 'new').ok === false, d.pr);
const again = await pr(e1);
ok('a second click later is refused', again.status === 409 && ['already_opened', 'pr_not_allowed'].includes(again.body.error.code) && fake.prCalls.length === 1 && (await db.query('select count(*)::int n from pull_requests where execution_id=$1', [e1])).rows[0].n === 1, again.body);

// ---- failures
const e2 = await mk('Add retry logic to the exporter');
await settled(e2); await approve(e2); await verify(e2);
fake.mode = 'no_access';
const denied = await pr(e2);
ok('a token without write access is explained and leaves nothing behind', denied.status === 403 && denied.body.error.code === 'no_write_access' && (await db.query('select count(*)::int n from pull_requests where execution_id=$1', [e2])).rows[0].n === 0, denied.body);
fake.mode = 'branch_exists_once';
const retried = await pr(e2, { confirm: true, draft: false, title: 'Add retry logic (exporter)', body: 'Custom body written by the reviewer.' });
const last = fake.prCalls.at(-1), first = fake.prCalls.at(-2);  // first: the attempt GitHub refused as 'branch exists'; last: the retry
ok('a branch left over from a half-failed attempt gets a fresh name once; overrides are honoured; ready (not draft) works', retried.status === 201 && first.branch !== last.branch && last.branch.startsWith(first.branch) && last.title === 'Add retry logic (exporter)' && last.body === 'Custom body written by the reviewer.' && last.draft === false, { status: retried.status, body: retried.body, calls: fake.prCalls.slice(-3).map((c) => c.branch) });

const e3 = await mk('Cache the report totals');
await settled(e3); await approve(e3); await verify(e3);
fake.mode = 'drop';
const unknown = await pr(e3);
ok('when the outcome is unknown the claim is kept and the user is told to check GitHub', unknown.status === 502 && unknown.body.error.code === 'pr_unconfirmed' && (await db.query("select status from pull_requests where execution_id=$1", [e3])).rows[0]?.status === 'unconfirmed', unknown.body);
fake.mode = 'ok';
ok('a blind retry after an unknown outcome is refused', (await pr(e3)).status === 409);

// ---- two clicks at the same moment (two tabs): exactly one pull request
const e5 = await mk('Retry failed webhooks with backoff');
await settled(e5); await approve(e5); await verify(e5);
const before = fake.prCalls.length;
const [x, y] = await Promise.all([pr(e5), pr(e5)]);
ok('two simultaneous clicks open exactly one pull request', [x.status, y.status].sort().join() === '201,409' && fake.prCalls.length === before + 1 && (await db.query('select count(*)::int n from pull_requests where execution_id=$1', [e5])).rows[0].n === 1, { x: x.status, y: y.status, calls: fake.prCalls.length - before });

// ---- changes requested: a new revision needs its own approval, verification and PR
const e4 = await mk('Validate webhook signatures');
await settled(e4); await approve(e4); await verify(e4);
ok('approved work cannot be sent back for changes', (await api(`/executions/${e4}/review`, 'pr_dev', 'POST', { verdict: 'changes', comment: 'x' })).status === 409);

fake.mode = 'ok';
server.close();
for (const p of [P.id]) await db.query('delete from projects where id = $1', [p]);
await db.query('delete from users where username = any($1)', [U]);
await db.end();
