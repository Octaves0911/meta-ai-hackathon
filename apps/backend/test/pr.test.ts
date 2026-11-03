import test from 'node:test';
import assert from 'node:assert/strict';
import { branchName, defaultPrBody, prChecks, type PrFacts } from '../src/agents/pr.js';

const ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

test('branch names are under our prefix, safe, short, and distinct per revision', () => {
  assert.equal(branchName('Fix the billing webhook retry bug', ID, 0), 'meetpilot/fix-the-billing-webhook-retry-bug-1a2b3c4d');
  assert.equal(branchName('Fix it', ID, 2), 'meetpilot/fix-it-1a2b3c4d-r2');
  for (const t of ['', '!!!', '../../etc/passwd', 'x'.repeat(300), 'Émoji 🚀 title', 'a\nb', 'main']) {
    const b = branchName(t, ID, 0);
    assert.match(b, /^meetpilot\/[a-z0-9][a-z0-9-]{2,60}$/, JSON.stringify(t));
    assert.ok(b.length <= 80);
    assert.ok(!b.includes('..') && !b.endsWith('-'));
  }
  assert.match(branchName('', ID, 0), /^meetpilot\/change-1a2b3c4d$/);
});

const VERIFIED = { status: 'verified', ecosystem: 'node', red_exit: 1, green_exit: 0, warnings: ['tests were already failing'], steps: [{ label: 'tests', counts: { passed: 7 } }] };
const FILES = [{ path: 'src/add.js', status: 'modified', additions: 1, deletions: 1 }, { path: 'test/add.test.js', status: 'added', additions: 4, deletions: 0 }];

test('the default description has the change and the evidence and nothing from the meeting', () => {
  const b = defaultPrBody({ summary: 'Fix add so it adds', files: FILES, verification: VERIFIED });
  for (const needle of ['## What', 'Fix add so it adds', '`src/add.js` (modified, +1 −1)', '`test/add.test.js` (added, +4 −0)', 'Verified in an isolated sandbox (node): the tests ran and passed (7 passed).', 'failed before the change and passed after it', 'Nothing was merged automatically']) assert.ok(b.includes(needle), needle);
  assert.ok(!/priya|omar|transcript|meeting|said/i.test(b));
});

test('descriptions are sanitised and capped: no pipes, backticks, markup or newlines smuggled through names or text', () => {
  const b = defaultPrBody({ summary: 'x'.repeat(5000) + '\n## Injected', files: [{ path: 'a`b|c<script>.js', status: 'modified', additions: 1, deletions: 0 }], verification: { status: 'verified', warnings: ['<img src=x onerror=y>'.repeat(50)] } });
  assert.ok(b.length < 19_000);
  assert.ok(!b.includes('<script>') && !b.includes('<img'));
  assert.ok(!b.split('\n').some((l) => l.startsWith('## Injected')));
  assert.equal(defaultPrBody({ summary: null, files: [], verification: null }).includes('Not verified.'), true);
});

const OK: PrFacts = { status: 'approved', verification: { status: 'verified' }, repoId: 'r', canPush: true, githubConnected: true, hasFiles: true, baseSha: 'a'.repeat(40), alreadyOpened: false };

test('a pull request is allowed only when every condition holds, and each failure explains itself', () => {
  assert.ok(prChecks(OK).every((c) => c.ok));
  const fail = (o: Partial<PrFacts>) => prChecks({ ...OK, ...o }).filter((c) => !c.ok);
  assert.deepEqual(fail({ status: 'awaiting_review' }).map((c) => c.key), ['approved']);
  assert.deepEqual(fail({ verification: { status: 'failed', reason: 'The tests failed after the change.' } }).map((c) => [c.key, /tests failed/.test(c.detail!)]), [['verified', true]]);
  assert.match(fail({ verification: { status: 'not_tested', reason: 'The sandbox is switched off' } })[0].detail!, /only offered for verified changes/);
  assert.deepEqual(fail({ verification: null }).map((c) => c.key), ['verified']);
  assert.deepEqual(fail({ repoId: null }).map((c) => c.key), ['repo']);
  assert.match(fail({ githubConnected: false })[0].detail!, /Connect a GitHub token/);
  assert.match(fail({ canPush: false })[0].detail!, /cannot push|not push/);
  assert.deepEqual(fail({ canPush: null }).map((c) => c.key), ['github']);
  assert.deepEqual(fail({ hasFiles: false }).map((c) => c.key), ['files']);
  assert.deepEqual(fail({ baseSha: null }).map((c) => c.key), ['files']);
  assert.deepEqual(fail({ alreadyOpened: true }).map((c) => c.key), ['new']);
});
