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
import { AiNotesPanel } from '../components/AiNotesPanel';
import { useAiNotes } from '../hooks/useAiNotes';
import { useTasks } from '../hooks/useTasks';
import { TasksPanel } from '../components/TasksPanel';
import { EndOverlay } from '../components/EndOverlay';

const TABS = ['Chat', 'Notes', 'Tasks', 'AI'] as const;

export function Room() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const nav = useNavigate();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<(typeof TABS)[number]>('Chat');
  const [aiOn, setAiOn] = useState(false);

  // Make sure we are marked as joined (also covers direct links / reloads), then open the room.
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const m = await api<MeetingDetail>(`/meetings/${id}`);
        setMeeting(m);
        setAiOn(m.aiAssist);
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
  const tasks = useTasks(id, user?.username ?? '', ready && !!user);
  const ai = useAiNotes(id, user?.username ?? '', ready && !!user, tab === 'AI');
  // The AI switch is shared by everyone in the call; changes arrive live.
  useEffect(() => {
    if (!user) return;
    const s = getSocket(user.username);
    const on = (p: { enabled: boolean }) => setAiOn(p.enabled);
    s.on('ai:assist', on);
    return () => { s.off('ai:assist', on); };
  }, [user]);
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
  const toggleAi = async () => {
    const next = !aiOn;
    setAiOn(next);
    try { await api(`/meetings/${id}/ai-assist`, { method: 'PUT', json: { enabled: next } }); }
    catch (e) { setAiOn(!next); setError((e as Error).message); }
  };
  const end = async () => {
    if (!confirm('End this meeting for everyone?')) return;
    try { await api(`/meetings/${id}/end`, { method: 'POST' }); } catch (e) { setError((e as Error).message); }
  };

  const problem = error || mesh.joinError;
  if (problem) return <div className="center"><div className="card"><p role="alert">{problem}</p><Link to={`/meetings/${id}`}>Back to meeting</Link></div></div>;
  if (mesh.ended) return <EndOverlay tasks={tasks.finalTasks} fetchAll={tasks.fetchAll} onDone={() => nav(`/meetings/${id}`)} />;

  const [main, ...extra] = mesh.peers;
  const isOwner = meeting?.ownerId === user.id;

  return (
    <div className="room">
      <header className="room-header">
        <div><strong>{meeting?.title ?? '…'}</strong> <span className="muted">· {mesh.peers.length + 1} in call</span></div>
        <div className="row">
          <label className="ai-switch" title="Live memory-backed assistance for everyone in this meeting">
            <input type="checkbox" role="switch" checked={aiOn} onChange={toggleAi} /> AI Assistance
          </label>
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
          {TABS.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t}{t === 'Tasks' && tasks.counts.total > 0 && <span className="badge-count neutral">{tasks.counts.total}</span>}{t === 'AI' && ai.unread > 0 && <span className="badge-count" aria-label={`${ai.unread} unread`}>{ai.unread}</span>}
            </button>
          ))}
        </div>
        {/* Wait for the join call: chat access requires an active session. */}
        {ready && tab === 'Chat' && <ChatPanel meetingId={id} />}
        {ready && tab === 'Notes' && <NotesPanel meetingId={id} />}
        {tab === 'AI' && <AiNotesPanel notes={ai.notes} hasMore={ai.hasMore} loadOlder={ai.loadOlder} aiOn={aiOn} error={ai.error} />}
        {ready && tab === 'Tasks' && <TasksPanel tasks={tasks.tasks} counts={tasks.counts} filter={tasks.filter} setFilter={tasks.setFilter}
          hasMore={tasks.hasMore} loadMore={tasks.loadMore} error={tasks.error} />}
      </aside>
    </div>
  );
}
