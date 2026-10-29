import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { Governor, type Routable } from '../src/insights/governor.js';
import { answerRules, extractRules, judgeRules, parseDatePhrase } from '../src/insights/rules.js';
import type { Candidate, EventDraft } from '../src/insights/types.js';

const cand = (kind: Routable['kind'], over: Partial<Routable> = {}): Routable =>
  ({ kind, score: 0.8, topicKey: `t${Math.random()}`, evidenceIds: [`e${Math.random()}`], ...over });

describe('governor', () => {
  const make = (start = 1_000_000) => {
    let t = start;
    const g = new Governor({ now: () => t, maxChat: 6, windowMs: 30 * 60_000 });
    return { g, advance: (ms: number) => { t += ms; } };
  };

  test('first strong insight interrupts; the next within the cooldown is queued', () => {
    const { g, advance } = make();
    assert.equal(g.route(cand('context')), 'interrupt');
    advance(10_000);
    assert.equal(g.route(cand('context')), 'queued');
    advance(90_000);
    assert.equal(g.route(cand('context')), 'interrupt');
  });

  test('conflicts use the shorter 30 s cooldown and are exempt from the cap', () => {
    const { g, advance } = make();
    g.route(cand('context'));
    advance(31_000);
    assert.equal(g.route(cand('conflict')), 'interrupt');
  });

  test('weak, repeated, muted, private and no_record items go to the feed, never lost', () => {
    const { g } = make();
    assert.equal(g.route(cand('conflict', { score: 0.2 })), 'feed');
    assert.equal(g.route(cand('no_record', { score: 0.95 })), 'feed');
    assert.equal(g.route(cand('conflict', { private: true })), 'feed');
    const first = cand('conflict', { topicKey: 'same', evidenceIds: ['ev1'] });
    assert.equal(g.route(first), 'interrupt');
    assert.equal(g.route(cand('conflict', { topicKey: 'same' })), 'feed', 'same topic');
    assert.equal(g.route(cand('conflict', { evidenceIds: ['ev1'] })), 'feed', 'same evidence');
    assert.equal(g.route(cand('context', { score: 0.4 })), 'feed', 'below kind threshold');
  });

  test('hard cap: at most 6 chat cards per 30 minutes', () => {
    const { g, advance } = make();
    const tiers: string[] = [];
    for (let i = 0; i < 10; i++) { tiers.push(g.route(cand('context'))); advance(91_000); }
    assert.equal(tiers.filter((t) => t === 'interrupt').length, 6);
    assert.equal(tiers.slice(6).every((t) => t === 'feed'), true);
    advance(31 * 60_000); // window slides
    assert.equal(g.route(cand('context')), 'interrupt');
  });

  test('queued items merge into one card at a pause, highest priority first, max 3; rest to feed', () => {
    const { g, advance } = make();
    g.route(cand('context'));
    advance(35_000);
    const items = [cand('context', { score: 0.7 }), cand('reminder'), cand('answer'), cand('context', { score: 0.9 })];
    items.forEach((i) => assert.equal(g.route(i), 'queued'));
    assert.equal(g.flush(2_000), null, 'no pause yet and cooldown not over');
    advance(5_000);
    const r = g.flush(9_000)!;
    assert.deepEqual(r.merged.map((m) => m.kind), ['reminder', 'answer', 'context']);
    assert.equal(r.feed.length, 1);
    assert.equal(g.flush(9_000), null, 'queue is empty');
  });

  test('queued items also flush once the cooldown has elapsed, even without a pause', () => {
    const { g, advance } = make();
    g.route(cand('context'));
    advance(10_000);
    g.route(cand('reminder'));
    advance(81_000);
    assert.equal(g.flush(0)!.merged.length, 1);
  });

  test('feedback: helpful lowers the bar (floor 0.35); dismissed raises it (cap 0.9) and mutes the topic', () => {
    const { g } = make();
    const base = g.threshold('context');
    g.feedback('context', 'x', 'helpful');
    assert.ok(g.threshold('context') < base);
    for (let i = 0; i < 20; i++) g.feedback('context', 'x', 'helpful');
    assert.equal(g.threshold('context'), 0.35);
    g.feedback('reminder', 'noisy', 'dismissed');
    assert.ok(g.threshold('reminder') > 0.55);
    assert.equal(g.route(cand('reminder', { topicKey: 'noisy' })), 'feed');
    for (let i = 0; i < 20; i++) g.feedback('reminder', 'y', 'dismissed');
    assert.equal(g.threshold('reminder'), 0.9);
  });
});

describe('rules extractor', () => {
  const line = (seq: number, speaker: string, text: string) => ({ seq, speaker, text });

  test('golden: "Let\'s ship on September 5" is a deployment_date decision', () => {
    const [e] = extractRules([line(1, 'Priya', "Let's ship on September 5.")]);
    assert.equal(e.type, 'decision');
    assert.equal(e.entityKey, 'deployment_date');
    assert.equal(e.value, 'September 5');
  });
  test('tasks, questions, deadlines, blockers, earlier references; small talk ignored', () => {
    const ev = extractRules([
      line(1, 'Aman', 'I will send the report by Friday.'),
      line(2, 'Priya', 'Why did we choose Deepgram?'),
      line(3, 'Aman', 'The deadline is October 31.'),
      line(4, 'Zed', "We're blocked on the API keys."),
      line(5, 'Priya', 'As we agreed last week, budget is 40k'),
      line(6, 'Zed', 'Nice weather today, right'),
    ]);
    assert.deepEqual(ev.map((e) => e.type), ['task', 'question', 'deadline', 'blocker', 'info']);
    assert.equal(ev[0].who, 'Aman');
    assert.equal(ev[4].referencesEarlier, true);
  });
  test('parseDatePhrase normalises month names and ordinals', () => {
    assert.equal(parseDatePhrase('on sept 5th'), 'September 5');
    assert.equal(parseDatePhrase('Aug 1'), 'August 1');
    assert.equal(parseDatePhrase('no date here'), null);
  });
});

describe('rules judge', () => {
  const T = { answer: 0.25, reminder: 0.25 };
  const ev = (over: Partial<EventDraft>): EventDraft => ({ type: 'decision', entityKey: null, value: null, summary: 's', who: null, dueText: null, referencesEarlier: false, quote: '', fromSeq: 1, toSeq: 1, ...over });
  const dec = (value: string): Candidate => ({ id: 'd1', sourceType: 'decision', text: `Decision: deployment_date = ${value}`, score: 0.7, label: 'Earlier meeting (Jul 12)', entityKey: 'deployment_date', value });

  test('different value => conflict naming the source', () => {
    const v = judgeRules(ev({ entityKey: 'deployment_date', value: 'September 5' }), [dec('August 1')], T)!;
    assert.equal(v.kind, 'conflict');
    assert.equal(v.message, 'Earlier meeting (Jul 12) decided deployment on August 1.');
    assert.deepEqual(v.evidenceIds, ['d1']);
  });
  test('same value (restatement) stays silent', () => {
    assert.equal(judgeRules(ev({ entityKey: 'deployment_date', value: 'August 1' }), [dec('August 1')], T), null);
  });
  test('"as we agreed" with nothing in memory => no_record; with evidence => silent', () => {
    assert.equal(judgeRules(ev({ type: 'info', referencesEarlier: true }), [], T)!.kind, 'no_record');
    const c: Candidate = { id: 'x', sourceType: 'transcript', text: 'budget 40k', score: 0.6, label: 'Meeting' };
    assert.equal(judgeRules(ev({ type: 'info', referencesEarlier: true }), [c], T), null);
  });
  test('question + strong candidate => answer; weak => silent', () => {
    const c: Candidate = { id: 'x', sourceType: 'transcript', text: 'We chose Deepgram for streaming latency.', score: 0.5, label: 'Meeting “Arch”' };
    assert.equal(judgeRules(ev({ type: 'question' }), [c], T)!.kind, 'answer');
    assert.equal(judgeRules(ev({ type: 'question' }), [{ ...c, score: 0.1 }], T), null);
  });
  test('task + related open task => reminder', () => {
    const c: Candidate = { id: 't1', sourceType: 'task', text: 'Task: Prepare release checklist', score: 0.5, label: 'Meeting “Planning”' };
    assert.equal(judgeRules(ev({ type: 'task' }), [c], T)!.kind, 'reminder');
  });
  test('answerRules quotes best sources or returns null', () => {
    assert.equal(answerRules([]), null);
    const r = answerRules([{ id: 'a', sourceType: 'transcript', text: 'Because it streams.', score: 0.4, label: 'Meeting X' }])!;
    assert.match(r.answer, /Because it streams\. \(Meeting X\)/);
  });
});
