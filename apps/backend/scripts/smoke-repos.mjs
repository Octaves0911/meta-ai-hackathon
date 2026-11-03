// Project repositories and the GitHub token, with a FAKE connector (no GitHub traffic): owner-only changes, validation, duplicates, limits, reindex, token handling.
//   BACKEND_PORT=4101 CONNECTOR_URL=http://localhost:6199 INSIGHTS_LLM=off npm start -w @meetpilot/backend
//   BACKEND_URL=http://localhost:4101 DATABASE_URL=... npm run smoke:repos -w @meetpilot/backend
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const B = process.env.BACKEND_URL ?? 'http://localhost:4101';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const api = async (path, user, method = 'GET', json) => {
  const r = await fetch(B + '/api' + path, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user': user } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const text = r.status === 204 ? '' : await r.text();
  return { status: r.status, text, body: text ? JSON.parse(text) : null };
};
const ok = (name, cond, extra) => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra ?? '').slice(0, 400)); if (!cond) process.exitCode = 1; };

const TOKEN = 'github_pat_11ABCDEF0123456789_abcdefghijklmnopqrstuvwxyz';
let version = 1;
const seen = { inspect: [], tokens: [], purged: 0, deleted: 0 };
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://x');
    const send = (status, o) => { res.statusCode = status; res.end(JSON.stringify(o)); };
    if (url.pathname === '/github/inspect') {
      const b = JSON.parse(body); seen.inspect.push(b);
      if (b.owner === 'missing') return send(404, { error: { code: 'repo_not_found', message: 'Repository not found (if it is private, add a GitHub token first)' } });
      return send(200, { meta: { owner: b.owner, name: b.name, defaultBranch: version === 1 ? 'main' : 'develop', description: `The ${b.name} service`, isPrivate: b.owner === 'acme-private', canPush: true, language: 'TypeScript' },
                        languages: { TypeScript: 9000, SQL: 1000 }, indexText: `${b.owner}/${b.name} — The ${b.name} service\nLanguages: TypeScript 90%\nTop level: src/, package.json` });
    }
    if (url.pathname === '/github/token' && req.method === 'PUT') { seen.tokens.push(JSON.parse(body)); return send(200, { account: 'octo-owner' }); }
    if (url.pathname === '/github/token' && req.method === 'DELETE') { seen.deleted++; res.statusCode = 204; return res.end(); }
    if (url.pathname === '/github/status') return send(200, { connected: seen.tokens.length > seen.deleted, account: seen.tokens.length > seen.deleted ? 'octo-owner' : null });
    if (url.pathname.endsWith('/purge')) { seen.purged++; res.statusCode = 204; return res.end(); }
    send(404, {});
  });
}).listen(6199);

const U = ['rp_owner', 'rp_member', 'rp_stranger'];
for (const u of U) await api('/users', null, 'POST', { username: u });
const users = (await api('/users')).body; const id = (n) => users.find((u) => u.username === n).id;
const P = (await api('/projects', 'rp_owner', 'POST', { name: 'Repos' })).body;
await db.query("insert into project_members values ($1,$2,'member')", [P.id, id('rp_member')]);
const add = (url, user = 'rp_owner', description) => api(`/projects/${P.id}/repos`, user, 'POST', { url, description });

const r1 = await add('https://github.com/acme/shop-api', 'rp_owner', 'Billing and checkout API');
ok('the owner links a repository; details come from GitHub', r1.status === 201 && r1.body.fullName === 'acme/shop-api' && r1.body.defaultBranch === 'main' && r1.body.language === 'TypeScript' && r1.body.description === 'Billing and checkout API' && r1.body.githubDescription === 'The shop-api service' && r1.body.canPush === true && !!r1.body.indexedAt, r1);
ok('the repository index is stored but not sent to the browser', (await db.query('select index_text from project_repos where id=$1', [r1.body.id])).rows[0].index_text.includes('Languages: TypeScript 90%') && !('indexText' in r1.body) && !r1.text.includes('Top level'));
ok('the same repository in another spelling is a duplicate', (await add('acme/SHOP-API.git')).status === 409 && (await add('https://github.com/Acme/Shop-API/tree/main/src')).status === 409);
ok('private repositories are flagged', (await add('https://github.com/acme-private/secrets-service')).body?.isPrivate === true);
for (const [bad, why] of [['https://gitlab.com/a/b', 'other host'], ['http://github.com/a/b', 'http'], ['https://user:pw@github.com/a/b', 'credentials'], ['not a url', 'junk'], ['https://github.com/a', 'no repo'], ['https://github.com/a/..', 'traversal']]) {
  const r = await add(bad);
  ok(`refused: ${why}`, r.status === 400 && r.body.error.code === 'invalid_repo', r);
}
const before = seen.inspect.length;
await add('https://evil.example/a/b');
ok('refused links never reach GitHub', seen.inspect.length === before);
const missing = await add('https://github.com/missing/nothing');
ok('a repository that GitHub cannot find is refused with its reason', missing.status === 404 && missing.body.error.code === 'repo_not_found' && /private/.test(missing.body.error.message), missing);
ok('a failed lookup leaves nothing behind', (await db.query("select count(*)::int n from project_repos where owner='missing'")).rows[0].n === 0);

ok('members can list but not change; strangers see nothing', (await api(`/projects/${P.id}/repos`, 'rp_member')).body.length === 2 && [403, 404].includes((await add('acme/other', 'rp_member')).status) && (await api(`/projects/${P.id}/repos`, 'rp_stranger')).status === 404 && (await add('acme/other', 'rp_stranger')).status === 404);
const rid = r1.body.id;
ok('the owner edits the description the agent reads', (await api(`/projects/${P.id}/repos/${rid}`, 'rp_owner', 'PATCH', { description: 'Payments, invoices, Stripe webhooks' })).body.description === 'Payments, invoices, Stripe webhooks'
  && (await api(`/projects/${P.id}/repos/${rid}`, 'rp_member', 'PATCH', { description: 'x' })).status !== 200);
version = 2;
const re = await api(`/projects/${P.id}/repos/${rid}/reindex`, 'rp_owner', 'POST');
ok('reindex refreshes GitHub data and keeps the owner description', re.status === 200 && re.body.defaultBranch === 'develop' && re.body.description === 'Payments, invoices, Stripe webhooks', re.body);

// limit of 10
let last;
for (let i = 0; i < 12; i++) last = await add(`acme/svc-${i}`);
ok('at most ten repositories per project', last.status === 409 && last.body.error.code === 'too_many_repos' && (await db.query('select count(*)::int n from project_repos where project_id=$1', [P.id])).rows[0].n === 10, last.body);

ok('removing a repository (owner only)', [403, 404].includes((await api(`/projects/${P.id}/repos/${rid}`, 'rp_member', 'DELETE')).status) && (await api(`/projects/${P.id}/repos/${rid}`, 'rp_owner', 'DELETE')).status === 204 && (await api(`/projects/${P.id}/repos/${rid}`, 'rp_owner', 'DELETE')).status === 404);

// GitHub token
ok('status starts disconnected', (await api(`/projects/${P.id}/github`, 'rp_member')).body.connected === false);
ok('only the owner connects a token; junk is refused before it reaches the connector', [403, 404].includes((await api(`/projects/${P.id}/github`, 'rp_member', 'PUT', { token: TOKEN })).status)
  && (await api(`/projects/${P.id}/github`, 'rp_owner', 'PUT', { token: 'has spaces and bad chars!!!!!!!!!' })).status === 400 && seen.tokens.length === 0);
const put = await api(`/projects/${P.id}/github`, 'rp_owner', 'PUT', { token: TOKEN });
ok('the token is validated by the connector and never echoed back', put.status === 200 && put.body.connected === true && put.body.account === 'octo-owner' && !put.text.includes('github_pat') && seen.tokens[0].token === TOKEN && seen.tokens[0].projectId === P.id, put);
ok('status shows the account, not the token', JSON.stringify((await api(`/projects/${P.id}/github`, 'rp_member')).body) === '{"connected":true,"account":"octo-owner"}');
ok('disconnecting removes it', (await api(`/projects/${P.id}/github`, 'rp_owner', 'DELETE')).status === 204 && seen.deleted === 1);
ok('the token is nowhere in the backend database', (await db.query("select count(*)::int n from events where props::text like '%github_pat%'")).rows[0].n === 0);

// deleting the project removes its repos and purges the connector
ok('deleting the project removes its repositories and asks the connector to purge', (await api(`/projects/${P.id}`, 'rp_owner', 'DELETE')).status === 204 && (await db.query('select count(*)::int n from project_repos where project_id=$1', [P.id])).rows[0].n === 0 && seen.purged === 1);

fake.close();
await db.query('delete from users where username = any($1)', [U]);
await db.end();
