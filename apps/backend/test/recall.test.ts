import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPriors, recallRules, type Prior } from '../src/insights/recall.js';
import { Governor } from '../src/insights/governor.js';
import type { EventDraft } from '../src/insights/types.js';

const ev = (o: Partial<EventDraft>): EventDraft => ({ type: 'task', entityKey: null, value: null, summary: '', who: null, dueText: null, referencesEarlier: false, quote: '', fromSeq: 1, toSeq: 1, speaker: 'aman', ...o });
const launch: Prior = { id: 'd1', kind: 'decision', text: 'Launch on November 20', entityKey: 'launch_date', value: 'November 20', who: 'aman', label: 'this meeting', sameMeeting: true };
const deck: Prior = { id: 't1', kind: 'task', text: 'Send the updated pricing deck to leadership', assignee: 'priya', due: '2026-11-06', status: 'open', who: 'aman', label: 'this meeting', sameMeeting: true };

test('a changed launch date in the same meeting is a conflict, naming the old value', () => {
  const e = ev({ type: 'decision', entityKey: 'launch_date', value: 'November 25', summary: 'Launch on November 25' });
  const v = recallRules(e, findPriors(e, [launch, deck]))!;
  assert.equal(v.kind, 'conflict');
  assert.match(v.message, /November 20/);
  assert.match(v.message, /November 25/);
});

test('the same date written differently is not a conflict', () => {
  const e = ev({ type: 'decision', entityKey: 'launch_date', value: 'Nov 20', summary: 'Launch on Nov 20' });
  assert.equal(recallRules(e, findPriors(e, [launch])), null); // same speaker, same meeting: silent restatement
});

test('the same task given to a different person is an update that names the previous owner', () => {
  const e = ev({ summary: 'Send the updated pricing deck to the leadership team', who: 'Sam' });
  const v = recallRules(e, findPriors(e, [launch, deck]))!;
  assert.equal(v.kind, 'update');
  assert.match(v.message, /priya/);
  assert.match(v.message, /Sam/);
});

test('same task, same person, new date is a deadline change', () => {
  const e = ev({ summary: 'Send the updated pricing deck to leadership', who: 'priya', dueText: 'November 12' });
  const v = recallRules(e, findPriors(e, [{ ...deck, due: 'November 6' }]))!;
  assert.equal(v.kind, 'update');
  assert.equal(v.title, 'Deadline changed');
});

test('same task, same person is flagged as already assigned', () => {
  const e = ev({ summary: 'Send the updated pricing deck to leadership', who: 'Priya' });
  assert.equal(recallRules(e, findPriors(e, [deck]))!.kind, 'repeat');
});

test('unrelated tasks are not matched', () => {
  const e = ev({ summary: 'Fix the login bug on the signup page', who: 'Sam' });
  assert.deepEqual(findPriors(e, [launch, deck]), []);
});

test('recall cards use the short cooldown and ignore the chat cap', () => {
  let now = 100_000;
  const g = new Governor({ now: () => now, maxChat: 1, cooldownMs: 60_000, conflictCooldownMs: 8_000 });
  const card = (kind: 'conflict' | 'update' | 'repeat', topicKey: string) => ({ kind, score: 0.9, topicKey, evidenceIds: [topicKey] });
  assert.equal(g.route(card('update', 'a')), 'interrupt');
  now = 109_000;
  assert.equal(g.route(card('conflict', 'b')), 'interrupt'); // cap of 1 already used, still shown
  now = 110_000;
  assert.equal(g.route(card('repeat', 'c')), 'queued');       // inside the 8 s gap: merged, not dropped
});

import { parseDatePhrase } from '../src/insights/rules.js';
test('spoken date forms normalise to the same calendar date', () => {
  for (const t of ['November 20', 'Nov. 20th', '20th of November', '20 November', 'the twentieth of November']) assert.equal(parseDatePhrase(t), 'November 20', t);
  assert.equal(parseDatePhrase('the twenty-fifth of November'), 'November 25');
  assert.equal(parseDatePhrase('2026-11-25'), 'November 25');
  assert.equal(parseDatePhrase('next Friday'), null);
});
