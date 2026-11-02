// "Raised before": find earlier statements, decisions and tasks about the same topic (this meeting included) so the
// assistant can say "you changed this", "already assigned to Priya" or "we covered this". Matching is cheap and
// deterministic; deciding whether it is a contradiction, an update or a repeat is the judge's job (LLM, or rules below).
import { jaccard, tokens } from '../analytics/compute.js';
import { normalizeValue, parseDatePhrase } from './rules.js';
import type { Candidate, EventDraft, Verdict } from './types.js';

export type PriorKind = 'decision' | 'task' | 'event';
export interface Prior {
  id: string; kind: PriorKind; text: string;
  type?: string;               // knowledge event type for kind=event
  entityKey?: string | null; value?: string | null;
  assignee?: string | null; due?: string | null; status?: string | null;
  who?: string | null;         // who said it
  label: string;               // "Meeting “Kickoff” · Nov 2" or "This meeting"
  sameMeeting: boolean;
}

const MIN_TASK_SIM = 0.45;
const MIN_TOPIC_SIM = 0.4;

const evText = (ev: EventDraft) => `${ev.summary} ${ev.value ?? ''}`;
const priorText = (p: Prior) => `${p.text} ${p.value ?? ''}`;

/** Earlier items about the same topic as `ev`, best first. */
export function findPriors(ev: EventDraft, pool: Prior[], limit = 3): Array<Prior & { sim: number }> {
  const t = tokens(evText(ev));
  const scored: Array<Prior & { sim: number }> = [];
  for (const p of pool) {
    let sim = jaccard(t, tokens(priorText(p)));
    if (ev.entityKey && p.entityKey && ev.entityKey === p.entityKey) sim = Math.max(sim, 0.95);
    const bar = ev.type === 'task' ? (p.kind === 'task' ? MIN_TASK_SIM : 0.6) : MIN_TOPIC_SIM;
    if (sim >= bar) scored.push({ ...p, sim });
  }
  return scored.sort((a, b) => b.sim - a.sim).slice(0, limit);
}

/** Describe a prior for the judge in one line (assignee, due date and status included). */
export function describePrior(p: Prior): string {
  const by = p.who ? ` (said by ${p.who})` : '';
  if (p.kind === 'task') return `Task: ${p.text} — assigned to ${p.assignee ?? 'nobody'}, due ${p.due ?? 'no date'}, ${p.status ?? 'open'}${by}`;
  if (p.kind === 'decision') return `Decision: ${p.entityKey ?? p.text} = ${p.value ?? p.text}${by}`;
  return `${p.type ?? 'Note'}: ${p.text}${by}`;
}

export function priorToCandidate(p: Prior & { sim: number }): Candidate {
  return { id: p.id, sourceType: p.kind === 'event' ? 'event' : p.kind, text: describePrior(p), score: Math.max(p.sim, 0.5), label: p.label,
    entityKey: p.entityKey ?? null, value: p.value ?? null };
}

const sameDate = (a?: string | null, b?: string | null) => {
  const [x, y] = [a, b].map((v) => (v ? parseDatePhrase(v) : null));
  return x && y ? x === y : null; // null = cannot tell
};
const sameName = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase().trim() === b.toLowerCase().trim();

/** Rules fallback used when the LLM is unavailable: handles the clear-cut cases only. */
export function recallRules(ev: EventDraft, priors: Array<Prior & { sim: number }>): Verdict | null {
  const p = priors[0];
  if (!p) return null;
  const where = p.sameMeeting ? 'earlier in this meeting' : p.label;
  const base = { speak: true as const, sourceLabel: p.label, sourceUrl: null, evidenceIds: [p.id], private: false };

  if (ev.type === 'decision' && p.kind === 'decision' && ev.value && p.value) {
    const same = sameDate(ev.value, p.value) ?? (normalizeValue(ev.value) === normalizeValue(p.value));
    if (!same) {
      return { ...base, kind: 'conflict', score: 0.9, title: 'This changes an earlier decision',
        message: `${p.who ? `${p.who} said` : 'It was decided'} “${p.value}” ${where}. Now: “${ev.value}”.`, topicKey: `recall:${p.id}:${normalizeValue(ev.value)}` };
    }
    return p.sameMeeting && sameName(p.who, ev.speaker) ? null : { ...base, kind: 'repeat', score: 0.6, title: 'Already decided',
      message: `Same as ${where}: “${p.value}”.`, topicKey: `recall:${p.id}` };
  }

  if (ev.type === 'task' && p.kind === 'task') {
    const now = ev.who ?? ev.speaker;
    const q = ev.summary;
    if (p.assignee && now && !sameName(p.assignee, now)) {
      return { ...base, kind: 'update', score: 0.85, title: 'Task already assigned to someone else',
        message: `“${p.text}” was assigned to ${p.assignee} ${where}${p.due ? ` (due ${p.due})` : ''}. Now it is going to ${now}.`, topicKey: `recall:${p.id}:${normalizeValue(now)}` };
    }
    const due = ev.dueText && p.due ? sameDate(ev.dueText, p.due) : null;
    if (due === false) {
      return { ...base, kind: 'update', score: 0.8, title: 'Deadline changed',
        message: `“${q}” was due ${p.due} ${where}. Now: ${ev.dueText}.`, topicKey: `recall:${p.id}:${normalizeValue(ev.dueText)}` };
    }
    return { ...base, kind: 'repeat', score: 0.6, title: 'Already assigned',
      message: `“${p.text}” is already ${p.assignee ? `with ${p.assignee}` : 'on the list'} (${where}${p.status && p.status !== 'open' ? `, ${p.status}` : ''}).`, topicKey: `recall:${p.id}` };
  }

  if (['blocker', 'info', 'question', 'deadline'].includes(ev.type) && p.sim >= 0.55) {
    return { ...base, kind: 'repeat', score: 0.55, title: 'Raised before', message: `This came up ${where}: “${p.text}”.`, topicKey: `recall:${p.id}` };
  }
  return null;
}
