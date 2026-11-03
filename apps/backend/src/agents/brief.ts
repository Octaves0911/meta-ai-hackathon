// The task brief every agent receives (docs/09 §1.2): what was said around the task, current decisions with their change history,
// sibling tasks, earlier approved work, and the project memory the agents already had. Shapes match apps/ai/brief.py.
import type { Pool } from 'pg';
import { buildContext } from '../memory/context.js';
import type { Embedder } from '../memory/embedder.js';
import { jaccard, tokens } from '../analytics/compute.js';

export const LINE_RADIUS = 10;
export const MAX_LINES = 24;

export interface SourceLine { speaker: string; text: string; at_task: boolean }
export interface BriefBody {
  task: { title: string; description: string | null; due_date: string | null; assignee: string | null; priority: string | null; assigned_by: string | null };
  context: { label: string; text: string; meta?: Record<string, string | null> }[];
  meeting: { title: string; date: string | null; attendees: string[]; goal: string | null };
  quote: string | null;
  source_lines: SourceLine[];
  decisions: { key: string; value: string; previous: string[] }[];
  neighbours: { title: string; assignee: string | null; status: string | null }[];
  prior_work: { title: string; agent: string; summary: string }[];
}

/** The transcript window around the sentence(s) a task came from: ±LINE_RADIUS segments, the task's own segments marked. Capped. */
export function windowLines(segs: { seq: number; speaker_name: string; text: string }[], from: number | null, to: number | null, max = MAX_LINES): SourceLine[] {
  if (from == null) return [];
  const hi = to ?? from;
  const inWin = segs.filter((s) => s.seq >= from - LINE_RADIUS && s.seq <= hi + LINE_RADIUS).sort((a, b) => a.seq - b.seq);
  let pick = inWin;
  if (inWin.length > max) {
    // keep the task's own lines, then the nearest neighbours, then restore order
    const mid = (from + hi) / 2;
    const own = inWin.filter((s) => s.seq >= from && s.seq <= hi);
    const rest = inWin.filter((s) => !(s.seq >= from && s.seq <= hi)).sort((a, b) => Math.abs(a.seq - mid) - Math.abs(b.seq - mid));
    pick = [...own, ...rest].slice(0, max).sort((a, b) => a.seq - b.seq);
  }
  return pick.map((s) => ({ speaker: s.speaker_name, text: s.text, at_task: s.seq >= from && s.seq <= hi }));
}

/** Current value of each decision plus up to three earlier values (newest first). Decisions from this meeting come first. */
export function withHistory(current: { entity_key: string; value: string }[], older: { entity_key: string; value: string }[]) {
  const hist = new Map<string, string[]>();
  for (const o of older) { const l = hist.get(o.entity_key) ?? []; if (l.length < 3) l.push(o.value); hist.set(o.entity_key, l); }
  return current.map((c) => ({ key: c.entity_key, value: c.value, previous: (hist.get(c.entity_key) ?? []).filter((v) => v !== c.value) }));
}

/** Approved work on similar tasks: same agent counts extra, then title overlap. */
export function rankPriorWork<T extends { title: string; agent: string }>(rows: T[], title: string, agent: string, n = 3): T[] {
  const want = tokens(title);
  return rows
    .map((r) => ({ r, s: jaccard(want, tokens(r.title)) + (r.agent === agent ? 0.15 : 0) }))
    .filter((x) => x.s > 0.15)
    .sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.r);
}

export async function buildBrief(db: Pool, embedder: Embedder, e: {
  id: string; task_id: string; project_id: string; meeting_id: string; reviewer_id: string; agent: string | null;
  title: string; description: string | null; due: string | null; assignee: string | null;
}): Promise<BriefBody> {
  const [task, meeting, parts, decisions, neighbours, approved] = await Promise.all([
    db.query(`select t.priority, ev.quote, ev.segment_from_seq as from_seq, ev.segment_to_seq as to_seq, ub.username as assigned_by
              from tasks t left join knowledge_events ev on ev.id = t.event_id left join users ub on ub.id = t.assigned_by where t.id = $1`, [e.task_id]),
    db.query(`select title, description, to_char(coalesce(started_at, created_at), 'YYYY-MM-DD') as day from meetings where id = $1`, [e.meeting_id]),
    db.query('select u.username from meeting_participants p join users u on u.id = p.user_id where p.meeting_id = $1 order by u.username', [e.meeting_id]),
    db.query(`select entity_key, value from decisions where project_id = $1 and superseded_by is null
              order by (meeting_id = $2) desc, created_at desc limit 10`, [e.project_id, e.meeting_id]),
    db.query(`select t.title, u.username as assignee, t.status from tasks t left join users u on u.id = t.assigned_to
              where t.meeting_id = $1 and t.id <> $2 and t.finalized order by t.created_at limit 10`, [e.meeting_id, e.task_id]),
    db.query(`select t.title, x.agent, x.summary from executions x join tasks t on t.id = x.task_id
              where t.project_id = $1 and x.status = 'approved' and x.task_id <> $2 order by x.updated_at desc limit 25`, [e.project_id, e.task_id]),
  ]);
  const t = task.rows[0] ?? {};
  const keys = decisions.rows.map((d) => d.entity_key);
  const [segs, older, pkg] = await Promise.all([
    t.from_seq != null
      ? db.query('select seq, speaker_name, text from transcript_segments where meeting_id = $1 and seq between $2 and $3 order by seq',
          [e.meeting_id, t.from_seq - LINE_RADIUS, (t.to_seq ?? t.from_seq) + LINE_RADIUS])
      : Promise.resolve({ rows: [] as any[] }),
    keys.length ? db.query('select entity_key, value from decisions where project_id = $1 and entity_key = any($2) and superseded_by is not null order by created_at desc', [e.project_id, keys]) : Promise.resolve({ rows: [] as any[] }),
    buildContext(db, embedder, { projectId: e.project_id, viewerId: e.reviewer_id, query: `${e.title} ${e.description ?? ''}` }),
  ]);

  const hits = Object.values(pkg).flat().slice(0, 12);
  const meetingIds = [...new Set(hits.map((h) => h.meetingId).filter(Boolean))];
  const titles = new Map<string, string>();
  if (meetingIds.length) (await db.query('select id, title from meetings where id = any($1::uuid[])', [meetingIds])).rows.forEach((r) => titles.set(r.id, r.title));
  const context = hits.map((h) => ({
    label: h.sourceType === 'external' ? [h.provider === 'drive' ? 'Drive' : 'Gmail', h.author, h.title].filter(Boolean).join(' · ') : h.meetingId ? `Meeting “${titles.get(h.meetingId) ?? ''}” (${h.sourceType})` : `Project ${h.sourceType}`,
    text: h.text,
    meta: h.sourceType === 'external' && h.meta ? { from_email: h.meta.fromEmail ?? null, thread_id: h.meta.threadId ?? null, message_id: h.meta.messageId ?? null, subject: h.meta.subject ?? null } : undefined,
  }));

  const m = meeting.rows[0] ?? {};
  return {
    task: { title: e.title, description: e.description, due_date: e.due, assignee: e.assignee, priority: t.priority ?? null, assigned_by: t.assigned_by ?? null },
    context,
    meeting: { title: m.title ?? '', date: m.day ?? null, attendees: parts.rows.map((r) => r.username), goal: m.description ?? null },
    quote: t.quote ?? null,
    source_lines: windowLines(segs.rows, t.from_seq ?? null, t.to_seq ?? null),
    decisions: withHistory(decisions.rows, older.rows),
    neighbours: neighbours.rows.map((r) => ({ title: r.title, assignee: r.assignee, status: r.status })),
    prior_work: rankPriorWork(approved.rows, e.title, e.agent ?? '').map((r) => ({ title: r.title, agent: r.agent, summary: String(r.summary ?? '').slice(0, 600) })),
  };
}
