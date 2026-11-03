// Live check of the GitHub client against real GitHub. Public repositories need no token (anonymous limit: 60 requests/hour, ~7 per repo).
//   cd apps/connector && npx tsx scripts/github-live-check.ts [owner/name ...]
// With a token (private repos, push permission):  GITHUB_TOKEN=... npx tsx scripts/github-live-check.ts owner/private-repo
import { GithubClient, GithubError } from '../src/github.js';

const repos = process.argv.slice(2).length ? process.argv.slice(2) : ['octocat/Hello-World', 'expressjs/express'];
const client = new GithubClient();
const token = process.env.GITHUB_TOKEN || null;
let failed = 0;
for (const r of repos) {
  const [owner, name] = r.split('/');
  try {
    const t0 = Date.now();
    const i = await client.inspect(owner, name, token);
    console.log(`PASS ${r}: ${i.meta.defaultBranch}, ${i.meta.isPrivate ? 'private' : 'public'}, push=${i.meta.canPush}, ${Date.now() - t0} ms, index ${i.indexText.length} chars`);
    console.log(i.indexText.split('\n').map((l) => `   ${l.slice(0, 160)}`).join('\n'));
  } catch (e) { failed++; console.log(`FAIL ${r}: ${(e as GithubError).code ?? ''} ${(e as Error).message}`); }
}
try { await client.repo('octocat', 'this-repo-does-not-exist-123456'); failed++; console.log('FAIL missing repo should be an error'); }
catch (e) { console.log(e instanceof GithubError && e.code === 'repo_not_found' ? 'PASS a missing repo is reported as not found' : `FAIL unexpected ${e}`); if (!(e instanceof GithubError && e.code === 'repo_not_found')) failed++; }
process.exit(failed ? 1 : 0);
