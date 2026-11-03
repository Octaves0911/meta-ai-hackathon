import { ArrowRight, CheckCircle2, Circle, Hammer, Loader2, PauseCircle, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ExecutionDetail, PipelineStage } from '@meetpilot/shared';
import { api } from '../lib/api';
import { AGENT_LABEL } from '../routes/Reviews';
import { toast } from '../ui';

const STATE: Record<PipelineStage['status'], { label: string; icon: JSX.Element }> = {
  done: { label: 'Approved', icon: <CheckCircle2 size={15} color="var(--success)" /> },
  active: { label: 'Working', icon: <Loader2 size={15} className="spin" /> },
  waiting: { label: 'Needs your review', icon: <PauseCircle size={15} color="var(--accent)" /> },
  planned: { label: 'Next', icon: <Circle size={15} /> },
  stopped: { label: 'Stopped', icon: <XCircle size={15} color="var(--danger)" /> },
};

/** The agents of a multi-stage task in order, where each one is, and which design direction was approved. Empty for single-stage work. */
export function Pipeline({ d }: { d: ExecutionDetail }) {
  if (!d.pipeline || d.pipeline.length < 2) return null;
  return (
    <nav className="card" aria-label="Task stages" style={{ marginBottom: 16 }}>
      <ol className="row" style={{ gap: 8, flexWrap: 'wrap', listStyle: 'none', margin: 0, padding: 0, alignItems: 'center' }}>
        {d.pipeline.map((s, i) => {
          const label = <><span aria-hidden>{STATE[s.status].icon}</span> <strong>{AGENT_LABEL[s.agent] ?? s.agent}</strong>{s.choice ? <span className="faint"> · direction {s.choice}</span> : null} <span className="faint">· {STATE[s.status].label}</span></>;
          return (
            <li key={s.stage} className="row" style={{ gap: 8, alignItems: 'center' }} aria-current={s.current ? 'step' : undefined}>
              {i > 0 && <ArrowRight size={14} aria-hidden />}
              {s.executionId && !s.current ? <Link to={`/reviews/${s.executionId}`} className="mini-link">{label}</Link> : <span style={s.current ? { fontWeight: 600 } : undefined}>{label}</span>}
            </li>
          );
        })}
      </ol>
      <p className="faint" style={{ margin: '8px 0 0' }}>Each stage is reviewed by you before the next one starts. Rejecting a stage stops the task there.</p>
    </nav>
  );
}

/** An approved web-page design that was not planned as design + build can still be built, once, by the reviewer. Never offered for cards, banners and other designs. */
export function BuildWithCode({ d, onDone }: { d: ExecutionDetail; onDone: () => Promise<unknown> | void }) {
  const [busy, setBusy] = useState(false);
  const hasNext = (d.pipeline ?? []).some((s) => s.agent === 'code');
  if (d.agent !== 'designer' || d.status !== 'approved' || !d.stagePlan?.webPage || !d.canReview || hasNext) return null;
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ executionId: string }>(`/executions/${d.id}/handoff`, { method: 'POST', json: { agent: 'code' } });
      toast('The Code agent is building the approved design…');
      await onDone();
      window.location.assign(`/reviews/${r.executionId}`);
    } catch (e) { toast.error((e as Error).message); setBusy(false); }
  };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div><strong>Build this page</strong><div className="muted">The Code agent implements the approved design{d.approvedChoice ? ` (direction ${d.approvedChoice})` : ''} in a linked repository, or as a static site you can download. You review the result before anything is used.</div></div>
        <button onClick={go} disabled={busy}><Hammer size={15} /> {busy ? 'Starting…' : 'Also build it with Code'}</button>
      </div>
    </div>
  );
}
