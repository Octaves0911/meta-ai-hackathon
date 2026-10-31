// Pure per-meeting analytics: who spoke, how the conversation moved, and what it produced.
import type { MeetingRef, MeetingSummary, Moment, MomentType } from '@meetpilot/shared';
import { jaccard, tokens } from './compute.js';

export interface Seg { seq: number; speaker_name: string; text: string; offset_ms: number | null; created_at: Date | string }
export interface Ev { id: string; meeting_id: string; type: string; entity_key: string | null; summary: string; who: string | null; quote: string | null; segment_from_seq: number | null; created_at: Date | string }
export interface Dec { entity_key: string; value: string; meeting_id: string | null; event_id: string | null; created_at: Date | string }
export interface Conf { id: string; title: string; body: string; created_at: Date | string }
export interface TaskR { status: 'open' | 'in_progress' | 'review' | 'done'; assignee: string | null; due: string | null }
export interface MeetingInput {
  meetingId: string; today: string; segments: Seg[]; events: Ev[]; earlierEvents: Ev[]; decisions: Dec[]; conflicts: Conf[]; tasks: TaskR[];
  meetings: { id: string; title: string; created_at: Date | string; ended_at: Date | string | null }[];
  messages: number; recap: { title: string; body: string; created_at: Date | string } | null; readable: boolean;
}

const iso = (d: Date | string) => new Date(d).toISOString();
const WPM = 150;

export function computeMeetingSummary(inp: MeetingInput): MeetingSummary {
  const ref = (id: string | null): MeetingRef | null => { const m = inp.meetings.find((x) => x.id === id); return m ? { id: m.id, title: m.title, at: iso(m.ended_at ?? m.created_at) } : null; };

  const taskStats = {
    total: inp.tasks.length, done: inp.tasks.filter((t) => t.status === 'done').length,
    overdue: inp.tasks.filter((t) => t.status !== 'done' && t.due && t.due < inp.today).length, unassigned: inp.tasks.filter((t) => !t.assignee).length,
    byStatus: { open: 0, in_progress: 0, review: 0, done: 0 },
    byAssignee: [] as { name: string; total: number; done: number }[],
  };
  for (const t of inp.tasks) {
    taskStats.byStatus[t.status]++;
    const name = t.assignee ?? 'Unassigned';
    const row = taskStats.byAssignee.find((r) => r.name === name) ?? (taskStats.byAssignee[taskStats.byAssignee.push({ name, total: 0, done: 0 }) - 1]);
    row.total++; if (t.status === 'done') row.done++;
  }
  taskStats.byAssignee.sort((a, b) => b.total - a.total);
  const recap = inp.recap ? { title: inp.recap.title, body: inp.recap.body, createdAt: iso(inp.recap.created_at) } : null;

  if (!inp.readable) {
    return { readable: false, recap, kpis: { lines: 0, words: 0, speakers: 0, decisions: 0, tasks: inp.tasks.length, questions: 0, blockers: 0, conflicts: 0, messages: 0 }, speakers: [], pulse: [], moments: [], tasks: taskStats };
  }

  // ---- speakers ----
  const by = new Map<string, { lines: number; words: number }>();
  for (const s of inp.segments) {
    const e = by.get(s.speaker_name) ?? { lines: 0, words: 0 };
    e.lines++; e.words += s.text.split(/\s+/).filter(Boolean).length;
    by.set(s.speaker_name, e);
  }
  const totalWords = [...by.values()].reduce((a, b) => a + b.words, 0) || 1;
  const speakers = [...by.entries()].map(([name, v]) => ({ name, lines: v.lines, words: v.words, share: v.words / totalWords, minutes: Math.round((v.words / WPM) * 10) / 10 })).sort((a, b) => b.words - a.words);

  // ---- moments ----
  const segAt = new Map(inp.segments.map((s) => [s.seq, s]));
  const decByEvent = new Map(inp.decisions.filter((d) => d.event_id).map((d) => [d.event_id!, d]));
  const moments: Moment[] = inp.events.filter((e) => e.type !== 'info' || e.summary).map((e) => {
    let changedFrom: Moment['changedFrom'] = null;
    if (e.type === 'decision' && e.entity_key) {
      const mine = decByEvent.get(e.id);
      const prior = inp.decisions.filter((d) => d.entity_key === e.entity_key && d.meeting_id !== inp.meetingId && +new Date(d.created_at) < +new Date(mine?.created_at ?? e.created_at))
        .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0];
      if (prior && mine && prior.value.toLowerCase() !== mine.value.toLowerCase()) changedFrom = { value: prior.value, meeting: ref(prior.meeting_id) };
    }
    let raisedBefore: MeetingRef[] = [];
    if (['question', 'blocker', 'task', 'deadline'].includes(e.type)) {
      const tok = tokens(e.summary);
      const hits = inp.earlierEvents.filter((x) => x.type === e.type && x.meeting_id !== inp.meetingId && ((e.entity_key && x.entity_key === e.entity_key) || jaccard(tok, tokens(x.summary)) >= 0.5));
      raisedBefore = [...new Map(hits.map((x) => [x.meeting_id, ref(x.meeting_id)]).filter(([, v]) => v) as [string, MeetingRef][]).values()].sort((a, b) => +new Date(a.at) - +new Date(b.at));
    }
    const seg = e.segment_from_seq != null ? segAt.get(e.segment_from_seq) : undefined;
    return { id: e.id, type: e.type as MomentType, title: e.summary, who: e.who, quote: e.quote, seq: e.segment_from_seq, atMs: seg?.offset_ms ?? null, at: iso(e.created_at), changedFrom, raisedBefore };
  });
  for (const c of inp.conflicts) moments.push({ id: c.id, type: 'conflict', title: c.title, who: null, quote: c.body, seq: null, atMs: null, at: iso(c.created_at), changedFrom: null, raisedBefore: [] });
  moments.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || +new Date(a.at) - +new Date(b.at));

  // ---- conversation pulse: lines per slice of the meeting, with moments marked ----
  const n = inp.segments.length;
  const buckets = Math.max(1, Math.min(12, n));
  const hasTime = inp.segments.some((s) => (s.offset_ms ?? 0) > 0);
  const maxMs = Math.max(1, ...inp.segments.map((s) => s.offset_ms ?? 0));
  const bucketOf = (idx: number, ms: number | null) => Math.min(buckets - 1, hasTime && ms != null ? Math.floor((ms / (maxMs + 1)) * buckets) : Math.floor((idx / Math.max(1, n)) * buckets));
  const pulse = Array.from({ length: buckets }, (_, i) => ({ label: hasTime ? `${Math.round(((i + 0.5) / buckets) * maxMs / 60000)}m` : `${i + 1}`, lines: 0, marks: {} as Partial<Record<MomentType, number>> }));
  inp.segments.forEach((s, i) => { pulse[bucketOf(i, s.offset_ms)].lines++; });
  const firstAt = n ? +new Date(inp.segments[0].created_at) : 0, lastAt = n ? +new Date(inp.segments[n - 1].created_at) : 0;
  for (const m of moments) {
    let b = buckets - 1;
    if (m.seq != null) { const idx = inp.segments.findIndex((s) => s.seq >= m.seq!); if (idx >= 0) b = bucketOf(idx, segAt.get(inp.segments[idx].seq)?.offset_ms ?? null); }
    else if (lastAt > firstAt) b = Math.max(0, Math.min(buckets - 1, Math.floor(((+new Date(m.at) - firstAt) / (lastAt - firstAt)) * buckets)));
    if (n) pulse[b].marks[m.type] = (pulse[b].marks[m.type] ?? 0) + 1;
  }

  const count = (t: MomentType) => moments.filter((m) => m.type === t).length;
  return {
    readable: true, recap,
    kpis: { lines: n, words: totalWords === 1 && !n ? 0 : totalWords, speakers: speakers.length, decisions: count('decision'), tasks: inp.tasks.length, questions: count('question'), blockers: count('blocker'), conflicts: count('conflict'), messages: inp.messages },
    speakers, pulse: n ? pulse : [], moments, tasks: taskStats,
  };
}
