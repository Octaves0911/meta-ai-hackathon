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
