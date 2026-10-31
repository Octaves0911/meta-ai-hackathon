import { Bot, CheckCircle2, ChevronRight, Clock, Hand, Loader2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { ExecutionSummary } from '@meetpilot/shared';
import { AppShell } from '../components/AppShell';
import { api, useSession } from '../lib/api';
import { getSocket } from '../lib/socket';
import { EmptyState, Skeleton } from '../ui';

export const STATUS_LABEL: Record<string, string> = {
  awaiting_review: 'Needs your review', routed: 'Queued', running: 'Working…', changes_requested: 'Redoing with your feedback',
  approved: 'Approved', failed: 'Failed', skipped_human: 'Left for a human',
};
export const AGENT_LABEL: Record<string, string> = { research: 'Research', marketing: 'Marketing', designer: 'Designer', communication: 'Communication', code: 'Code' };

export function StatusBadge({ status }: { status: string }) {
  const icon = status === 'approved' ? <CheckCircle2 size={13} /> : status === 'failed' ? <XCircle size={13} /> : status === 'skipped_human' ? <Hand size={13} />
    : status === 'awaiting_review' ? <Clock size={13} /> : <Loader2 size={13} className="spin" />;
  return <span className={`status status-${status}`} style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>{icon}{STATUS_LABEL[status] ?? status}</span>;
}

function Row({ e }: { e: ExecutionSummary }) {
  return (
    <Link to={`/reviews/${e.id}`} className="review-row">
      <div className="row" style={{ gap: 14, minWidth: 0 }}>
        <span className="avatar lg" style={{ background: e.agent ? 'var(--ai)' : 'var(--text-3)', borderRadius: 12 }}><Bot size={20} /></span>
        <div style={{ minWidth: 0 }}><strong style={{ display: 'block' }}>{e.taskTitle}</strong>
          <span className="faint" style={{ fontSize: 13 }}>{e.meetingTitle}{e.agent ? ` · ${AGENT_LABEL[e.agent] ?? e.agent} agent` : ''}{e.dueDate ? ` · due ${e.dueDate}` : ''}</span></div>
      </div>
      <div className="row"><StatusBadge status={e.status} /><ChevronRight size={17} className="faint" /></div>
    </Link>
  );
}

export function Reviews() {
  const { user } = useSession();
  const [items, setItems] = useState<ExecutionSummary[] | null>(null);
  const load = useCallback(() => api<ExecutionSummary[]>('/reviews').then(setItems).catch(() => setItems([])), []);

  useEffect(() => {
    if (!user) return;
    void load();
    const s = getSocket(user.username);
    s.on('execution:update', load);
    return () => { s.off('execution:update', load); };
  }, [user, load]);
  if (!user) return <Navigate to="/start" replace />;

  const needs = (items ?? []).filter((e) => e.status === 'awaiting_review');
  const rest = (items ?? []).filter((e) => e.status !== 'awaiting_review');
  return (
    <AppShell active="reviews" crumbs={<span>Agent reviews</span>}>
      <div className="page-head"><div><h1>Agent reviews</h1><p>Specialist agents draft the follow-up work. Nothing leaves MeetPilot until you approve it.</p></div></div>
      {items === null ? <div className="stack"><Skeleton h={72} /><Skeleton h={72} /></div> : (
        <>
          <div className="section-title" style={{ marginTop: 0 }}><h3>Needs your review {needs.length > 0 && <span className="badge-count">{needs.length}</span>}</h3></div>
          {needs.length === 0 ? <div className="card"><EmptyState icon={CheckCircle2} title="Nothing is waiting for you">When a meeting ends, doable tasks are handed to agents and their drafts show up here.</EmptyState></div>
            : <div className="review-list">{needs.map((e) => <Row key={e.id} e={e} />)}</div>}
          <div className="section-title"><h3>Everything else</h3></div>
          {rest.length === 0 ? <div className="card"><EmptyState icon={Bot} title="No other agent work yet">Finished, running and human-only tasks are listed here.</EmptyState></div>
            : <div className="review-list">{rest.map((e) => <Row key={e.id} e={e} />)}</div>}
        </>
      )}
    </AppShell>
  );
}
