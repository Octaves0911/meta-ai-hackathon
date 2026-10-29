import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import type { MeetingDetail } from '@meetpilot/shared';
import { api, storedUser, useSession } from '../lib/api';
import { getSocket } from '../lib/socket';
import { usePeerMesh } from '../hooks/usePeerMesh';
import { useCaptionStream } from '../hooks/useCaptionStream';
import { useCaptionFeed } from '../hooks/useCaptionFeed';
import { SubtitleOverlay } from '../components/SubtitleOverlay';
import { VideoTile } from '../components/VideoTile';
import { ChatPanel } from '../components/ChatPanel';
import { NotesPanel } from '../components/NotesPanel';

const TABS = ['Chat', 'Notes', 'Tasks', 'AI'] as const;

export function Room() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const nav = useNavigate();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<(typeof TABS)[number]>('Chat');

  // Make sure we are marked as joined (also covers direct links / reloads), then open the room.
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const m = await api<MeetingDetail>(`/meetings/${id}`);
        setMeeting(m);
        if (m.status === 'ended' || m.status === 'closed') return setError('This meeting has ended.');
        await api(`/meetings/${id}/join`, { method: 'POST' });
        setReady(true);
      } catch (e) { setError((e as Error).message); }
    })();
  }, [id, user]);

  const mesh = usePeerMesh(id, user?.username ?? '', ready && !!user);
  // Captions start automatically on joining; no button (F4.1).
  const capStatus = useCaptionStream({ meetingId: id, username: user?.username ?? '', stream: mesh.local, muted: !mesh.micOn, enabled: ready && !!user && !mesh.ended });
  const caps = useCaptionFeed(id, user?.username ?? '');
  if (!user) return <Navigate to="/start" replace />;

  const leave = () => {
    getSocket(user.username).emit('room:leave', {}, () => nav(`/meetings/${id}`));
    setTimeout(() => nav(`/meetings/${id}`), 500);
  };
  const downloadTranscript = async () => {
    try {
      const res = await fetch(`/api/meetings/${id}/transcript?format=txt`, { headers: { 'x-user': storedUser() ?? '' } });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? 'download failed');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `${meeting?.title ?? 'meeting'}-transcript.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError((e as Error).message); }
  };
  const end = async () => {
    if (!confirm('End this meeting for everyone?')) return;
    try { await api(`/meetings/${id}/end`, { method: 'POST' }); } catch (e) { setError((e as Error).message); }
  };

  const problem = error || mesh.joinError;
  if (problem) return <div className="center"><div className="card"><p role="alert">{problem}</p><Link to={`/meetings/${id}`}>Back to meeting</Link></div></div>;
  if (mesh.ended) return (
    <div className="center"><div className="card" role="dialog" aria-modal="true" aria-label="Meeting ended">
      <h2>Meeting ended</h2><p className="muted">The owner ended this meeting.</p>
      <button className="primary" onClick={() => nav(`/meetings/${id}`)}>Done</button>
    </div></div>
  );

  const [main, ...extra] = mesh.peers;
  const isOwner = meeting?.ownerId === user.id;

  return (
    <div className="room">
      <header className="room-header">
        <div><strong>{meeting?.title ?? '…'}</strong> <span className="muted">· {mesh.peers.length + 1} in call</span></div>
        <div className="row">
          {isOwner && <button className="danger" onClick={end}>End meeting</button>}
          <button onClick={leave}>Leave</button>
        </div>
      </header>
      <section className="stage" aria-label="Video">
        {mesh.mediaNote && <div className="note" role="status">{mesh.mediaNote}</div>}
        {main ? (
          <>
            <VideoTile className="main-tile" stream={main.stream} name={main.name} state={main.state} onRetry={() => mesh.retry(main.socketId)} />
            {extra.length > 0 && (
              <div className="extras">
                {extra.map((p) => <VideoTile key={p.socketId} stream={p.stream} name={p.name} state={p.state} onRetry={() => mesh.retry(p.socketId)} />)}
              </div>
            )}
          </>
        ) : <div className="waiting">Waiting for others…</div>}
        <VideoTile className="self-tile" self stream={mesh.local} name={user.username} />
        <SubtitleOverlay lines={caps.lines} visible={caps.visible} status={capStatus} />
        <div className="controls">
          <button onClick={downloadTranscript} aria-label="Download transcript">⤓ Transcript</button>
          <button onClick={mesh.toggleMic} aria-pressed={!mesh.micOn} disabled={!mesh.local?.getAudioTracks().length}>{!mesh.local?.getAudioTracks().length ? '🎤 No microphone' : mesh.micOn ? '🎤 Mute' : '🔇 Unmute'}</button>
          <button onClick={mesh.toggleCam} aria-pressed={!mesh.camOn} disabled={!mesh.local?.getVideoTracks().length}>{!mesh.local?.getVideoTracks().length ? '📷 No camera' : mesh.camOn ? '📷 Camera off' : '📷 Camera on'}</button>
        </div>
      </section>
      <aside className="side" aria-label="Side panel">
        <div role="tablist" className="tabs">
          {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}
        </div>
        {/* Wait for the join call: chat access requires an active session. */}
        {ready && tab === 'Chat' && <ChatPanel meetingId={id} />}
        {ready && tab === 'Notes' && <NotesPanel meetingId={id} />}
        {(tab === 'Tasks' || tab === 'AI') && <p className="muted" style={{ padding: 16 }}>Available in a later release.</p>}
      </aside>
    </div>
  );
}
