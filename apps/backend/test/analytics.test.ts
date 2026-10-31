import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeIntelligence, jaccard, tokens, weekStart, type Input } from '../src/analytics/compute.js';

const m = (id: string, title: string, d: string) => ({ id, title, created_at: `${d}T10:00:00Z`, ended_at: `${d}T11:00:00Z` });
const task = (o: Partial<Input['tasks'][number]> & { id: string }) => ({
  meeting_id: 'm1', title: 'x', assignee: 'aman', due: null, priority: 'high', category: 'code', status: 'open' as const,
  created_at: '2026-10-01T10:00:00Z', event_id: null, completed_at: null, last_status_at: null, reschedules: 0, ...o,
});
const base = (over: Partial<Input>): Input => ({ today: '2026-10-20', weeks: 4, meetings: [m('m1', 'Planning', '2026-10-01'), m('m2', 'Sync', '2026-10-10')], tasks: [], events: [], decisions: [], conflicts: [], ...over });

test('weekStart returns Monday', () => assert.equal(weekStart('2026-10-22'), '2026-10-19'));
test('jaccard matches paraphrases of the same blocker', () => assert.ok(jaccard(tokens('Waiting on legal approval for the contract'), tokens('Still waiting for legal approval of contract')) >= 0.5));

test('task KPIs, overdue and on-time rate', () => {
  const r = computeIntelligence(base({ tasks: [
    task({ id: 'a', status: 'done', due: '2026-10-05', completed_at: '2026-10-04T10:00:00Z' }),
    task({ id: 'b', status: 'done', due: '2026-10-05', completed_at: '2026-10-08T10:00:00Z' }),
    task({ id: 'c', status: 'open', due: '2026-10-10' }),
    task({ id: 'd', status: 'in_progress', due: '2026-10-30' }),
  ] }));
  assert.equal(r.kpis.totalTasks, 4); assert.equal(r.kpis.done, 2); assert.equal(r.kpis.overdue, 1);
  assert.equal(r.kpis.onTimeRate, 1 / 3);
  assert.equal(r.tasks.find((t) => t.id === 'b')!.daysLate, 3);
  assert.equal(r.commitments.missed, 1); assert.equal(r.commitments.deliveredLate, 1); assert.equal(r.commitments.pending, 1);
});

test('statement changes capture who changed what and flag contradictions of someone else', () => {
  const r = computeIntelligence(base({ decisions: [
    { id: 'd1', entity_key: 'deployment_date', value: 'August 1', meeting_id: 'm1', created_at: '2026-10-01T10:00:00Z', who: 'Priya' },
    { id: 'd2', entity_key: 'deployment_date', value: 'September 5', meeting_id: 'm2', created_at: '2026-10-10T10:00:00Z', who: 'Dana' },
  ] }));
  const c = r.statementChanges[0];
  assert.deepEqual([c.from, c.to, c.fromBy, c.by, c.contradictsOther, c.meeting?.title], ['August 1', 'September 5', 'Priya', 'Dana', true, 'Sync']);
});

test('recurring blockers across meetings are found, and resolved ones are marked', () => {
  const ev = (id: string, meeting: string, summary: string) => ({ id, meeting_id: meeting, type: 'blocker', entity_key: null, summary, who: 'Sam', due_at: null, created_at: meeting === 'm1' ? '2026-10-01T10:00:00Z' : '2026-10-10T10:00:00Z' });
  const open = computeIntelligence(base({ events: [ev('e1', 'm1', 'Waiting on legal approval for contract'), ev('e2', 'm2', 'Still waiting for legal approval of the contract')] }));
  assert.equal(open.patterns.recurringBlockers.length, 1); assert.equal(open.patterns.recurringBlockers[0].resolved, false);
  assert.equal(open.kpis.openBlockers, 1);
  const fixed = computeIntelligence(base({ events: [ev('e1', 'm1', 'Waiting on legal approval for contract'), ev('e2', 'm2', 'Still waiting for legal approval of the contract')],
    tasks: [task({ id: 't', status: 'done', event_id: 'e2', title: 'Get legal sign off' })] }));
  assert.equal(fixed.patterns.recurringBlockers[0].resolved, true);
});

test('accountability is per person and the health score drops with overdue work', () => {
  const healthy = computeIntelligence(base({ tasks: [task({ id: 'a', status: 'done', due: '2026-10-05', completed_at: '2026-10-04T10:00:00Z' })] }));
  const sick = computeIntelligence(base({ tasks: ['a', 'b', 'c', 'd'].map((id) => task({ id, due: '2026-10-01' })) }));
  assert.ok(healthy.health.score! > sick.health.score!);
  assert.equal(sick.accountability.people[0].overdue, 4);
  assert.ok(sick.health.risks.some((r) => r.id === 'load-aman'));
  assert.equal(computeIntelligence(base({})).health.label, 'no_data');
});
