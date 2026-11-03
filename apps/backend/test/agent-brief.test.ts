import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LINES, rankPriorWork, windowLines, withHistory } from '../src/agents/brief.js';

const segs = (n: number) => Array.from({ length: n }, (_, i) => ({ seq: i, speaker_name: i % 2 ? 'omar' : 'priya', text: `line ${i}` }));

test('window is ±10 lines around the task, with the task\'s own lines marked', () => {
  const out = windowLines(segs(60), 30, 31);
  assert.equal(out[0].text, 'line 20');
  assert.equal(out.at(-1)?.text, 'line 41');
  assert.deepEqual(out.filter((l) => l.at_task).map((l) => l.text), ['line 30', 'line 31']);
});

test('window clips at the start of the transcript and tolerates a missing range', () => {
  assert.equal(windowLines(segs(5), 1, 1)[0].text, 'line 0');
  assert.deepEqual(windowLines(segs(5), null, null), []);
  assert.equal(windowLines(segs(60), 30, null).filter((l) => l.at_task).length, 1); // single-segment task
});

test('an over-long window keeps the task\'s lines and the nearest context, in order', () => {
  const out = windowLines(segs(200), 100, 108, 12);
  assert.equal(out.length, 12);
  assert.ok(out.filter((l) => l.at_task).length === 9);
  assert.deepEqual(out.map((l) => l.text), [...out.map((l) => l.text)].sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))));
  assert.ok(MAX_LINES >= 24);
});

test('decisions carry their change history, newest first, without repeating the current value', () => {
  const out = withHistory(
    [{ entity_key: 'launch date', value: 'November 22' }, { entity_key: 'price', value: '$49' }],
    [{ entity_key: 'launch date', value: 'November 15' }, { entity_key: 'launch date', value: 'November 1' }, { entity_key: 'launch date', value: 'November 22' }],
  );
  assert.deepEqual(out[0].previous, ['November 15', 'November 1']);
  assert.deepEqual(out[1].previous, []);
});

test('prior work: similar titles first, same agent breaks ties, unrelated work is dropped', () => {
  const rows = [
    { title: 'Write the launch FAQ', agent: 'communication' },
    { title: 'Water the plants', agent: 'communication' },
    { title: 'Announce the launch to customers', agent: 'communication' },
    { title: 'Announce the launch to leadership', agent: 'marketing' },
  ];
  const out = rankPriorWork(rows, 'Announce launch to leadership', 'communication');
  assert.ok(out.length >= 1 && out.length <= 3);
  assert.ok(!out.some((r) => r.title === 'Water the plants'));
  assert.equal(out[0].title, 'Announce the launch to leadership');
});
