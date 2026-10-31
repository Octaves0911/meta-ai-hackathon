import { ArrowLeft, Bot, CheckCircle2, GitBranch, Hand, MessageCircleMore, RotateCcw, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { MAX_REVISIONS, type ExecutionDetail } from '@meetpilot/shared';
import { AppShell } from '../components/AppShell';
import { SendEmailPanel } from '../components/SendEmailPanel';
import { ArtifactView } from '../components/viewers/ArtifactView';
import { api, useSession } from '../lib/api';
import { getSocket } from '../lib/socket';
import { Avatar, EmptyState, Skeleton, toast } from '../ui';
import { AGENT_LABEL, StatusBadge } from './Reviews';

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
  useEffect(() => { if (user) void load(); }, [user, load]);
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

  const crumbs = <Link to="/reviews" className="row" style={{ gap: 6, color: 'var(--text-2)' }}><ArrowLeft size={16} /> Agent reviews</Link>;
  if (!d) return <AppShell active="reviews" crumbs={crumbs}>{error ? <div className="card"><EmptyState icon={Bot} title="Review not found">{error}</EmptyState></div> : <div className="stack"><Skeleton h={34} w={300} /><Skeleton h={120} /><Skeleton h={220} /></div>}</AppShell>;

  const submit = async (verdict: 'approve' | 'changes') => {
    setBusy(true); setError('');
    try {
      await api(`/executions/${d.id}/review`, { method: 'POST', json: { verdict, comment: comment.trim() || undefined } });
      toast.success(verdict === 'approve' ? 'Approved. The task is done.' : 'Sent back to the agent');
      setComment(''); setTab(0); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const retry = async () => { try { await api(`/executions/${d.id}/retry`, { method: 'POST' }); toast('Retrying…'); await load(); } catch (e) { toast.error((e as Error).message); } };

  const arts = d.artifacts;
  const current = arts[Math.min(tab, Math.max(arts.length - 1, 0))];
  const revisionsLeft = MAX_REVISIONS - d.revision;

  return (
    <AppShell active="reviews" crumbs={crumbs}>
      <div style={{ paddingBottom: d.canReview ? 150 : 0 }}>
        <div className="page-head">
          <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
            <span className="avatar lg" style={{ background: d.agent ? 'var(--ai)' : 'var(--text-3)', borderRadius: 14, width: 52, height: 52 }}><Bot size={24} /></span>
            <div><div className="row" style={{ gap: 10, marginBottom: 6 }}><StatusBadge status={d.status} /><span className="faint">{d.meetingTitle}</span></div><h1 style={{ margin: 0 }}>{d.taskTitle}</h1></div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <dl className="kv">
            <div><dt>Agent</dt><dd>{d.agent ? `${AGENT_LABEL[d.agent] ?? d.agent}` : '—'}</dd></div>
            <div><dt>Assigned to</dt><dd className="row" style={{ gap: 8 }}>{d.assignee ? <><Avatar name={d.assignee.username} size="sm" />{d.assignee.username}</> : 'Unassigned'}</dd></div>
            <div><dt>Reviewer</dt><dd className="row" style={{ gap: 8 }}>{d.reviewer ? <><Avatar name={d.reviewer.username} size="sm" />{d.reviewer.username}</> : '—'}</dd></div>
            <div><dt>Due</dt><dd>{d.dueDate ?? '—'}</dd></div>
            <div><dt>Revision</dt><dd>{d.revision} of {MAX_REVISIONS}</dd></div>
          </dl>
        </div>

        {d.status === 'skipped_human' && <div className="note-inline info" role="status"><Hand size={18} /> <span><strong>Left for a human.</strong> {d.routeReason}</span></div>}
        {BUSY.has(d.status) && <div className="note-inline info" role="status"><span className="spinner" /> The {d.agent} agent is {d.status === 'changes_requested' ? 'redoing the work with your feedback' : 'working on this'}…</div>}
        {d.status === 'failed' && <div className="card" role="alert" style={{ borderColor: 'var(--danger)' }}><strong>The agent could not finish.</strong> <span className="muted">{d.error}</span><div style={{ marginTop: 10 }}><button onClick={retry}><RotateCcw size={15} /> Retry</button></div></div>}

        {d.summary && <div className="card" style={{ marginBottom: 16 }}><h3>Summary</h3><p style={{ marginBottom: 4 }}>{d.summary}</p>{d.notes && <p className="muted" style={{ margin: 0 }}>{d.notes}</p>}</div>}

        {d.consultations.length > 0 && (
          <details className="card" style={{ marginBottom: 16 }} open>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}><GitBranch size={15} style={{ verticalAlign: -2, marginRight: 6 }} />Collaboration <span className="faint" style={{ fontWeight: 450 }}>· {d.consultations.length} consultation{d.consultations.length > 1 ? 's' : ''}</span></summary>
            {d.consultations.map((c) => (
              <div key={c.id} className="consult"><div><strong>{AGENT_LABEL[c.fromAgent] ?? c.fromAgent}</strong> asked <strong>{AGENT_LABEL[c.toAgent] ?? c.toAgent}</strong>: {c.question}</div><div className="muted" style={{ marginTop: 4 }}>→ {c.answer}</div></div>
            ))}
          </details>
        )}

        {arts.length > 0 && (
          <div className="card" style={{ padding: 0, marginBottom: 16, overflow: 'hidden' }}>
            <div role="tablist" className="tabs">
              {arts.map((a, i) => <button key={a.id} role="tab" aria-selected={i === tab} className={i === tab ? 'active' : ''} onClick={() => setTab(i)}>{a.title ?? a.type}</button>)}
            </div>
            <div style={{ padding: 20 }}>{current && <ArtifactView artifact={current} executionId={d.id} editable={d.canReview} onSaved={load} />}</div>
          </div>
        )}

        <SendEmailPanel d={d} onDone={load} />

        {d.reviews.length > 0 && (
          <div className="card" style={{ marginTop: 16 }}>
            <h3>Review history</h3>
            <div className="stack" style={{ gap: 10 }}>
              {d.reviews.map((r, i) => (
                <div key={i} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                  <span className="avatar sm" style={{ background: r.verdict === 'approve' ? 'var(--success)' : 'var(--warn)' }}>{r.verdict === 'approve' ? <CheckCircle2 size={14} /> : <MessageCircleMore size={14} />}</span>
                  <div><strong>{r.verdict === 'approve' ? 'Approved' : 'Changes requested'}</strong> <span className="faint">by {r.reviewer ?? 'someone'} · revision {r.revision}</span>{r.comment && <div className="muted">“{r.comment}”</div>}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {d.canReview && (
        <div className="review-bar" role="region" aria-label="Review">
          <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What should change? (required to request changes)" aria-label="Review comment" />
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span className="faint" style={{ fontSize: 13 }}>{revisionsLeft > 0 ? `${revisionsLeft} revision${revisionsLeft > 1 ? 's' : ''} left` : 'No revisions left — approve or handle this yourself.'}</span>
            <div className="row">
              <button disabled={busy || !comment.trim() || revisionsLeft <= 0} onClick={() => submit('changes')}><RotateCcw size={15} /> Request changes</button>
              <button className="primary" disabled={busy} onClick={() => submit('approve')}><Send size={15} /> Approve</button>
            </div>
          </div>
          {error && <p className="error" role="alert" style={{ margin: 0 }}>{error}</p>}
        </div>
      )}
      {!d.canReview && error && <p className="error" role="alert">{error}</p>}
    </AppShell>
  );
}
