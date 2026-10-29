import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { MAX_REVISIONS, type ExecutionDetail } from '@meetpilot/shared';
import { api, useSession } from '../lib/api';
import { getSocket } from '../lib/socket';
import { ArtifactView } from '../components/viewers/ArtifactView';
import { STATUS_LABEL } from './Reviews';

const BUSY = new Set(['routed', 'running', 'changes_requested']);

export function Review() {
  const { id } = useParams();
  const { user } = useSession();
  const [d, setD] = useState<ExecutionDetail | null>(null);
  const [tab, setTab] = useState(0);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<ExecutionDetail>(`/executions/${id}`).then(setD).catch((e) => setError(e.message)), [id]);
  useEffect(() => { if (user) load(); }, [user, load]);
  useEffect(() => {
    if (!user) return;
    const s = getSocket(user.username);
    s.on('execution:update', load);
    return () => { s.off('execution:update', load); };
  }, [user, load]);
  // Poll while an agent is working, in case a push is missed.
  useEffect(() => {
    if (!d || !BUSY.has(d.status)) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [d, load]);
  if (!user) return <Navigate to="/start" replace />;
  if (!d) return <div className="main">{error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>}</div>;

  const submit = async (verdict: 'approve' | 'changes') => {
    setBusy(true); setError('');
    try { await api(`/executions/${d.id}/review`, { method: 'POST', json: { verdict, comment: comment.trim() || undefined } }); setComment(''); setTab(0); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const retry = async () => { try { await api(`/executions/${d.id}/retry`, { method: 'POST' }); await load(); } catch (e) { setError((e as Error).message); } };

  const arts = d.artifacts;
  const current = arts[Math.min(tab, Math.max(arts.length - 1, 0))];
  const revisionsLeft = MAX_REVISIONS - d.revision;

  return (
    <div className="main" style={{ maxWidth: 960, margin: '0 auto', paddingBottom: 160 }}>
      <p><Link to="/reviews">← Reviews</Link></p>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
        <div>
          <h1>{d.taskTitle}</h1>
          <p className="muted">{d.meetingTitle}</p>
        </div>
        <span className={`status status-${d.status}`}>{STATUS_LABEL[d.status] ?? d.status}</span>
      </div>
      <dl className="task-meta card" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <div><dt>Agent</dt><dd>{d.agent ?? '—'}</dd></div>
        <div><dt>Assigned to</dt><dd>{d.assignee?.username ?? 'Unassigned'}</dd></div>
        <div><dt>Reviewer</dt><dd>{d.reviewer?.username ?? '—'}</dd></div>
        <div><dt>Due</dt><dd>{d.dueDate ?? '—'}</dd></div>
        <div><dt>Revision</dt><dd>{d.revision} / {MAX_REVISIONS}</dd></div>
      </dl>

      {d.status === 'skipped_human' && <div className="card" role="status"><strong>Left for a human.</strong> <span className="muted">{d.routeReason}</span></div>}
      {BUSY.has(d.status) && <div className="card row" role="status"><span className="spinner" aria-hidden /> The {d.agent} agent is {d.status === 'changes_requested' ? 'redoing the work with your feedback' : 'working on this'}…</div>}
      {d.status === 'failed' && <div className="card" role="alert"><strong>The agent could not finish.</strong> <span className="muted">{d.error}</span><div><button style={{ marginTop: 8 }} onClick={retry}>Retry</button></div></div>}

      {d.summary && <div className="card" style={{ marginTop: 16 }}><h3>Summary</h3><p>{d.summary}</p>{d.notes && <p className="muted">{d.notes}</p>}</div>}

      {d.consultations.length > 0 && (
        <details className="card" style={{ marginTop: 16 }} open>
          <summary><strong>Collaboration</strong> <span className="muted">({d.consultations.length} consultation{d.consultations.length > 1 ? 's' : ''})</span></summary>
          {d.consultations.map((c) => (
            <div key={c.id} className="consult"><div><strong>{c.fromAgent}</strong> asked <strong>{c.toAgent}</strong>: {c.question}</div><div className="muted">→ {c.answer}</div></div>
          ))}
        </details>
      )}

      {arts.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div role="tablist" className="tabs" style={{ marginBottom: 12 }}>
            {arts.map((a, i) => <button key={a.id} role="tab" aria-selected={i === tab} className={i === tab ? 'active' : ''} onClick={() => setTab(i)}>{a.title ?? a.type}</button>)}
          </div>
          {current && <ArtifactView artifact={current} executionId={d.id} editable={d.canReview} onSaved={load} />}
        </div>
      )}

      {d.reviews.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Review history</h3>
          {d.reviews.map((r, i) => <p key={i} className="muted">Revision {r.revision}: <strong>{r.verdict === 'approve' ? 'Approved' : 'Changes requested'}</strong> by {r.reviewer ?? 'someone'}{r.comment ? ` — “${r.comment}”` : ''}</p>)}
        </div>
      )}

      {d.canReview && (
        <div className="review-bar" role="region" aria-label="Review">
          <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What should change? (required to request changes)" aria-label="Review comment" />
          <div className="row">
            <button disabled={busy || !comment.trim() || revisionsLeft <= 0} onClick={() => submit('changes')} title={revisionsLeft <= 0 ? 'No revisions left' : undefined}>Request changes</button>
            <button className="primary" disabled={busy} onClick={() => submit('approve')}>Approve</button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <span className="muted" style={{ fontSize: 12 }}>{revisionsLeft > 0 ? `${revisionsLeft} revision${revisionsLeft > 1 ? 's' : ''} left` : 'No revisions left — approve or handle this yourself.'}</span>
        </div>
      )}
      {!d.canReview && error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
