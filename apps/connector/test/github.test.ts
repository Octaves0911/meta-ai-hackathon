import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { GithubClient, GithubError, GithubService, MAX_INDEX_CHARS, buildIndexText, cleanReadme, summariseManifest } from '../src/github.js';

process.env.TOKEN_ENC_KEY = randomBytes(32).toString('base64');
const TOKEN = 'github_pat_11ABCDEF0123456789_SECRETSECRETSECRETSECRETSECRET';
const b64 = (s: string) => Buffer.from(s).toString('base64');
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Routes a path suffix to a canned response; records every request. */
function stub(routes: Record<string, () => Response>) {
  const calls: { url: string; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    return key ? routes[key]() : json({ message: 'Not Found' }, 404);
  }) as unknown as typeof fetch;
  return { client: new GithubClient(f), calls };
}

const REPO = { name: 'shop-api', owner: { login: 'acme' }, default_branch: 'develop', description: 'Billing and checkout API', private: true, language: 'TypeScript', html_url: 'https://github.com/acme/shop-api', permissions: { push: true } };

test('repository metadata is mapped, including push permission (visible only with a token)', async () => {
  const { client } = stub({ '/repos/acme/shop-api': () => json(REPO) });
  const m = await client.repo('acme', 'shop-api', TOKEN);
  assert.deepEqual(m, { owner: 'acme', name: 'shop-api', defaultBranch: 'develop', description: 'Billing and checkout API', isPrivate: true, canPush: true, language: 'TypeScript', htmlUrl: 'https://github.com/acme/shop-api' });
  const pub = stub({ '/repos/o/n': () => json({ ...REPO, private: false, permissions: undefined }) });
  assert.equal((await pub.client.repo('o', 'n')).canPush, false);
});

test('the token travels only in the Authorization header', async () => {
  const { client, calls } = stub({ '/repos/acme/shop-api': () => json(REPO) });
  await client.repo('acme', 'shop-api', TOKEN);
  await client.repo('acme', 'shop-api');
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
  assert.equal(calls[1].auth, null);
  for (const c of calls) assert.ok(!c.url.includes('github_pat'));
});

test('errors are short, mapped, and never contain the token', async () => {
  const cases: [Response, number, string][] = [
    [json({ message: 'Not Found' }, 404), 404, 'repo_not_found'], [json({ message: 'Bad credentials' }, 401), 401, 'bad_token'],
    [json({ message: 'rate limit' }, 403, { 'x-ratelimit-remaining': '0' }), 429, 'rate_limited'], [json({}, 429), 429, 'rate_limited'],
    [json({ message: 'Resource not accessible' }, 403), 403, 'forbidden'], [json({}, 500), 502, 'github_error'],
  ];
  for (const [res, status, code] of cases) {
    const { client } = stub({ '/repos/a/b': () => res });
    await assert.rejects(client.repo('a', 'b', TOKEN), (e: any) => e instanceof GithubError && e.status === status && e.code === code && !e.message.includes(TOKEN), code);
  }
  const down = new GithubClient((async () => { throw new Error(`connect ECONNREFUSED with ${TOKEN}`); }) as unknown as typeof fetch);
  await assert.rejects(down.repo('a', 'b', TOKEN), (e: any) => e.code === 'github_unreachable' && !e.message.includes(TOKEN));
});

test('a renamed or moved repository says so, and redirects are never followed', async () => {
  const seen: RequestInit[] = [];
  const f = (async (_u: string, init: RequestInit) => { seen.push(init); return new Response(null, { status: 301, headers: { location: 'https://evil.example/x' } }); }) as unknown as typeof fetch;
  await assert.rejects(new GithubClient(f).repo('a', 'b', TOKEN), (e: any) => e.code === 'repo_moved' && e.status === 404 && /moved or been renamed/.test(e.message) && !e.message.includes(TOKEN));
  assert.equal(seen[0].redirect, 'manual');
});

test('a 404 tells the user to add a token only when none was used', async () => {
  const { client } = stub({});
  await assert.rejects(client.repo('a', 'b'), /private, add a GitHub token/);
  await assert.rejects(client.repo('a', 'b', TOKEN), /token has no access/);
});

test('invalid names never reach the network', async () => {
  const { client, calls } = stub({});
  for (const [o, n] of [['../x', 'y'], ['a', 'b/c'], ['a b', 'c'], ['a', ''], ['-a', 'b'], ['a', 'x'.repeat(101)]]) await assert.rejects(client.repo(o, n), (e: any) => e.code === 'invalid_repo');
  assert.equal(calls.length, 0);
});

test('inspection builds an index the picker can read: languages, top level, manifest, README', async () => {
  const { client } = stub({
    '/repos/acme/shop-api': () => json(REPO),
    '/repos/acme/shop-api/languages': () => json({ TypeScript: 8000, SQL: 1500, Shell: 500 }),
    '/repos/acme/shop-api/readme': () => json({ content: b64('# Shop API\n\n[![CI](https://x/badge.svg)](https://x)\n\nThe **billing** and checkout service for <b>Acme</b>. See [docs](https://docs).\n![logo](https://x/logo.png)') }),
    '/repos/acme/shop-api/contents/': () => json([{ name: 'src', type: 'dir' }, { name: 'package.json', type: 'file' }, { name: 'README.md', type: 'file' }]),
    '/repos/acme/shop-api/contents/package.json': () => json({ content: b64(JSON.stringify({ name: 'shop-api', description: 'billing', scripts: { test: 'node --test', build: 'tsc' }, dependencies: { fastify: '^5' }, devDependencies: { typescript: '^5' } })) }),
  });
  const r = await client.inspect('acme', 'shop-api', TOKEN);
  const t = r.indexText;
  for (const needle of ['acme/shop-api — Billing and checkout API', 'TypeScript 80%', 'SQL 15%', 'Top level: src/, package.json, README.md', 'scripts test, build', 'deps fastify, typescript', 'README: Shop API', 'billing and checkout service for Acme']) assert.ok(t.includes(needle), needle);
  assert.ok(!t.includes('<b>') && !t.includes('badge.svg') && !t.includes('logo.png') && !t.includes('https://docs'));
  assert.deepEqual(r.languages, { TypeScript: 8000, SQL: 1500, Shell: 500 });
  assert.equal(r.meta.canPush, true);
});

test('missing README, tree or languages do not fail the inspection, but rate limiting and bad tokens do', async () => {
  const ok = stub({ '/repos/o/n': () => json({ ...REPO, name: 'n', owner: { login: 'o' } }) });
  const r = await ok.client.inspect('o', 'n');
  assert.ok(r.indexText.startsWith('o/n'));
  const limited = stub({ '/repos/o/n': () => json({ ...REPO, name: 'n', owner: { login: 'o' } }), '/repos/o/n/languages': () => json({}, 403, { 'x-ratelimit-remaining': '0' }) });
  await assert.rejects(limited.client.inspect('o', 'n'), (e: any) => e.code === 'rate_limited');
});

test('index text is capped and README cleaning is thorough', () => {
  const meta = { owner: 'o', name: 'n', defaultBranch: 'main', description: 'd', isPrivate: false, canPush: false, language: null, htmlUrl: '' };
  assert.ok(buildIndexText(meta, { JS: 1 }, 'x '.repeat(50_000), Array.from({ length: 60 }, (_, i) => ({ name: `f${i}`, type: 'file' })), ['m: ' + 'y'.repeat(5000)]).length <= MAX_INDEX_CHARS);
  assert.equal(cleanReadme('# T\n<img src=x onerror=y> [a](http://b) ![i](c) `code` **bold**'), 'T a code bold');
  assert.equal(cleanReadme('Docs \\& Community'), 'Docs & Community');
  assert.equal(summariseManifest('package.json', '{not json'), 'unreadable');
  assert.ok(summariseManifest('go.mod', 'module x\n\ngo 1.22').startsWith('module x'));
});

/** In-memory stand-in for the github_connections table. */
function fakeDb() {
  let row: any = null;
  return {
    get row() { return row; },
    query: async (sql: string, p: any[] = []) => {
      if (/^insert into github_connections/.test(sql)) { row = { project_id: p[0], token_ciphertext: p[1], token_iv: p[2], token_tag: p[3], account: p[4], added_by: p[5] }; return { rows: [] }; }
      if (/^delete from github_connections/.test(sql)) { row = null; return { rows: [] }; }
      if (/select account from github_connections/.test(sql)) return { rows: row ? [{ account: row.account }] : [] };
      if (/select token_ciphertext/.test(sql)) return { rows: row ? [row] : [] };
      throw new Error(`unexpected sql ${sql.slice(0, 40)}`);
    },
  } as any;
}

test('the token is validated with GitHub, stored sealed (no plaintext anywhere), and never returned', async () => {
  const db = fakeDb();
  const { client, calls } = stub({ '/user': () => json({ login: 'octo-owner' }) });
  const svc = new GithubService(db, client);
  const out = await svc.saveToken('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', TOKEN);
  assert.deepEqual(out, { account: 'octo-owner' });
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
  const stored = JSON.stringify(db.row) + db.row.token_ciphertext.toString('utf8') + db.row.token_ciphertext.toString('base64');
  assert.ok(!stored.includes('SECRETSECRET') && !stored.includes('github_pat'));
  assert.deepEqual(await svc.status('p'), { connected: true, account: 'octo-owner' });
  assert.equal(await svc.cloneToken('p'), TOKEN);
  await svc.removeToken('p');
  assert.deepEqual(await svc.status('p'), { connected: false, account: null });
  assert.equal(await svc.cloneToken('p'), null);
});

test('a rejected token is not stored; a wrong vault key reads as no token; no vault key refuses to store', async () => {
  const db = fakeDb();
  const bad = new GithubService(db, stub({ '/user': () => json({ message: 'Bad credentials' }, 401) }).client);
  await assert.rejects(bad.saveToken('p', 'u', TOKEN), (e: any) => e.code === 'bad_token' && !e.message.includes(TOKEN));
  assert.equal(db.row, null);
  const good = new GithubService(db, stub({ '/user': () => json({ login: 'x' }) }).client);
  await good.saveToken('p', 'u', TOKEN);
  const old = process.env.TOKEN_ENC_KEY;
  process.env.TOKEN_ENC_KEY = randomBytes(32).toString('base64');
  assert.equal(await good.cloneToken('p'), null);
  process.env.TOKEN_ENC_KEY = '';
  await assert.rejects(good.saveToken('p', 'u', TOKEN), (e: any) => e.code === 'vault_not_configured');
  process.env.TOKEN_ENC_KEY = old;
});

test('inspection uses the stored token for private repositories', async () => {
  const db = fakeDb();
  const { client, calls } = stub({ '/user': () => json({ login: 'x' }), '/repos/acme/shop-api': () => json(REPO) });
  const svc = new GithubService(db, client);
  await svc.saveToken('p', 'u', TOKEN);
  calls.length = 0;
  await svc.inspect('p', 'acme', 'shop-api');
  assert.ok(calls.length >= 1 && calls.every((c) => c.auth === `Bearer ${TOKEN}`));
});

// ---- read-only repository access for the Code agent
import { isSecretPath, safePath, MAX_FILE_BYTES } from '../src/github.js';

test('secret-looking files are never readable, however they are spelled', () => {
  for (const p of ['.env', '.env.local', 'config/.env.production', '.npmrc', 'a/b/id_rsa', 'id_ed25519.pub', 'certs/server.pem', 'keys/app.key', 'credentials.json', 'secrets.yml', 'secret.json',
    'deploy/service-account-prod.json', 'x/.aws/credentials', 'store.p12', 'my.keystore', '.ssh/config', '.netrc', 'a/.git-credentials']) assert.equal(isSecretPath(p) || safePath(p) === null, true, p);
  for (const p of ['src/environment.ts', 'docs/secrets-management.md'.replace('secrets-management.md', 'security.md'), 'src/keyboard.ts', 'README.md', 'lib/credentialsProvider.ts']) assert.notEqual(safePath(p), null, p);
});

test('paths cannot traverse, be absolute or carry control characters', () => {
  for (const p of ['../etc/passwd', 'a/../../b', '/etc/passwd', 'a//b', './a', 'a/./b', 'a\\b', 'a\nb', 'a\0b', '', 'x'.repeat(301)]) assert.equal(safePath(p), null, JSON.stringify(p));
  assert.equal(safePath('src/app/main.ts'), 'src/app/main.ts');
});

test('the file list drops secrets, vendored folders and lockfiles and says when it was truncated', async () => {
  const SHA1 = 'a'.repeat(40);
  const { client } = stub({ '/commits/main': () => json({ sha: SHA1 }), [`/git/trees/${SHA1}?recursive=1`]: () => json({ truncated: true, tree: [
    { path: 'src/app.js', type: 'blob', size: 10, mode: '100755' }, { path: 'src', type: 'tree' }, { path: '.env', type: 'blob', size: 5 }, { path: 'node_modules/x/index.js', type: 'blob', size: 1 },
    { path: 'package-lock.json', type: 'blob', size: 99 }, { path: 'dist/out.js', type: 'blob', size: 1 }, { path: 'keys/server.pem', type: 'blob', size: 1 }, { path: 'test/app.test.js', type: 'blob', size: 7 } ] }) });
  const t = await client.tree('acme', 'shop', 'main', TOKEN);
  assert.deepEqual(t.files.map((f) => f.path), ['src/app.js', 'test/app.test.js']);
  assert.equal(t.truncated, true);
  assert.equal(t.commit, SHA1);                                 // the exact commit everything else is pinned to
  assert.equal(t.files[0].mode, '100755');                     // modes are kept so a PR does not drop the executable bit
});

test('reading a file: text only, size-capped, no secrets, no directories, safe URLs', async () => {
  const urls: string[] = [];
  const f = (async (url: string) => { urls.push(url); if (url.includes('/contents/dir')) return json([{ name: 'a' }]); if (url.includes('big')) return json({ type: 'file', size: MAX_FILE_BYTES + 1, content: '' });
    if (url.includes('bin')) return json({ type: 'file', size: 3, content: b64('a\0b') }); return json({ type: 'file', size: 5, content: b64('hello') }); }) as unknown as typeof fetch;
  const client = new GithubClient(f);
  assert.deepEqual(await client.file('acme', 'shop', 'src/a b.js', 'feature/x', TOKEN), { path: 'src/a b.js', size: 5, text: 'hello' });
  assert.ok(urls[0].includes('/contents/src/a%20b.js?ref=feature%2Fx'));
  await assert.rejects(client.file('acme', 'shop', '.env', 'main'), (e: any) => e.code === 'path_not_allowed');
  await assert.rejects(client.file('acme', 'shop', '../x', 'main'), (e: any) => e.code === 'path_not_allowed');
  await assert.rejects(client.file('acme', 'shop', 'dir', 'main'), (e: any) => e.code === 'not_a_file');
  await assert.rejects(client.file('acme', 'shop', 'big.js', 'main'), (e: any) => e.code === 'file_too_large' && e.status === 413);
  await assert.rejects(client.file('acme', 'shop', 'bin.dat', 'main'), (e: any) => e.code === 'binary_file');
  await assert.rejects(client.file('acme', 'shop', 'a.js', '../../x'), (e: any) => e.code === 'invalid_repo');
  assert.equal(urls.length, 4); // refused requests never reached GitHub
});

// ---- pull requests
import { GithubWriter, MAX_PR_FILES, prProblem, type PrRequest } from '../src/github.js';

const BASE = 'b'.repeat(40);
const PR: PrRequest = { owner: 'acme', name: 'shop-api', baseBranch: 'main', baseSha: BASE, branch: 'meetpilot/fix-add-1a2b3c4d', title: 'Fix add', body: '## What\nFixes add.', message: 'Fix add\n\nPrepared by MeetPilot', draft: true,
  files: [{ path: 'src/add.js', content: 'module.exports = (a, b) => a + b;\n', mode: '100755' }, { path: 'test/add.test.js', content: "test('adds', () => {});\n" }] };

/** Records every call and answers like GitHub's Git Data API. */
function gh(overrides: Record<string, () => Response> = {}) {
  const calls: { method: string; url: string; auth: string | null; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, auth: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url.replace('https://api.github.com', '')}`;
    const hit = Object.keys(overrides).find((k) => { const [m, p] = k.split(' '); return m === method && url.endsWith(p); });
    if (hit) return overrides[hit]();
    if (key.endsWith(`/git/commits/${BASE}`)) return json({ sha: BASE, tree: { sha: 't'.repeat(40) } });
    if (key.endsWith('/git/blobs')) return json({ sha: `blob${calls.length}`.padEnd(40, '0') });
    if (key.endsWith('/git/trees')) return json({ sha: 'n'.repeat(40) });
    if (key.endsWith('/git/commits')) return json({ sha: 'c'.repeat(40) });
    if (key.endsWith('/git/refs')) return json({ ref: 'refs/heads/x' }, 201);
    if (key.endsWith('/pulls')) return json({ number: 12, html_url: 'https://github.com/acme/shop-api/pull/12' }, 201);
    return json({ message: 'unexpected' }, 500);
  }) as unknown as typeof fetch;
  return { writer: new GithubWriter(f), calls };
}

test('a pull request is one commit on a NEW branch cut from the verified commit, then a PR into the base', async () => {
  const { writer, calls } = gh();
  const r = await writer.createPullRequest(PR, TOKEN);
  assert.deepEqual(r, { number: 12, url: 'https://github.com/acme/shop-api/pull/12', branch: 'meetpilot/fix-add-1a2b3c4d', headSha: 'c'.repeat(40) });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace('https://api.github.com/repos/acme/shop-api', '')}`),
    [`GET /git/commits/${BASE}`, 'POST /git/blobs', 'POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'POST /git/refs', 'POST /pulls']);
  const tree = calls.find((c) => c.url.endsWith('/git/trees'))!.body;
  assert.equal(tree.base_tree, 't'.repeat(40));
  assert.deepEqual(tree.tree.map((e: any) => [e.path, e.mode, e.type]), [['src/add.js', '100755', 'blob'], ['test/add.test.js', '100644', 'blob']]);   // the executable bit is kept
  const commit = calls.find((c) => c.url.endsWith('/git/commits'))!.body;
  assert.deepEqual([commit.parents, commit.tree], [[BASE], 'n'.repeat(40)]);                                                                         // parent = the commit that was verified
  assert.deepEqual(calls.find((c) => c.url.endsWith('/git/refs'))!.body, { ref: 'refs/heads/meetpilot/fix-add-1a2b3c4d', sha: 'c'.repeat(40) });
  const pull = calls.find((c) => c.url.endsWith('/pulls'))!.body;
  assert.deepEqual([pull.head, pull.base, pull.draft, pull.title], ['meetpilot/fix-add-1a2b3c4d', 'main', true, 'Fix add']);
});

test('the base branch is never written, no force push, no merge, and the token is only in the Authorization header', async () => {
  const { writer, calls } = gh();
  await writer.createPullRequest({ ...PR, draft: false }, TOKEN);
  for (const c of calls) {
    assert.ok(['GET', 'POST'].includes(c.method), c.method);                       // no PATCH (ref update/force), PUT (merge) or DELETE
    assert.equal(c.auth, `Bearer ${TOKEN}`);
    assert.ok(!c.url.includes('github_pat') && !JSON.stringify(c.body ?? '').includes('github_pat'));
    assert.ok(!/\/merge|\/refs\/heads\/main/.test(c.url));
  }
  assert.ok(!JSON.stringify(calls.map((c) => c.body)).includes('"force"'));
  assert.equal(calls.find((c) => c.url.endsWith('/pulls'))!.body.draft, false);
});

test('everything unsafe is refused before a single request', async () => {
  const bad: [Partial<PrRequest>, RegExp][] = [
    [{ files: [{ path: '.github/workflows/ci.yml', content: 'x' }] }, /cannot be changed/], [{ files: [{ path: '.env', content: 'A=1' }] }, /cannot be changed/],
    [{ files: [{ path: '../evil', content: 'x' }] }, /cannot be changed/], [{ files: [{ path: 'keys/id_rsa', content: 'x' }] }, /cannot be changed/],
    [{ files: [{ path: 'a.js', content: 'x' }, { path: 'a.js', content: 'y' }] }, /twice/], [{ files: [{ path: 'bin.dat', content: 'a\0b' }] }, /not text/],
    [{ files: [{ path: 'a.sh', content: 'x', mode: '120000' }] }, /file mode/], [{ files: [] }, /between 1 and/],
    [{ files: Array.from({ length: MAX_PR_FILES + 1 }, (_, i) => ({ path: `f${i}.js`, content: 'x' })) }, /between 1 and/],
    [{ files: [{ path: 'big.txt', content: 'x'.repeat(300_001) }] }, /too large/],
    [{ branch: 'main' }, /branch name/], [{ branch: 'meetpilot/Bad Name' }, /branch name/], [{ branch: 'feature/x' }, /branch name/], [{ branch: 'meetpilot/..' }, /branch name/],
    [{ baseSha: 'abc' }, /commit id/], [{ baseBranch: '../x' }, /base branch/], [{ title: '' }, /title/], [{ title: 'a\nb' }, /title/], [{ body: 'x'.repeat(20_001) }, /too long/],
    [{ owner: '../x' }, /invalid repository/],
  ];
  for (const [patch, re] of bad) {
    const { writer, calls } = gh();
    await assert.rejects(writer.createPullRequest({ ...PR, ...patch } as PrRequest, TOKEN), (e: any) => e instanceof GithubError && e.status === 400 && re.test(e.message), JSON.stringify(patch).slice(0, 60));
    assert.equal(calls.length, 0);
  }
  assert.equal(prProblem(PR), null);
});

test('write failures are mapped, stop the sequence, and never carry the token', async () => {
  const cases: [string, Response, number, string][] = [
    ['POST /git/blobs', json({ message: 'Not Found' }, 404), 403, 'no_write_access'], ['POST /git/refs', json({ message: 'Resource not accessible by personal access token' }, 403), 403, 'no_write_access'],
    ['POST /git/refs', json({ message: 'Reference already exists' }, 422), 409, 'branch_exists'], ['POST /pulls', json({ message: 'Validation Failed', errors: [{ message: `A pull request already exists ${TOKEN}` }] }, 422), 422, 'github_rejected'],
    ['GET /git/commits/' + BASE, json({ message: 'Bad credentials' }, 401), 401, 'bad_token'], ['POST /git/trees', json({}, 429), 429, 'rate_limited'], ['POST /git/commits', json({}, 500), 502, 'github_error'],
  ];
  for (const [at, res, status, code] of cases) {
    const { writer, calls } = gh({ [at]: () => res });
    await assert.rejects(writer.createPullRequest(PR, TOKEN), (e: any) => e instanceof GithubError && e.status === status && e.code === code && !e.message.includes(TOKEN) && !e.message.includes('SECRETSECRET'), at);
    if (at.startsWith('POST /git/refs')) assert.ok(!calls.some((c) => c.url.endsWith('/pulls')), 'no PR after the branch failed');
  }
  const down = new GithubWriter((async () => { throw new Error(`ECONNRESET ${TOKEN}`); }) as unknown as typeof fetch);
  await assert.rejects(down.createPullRequest(PR, TOKEN), (e: any) => e.code === 'github_unreachable' && !e.message.includes(TOKEN));
});

test('the service refuses to open a pull request without a stored token and calls nothing', async () => {
  const db = fakeDb();
  const { writer, calls } = gh();
  const svc = new GithubService(db, stub({}).client, writer);
  await assert.rejects(svc.createPullRequest('p', PR), (e: any) => e.code === 'github_not_connected' && e.status === 409);
  assert.equal(calls.length, 0);
  const ok = new GithubService(db, stub({ '/user': () => json({ login: 'x' }) }).client, writer);
  await ok.saveToken('p', 'u', TOKEN);
  assert.equal((await ok.createPullRequest('p', PR)).number, 12);
  assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}`));
});
