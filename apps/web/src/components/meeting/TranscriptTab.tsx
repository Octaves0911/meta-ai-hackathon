import { Download, Mic, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MeetingSummary } from '@meetpilot/shared';
import { api } from '../../lib/api';
import { Avatar, EmptyState, Skeleton } from '../../ui';
import { MOMENT, clock } from './InsightsTab';

interface Seg { seq: number; speaker: string; text: string; offsetMs: number }

export function TranscriptTab({ meetingId, summary, focusSeq }: { meetingId: string; summary: MeetingSummary | null; focusSeq: number | null }) {
  const [segs, setSegs] = useState<Seg[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [who, setWho] = useState('all');
  const flash = useRef<number | null>(null);
  useEffect(() => { api<Seg[]>(`/meetings/${meetingId}/transcript`).then(setSegs).catch((e) => setError(e.message)); }, [meetingId]);

  const marks = useMemo(() => {
    const m = new Map<number, NonNullable<MeetingSummary['moments']>>();
    for (const x of summary?.moments ?? []) if (x.seq != null) m.set(x.seq, [...(m.get(x.seq) ?? []), x]);
    return m;
  }, [summary]);
  const speakers = useMemo(() => [...new Set((segs ?? []).map((s) => s.speaker))], [segs]);
  useEffect(() => {
    if (focusSeq == null || !segs) return;
    flash.current = focusSeq;
    const el = document.getElementById(`seg-${focusSeq}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.classList.add('flash');
    const t = setTimeout(() => el?.classList.remove('flash'), 2200);
    return () => clearTimeout(t);
  }, [focusSeq, segs]);

  if (error) return <div className="card"><EmptyState icon={Mic} title="Transcript unavailable">{error}</EmptyState></div>;
  if (!segs) return <Skeleton h={240} />;
  const shown = segs.filter((s) => (who === 'all' || s.speaker === who) && (!q || s.text.toLowerCase().includes(q.toLowerCase())));
  const hl = (t: string) => {
    if (!q) return t;
    const i = t.toLowerCase().indexOf(q.toLowerCase());
    return i < 0 ? t : <>{t.slice(0, i)}<mark>{t.slice(i, i + q.length)}</mark>{t.slice(i + q.length)}</>;
  };
  const download = (kind: 'txt' | 'json') => {
    const body = kind === 'txt' ? segs.map((s) => `${clock(s.offsetMs) ? `[${clock(s.offsetMs)}] ` : ''}${s.speaker}: ${s.text}`).join('\n') : JSON.stringify(segs, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' })); a.download = `transcript.${kind}`; a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <div className="card transcript">
      <div className="tr-tools">
        <label className="search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the transcript" aria-label="Search transcript" /></label>
        <div className="seg"><button className={who === 'all' ? 'on' : ''} onClick={() => setWho('all')}>Everyone</button>{speakers.map((s) => <button key={s} className={who === s ? 'on' : ''} onClick={() => setWho(s)}>{s}</button>)}</div>
        <button className="ghost" onClick={() => download('txt')} disabled={!segs.length}><Download size={15} /> Export</button>
      </div>
      {segs.length === 0 ? <EmptyState icon={Mic} title="No transcript">Captions are saved here once people speak with captions on, or you can import a transcript from a file.</EmptyState> : shown.length === 0 ? <p className="faint" style={{ padding: 16 }}>No lines match.</p> : (
        <div className="tr-lines">
          {shown.map((s) => (
            <div className="tr-line" id={`seg-${s.seq}`} key={s.seq}>
              <time>{clock(s.offsetMs) || `#${s.seq}`}</time><Avatar name={s.speaker} size="sm" />
              <div><b>{s.speaker}</b><p>{hl(s.text)}</p>
                {marks.get(s.seq)?.map((m) => <span key={m.id} className="tr-chip" style={{ color: MOMENT[m.type].color, background: `color-mix(in srgb, ${MOMENT[m.type].color} 12%, transparent)` }}>{MOMENT[m.type].label}: {m.title.length > 60 ? m.title.slice(0, 58) + '…' : m.title}</span>)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
