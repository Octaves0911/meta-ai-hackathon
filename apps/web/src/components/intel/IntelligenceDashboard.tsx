import { AlertTriangle, ArrowRight, ArrowRightLeft, CheckCircle2, Clock3, GitCompareArrows, Handshake, Repeat2, ShieldAlert, Target, Users } from 'lucide-react';
import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IntelTask, Pattern, ProjectIntelligence, Risk, Slice } from '@meetpilot/shared';
import { api } from '../../lib/api';
import { Reveal } from '../../landing/Reveal';
import { useCountUp } from '../../landing/hooks';
import { EmptyState, Skeleton, toast } from '../../ui';
import { Drawer } from './Drawer';
import { Donut, Gauge, Meter, StackBar, TrendChart } from './charts';
import '../../styles/intel.css';

type Drill = { title: string; subtitle?: string; body: 'tasks' | 'patterns' | 'conflicts' | 'changes'; filter?: (t: IntelTask) => boolean; patterns?: Pattern[] } | null;
type Dim = 'category' | 'priority' | 'department' | 'assignee';
const DIM_LABEL: Record<Dim, string> = { category: 'Type', priority: 'Priority', department: 'Department', assignee: 'Assignee' };
const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const fmtVal = (v: string) => (/^\d{4}-\d\d-\d\d$/.test(v) ? new Date(v + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : v);
const fmtDate = (s: string) => new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const HEALTH = { on_track: { label: 'On track', tone: 'var(--success)', cls: 'success' }, at_risk: { label: 'At risk', tone: 'var(--warn)', cls: 'warn' }, critical: { label: 'Critical', tone: 'var(--danger)', cls: 'danger' }, no_data: { label: 'Not enough data', tone: 'var(--border-strong)', cls: '' } } as const;

function Num({ to, suffix = '' }: { to: number; suffix?: string }) {
  const { ref, value } = useCountUp(to, 1.1);
  return <span ref={ref as never}>{value}{suffix}</span>;
}

function Section({ id, icon: Icon, title, hint, children, aside }: { id: string; icon: typeof Target; title: string; hint?: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <Reveal className="intel-section"><section id={`intel-${id}`}>
      <div className="intel-head"><div><h3><Icon size={18} /> {title}</h3>{hint && <p className="faint">{hint}</p>}</div>{aside}</div>
      {children}
    </section></Reveal>
  );
}

export function IntelligenceDashboard({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectIntelligence | null>(null);
  const [weeks, setWeeks] = useState(12);
  const [dim, setDim] = useState<Dim>('category');
  const [pat, setPat] = useState<'unresolved' | 'recurringBlockers' | 'recurringTasks'>('unresolved');
  const [drill, setDrill] = useState<Drill>(null);
  const [tlFilter, setTlFilter] = useState<string>('all');

  useEffect(() => {
    setData(null);
    api<ProjectIntelligence>(`/projects/${projectId}/intelligence?weeks=${weeks}`).then(setData).catch((e) => toast.error(e.message));
  }, [projectId, weeks]);

  const tasksDrill = (title: string, filter: (t: IntelTask) => boolean, subtitle?: string) => setDrill({ title, subtitle, body: 'tasks', filter });
  const riskDrill = (r: Risk) => {
    const d = r.drill; if (!d || !data) return;
    if (d.kind === 'tasks') tasksDrill(r.title, (t) => (d.assignee ? t.assignee === d.assignee && t.status !== 'done' : d.filter === 'overdue' ? t.overdue : d.filter === 'review' ? t.status === 'review' : t.status !== 'done'), r.detail);
    else if (d.kind === 'patterns') setDrill({ title: r.title, subtitle: r.detail, body: 'patterns', patterns: [...data.patterns.recurringBlockers.filter((p) => !p.resolved), ...data.patterns.unresolved] });
    else setDrill({ title: r.title, subtitle: r.detail, body: d.kind === 'conflicts' ? 'conflicts' : 'changes' });
  };
  const pickSlice = (key: string) => data && tasksDrill(`${DIM_LABEL[dim]}: ${data.classification[dim].find((s) => s.key === key)?.label ?? key}`, (t) => (dim === 'assignee' ? (t.assignee ?? 'Unassigned') : t[dim]) === key);

  if (!data) return <div className="stack"><Skeleton h={220} /><div className="grid"><Skeleton h={100} /><Skeleton h={100} /><Skeleton h={100} /><Skeleton h={100} /></div><Skeleton h={280} /></div>;
  if (!data.kpis.totalTasks && !data.kpis.meetings) return <div className="card"><EmptyState icon={Target} title="No project history yet">Hold a meeting with AI Assistance on. Tasks, decisions and commitments will appear here as they are discussed.</EmptyState></div>;

  const k = data.kpis, h = HEALTH[data.health.label];
  const kpis = [
    { label: 'Total tasks', v: k.totalTasks, tone: '', icon: Target, on: () => tasksDrill('All tasks', () => true) },
    { label: 'Completed', v: k.done, tone: 'ok', icon: CheckCircle2, on: () => tasksDrill('Completed tasks', (t) => t.status === 'done') },
    { label: 'In progress', v: k.inProgress + k.review, tone: 'ai', icon: Clock3, on: () => tasksDrill('In progress and in review', (t) => t.status === 'in_progress' || t.status === 'review') },
    { label: 'Pending', v: k.pending, tone: 'warn', icon: Clock3, on: () => tasksDrill('Pending tasks', (t) => t.status === 'open') },
    { label: 'Overdue', v: k.overdue, tone: 'danger', icon: AlertTriangle, on: () => tasksDrill('Overdue tasks', (t) => t.overdue) },
  ];
  const cls = data.classification[dim];
  const maxRow = Math.max(1, ...cls.map((s) => s.total));
  const cm = data.commitments;
  const cmParts = [
    { label: 'Delivered on time', n: cm.delivered - cm.deliveredLate, c: 'var(--success)' }, { label: 'Delivered late', n: cm.deliveredLate, c: 'var(--warn)' },
    { label: 'Pending', n: cm.pending, c: 'var(--accent)' }, { label: 'Missed', n: cm.missed, c: 'var(--danger)' },
  ];
  const patterns = data.patterns[pat];
  const tl = data.timeline.filter((t) => tlFilter === 'all' || t.type === tlFilter);

  return (
    <div className="intel">
      {/* Health */}
      <Reveal now><div className="card health">
        <div className="health-gauge">
          <Gauge value={data.health.score} tone={h.tone} />
          <span className={`pill ${h.cls}`}>{h.label}</span>
        </div>
        <div className="health-drivers">
          <h3>Project health</h3>
          <p className="faint">Weighted from delivery, overdue load, decision consistency, blockers and momentum.</p>
          {data.health.drivers.map((d) => (
            <div className="driver" key={d.key} title={d.note}><div className="driver-row"><span>{d.label}</span><span className="faint">{d.note}</span></div><Meter value={d.score} tone={d.score >= 0.75 ? 'var(--success)' : d.score >= 0.5 ? 'var(--warn)' : 'var(--danger)'} /></div>
          ))}
        </div>
        <div className="health-risks">
          <h3><ShieldAlert size={17} /> What needs attention</h3>
          {data.health.risks.length === 0 && <p className="faint">No risks detected. Nice.</p>}
          {data.health.risks.slice(0, 5).map((r) => (
            <button key={r.id} className={`risk ${r.severity}`} onClick={() => riskDrill(r)}><i /><span><b>{r.title}</b><small>{r.detail}</small></span><ArrowRight size={15} /></button>
          ))}
        </div>
      </div></Reveal>

      {/* KPIs */}
      <div className="kpi-grid">
        {kpis.map(({ label, v, tone, icon: Icon, on }, i) => (
          <motion.button key={label} className="card kpi" onClick={on} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 * i, duration: 0.5 }} whileHover={{ y: -3 }}>
            <span className={`ico ${tone}`}><Icon size={16} /></span><span className="label">{label}</span><strong><Num to={v} /></strong>
            <small>{k.totalTasks ? `${Math.round((v / k.totalTasks) * 100)}% of tasks` : ''}</small>
          </motion.button>
        ))}
      </div>
      <div className="kpi-grid sub">
        <div className="card kpi flat"><span className="label">Completion rate</span><strong>{pct(k.completionRate)}</strong><Meter value={k.completionRate} tone="var(--success)" /></div>
        <div className="card kpi flat"><span className="label">On-time delivery</span><strong>{pct(k.onTimeRate)}</strong><Meter value={k.onTimeRate ?? 0} tone="var(--accent)" /></div>
        <button className="card kpi flat" onClick={() => setDrill({ title: 'Conflicting statements', body: 'conflicts' })}><span className="label">Conflicts detected</span><strong><Num to={k.conflicts} /></strong><small>{k.reversals} statements changed</small></button>
        <button className="card kpi flat" onClick={() => { setPat('recurringBlockers'); document.getElementById('intel-patterns')?.scrollIntoView({ behavior: 'smooth' }); }}><span className="label">Open blockers</span><strong><Num to={k.openBlockers} /></strong><small>raised and unresolved</small></button>
      </div>

      {/* Trend */}
      <Section id="trend" icon={Target} title="Execution trend" hint="Work created vs completed each week, with conflicts marked."
        aside={<div className="seg" role="tablist" aria-label="Range">{[4, 12, 26].map((w) => <button key={w} role="tab" aria-selected={weeks === w} className={weeks === w ? 'on' : ''} onClick={() => setWeeks(w)}>{w}w</button>)}</div>}>
        <div className="card"><TrendChart data={data.trend} /></div>
      </Section>

      {/* Classification */}
      <Section id="classification" icon={Target} title="Task breakdown" hint="Click a slice or row to see the tasks behind it."
        aside={<div className="seg">{(Object.keys(DIM_LABEL) as Dim[]).map((d) => <button key={d} className={dim === d ? 'on' : ''} onClick={() => setDim(d)}>{DIM_LABEL[d]}</button>)}</div>}>
        <div className="card split">
          <Donut slices={cls} onPick={pickSlice} />
          <div className="rows">
            {cls.map((s: Slice) => (
              <button className="row-bar" key={s.key} onClick={() => pickSlice(s.key)}>
                <span className="name">{s.label}</span><StackBar done={s.done} overdue={s.overdue} total={s.total} max={maxRow} /><span className="num">{s.done}/{s.total}{s.overdue ? <em> · {s.overdue} late</em> : null}</span>
              </button>
            ))}
            <div className="legend"><span><i style={{ background: 'var(--success)' }} />Done</span><span><i style={{ background: 'var(--accent)', opacity: 0.55 }} />Open</span><span><i style={{ background: 'var(--danger)' }} />Overdue</span></div>
          </div>
        </div>
      </Section>

      {/* Commitments */}
      <Section id="commitments" icon={Handshake} title="Commitments vs delivery" hint="Tasks with an owner and a due date, judged against what actually shipped."
        aside={<span className="pill accent">Reliability {pct(cm.reliability)}</span>}>
        <div className="card">
          <div className="funnel" role="img" aria-label="Commitment outcomes">
            {cmParts.map((p) => p.n > 0 && <motion.div key={p.label} style={{ background: p.c, flexGrow: p.n }} initial={{ scaleX: 0 }} whileInView={{ scaleX: 1 }} viewport={{ once: true }} transition={{ duration: 0.7 }} title={`${p.label}: ${p.n}`}>{p.n}</motion.div>)}
          </div>
          <div className="legend">{cmParts.map((p) => <span key={p.label}><i style={{ background: p.c }} />{p.label} · {p.n}</span>)}<span className="faint">{cm.rescheduled} due-date change{cm.rescheduled === 1 ? '' : 's'}</span></div>
          <table className="intel-table"><thead><tr><th>Meeting</th><th>Made</th><th>Delivered</th><th>Late</th><th>Missed</th><th className="hide-sm">Follow-through</th></tr></thead>
            <tbody>{cm.byMeeting.map((m) => (
              <tr key={m.id}><td><Link to={`/meetings/${m.id}`}>{m.title}</Link><div className="faint small">{fmtDate(m.at)}</div></td><td>{m.made}</td><td>{m.delivered}</td><td>{m.late || '–'}</td><td className={m.missed ? 'bad' : ''}>{m.missed || '–'}</td>
                <td className="hide-sm"><Meter value={m.delivered / m.made} tone={m.delivered / m.made >= 0.7 ? 'var(--success)' : m.delivered / m.made >= 0.4 ? 'var(--warn)' : 'var(--danger)'} /></td></tr>))}</tbody></table>
        </div>
      </Section>

      {/* Accountability */}
      <Section id="accountability" icon={Users} title="Accountability" hint="Ownership, follow-through and delays per person."
        aside={<span className="pill">Team on-time {pct(data.accountability.team.onTimeRate)} · avg delay {data.accountability.team.avgDelayDays}d</span>}>
        <div className="card flush">
          <table className="intel-table people"><thead><tr><th>Person</th><th>Ownership</th><th>Done</th><th>Overdue</th><th className="hide-sm">Avg delay</th><th>On-time</th></tr></thead>
            <tbody>{data.accountability.people.map((p) => (
              <tr key={p.name} className="click" onClick={() => tasksDrill(`${p.name}’s tasks`, (t) => (t.assignee ?? 'Unassigned') === p.name, `${p.assigned} assigned · ${p.open} open`)}>
                <td><span className="who"><span className="avatar sm">{p.name[0].toUpperCase()}</span>{p.name}</span></td>
                <td><div className="own"><Meter value={p.share} tone="var(--ai)" /><span>{Math.round(p.share * 100)}%</span></div></td>
                <td>{p.done}/{p.assigned}</td><td className={p.overdue ? 'bad' : ''}>{p.overdue || '–'}</td><td className="hide-sm">{p.avgDelayDays ? `${p.avgDelayDays}d` : '–'}</td>
                <td><span className={`pill ${p.onTimeRate == null ? '' : p.onTimeRate >= 0.75 ? 'success' : p.onTimeRate >= 0.5 ? 'warn' : 'danger'}`}>{pct(p.onTimeRate)}</span></td></tr>))}</tbody></table>
        </div>
      </Section>

      {/* Patterns */}
      <Section id="patterns" icon={Repeat2} title="Recurring patterns" hint="Things raised again and again across meetings."
        aside={<div className="seg">{([['unresolved', 'Unresolved'], ['recurringBlockers', 'Blockers'], ['recurringTasks', 'Repeated tasks']] as const).map(([key, l]) => <button key={key} className={pat === key ? 'on' : ''} onClick={() => setPat(key)}>{l} <em>{data.patterns[key].length}</em></button>)}</div>}>
        <div className="pattern-list">
          {patterns.length === 0 && <div className="card"><EmptyState icon={CheckCircle2} title="Nothing recurring here">No repeated items in this category.</EmptyState></div>}
          {patterns.map((p) => <PatternCard key={p.key + p.title} p={p} />)}
        </div>
      </Section>

      {/* Conflicts + changes */}
      <Section id="changes" icon={GitCompareArrows} title="Statement changes & conflicts" hint="Who changed a previous statement, what changed, and where."
        aside={<button className="ghost" onClick={() => setDrill({ title: 'Detected conflicts', body: 'conflicts' })}>All {data.conflicts.total} conflicts <ArrowRight size={14} /></button>}>
        <div className="change-grid">
          {data.statementChanges.length === 0 && <div className="card"><EmptyState icon={CheckCircle2} title="No changed statements">Decisions and deadlines have stayed consistent.</EmptyState></div>}
          {data.statementChanges.slice(0, 6).map((c, i) => <ChangeCard key={i} c={c} />)}
        </div>
      </Section>

      {/* Timeline */}
      <Section id="timeline" icon={Clock3} title="Project timeline" hint="Decisions, conflicts, changes and delivery in one stream."
        aside={<div className="seg">{['all', 'decision', 'conflict', 'change', 'done', 'overdue', 'meeting'].map((t) => <button key={t} className={tlFilter === t ? 'on' : ''} onClick={() => setTlFilter(t)}>{t === 'all' ? 'All' : t[0].toUpperCase() + t.slice(1)}</button>)}</div>}>
        <div className="card timeline">
          {tl.length === 0 && <p className="faint">Nothing in this view.</p>}
          {tl.map((t, i) => (
            <motion.div className={`tl-item ${t.type}`} key={`${t.at}${i}`} initial={{ opacity: 0, x: -8 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true, margin: '-5%' }} transition={{ duration: 0.4 }}>
              <i /><div><b>{t.meetingId ? <Link to={`/meetings/${t.meetingId}`}>{t.title}</Link> : t.title}</b>{t.detail && <p>{t.detail}</p>}</div><time>{fmtDate(t.at)}</time>
            </motion.div>
          ))}
        </div>
      </Section>

      <Drawer open={!!drill} onClose={() => setDrill(null)} title={drill?.title ?? ''} subtitle={drill?.subtitle}>
        {drill?.body === 'tasks' && <TaskList tasks={data.tasks.filter(drill.filter ?? (() => true))} />}
        {drill?.body === 'patterns' && <div className="pattern-list">{drill.patterns?.map((p) => <PatternCard key={p.key + p.title} p={p} />)}</div>}
        {drill?.body === 'conflicts' && <div className="stack">{data.conflicts.items.map((c) => (
          <div className="insight kind-conflict" key={c.id}><div className="insight-head"><span className="ico"><AlertTriangle size={14} /></span><strong>{c.title}</strong></div><div className="insight-body">{c.body}</div>
            <div className="insight-source">{c.meeting ? <Link to={`/meetings/${c.meeting.id}`}>{c.meeting.title}</Link> : 'Meeting'} · {fmtDate(c.at)}{c.source ? ` · ${c.source}` : ''}</div></div>))}</div>}
        {drill?.body === 'changes' && <div className="stack">{data.statementChanges.map((c, i) => <ChangeCard key={i} c={c} />)}</div>}
      </Drawer>
    </div>
  );
}

function PatternCard({ p }: { p: Pattern }) {
  return (
    <div className="card pattern">
      <div className="pattern-top"><b>{p.title}</b><span className={`pill ${p.resolved ? 'success' : 'warn'}`}>{p.resolved ? 'Resolved' : 'Open'}</span></div>
      <div className="pattern-meta faint">Raised {p.count}× across {p.meetings.length} meetings{p.who.length ? ` · ${p.who.join(', ')}` : ''}</div>
      <div className="dots">{p.meetings.map((m) => <Link key={m.id} to={`/meetings/${m.id}`} title={`${m.title} · ${fmtDate(m.at)}`} className="dot-link"><i /><span>{m.title}</span></Link>)}</div>
    </div>
  );
}

function ChangeCard({ c }: { c: ProjectIntelligence['statementChanges'][number] }) {
  return (
    <div className="card change">
      <div className="change-top"><span className={`pill ${c.kind === 'decision' ? 'ai' : 'accent'}`}>{c.kind === 'decision' ? 'Decision' : 'Deadline'}</span><b>{c.label}</b>{c.contradictsOther && <span className="pill warn">Reversed another person</span>}</div>
      <div className="change-flow"><span className="from">{fmtVal(c.from)}</span><ArrowRightLeft size={15} /><span className="to">{fmtVal(c.to)}</span></div>
      <div className="faint small">{c.fromBy ? `${c.fromBy} said it` : 'Earlier'}{c.fromMeeting ? ` in ${c.fromMeeting.title}` : ''} · changed {c.by ? `by ${c.by}` : ''}{c.meeting ? <> in <Link to={`/meetings/${c.meeting.id}`}>{c.meeting.title}</Link></> : null} on {fmtDate(c.at)}</div>
    </div>
  );
}

function TaskList({ tasks }: { tasks: IntelTask[] }) {
  const sorted = useMemo(() => [...tasks].sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9')), [tasks]);
  if (!sorted.length) return <p className="faint">No tasks match.</p>;
  return (
    <div className="stack">
      {sorted.map((t) => (
        <div className={`dtask${t.overdue ? ' overdue' : ''}`} key={t.id}>
          <div><b>{t.title}</b><div className="faint small">{t.assignee ?? 'Unassigned'} · {t.department} · <Link to={`/meetings/${t.meetingId}`}>{t.meetingTitle}</Link></div></div>
          <div className="dtask-r"><span className={`pill ${t.status === 'done' ? 'success' : t.overdue ? 'danger' : 'accent'}`}>{t.overdue ? `${t.daysLate}d overdue` : t.status.replace('_', ' ')}</span>{t.dueDate && <span className="faint small">due {fmtDate(t.dueDate)}</span>}</div>
        </div>
      ))}
    </div>
  );
}
