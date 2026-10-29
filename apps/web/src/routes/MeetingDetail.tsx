import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type { MeetingDetail as Detail } from '@meetpilot/shared';
import { api, useSession } from '../lib/api';

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');

export function MeetingDetail() {
  const { id } = useParams();
  const { user } = useSession();
  const [m, setM] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => api<Detail>(`/meetings/${id}`).then(setM).catch((e) => setError(e.message)), [id]);
  useEffect(() => { if (user) load(); }, [user, load]);
  if (!user) return <Navigate to="/start" replace />;

  const act = async (path: string, json?: unknown) => {
    setError('');
    try { await api(`/meetings/${id}/${path}`, { method: 'POST', json }); await load(); }
    catch (e) { setError((e as Error).message); }
  };

  if (!m) return <div className="main">{error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>}</div>;

  const isOwner = m.ownerId === user.id;
  const over = m.status === 'ended' || m.status === 'closed';
  const invited = m.myInviteStatus === 'invited';
  const joined = m.myInviteStatus === 'joined';

  return (
    <div className="main" style={{ maxWidth: 860, margin: '0 auto' }}>
      <p><Link to="/dashboard">← Dashboard</Link></p>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
        <div>
          <h1>{m.title}</h1>
          <p className="muted">{m.projectName} · owned by {m.ownerName} · <strong>{m.status}</strong></p>
          {m.description && <p>{m.description}</p>}
        </div>
        <div className="row">
          {invited && <><button className="primary" onClick={() => act('respond', { accept: true })}>Accept</button>
            <button onClick={() => act('respond', { accept: false })}>Decline</button></>}
          {!over && !invited && m.myInviteStatus && m.myInviteStatus !== 'declined' && !joined &&
            <button className="primary" onClick={() => act('join')}>Join</button>}
          {!over && joined && <button onClick={() => act('leave')}>Leave</button>}
          {!over && isOwner && m.status === 'active' && <button className="danger" onClick={() => act('end')}>End meeting</button>}
        </div>
      </div>
      {over && <div className="card" role="status">This meeting has ended and can no longer be joined.</div>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="grid" style={{ margin: '16px 0' }}>
        {([
          ['Duration', `${Math.floor(m.totalDurationSec / 60)}m ${m.totalDurationSec % 60}s`],
          ['Participants', m.participants.length],
          ['Messages', m.stats.messages], ['Notes', m.stats.notes], ['Transcript segments', m.stats.transcriptSegments],
        ] as [string, string | number][]).map(([l, v]) => (
          <div className="card" key={l}><div className="muted">{l}</div><div className="stat">{v}</div></div>
        ))}
      </div>
      <div className="card">
        <h3>Timeline</h3>
        <p className="muted">Scheduled: {fmt(m.scheduledAt)} · Created: {fmt(m.createdAt)} · Started: {fmt(m.startedAt)} · Ended: {fmt(m.endedAt)}</p>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Participants</h3>
        <ul>{m.participants.map((p) => <li key={p.userId}>{p.username} <span className="muted">— {p.inviteStatus}</span></li>)}</ul>
      </div>
    </div>
  );
}
