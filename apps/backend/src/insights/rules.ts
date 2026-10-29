// Rules-based fallbacks used when no LLM is configured or it is unavailable (docs/04 §3, F5.5).
// They are deliberately conservative: they only speak when the evidence is concrete.
import type { Candidate, EventDraft, TranscriptLine, Verdict } from './types.js';

const MONTHS: Record<string, string> = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June',
  jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December',
};
const DATE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
const RELATIVE_RE = /\b(today|tomorrow|next week|next month|end of (?:the )?(?:week|month)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|in \d+ days?)\b/i;
const DECISION_RE = /\b(we (?:have )?(?:decided|agreed)|(?:the )?decision is|let'?s (?:go with|ship|deploy|launch|release|move)|we(?:'ll| will) (?:ship|deploy|launch|release|go with))\b/i;
const RELEASE_RE = /\b(ship|shipping|deploy|deployment|launch|release|go live)\b/i;
const TASK_RE = /\b(I(?:'ll| will)|[A-Z][a-z]+ will|[Cc]an you|[Cc]ould you|[Pp]lease)\b/;
const BLOCKER_RE = /\b(blocked|blocker|stuck on|can'?t proceed)\b/i;
const EARLIER_RE = /\b(as we (?:agreed|discussed|decided)|as discussed|last (?:week|meeting|time)|earlier|previously|we already)\b/i;

export const normalizeValue = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export function parseDatePhrase(text: string): string | null {
  const m = DATE_RE.exec(text);
  return m ? `${MONTHS[m[1].slice(0, 3).toLowerCase()]} ${Number(m[2])}` : null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One event per line at most; small talk yields nothing. */
export function extractRules(lines: TranscriptLine[]): EventDraft[] {
  const out: EventDraft[] = [];
  for (const l of lines) {
    const text = l.text.trim();
    const date = parseDatePhrase(text);
    const rel = RELATIVE_RE.exec(text)?.[1] ?? null;
    const base = { who: l.speaker, dueText: date ?? rel, referencesEarlier: EARLIER_RE.test(text), quote: clip(text, 240), fromSeq: l.seq, toSeq: l.seq };

    // "As we agreed last week…" refers to an earlier decision; it is not a new one.
    if (DECISION_RE.test(text) && !base.referencesEarlier) {
      const isRelease = RELEASE_RE.test(text) && date;
      out.push({ ...base, type: 'decision', entityKey: isRelease ? 'deployment_date' : null, value: isRelease ? date : null,
        summary: isRelease ? `Deploy on ${date}` : clip(text, 160) });
    } else if (/\b(deadline|due)\b/i.test(text) && (date || rel)) {
      out.push({ ...base, type: 'deadline', entityKey: null, value: null, summary: clip(text, 160) });
    } else if (TASK_RE.test(text)) {
      const named = /\b([A-Z][a-z]+) will\b/.exec(text)?.[1];
      out.push({ ...base, type: 'task', entityKey: null, value: null, who: named ?? (/\bi(?:'ll| will)\b/i.test(text) ? l.speaker : null), summary: clip(text, 160) });
    } else if (BLOCKER_RE.test(text)) {
      out.push({ ...base, type: 'blocker', entityKey: null, value: null, summary: clip(text, 160) });
    } else if (text.endsWith('?')) {
      out.push({ ...base, type: 'question', entityKey: null, value: null, summary: clip(text, 160) });
    } else if (base.referencesEarlier) {
      out.push({ ...base, type: 'info', entityKey: null, value: null, summary: clip(text, 160) });
    }
  }
  return out;
}

export interface JudgeThresholds { answer: number; reminder: number }

const KEY_PHRASE: Record<string, string> = { deployment_date: 'deployment on' };
const keyPhrase = (k: string) => KEY_PHRASE[k] ?? `${k.replace(/_/g, ' ')}:`;

/** Concrete-evidence judge: conflicts, answers to questions, reminders of open tasks, "no record" claims. */
export function judgeRules(ev: EventDraft, cands: Candidate[], t: JudgeThresholds): Verdict | null {
  const topic = (k: string) => `${k}`;
  // Conflict: same decision key, different value (a restatement stays silent).
  if (ev.type === 'decision' && ev.entityKey && ev.value) {
    const prior = cands.find((c) => c.sourceType === 'decision' && c.entityKey === ev.entityKey);
    if (prior && normalizeValue(prior.value) !== normalizeValue(ev.value)) {
      return { speak: true, kind: 'conflict', score: 0.9, title: 'Conflicts with an earlier decision',
        message: `${prior.label} decided ${keyPhrase(ev.entityKey)} ${prior.value}.`,
        sourceLabel: prior.label, sourceUrl: prior.url ?? null, topicKey: topic(`decision:${ev.entityKey}`),
        evidenceIds: [prior.id], private: !!prior.private };
    }
    if (prior) return null;
  }
  if (ev.type === 'question') {
    const best = cands.filter((c) => c.sourceType !== 'decision' || true).sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= t.answer) {
      return { speak: true, kind: 'answer', score: Math.min(0.95, 0.55 + best.score / 2), title: 'Possible answer from memory',
        message: clip(`${best.text.replace(/\s+/g, ' ')}`, 240), sourceLabel: best.label, sourceUrl: best.url ?? null,
        topicKey: `question:${ev.summary.toLowerCase().slice(0, 60)}`, evidenceIds: [best.id], private: !!best.private };
    }
    return null;
  }
  if (ev.type === 'task' || ev.type === 'deadline') {
    const task = cands.filter((c) => c.sourceType === 'task').sort((a, b) => b.score - a.score)[0];
    if (task && task.score >= t.reminder) {
      return { speak: true, kind: 'reminder', score: 0.6, title: 'Related earlier commitment',
        message: clip(task.text.replace(/\s+/g, ' '), 240), sourceLabel: task.label, sourceUrl: task.url ?? null,
        topicKey: `task:${task.id}`, evidenceIds: [task.id], private: !!task.private };
    }
  }
  if (ev.referencesEarlier && !cands.some((c) => c.score >= t.answer)) {
    return { speak: true, kind: 'no_record', score: 0.6, title: 'No record found',
      message: "Someone referred to an earlier agreement, but nothing in this project's memory matches it.",
      sourceLabel: 'Project memory', topicKey: `norecord:${ev.summary.toLowerCase().slice(0, 60)}`, evidenceIds: [], private: false };
  }
  return null;
}

/** Plain-text answer for `@ai` when no LLM is available: quote the best sources. */
export function answerRules(cands: Candidate[]): { answer: string; used: Candidate[] } | null {
  const top = [...cands].sort((a, b) => b.score - a.score).slice(0, 2);
  if (!top.length) return null;
  return { answer: top.map((c) => `${clip(c.text.replace(/\s+/g, ' '), 220)} (${c.label})`).join(' '), used: top };
}
