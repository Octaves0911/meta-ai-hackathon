// Pure analytics over rows the route loads from Postgres. Everything the dashboard shows is derived here from
// real meetings, knowledge events, decisions, conflict insights and task history, so it can be unit tested.
import type { IntelTask, MeetingRef, Pattern, PersonStats, ProjectIntelligence, Risk, Slice, StatementChange, TimelineItem } from '@meetpilot/shared';

export interface MeetingRow { id: string; title: string; created_at: Date | string; ended_at: Date | string | null }
export interface TaskRow {
  id: string; meeting_id: string; title: string; assignee: string | null; due: string | null; priority: string | null; category: string | null;
  status: 'open' | 'in_progress' | 'review' | 'done'; created_at: Date | string; event_id: string | null;
  completed_at: Date | string | null; last_status_at: Date | string | null; reschedules: number;
}
export interface EventRow { id: string; meeting_id: string; type: string; entity_key: string | null; summary: string; who: string | null; due_at: Date | string | null; created_at: Date | string }
export interface DecisionRow { id: string; entity_key: string; value: string; meeting_id: string | null; created_at: Date | string; who: string | null }
export interface ConflictRow { id: string; meeting_id: string; title: string; body: string; source_label: string | null; created_at: Date | string }
export interface Input { today: string; weeks: number; meetings: MeetingRow[]; tasks: TaskRow[]; events: EventRow[]; decisions: DecisionRow[]; conflicts: ConflictRow[] }

const DAY = 86_400_000;
const iso = (d: Date | string) => new Date(d).toISOString();
const day = (d: Date | string) => iso(d).slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / DAY);
const pct = (n: number, d: number) => (d ? n / d : null);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export const DEPARTMENT: Record<string, string> = {
  code: 'Engineering', design: 'Design', marketing: 'Marketing', research: 'Research', communication: 'Communications', general: 'General',
};
const LABEL = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

/** Monday of the week containing `d`, as YYYY-MM-DD. */
export function weekStart(d: string): string {
  const t = new Date(d.slice(0, 10) + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

// ---- fuzzy matching of repeated statements ----
const STOP = new Set('the a an and or to of in on for with we i you they will can should need needs must be is are was were it this that by at as from our their have has had do does did not no yes just still again also about get got let lets'.split(' '));
export function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')));
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

interface Cluster { key: string; title: string; tok: Set<string>; events: EventRow[] }
function cluster(events: EventRow[], threshold = 0.5): Cluster[] {
  const out: Cluster[] = [];
  for (const e of [...events].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))) {
    const tok = tokens(e.summary);
    const hit = out.find((c) => (e.entity_key && c.events.some((x) => x.entity_key === e.entity_key)) || jaccard(c.tok, tok) >= threshold);
    if (hit) { hit.events.push(e); for (const t of tok) hit.tok.add(t); }
    else out.push({ key: e.entity_key ?? [...tok].sort().slice(0, 4).join('-'), title: e.summary, tok, events: [e] });
  }
  return out;
}

export function computeIntelligence(inp: Input): ProjectIntelligence {
  const { today, weeks } = inp;
  const meetingById = new Map(inp.meetings.map((m) => [m.id, m]));
  const mref = (id: string | null): MeetingRef | null => { const m = id ? meetingById.get(id) : undefined; return m ? { id: m.id, title: m.title, at: iso(m.ended_at ?? m.created_at) } : null; };

  // ---- tasks ----
  const tasks: IntelTask[] = inp.tasks.map((t) => {
    const completedAt = t.status === 'done' ? (t.completed_at ? iso(t.completed_at) : null) : null;
    const overdue = t.status !== 'done' && !!t.due && t.due < today;
    let daysLate: number | null = null;
    if (t.due) {
      if (t.status === 'done' && completedAt) daysLate = Math.max(0, dayDiff(completedAt, t.due));
      else if (overdue) daysLate = dayDiff(today, t.due);
    }
    const category = t.category ?? 'general';
    return {
      id: t.id, meetingId: t.meeting_id, meetingTitle: meetingById.get(t.meeting_id)?.title ?? '', title: t.title, assignee: t.assignee,
      status: t.status, priority: (t.priority ?? 'unset').toLowerCase(), category, department: DEPARTMENT[category] ?? 'General',
      dueDate: t.due, createdAt: iso(t.created_at), completedAt, overdue, daysLate, rescheduled: Number(t.reschedules) || 0,
    };
  });
  const count = (s: IntelTask['status']) => tasks.filter((t) => t.status === s).length;
  const done = count('done'), overdue = tasks.filter((t) => t.overdue).length;
  const doneLate = tasks.filter((t) => t.status === 'done' && (t.daysLate ?? 0) > 0);
  const doneWithDue = tasks.filter((t) => t.status === 'done' && t.dueDate);
  const onTimeRate = pct(doneWithDue.length - doneLate.length, doneWithDue.length + overdue);

  const slices = (keyOf: (t: IntelTask) => string, labelOf: (k: string) => string = LABEL): Slice[] => {
    const m = new Map<string, Slice>();
    for (const t of tasks) {
      const k = keyOf(t);
      const s = m.get(k) ?? { key: k, label: labelOf(k), total: 0, done: 0, overdue: 0 };
      s.total++; if (t.status === 'done') s.done++; if (t.overdue) s.overdue++;
      m.set(k, s);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  };
  const prioRank: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, unset: 4 };
  const priority = slices((t) => t.priority).sort((a, b) => (prioRank[a.key] ?? 5) - (prioRank[b.key] ?? 5));

  // ---- accountability ----
  const names = [...new Set(tasks.map((t) => t.assignee ?? 'Unassigned'))];
  const people: PersonStats[] = names.map((name) => {
    const mine = tasks.filter((t) => (t.assignee ?? 'Unassigned') === name);
    const d = mine.filter((t) => t.status === 'done'), late = d.filter((t) => (t.daysLate ?? 0) > 0);
    const withDue = d.filter((t) => t.dueDate), od = mine.filter((t) => t.overdue);
    const delays = [...late, ...od].map((t) => t.daysLate ?? 0);
    return {
      name, assigned: mine.length, done: d.length, open: mine.length - d.length, overdue: od.length, late: late.length,
      onTime: withDue.length - late.length, onTimeRate: pct(withDue.length - late.length, withDue.length + od.length),
      avgDelayDays: delays.length ? Math.round((delays.reduce((a, b) => a + b, 0) / delays.length) * 10) / 10 : 0,
      share: tasks.length ? mine.length / tasks.length : 0, rescheduled: mine.reduce((a, t) => a + t.rescheduled, 0),
    };
  }).sort((a, b) => b.assigned - a.assigned);
  const allDelays = tasks.filter((t) => (t.daysLate ?? 0) > 0).map((t) => t.daysLate!);

  // ---- commitments: assigned tasks with a due date, judged against what actually shipped ----
  const committed = tasks.filter((t) => t.dueDate && t.assignee);
  const delivered = committed.filter((t) => t.status === 'done');
  const deliveredLate = delivered.filter((t) => (t.daysLate ?? 0) > 0).length;
  const missed = committed.filter((t) => t.overdue).length;
  const pending = committed.length - delivered.length - missed;
  const byMeeting = inp.meetings.map((m) => {
    const c = committed.filter((t) => t.meetingId === m.id);
    return { ...mref(m.id)!, made: c.length, delivered: c.filter((t) => t.status === 'done').length, late: c.filter((t) => t.status === 'done' && (t.daysLate ?? 0) > 0).length, missed: c.filter((t) => t.overdue).length };
  }).filter((m) => m.made > 0).sort((a, b) => +new Date(b.at) - +new Date(a.at));

  // ---- recurring patterns ----
  const doneTok = tasks.filter((t) => t.status === 'done').map((t) => tokens(t.title));
  const doneEventIds = new Set(inp.tasks.filter((t) => t.status === 'done' && t.event_id).map((t) => t.event_id!));
  const toPattern = (c: Cluster, resolved: boolean): Pattern => {
    const ms = [...new Map(c.events.map((e) => [e.meeting_id, mref(e.meeting_id)]).filter(([, v]) => v) as [string, MeetingRef][]).values()].sort((a, b) => +new Date(a.at) - +new Date(b.at));
    return {
      key: c.key, title: c.title, count: c.events.length, meetings: ms, firstSeen: iso(c.events[0].created_at), lastSeen: iso(c.events[c.events.length - 1].created_at),
      resolved, who: [...new Set(c.events.map((e) => e.who).filter(Boolean) as string[])],
    };
  };
  const spansMeetings = (c: Cluster) => new Set(c.events.map((e) => e.meeting_id)).size >= 2;
  const isResolved = (c: Cluster) => c.events.some((e) => doneEventIds.has(e.id)) || doneTok.some((t) => jaccard(t, c.tok) >= 0.5);
  const clustersOf = (types: string[]) => cluster(inp.events.filter((e) => types.includes(e.type))).filter(spansMeetings);
  const recurringTasks = clustersOf(['task', 'deadline']).map((c) => toPattern(c, isResolved(c))).sort((a, b) => b.count - a.count);
  const blockerClusters = clustersOf(['blocker']);
  const recurringBlockers = blockerClusters.map((c) => toPattern(c, isResolved(c))).sort((a, b) => b.count - a.count);
  const unresolved = clustersOf(['task', 'deadline', 'question', 'blocker']).filter((c) => !isResolved(c)).map((c) => toPattern(c, false)).sort((a, b) => b.count - a.count);
  const openBlockers = recurringBlockers.filter((p) => !p.resolved).length + cluster(inp.events.filter((e) => e.type === 'blocker')).filter((c) => !spansMeetings(c) && !isResolved(c)).length;

  // ---- statement changes (decisions and deadlines that were reversed or moved) ----
  type Stmt = { kind: 'decision' | 'deadline'; key: string; value: string; who: string | null; at: string; meetingId: string | null };
  const stmts: Stmt[] = [
    ...inp.decisions.map((d): Stmt => ({ kind: 'decision', key: d.entity_key, value: d.value, who: d.who, at: iso(d.created_at), meetingId: d.meeting_id })),
    ...inp.events.filter((e) => e.type === 'deadline' && e.entity_key && e.due_at).map((e): Stmt => ({ kind: 'deadline', key: e.entity_key!, value: day(e.due_at!), who: e.who, at: iso(e.created_at), meetingId: e.meeting_id })),
  ];
  const statementChanges: StatementChange[] = [];
  const groups = new Map<string, Stmt[]>();
  for (const s of stmts) groups.set(`${s.kind}:${s.key}`, [...(groups.get(`${s.kind}:${s.key}`) ?? []), s]);
  for (const list of groups.values()) {
    list.sort((a, b) => +new Date(a.at) - +new Date(b.at));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (a.value.toLowerCase() === b.value.toLowerCase()) continue;
      statementChanges.push({
        key: b.key, label: LABEL(b.key), kind: b.kind, from: a.value, to: b.value, fromBy: a.who, by: b.who, at: b.at, fromAt: a.at,
        meeting: mref(b.meetingId), fromMeeting: mref(a.meetingId), contradictsOther: !!a.who && !!b.who && a.who.toLowerCase() !== b.who.toLowerCase(),
      });
    }
  }
  statementChanges.sort((a, b) => +new Date(b.at) - +new Date(a.at));

  // ---- conflicts ----
  const conflicts = inp.conflicts.map((c) => ({ id: c.id, title: c.title, body: c.body, at: iso(c.created_at), source: c.source_label, meeting: mref(c.meeting_id) })).sort((a, b) => +new Date(b.at) - +new Date(a.at));

  // ---- weekly trend ----
  const start = new Date(weekStart(today) + 'T00:00:00Z');
  const weekKeys = Array.from({ length: weeks }, (_, i) => new Date(start.getTime() - (weeks - 1 - i) * 7 * DAY).toISOString().slice(0, 10));
  const trend = weekKeys.map((w) => ({
    week: w,
    created: tasks.filter((t) => weekStart(t.createdAt) === w).length,
    completed: tasks.filter((t) => t.completedAt && weekStart(t.completedAt) === w).length,
    conflicts: conflicts.filter((c) => weekStart(c.at) === w).length,
  }));

  // ---- health ----
  const openTasks = tasks.length - done;
  const recent = trend.slice(-2);
  const created2 = recent.reduce((a, w) => a + w.created, 0), completed2 = recent.reduce((a, w) => a + w.completed, 0);
  const recentConflicts = conflicts.filter((c) => dayDiff(today, c.at) <= 14).length;
  const drivers = tasks.length ? [
    { key: 'delivery', label: 'Delivery on time', weight: 0.35, score: onTimeRate ?? 1, note: onTimeRate == null ? 'No dated commitments yet' : `${Math.round(onTimeRate * 100)}% of dated tasks delivered on time` },
    { key: 'overdue', label: 'Overdue load', weight: 0.25, score: 1 - Math.min(1, overdue / Math.max(1, openTasks)), note: `${overdue} of ${openTasks} open tasks are overdue` },
    { key: 'consistency', label: 'Decision consistency', weight: 0.15, score: 1 - Math.min(1, (recentConflicts + statementChanges.length * 0.5) / Math.max(3, inp.decisions.length)), note: `${recentConflicts} conflicts in 14 days, ${statementChanges.length} changed statements` },
    { key: 'blockers', label: 'Blockers', weight: 0.15, score: 1 - Math.min(1, openBlockers / 3), note: `${openBlockers} unresolved blocker${openBlockers === 1 ? '' : 's'}` },
    { key: 'momentum', label: 'Momentum', weight: 0.10, score: created2 ? clamp01(completed2 / created2) : completed2 ? 1 : 0.7, note: `${completed2} done vs ${created2} created in 2 weeks` },
  ].map((d) => ({ ...d, score: Math.round(clamp01(d.score) * 100) / 100 })) : [];
  const score = drivers.length ? Math.round(drivers.reduce((a, d) => a + d.score * d.weight, 0) * 100) : null;
  const label = score == null ? 'no_data' : score >= 75 ? 'on_track' : score >= 50 ? 'at_risk' : 'critical';

  // ---- risks ----
  const risks: Risk[] = [];
  if (overdue) risks.push({ id: 'overdue', severity: overdue >= 4 ? 'high' : 'medium', title: `${overdue} overdue task${overdue === 1 ? '' : 's'}`, detail: 'Past their due date and not done.', drill: { kind: 'tasks', filter: 'overdue' } });
  for (const p of people) {
    if (p.name !== 'Unassigned' && (p.overdue >= 3 || (p.open >= 4 && p.share >= 0.5)))
      risks.push({ id: `load-${p.name}`, severity: p.overdue >= 3 ? 'high' : 'medium', title: `${p.name} is a bottleneck`, detail: `${p.open} open, ${p.overdue} overdue, ${Math.round(p.share * 100)}% of all tasks.`, drill: { kind: 'tasks', assignee: p.name } });
  }
  const un = tasks.filter((t) => t.status !== 'done' && !t.assignee).length;
  if (un) risks.push({ id: 'unowned', severity: 'medium', title: `${un} open task${un === 1 ? '' : 's'} without an owner`, detail: 'Nobody is accountable for these yet.', drill: { kind: 'tasks' } });
  const staleReview = inp.tasks.filter((t) => t.status === 'review' && t.last_status_at && dayDiff(today, day(t.last_status_at)) >= 3).length;
  if (staleReview) risks.push({ id: 'review', severity: 'low', title: `${staleReview} task${staleReview === 1 ? '' : 's'} waiting in review 3+ days`, detail: 'Finished work is blocked on a reviewer.', drill: { kind: 'tasks', filter: 'review' } });
  for (const b of recurringBlockers.filter((p) => !p.resolved).slice(0, 2)) risks.push({ id: `blocker-${b.key}`, severity: 'high', title: `Recurring blocker: ${b.title}`, detail: `Raised in ${b.meetings.length} meetings and still unresolved.`, drill: { kind: 'patterns' } });
  if (unresolved.length) risks.push({ id: 'unresolved', severity: unresolved.length >= 3 ? 'medium' : 'low', title: `${unresolved.length} item${unresolved.length === 1 ? '' : 's'} discussed repeatedly without resolution`, detail: unresolved.slice(0, 2).map((u) => u.title).join(' · '), drill: { kind: 'patterns' } });
  if (recentConflicts) risks.push({ id: 'conflicts', severity: recentConflicts >= 3 ? 'high' : 'medium', title: `${recentConflicts} conflicting statement${recentConflicts === 1 ? '' : 's'} in the last 2 weeks`, detail: 'New statements contradicted earlier decisions.', drill: { kind: 'conflicts' } });
  const reschedTasks = tasks.filter((t) => t.rescheduled >= 2).length;
  if (reschedTasks) risks.push({ id: 'resched', severity: 'low', title: `${reschedTasks} commitment${reschedTasks === 1 ? '' : 's'} moved repeatedly`, detail: 'Due dates keep slipping.', drill: { kind: 'tasks' } });
  const rank = { high: 0, medium: 1, low: 2 };
  risks.sort((a, b) => rank[a.severity] - rank[b.severity]);

  // ---- timeline ----
  const timeline: TimelineItem[] = [
    ...inp.meetings.filter((m) => m.ended_at).map((m): TimelineItem => ({ at: iso(m.ended_at!), type: 'meeting', title: m.title, detail: 'Meeting ended', meetingId: m.id })),
    ...inp.decisions.map((d): TimelineItem => ({ at: iso(d.created_at), type: 'decision', title: `${LABEL(d.entity_key)}: ${d.value}`, detail: d.who ? `Decided by ${d.who}` : undefined, meetingId: d.meeting_id ?? undefined })),
    ...conflicts.map((c): TimelineItem => ({ at: c.at, type: 'conflict', title: c.title, detail: c.body, meetingId: c.meeting?.id })),
    ...statementChanges.map((c): TimelineItem => ({ at: c.at, type: 'change', title: `${c.label} changed: ${c.from} → ${c.to}`, detail: c.by ? `by ${c.by}` : undefined, meetingId: c.meeting?.id })),
    ...tasks.filter((t) => t.completedAt).map((t): TimelineItem => ({ at: t.completedAt!, type: 'done', title: t.title, detail: `${t.assignee ?? 'Unassigned'} completed${(t.daysLate ?? 0) > 0 ? `, ${t.daysLate}d late` : ''}`, meetingId: t.meetingId })),
    ...tasks.filter((t) => t.overdue).map((t): TimelineItem => ({ at: `${t.dueDate}T23:59:00.000Z`, type: 'overdue', title: t.title, detail: `${t.assignee ?? 'Unassigned'} · ${t.daysLate}d overdue`, meetingId: t.meetingId })),
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, 40);

  return {
    generatedAt: new Date().toISOString(), today, weeks,
    health: { score, label, drivers, risks },
    kpis: {
      totalTasks: tasks.length, done, inProgress: count('in_progress'), review: count('review'), pending: count('open'), overdue,
      completionRate: tasks.length ? done / tasks.length : 0, onTimeRate, conflicts: conflicts.length, reversals: statementChanges.length,
      openBlockers, meetings: inp.meetings.length, decisions: inp.decisions.length,
    },
    trend,
    classification: {
      category: slices((t) => t.category), priority, department: slices((t) => t.department, (k) => k), assignee: slices((t) => t.assignee ?? 'Unassigned', (k) => k),
    },
    patterns: { recurringTasks, recurringBlockers, unresolved },
    commitments: {
      total: committed.length, delivered: delivered.length, deliveredLate, missed, pending, rescheduled: committed.reduce((a, t) => a + t.rescheduled, 0),
      reliability: pct(delivered.length - deliveredLate, committed.length - pending), byMeeting,
    },
    conflicts: { total: conflicts.length, items: conflicts.slice(0, 25) },
    statementChanges: statementChanges.slice(0, 40),
    accountability: {
      people,
      team: { assigned: tasks.length, done, overdue, onTimeRate, avgDelayDays: allDelays.length ? Math.round((allDelays.reduce((a, b) => a + b, 0) / allDelays.length) * 10) / 10 : 0 },
    },
    timeline,
    tasks: tasks.slice(0, 500),
  };
}
