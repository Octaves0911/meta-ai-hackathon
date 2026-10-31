import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMeetingSummary, type MeetingInput } from '../src/analytics/meeting.js';

const seg = (seq: number, speaker: string, text: string, ms: number) => ({ seq, speaker_name: speaker, text, offset_ms: ms, created_at: '2026-10-01T10:00:00Z' });
const base = (o: Partial<MeetingInput> = {}): MeetingInput => ({
  meetingId: 'm2', today: '2026-10-20', segments: [seg(1, 'Priya', 'We should ship on the fifth of September', 0), seg(2, 'Aman', 'Agreed', 60000), seg(3, 'Priya', 'Legal approval is still blocking the contract', 120000)],
  events: [], earlierEvents: [], decisions: [], conflicts: [], tasks: [],
  meetings: [{ id: 'm1', title: 'Kickoff', created_at: '2026-09-01T10:00:00Z', ended_at: '2026-09-01T11:00:00Z' }, { id: 'm2', title: 'Sync', created_at: '2026-10-01T10:00:00Z', ended_at: null }],
  messages: 2, recap: null, readable: true, ...o,
});
const ev = (o: any) => ({ id: 'e', meeting_id: 'm2', type: 'blocker', entity_key: null, summary: 'x', who: null, quote: null, segment_from_seq: 3, created_at: '2026-10-01T10:20:00Z', ...o });

test('speaker share is by words and sums to one', () => {
  const r = computeMeetingSummary(base());
  assert.equal(r.speakers[0].name, 'Priya');
  assert.ok(Math.abs(r.speakers.reduce((a, s) => a + s.share, 0) - 1) < 1e-9);
  assert.equal(r.kpis.lines, 3);
});

test('a decision that replaces an earlier value reports what it changed from', () => {
  const r = computeMeetingSummary(base({
    events: [ev({ id: 'e2', type: 'decision', entity_key: 'deployment_date', summary: 'Deploy September 5', segment_from_seq: 1 })],
    decisions: [
      { entity_key: 'deployment_date', value: 'August 1', meeting_id: 'm1', event_id: 'e1', created_at: '2026-09-01T10:10:00Z' },
      { entity_key: 'deployment_date', value: 'September 5', meeting_id: 'm2', event_id: 'e2', created_at: '2026-10-01T10:10:00Z' },
    ],
  }));
  const d = r.moments.find((m) => m.type === 'decision')!;
  assert.equal(d.changedFrom?.value, 'August 1'); assert.equal(d.changedFrom?.meeting?.title, 'Kickoff');
});

test('blockers raised in earlier meetings are flagged, and moments land in the pulse', () => {
  const r = computeMeetingSummary(base({
    events: [ev({ summary: 'Waiting on legal approval for the vendor contract' })],
    earlierEvents: [ev({ id: 'old', meeting_id: 'm1', summary: 'Still waiting for legal approval of the vendor contract' })],
  }));
  assert.equal(r.moments[0].raisedBefore[0].title, 'Kickoff');
  assert.equal(r.pulse.reduce((a, p) => a + (p.marks.blocker ?? 0), 0), 1);
});

test('unshared conversations expose only task stats', () => {
  const r = computeMeetingSummary(base({ readable: false, tasks: [{ status: 'done', assignee: 'aman', due: null }, { status: 'open', assignee: null, due: '2026-10-01' }] }));
  assert.equal(r.readable, false); assert.equal(r.speakers.length, 0);
  assert.deepEqual([r.tasks.total, r.tasks.overdue, r.tasks.unassigned], [2, 1, 1]);
});
