import { motion, useReducedMotion } from 'framer-motion';
import { useState, type ReactNode } from 'react';

export const PALETTE = ['var(--accent)', 'var(--ai)', '#e0569c', 'var(--success)', 'var(--warn)', '#14b8c4', '#8b95a8'];
const EASE = [0.2, 0.7, 0.2, 1] as const;

/** Smooth line through points (cardinal-style cubic Béziers). */
function smooth(pts: [number, number][]): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], mx = (x0 + x1) / 2;
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  return d;
}

export function TrendChart({ data }: { data: { week: string; created: number; completed: number; conflicts: number }[] }) {
  const reduced = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 240, P = { l: 30, r: 12, t: 14, b: 28 };
  const max = Math.max(3, ...data.map((d) => Math.max(d.created, d.completed)));
  const x = (i: number) => P.l + (i * (W - P.l - P.r)) / Math.max(1, data.length - 1);
  const y = (v: number) => P.t + (1 - v / max) * (H - P.t - P.b);
  const line = (k: 'created' | 'completed') => data.map((d, i) => [x(i), y(d[k])] as [number, number]);
  const area = (k: 'created' | 'completed') => `${smooth(line(k))} L${x(data.length - 1)},${H - P.b} L${x(0)},${H - P.b} Z`;
  const ticks = [0, Math.ceil(max / 2), max];
  const h = hover != null ? data[hover] : null;
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Tasks created and completed per week" onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="g-created" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient>
          <linearGradient id="g-done" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--success)" stopOpacity="0.3" /><stop offset="1" stopColor="var(--success)" stopOpacity="0" /></linearGradient>
        </defs>
        {ticks.map((t) => <g key={t}><line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} className="grid-line" /><text x={P.l - 8} y={y(t) + 4} className="axis" textAnchor="end">{t}</text></g>)}
        <path d={area('created')} fill="url(#g-created)" /><path d={area('completed')} fill="url(#g-done)" />
        <motion.path d={smooth(line('created'))} className="series" stroke="var(--accent)" initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease: EASE }} />
        <motion.path d={smooth(line('completed'))} className="series" stroke="var(--success)" initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, delay: 0.12, ease: EASE }} />
        {data.map((d, i) => d.conflicts > 0 && <circle key={i} cx={x(i)} cy={H - P.b + 1} r={3 + Math.min(3, d.conflicts)} fill="var(--danger)" opacity="0.85" />)}
        {data.map((d, i) => (i % Math.ceil(data.length / 8) === 0 || i === data.length - 1) && <text key={d.week} x={x(i)} y={H - 8} className="axis" textAnchor="middle">{d.week.slice(5)}</text>)}
        {hover != null && <g><line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} className="guide" /><circle cx={x(hover)} cy={y(data[hover].created)} r="4.5" fill="var(--accent)" /><circle cx={x(hover)} cy={y(data[hover].completed)} r="4.5" fill="var(--success)" /></g>}
        {data.map((d, i) => <rect key={d.week} x={x(i) - (W - P.l - P.r) / data.length / 2} y={0} width={(W - P.l - P.r) / data.length} height={H} fill="transparent" onPointerEnter={() => setHover(i)} onPointerMove={() => setHover(i)} />)}
      </svg>
      {h && <div className="chart-tip" style={{ left: `${(x(hover!) / W) * 100}%` }}><b>Week of {h.week.slice(5)}</b><span><i style={{ background: 'var(--accent)' }} />{h.created} created</span><span><i style={{ background: 'var(--success)' }} />{h.completed} completed</span>{h.conflicts > 0 && <span><i style={{ background: 'var(--danger)' }} />{h.conflicts} conflict{h.conflicts > 1 ? 's' : ''}</span>}</div>}
      <div className="legend"><span><i style={{ background: 'var(--accent)' }} />Created</span><span><i style={{ background: 'var(--success)' }} />Completed</span><span><i style={{ background: 'var(--danger)' }} />Conflicts</span></div>
    </div>
  );
}

export function Donut({ slices, onPick, center }: { slices: { key: string; label: string; total: number }[]; onPick?: (key: string) => void; center?: ReactNode }) {
  const reduced = useReducedMotion();
  const [hover, setHover] = useState<string | null>(null);
  const total = slices.reduce((a, s) => a + s.total, 0) || 1;
  const R = 54, C = 2 * Math.PI * R;
  let acc = 0;
  const cur = slices.find((s) => s.key === hover);
  return (
    <div className="donut">
      <svg viewBox="0 0 140 140" role="img" aria-label="Breakdown">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--surface-3)" strokeWidth="16" />
        {slices.map((s, i) => {
          const len = (s.total / total) * C, off = acc; acc += len;
          return (
            <motion.circle key={s.key} cx="70" cy="70" r={R} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth={hover === s.key ? 20 : 16} strokeLinecap="butt"
              strokeDasharray={`${Math.max(0, len - 2)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 70 70)" style={{ cursor: onPick ? 'pointer' : 'default', transition: 'stroke-width .2s' }}
              initial={reduced ? false : { opacity: 0 }} animate={{ opacity: hover && hover !== s.key ? 0.35 : 1 }} transition={{ duration: 0.4, delay: reduced ? 0 : i * 0.06 }}
              onPointerEnter={() => setHover(s.key)} onPointerLeave={() => setHover(null)} onClick={() => onPick?.(s.key)} />
          );
        })}
        <text x="70" y="68" textAnchor="middle" className="donut-n">{cur ? cur.total : total}</text>
        <text x="70" y="84" textAnchor="middle" className="donut-l">{cur ? cur.label : 'tasks'}</text>
      </svg>
      <ul className="donut-legend">
        {slices.map((s, i) => (
          <li key={s.key} className={hover === s.key ? 'on' : ''} onPointerEnter={() => setHover(s.key)} onPointerLeave={() => setHover(null)} onClick={() => onPick?.(s.key)}>
            <i style={{ background: PALETTE[i % PALETTE.length] }} /><span>{s.label}</span><b>{s.total}</b>
          </li>
        ))}
      </ul>
      {center}
    </div>
  );
}

/** Done / open / overdue stacked share of one row. */
export function StackBar({ done, overdue, total, max }: { done: number; overdue: number; total: number; max: number }) {
  const open = total - done - overdue;
  const w = (n: number) => `${(n / Math.max(1, max)) * 100}%`;
  return (
    <div className="stackbar" title={`${done} done · ${open} open · ${overdue} overdue`}>
      <motion.i style={{ background: 'var(--success)' }} initial={{ width: 0 }} whileInView={{ width: w(done) }} viewport={{ once: true }} transition={{ duration: 0.7, ease: EASE }} />
      <motion.i style={{ background: 'var(--accent)', opacity: 0.55 }} initial={{ width: 0 }} whileInView={{ width: w(open) }} viewport={{ once: true }} transition={{ duration: 0.7, delay: 0.05, ease: EASE }} />
      <motion.i style={{ background: 'var(--danger)' }} initial={{ width: 0 }} whileInView={{ width: w(overdue) }} viewport={{ once: true }} transition={{ duration: 0.7, delay: 0.1, ease: EASE }} />
    </div>
  );
}

export function Gauge({ value, tone }: { value: number | null; tone: string }) {
  const reduced = useReducedMotion();
  const R = 70, C = Math.PI * R; // half circle
  return (
    <svg viewBox="0 0 180 110" className="gauge" role="img" aria-label={value == null ? 'No data' : `Health score ${value} out of 100`}>
      <path d="M20,95 A70,70 0 0 1 160,95" fill="none" stroke="var(--surface-3)" strokeWidth="14" strokeLinecap="round" />
      <motion.path d="M20,95 A70,70 0 0 1 160,95" fill="none" stroke={tone} strokeWidth="14" strokeLinecap="round" strokeDasharray={C}
        initial={reduced ? false : { strokeDashoffset: C }} animate={{ strokeDashoffset: C * (1 - (value ?? 0) / 100) }} transition={{ duration: 1.3, ease: EASE }} />
      <text x="90" y="80" textAnchor="middle" className="gauge-n">{value ?? '–'}</text>
      <text x="90" y="100" textAnchor="middle" className="gauge-l">out of 100</text>
    </svg>
  );
}

export function Meter({ value, tone = 'var(--accent)' }: { value: number; tone?: string }) {
  return <div className="meter"><motion.i style={{ background: tone }} initial={{ width: 0 }} whileInView={{ width: `${Math.round(value * 100)}%` }} viewport={{ once: true }} transition={{ duration: 0.8, ease: EASE }} /></div>;
}
