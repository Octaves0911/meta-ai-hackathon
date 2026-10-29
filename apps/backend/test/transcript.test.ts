import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, toSrt, toText } from '../src/services/transcript.js';
import { parseDeepgramResult } from '../src/services/deepgram.js';
import { tailText } from '@meetpilot/shared';

test('parseTranscript handles plain, timestamped and continuation lines', () => {
  const r = parseTranscript('Priya: hello there\n[00:01:05] Aman: hi\nstill Aman talking\n[2:30] Priya: later');
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { speaker: 'Priya', text: 'hello there', offsetMs: null });
  assert.equal(r[1].offsetMs, 65000);
  assert.equal(r[1].text, 'hi still Aman talking');
  assert.equal(r[2].offsetMs, 150000);
});

test('toText and toSrt format offsets', () => {
  const segs = [
    { seq: 1, speaker: 'A', text: 'one', offsetMs: 0 },
    { seq: 2, speaker: 'B', text: 'two', offsetMs: 3500 },
  ];
  assert.equal(toText(segs), '[00:00:00] A: one\n[00:00:03] B: two\n');
  const srt = toSrt(segs);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:03,500\nA: one/);
  assert.match(srt, /2\n00:00:03,500 --> 00:00:06,500\nB: two/);
});

test('parseDeepgramResult', () => {
  const msg = { type: 'Results', is_final: true, start: 1.25, channel: { alternatives: [{ transcript: ' hi there ', confidence: 0.9 }] } };
  assert.deepEqual(parseDeepgramResult(msg), { text: 'hi there', final: true, confidence: 0.9, startMs: 1250 });
  assert.equal(parseDeepgramResult({ ...msg, channel: { alternatives: [{ transcript: '' }] } }), null);
  assert.equal(parseDeepgramResult({ type: 'Metadata' }), null);
  assert.equal(parseDeepgramResult(null), null);
});

test('tailText keeps the tail at a word boundary', () => {
  assert.equal(tailText('short'), 'short');
  const long = 'word '.repeat(100).trim();
  const t = tailText(long, 50);
  assert.ok(t.startsWith('…word') && t.length <= 51, t);
});
