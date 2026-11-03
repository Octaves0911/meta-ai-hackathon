import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGithubRepo, GithubTokenBody, AddRepoBody } from '@meetpilot/shared';

test('accepted repository forms', () => {
  for (const [input, want] of [
    ['https://github.com/octocat/Hello-World', { owner: 'octocat', name: 'Hello-World' }],
    ['https://github.com/octocat/Hello-World.git', { owner: 'octocat', name: 'Hello-World' }],
    ['https://github.com/octocat/Hello-World/', { owner: 'octocat', name: 'Hello-World' }],
    ['https://github.com/octocat/Hello-World/tree/main/src', { owner: 'octocat', name: 'Hello-World' }],
    ['https://github.com/octocat/Hello-World/pull/12', { owner: 'octocat', name: 'Hello-World' }],
    ['https://github.com/octocat/Hello-World?tab=readme', { owner: 'octocat', name: 'Hello-World' }],
    ['  octocat/Hello.World_1  ', { owner: 'octocat', name: 'Hello.World_1' }],
    ['HTTPS://GITHUB.COM/Octo-Cat/repo.js', { owner: 'Octo-Cat', name: 'repo.js' }],
  ] as const) assert.deepEqual(parseGithubRepo(input), want, input);
});

test('everything else is refused: other hosts, credentials, ports, traversal, injection, junk', () => {
  for (const bad of [
    '', '   ', 'octocat', 'https://gitlab.com/octocat/Hello-World', 'http://github.com/octocat/Hello-World', 'https://github.com.evil.example/octocat/Hello-World',
    'https://evil.example/github.com/octocat/Hello-World', 'https://user:pass@github.com/octocat/Hello-World', 'https://github.com:8443/octocat/Hello-World',
    'https://github.com/octocat', 'https://github.com/-bad/repo', 'https://github.com/octocat/..', 'https://github.com/octocat/.', 'git@github.com:octocat/Hello-World.git',
    'octocat/Hello World', 'octocat/Hello\nWorld', 'octocat/repo; rm -rf /', 'https://github.com/octocat/Hello-World\r\nHost: evil', 'a/b/c', '../etc/passwd',
    'x'.repeat(400), 'https://github.com/' + 'a'.repeat(40) + '/repo',
  ]) assert.equal(parseGithubRepo(bad), null, JSON.stringify(bad).slice(0, 60));
});

test('request bodies', () => {
  assert.ok(AddRepoBody.safeParse({ url: 'octocat/Hello-World' }).success);
  assert.ok(!AddRepoBody.safeParse({ url: 'x' }).success);
  assert.ok(GithubTokenBody.safeParse({ token: 'github_pat_11ABCDEF0123456789_abcdefghijklmnopqrstuvwxyz' }).success);
  for (const bad of ['short', 'has spaces in the token value here', 'bad;chars$$$$$$$$$$$$$$$$$$$$$$', 'x'.repeat(300)]) assert.ok(!GithubTokenBody.safeParse({ token: bad }).success, bad);
});
