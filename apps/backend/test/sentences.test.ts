import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentenceAssembler, splitSentences } from '../src/services/sentences.js';

test('a sentence split across chunks is released once, whole', () => {
  const a = new SentenceAssembler();
  assert.deepEqual(a.push('Priya will send the updated'), []);
  assert.deepEqual(a.push('pricing deck to the leadership team by Friday.'), ['Priya will send the updated pricing deck to the leadership team by Friday.']);
});

test('a chunk holding the end of one sentence and the start of the next separates them', () => {
  const a = new SentenceAssembler();
  assert.deepEqual(a.push('pricing deck by Friday. Sam, please fix'), ['pricing deck by Friday.']);
  assert.equal(a.buffered, 'Sam, please fix');
  assert.deepEqual(a.push('the login bug on the sign up page for tomorrow.'), ['Sam, please fix the login bug on the sign up page for tomorrow.']);
});

test('multiple sentences and questions in one chunk', () => {
  assert.deepEqual(splitSentences('We decided to launch. Who owns onboarding? Not sure yet.'), ['We decided to launch.', 'Who owns onboarding?', 'Not sure yet.']);
});

test('abbreviations and decimals do not end a sentence', () => {
  assert.deepEqual(splitSentences('Dr. Rao said version 3.5 ships on Nov. 20 for Inc. customers.'), ['Dr. Rao said version 3.5 ships on Nov. 20 for Inc. customers.']);
});

test('flush releases an unfinished tail and empties the buffer', () => {
  const a = new SentenceAssembler();
  a.push('we still need to figure that out');
  assert.deepEqual(a.flush(), ['we still need to figure that out']);
  assert.deepEqual(a.flush(), []);
  assert.equal(a.buffered, '');
});

test('a missing period is inferred when a long unfinished line is followed by a capitalised chunk', () => {
  const a = new SentenceAssembler();
  assert.deepEqual(a.push("It's a high priority because it blocks new users"), []);
  assert.deepEqual(a.push('Then I will write the announcement draft by Monday.'), ["It's a high priority because it blocks new users", 'Then I will write the announcement draft by Monday.']);
});

test('a short unfinished line is still joined to a capitalised continuation', () => {
  const a = new SentenceAssembler();
  a.push('Send it to');
  assert.deepEqual(a.push('Priya by Friday.'), ['Send it to Priya by Friday.']);
});
