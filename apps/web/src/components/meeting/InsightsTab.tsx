import { AlertTriangle, ArrowRightLeft, CheckCircle2, CircleHelp, Gavel, Hourglass, ListChecks, Lock, Mic, NotebookText, Repeat2, Users } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { MeetingSummary, Moment, MomentType } from '@meetpilot/shared';
import { Reveal } from '../../landing/Reveal';
import { useCountUp } from '../../landing/hooks';
import { EmptyState } from '../../ui';
import { Meter, StackBar } from '../intel/charts';

export const MOMENT: Record<MomentType, { label: string; color: string; icon: typeof Gavel }> = {
  decision: { label: 'Decision', color: 'var(--ai)', icon: Gavel },
  task: { label: 'Task', color: 'var(--accent)', icon: ListChecks },
  deadline: { label: 'Deadline', color: 'var(--warn)', icon: Hourglass },
  question: { label: 'Question', color: '#14b8c4', icon: CircleHelp },
  blocker: { label: 'Blocker', color: 'var(--danger)', icon: AlertTriangle },
  conflict: { label: 'Conflict', color: '#e0569c', icon: AlertTriangle },
  info: { label: 'Note', color: 'var(--text-3)', icon: NotebookText },
};
const fmtDate = (s: string) => new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
export const clock = (ms: number | null) => (ms == null ? '' : `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`);

function Num({ to }: { to: number }) {
  const { ref, value } = useCountUp(to, 0.9);
  return <span ref={ref as never}>{value}</span>;
}

function Pulse({ pulse }: { pulse: MeetingSummary['pulse'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...pulse.map((p) => p.lines));
  const h = hover != null ? pulse[hover] : null;
  return (
    <div className="pulse-wrap">
      <div className="pulse" onPointerLeave={() => setHover(null)}>
        {pulse.map((p, i) => (
          <div className="pulse-col" key={i} onPointerEnter={() => setHover(i)}>
            <div className="pulse-marks">{(Object.entries(p.marks) as [MomentType, number][]).map(([t]) => <i key={t} style={{ background: MOMENT[t].color }} title={MOMENT[t].label} />)}</div>
            <motion.div className="pulse-bar" initial={{ height: 0 }} animate={{ height: `${Math.max(6, (p.lines / max) * 100)}%` }} transition={{ duration: 0.7, delay: i * 0.04, ease: [0.2, 0.7, 0.2, 1] }} style={{ opacity: hover == null || hover === i ? 1 : 0.45 }} />
            <span className="pulse-x">{p.label}</span>
          </div>
        ))}
      </div>
      {h && <div className="chart-tip" style={{ left: `${((hover! + 0.5) / pulse.length) * 100}%`, top: -4 }}><b>{h.lines} line{h.lines === 1 ? '' : 's'}</b>{(Object.entries(h.marks) as [MomentType, number][]).map(([t, n]) => <span key={t}><i style={{ background: MOMENT[t].color }} />{n} {MOMENT[t].label.toLowerCase()}{n > 1 ? 's' : ''}</span>)}</div>}
      <div className="legend">{(['decision', 'task', 'deadline', 'question', 'blocker', 'conflict'] as MomentType[]).map((t) => <span key={t}><i style={{ background: MOMENT[t].color }} />{MOMENT[t].label}</span>)}</div>
    </div>
  );
}

export function MomentCard({ m, onJump }: { m: Moment; onJump?: (seq: number) => void }) {
  const { icon: Icon, label, color } = MOMENT[m.type];
  return (
    <div className="moment" style={{ '--c': color } as React.CSSProperties}>
      <span className="moment-ico"><Icon size={15} /></span>
      <div className="moment-body">
        <div className="moment-top"><span className="pill" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}>{label}</span>{m.who && <span className="faint small">{m.who}</span>}
          {m.atMs != null && <span className="faint small">· {clock(m.atMs)}</span>}</div>
        <b>{m.title}</b>
        {m.quote && <blockquote>{m.quote}</blockquote>}
        {m.changedFrom && <div className="moment-note"><ArrowRightLeft size={13} /> Replaced <s>{m.changedFrom.value}</s>{m.changedFrom.meeting && <> from <Link to={`/meetings/${m.changedFrom.meeting.id}`}>{m.changedFrom.meeting.title}</Link></>}</div>}
        {m.raisedBefore.length > 0 && <div className="moment-note warn"><Repeat2 size={13} /> Raised before in {m.raisedBefore.map((r, i) => <span key={r.id}>{i ? ', ' : ''}<Link to={`/meetings/${r.id}`}>{r.title}</Link></span>)}</div>}
        {m.seq != null && onJump && <button className="link-btn" onClick={() => onJump(m.seq!)}>View in transcript</button>}
      </div>
    </div>
  );
}

export function InsightsTab({ s, onJump }: { s: MeetingSummary; onJump: (seq: number) => void }) {
  const [filter, setFilter] = useState<'all' | MomentType>('all');
  if (!s.readable) {
    return <div className="stack">
      <div className="card"><EmptyState icon={Lock} title="Conversation not shared">The owner has not shared this meeting’s transcript and chat, so conversation insights are hidden. Task details are still available.</EmptyState></div>
    </div>;
  }
  const k = s.kpis;
  const cards = [
    { label: 'Transcript lines', v: k.lines, sub: `${k.words} words` }, { label: 'Speakers', v: k.speakers, sub: 'took part' },
    { label: 'Decisions', v: k.decisions, sub: 'recorded' }, { label: 'Tasks', v: k.tasks, sub: 'created' },
    { label: 'Open questions', v: k.questions, sub: 'raised' }, { label: 'Blockers', v: k.blockers, sub: 'raised' },
  ];
  const types = [...new Set(s.moments.map((m) => m.type))];
  const moments = s.moments.filter((m) => filter === 'all' || m.type === filter);
  const maxA = Math.max(1, ...s.tasks.byAssignee.map((a) => a.total));
  return (
    <div className="mi">
      {s.recap && <Reveal now><div className="card recap"><span className="ico ai"><NotebookText size={16} /></span><div><b>{s.recap.title}</b><p>{s.recap.body}</p></div></div></Reveal>}
      <div className="kpi-grid six">
        {cards.map((c, i) => (
          <motion.div className="card kpi flat" key={c.label} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <span className="label">{c.label}</span><strong><Num to={c.v} /></strong><small>{c.sub}</small>
          </motion.div>
        ))}
      </div>
      <div className="mi-grid">
        <Reveal><div className="card"><div className="mi-head"><h3><Mic size={17} /> Conversation pulse</h3><span className="faint small">Lines over time, moments marked</span></div>
          {s.pulse.length ? <Pulse pulse={s.pulse} /> : <p className="faint">No transcript yet.</p>}</div></Reveal>
        <Reveal delay={0.06}><div className="card"><div className="mi-head"><h3><Users size={17} /> Who spoke</h3><span className="faint small">Share of words</span></div>
          <div className="speakers">{s.speakers.map((sp) => (
            <div className="speaker" key={sp.name}><span className="avatar sm">{sp.name[0]}</span><div><div className="speaker-top"><b>{sp.name}</b><span className="faint small">{Math.round(sp.share * 100)}% · ~{sp.minutes}m · {sp.lines} lines</span></div><Meter value={sp.share} tone="var(--ai)" /></div></div>
          ))}{s.speakers.length === 0 && <p className="faint">No one has spoken yet.</p>}</div></div></Reveal>
      </div>

      <Reveal><div className="card">
        <div className="mi-head"><h3><Gavel size={17} /> Key moments</h3>
          <div className="seg"><button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All <em>{s.moments.length}</em></button>{types.map((t) => <button key={t} className={filter === t ? 'on' : ''} onClick={() => setFilter(t)}>{MOMENT[t].label}</button>)}</div></div>
        {moments.length === 0 ? <EmptyState icon={CheckCircle2} title="No key moments">Turn on AI Assistance in a meeting to capture decisions, questions and blockers.</EmptyState>
          : <div className="moments">{moments.map((m) => <MomentCard key={m.id} m={m} onJump={onJump} />)}</div>}
      </div></Reveal>

      <Reveal><div className="card">
        <div className="mi-head"><h3><ListChecks size={17} /> Task outcome</h3><span className="faint small">{s.tasks.done}/{s.tasks.total} done{s.tasks.overdue ? ` · ${s.tasks.overdue} overdue` : ''}{s.tasks.unassigned ? ` · ${s.tasks.unassigned} unassigned` : ''}</span></div>
        {s.tasks.total === 0 ? <p className="faint">No tasks came out of this meeting.</p> : s.tasks.byAssignee.map((a) => (
          <div className="row-bar static" key={a.name}><span className="name">{a.name}</span><StackBar done={a.done} overdue={0} total={a.total} max={maxA} /><span className="num">{a.done}/{a.total}</span></div>
        ))}
      </div></Reveal>
    </div>
  );
}
