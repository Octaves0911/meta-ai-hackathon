import test from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff } from '@meetpilot/shared';

const show = (d: ReturnType<typeof lineDiff>) => d.map((x) => `${x.type === 'same' ? ' ' : x.type === 'add' ? '+' : '-'}${x.text}`);

test('identical text has no changes', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nb').map((x) => x.type), ['same', 'same']);
});

test('changed, added and removed lines are marked in order', () => {
  assert.deepEqual(show(lineDiff('# T\nlaunch Nov 15\nbudget', '# T\nlaunch Nov 22\nbudget\nowner: Priya')),
    [' # T', '-launch Nov 15', '+launch Nov 22', ' budget', '+owner: Priya']);
});

test('empty sides and a total rewrite', () => {
  assert.deepEqual(show(lineDiff('', 'x')), ['-', '+x']);
  assert.deepEqual(show(lineDiff('a\nb', 'c\nd')).sort(), ['+c', '+d', '-a', '-b']);
});

test('very large inputs do not blow up (coarse diff)', () => {
  const big = Array.from({ length: 2000 }, (_, i) => `l${i}`).join('\n');
  const d = lineDiff(big, big + '\nextra', 1500);
  assert.equal(d.filter((x) => x.type === 'add').length, 2001);
});
