import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { ExecutionSummary } from '@meetpilot/shared';
import { api, useSession } from '../lib/api';
import { getSocket } from '../lib/socket';

export const STATUS_LABEL: Record<string, string> = {
  awaiting_review: 'Needs your review', routed: 'Queued', running: 'Working…', changes_requested: 'Redoing with your feedback',
  approved: 'Approved', failed: 'Failed', skipped_human: 'Left for a human',
};

function Row({ e }: { e: ExecutionSummary }) {
  return (
    <Link to={`/reviews/${e.id}`} className="review-row">
      <div><strong>{e.taskTitle}</strong><div className="muted" style={{ fontSize: 13 }}>{e.meetingTitle}{e.agent ? ` · ${e.agent} agent` : ''}{e.dueDate ? ` · due ${e.dueDate}` : ''}</div></div>
      <span className={`status status-${e.status}`}>{STATUS_LABEL[e.status] ?? e.status}</span>
    </Link>
  );
}

export function Reviews() {
  const { user } = useSession();
  const [items, setItems] = useState<ExecutionSummary[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api<ExecutionSummary[]>('/reviews').then(setItems).catch((e) => setError(e.message)), []);

  useEffect(() => {
    if (!user) return;
    load();
    const s = getSocket(user.username);
    s.on('execution:update', load);
    return () => { s.off('execution:update', load); };
  }, [user, load]);
  if (!user) return <Navigate to="/start" replace />;

  const needs = (items ?? []).filter((e) => e.status === 'awaiting_review');
  const rest = (items ?? []).filter((e) => e.status !== 'awaiting_review');
  return (
    <div className="main" style={{ maxWidth: 860, margin: '0 auto' }}>
      <p><Link to="/dashboard">← Dashboard</Link></p>
      <h1>Reviews</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {items === null ? <p className="muted">Loading…</p> : (
        <>
          <h3>Needs your review</h3>
          {needs.length === 0 ? <div className="card"><p className="muted">Nothing is waiting for you.</p></div> : <div className="review-list">{needs.map((e) => <Row key={e.id} e={e} />)}</div>}
          <h3 style={{ marginTop: 24 }}>Everything else</h3>
          {rest.length === 0 ? <div className="card"><p className="muted">Agent work from your meetings will show up here.</p></div> : <div className="review-list">{rest.map((e) => <Row key={e.id} e={e} />)}</div>}
        </>
      )}
    </div>
  );
}
