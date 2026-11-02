import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldTail, HOLD_MS } from '../src/insights/hold.js';

const now = Date.parse('2026-11-03T10:00:00Z');
const row = (text: string, agoMs: number) => ({ text, created_at: new Date(now - agoMs) });

test('a fresh half sentence is held back until it completes', () => {
  const rows = [row('Okay, let us start.', 5000), row('Priya will send the updated', 1000)];
  assert.deepEqual(heldTail(rows, now).map((r) => r.text), ['Okay, let us start.']);
});

test('complete sentences and questions pass through', () => {
  const rows = [row('Sam, fix the bug by tomorrow.', 1000), row('Who owns onboarding?', 500)];
  assert.equal(heldTail(rows, now).length, 2);
});

test('a half sentence is released once it has been quiet for a while', () => {
  assert.equal(heldTail([row('we still need to figure that out', HOLD_MS + 1)], now).length, 1);
});

test('only the unfinished tail is held, not complete lines before it', () => {
  const rows = [row('One.', 900), row('and then', 800), row('we will', 700)];
  assert.deepEqual(heldTail(rows, now).map((r) => r.text), ['One.']);
});
