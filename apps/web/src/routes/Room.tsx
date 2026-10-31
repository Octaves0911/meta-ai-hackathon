import { useEffect, useState } from 'react';
import { FileDown, Link2, ListChecks, MessageSquare, Mic, MicOff, PhoneOff, Sparkles, StickyNote, Users, Video, VideoOff, Loader2 } from 'lucide-react';
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
import { Logo, toast, useConfirm } from '../ui';
import { useAiNotes } from '../hooks/useAiNotes';
import { useTasks } from '../hooks/useTasks';
import { TasksPanel } from '../components/TasksPanel';
import { EndOverlay } from '../components/EndOverlay';

const TABS = ['Chat', 'Notes', 'Tasks', 'AI'] as const;
const TAB_ICON = { Chat: MessageSquare, Notes: StickyNote, Tasks: ListChecks, AI: Sparkles } as const;

export function Room() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const nav = useNavigate();
  const confirm = useConfirm();
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
    } catch (e) { toast.error((e as Error).message); }
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(`${location.origin}/meetings/${id}`); toast.success('Meeting link copied'); } catch { toast.error('Could not copy the link'); }
  };
  const toggleAi = async () => {
    const next = !aiOn;
    setAiOn(next);
    try { await api(`/meetings/${id}/ai-assist`, { method: 'PUT', json: { enabled: next } }); }
    catch (e) { setAiOn(!next); toast.error((e as Error).message); }
  };
  const end = async () => {
    if (!(await confirm({ title: 'End this meeting for everyone?', message: 'Tasks are generated and agents start on the doable ones.', confirmLabel: 'End meeting', danger: true }))) return;
    try { await api(`/meetings/${id}/end`, { method: 'POST' }); } catch (e) { toast.error((e as Error).message); }
  };

  const problem = error || mesh.joinError;
  if (problem) return <div className="auth-panel" style={{ minHeight: '100vh' }}><div className="card auth-card" style={{ textAlign: 'center' }}><h2>Can’t open the room</h2><p role="alert" className="muted">{problem}</p><Link to={`/meetings/${id}`}><button className="primary">Back to meeting</button></Link></div></div>;
  if (!ready) return <div className="auth-panel" style={{ minHeight: '100vh' }}><div className="row muted"><Loader2 size={18} className="spin" /> Joining the room…</div></div>;
  if (mesh.ended) return <EndOverlay tasks={tasks.finalTasks} fetchAll={tasks.fetchAll} onDone={() => nav(`/meetings/${id}`)} />;

  const [main, ...extra] = mesh.peers;
  const isOwner = meeting?.ownerId === user.id;

  const noMic = !mesh.local?.getAudioTracks().length;
  const noCam = !mesh.local?.getVideoTracks().length;

  return (
    <div className="room">
      <header className="room-header">
        <div className="left">
          <Link to={`/meetings/${id}`} aria-label="Back to meeting"><Logo size={28} /></Link>
          <strong>{meeting?.title ?? '…'}</strong>
          <span className="pill success live"><span className="dot" /> Live</span>
          <span className="pill"><Users size={12} /> {mesh.peers.length + 1} in call</span>
        </div>
        <div className="right">
          <label className={`ai-switch${aiOn ? ' on' : ''}`} title="Live, memory-backed assistance for everyone in this meeting">
            <Sparkles size={14} /> AI Assistance
            <input className="toggle" type="checkbox" role="switch" checked={aiOn} onChange={toggleAi} aria-label="AI Assistance" />
          </label>
          {isOwner && <button className="danger" onClick={end}>End meeting</button>}
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
        ) : (
          <div className="waiting">
            <div><div className="ring"><Users size={28} /></div>
              <strong style={{ color: '#e8eeff', fontSize: 18, display: 'block' }}>Waiting for others to join</strong>
              <span>Share the meeting link so your team can come in.</span>
              <div style={{ marginTop: 14 }}><button onClick={copyLink} style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', borderColor: 'transparent' }}><Link2 size={16} /> Copy meeting link</button></div>
            </div>
          </div>
        )}
        <VideoTile className="self-tile" self stream={mesh.local} name={user.username} />
        <SubtitleOverlay lines={caps.lines} visible={caps.visible} status={capStatus} />
        <div className="controls" role="toolbar" aria-label="Call controls">
          <button onClick={mesh.toggleMic} aria-pressed={!noMic && !mesh.micOn} disabled={noMic} title={noMic ? 'No microphone' : mesh.micOn ? 'Mute' : 'Unmute'} aria-label={noMic ? 'No microphone' : mesh.micOn ? 'Mute' : 'Unmute'}>
            {mesh.micOn && !noMic ? <Mic size={20} /> : <MicOff size={20} />}</button>
          <button onClick={mesh.toggleCam} aria-pressed={!noCam && !mesh.camOn} disabled={noCam} title={noCam ? 'No camera' : mesh.camOn ? 'Turn camera off' : 'Turn camera on'} aria-label={noCam ? 'No camera' : mesh.camOn ? 'Turn camera off' : 'Turn camera on'}>
            {mesh.camOn && !noCam ? <Video size={20} /> : <VideoOff size={20} />}</button>
          <button onClick={downloadTranscript} title="Download transcript" aria-label="Download transcript"><FileDown size={20} /></button>
          <button className="leave" onClick={leave} title="Leave call" aria-label="Leave call"><PhoneOff size={20} /></button>
        </div>
      </section>

      <aside className="side" aria-label="Side panel">
        <div role="tablist" className="tabs">
          {TABS.map((t) => {
            const Icon = TAB_ICON[t];
            return (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                <Icon size={15} />{t}
                {t === 'Tasks' && tasks.counts.total > 0 && <span className="badge-count neutral">{tasks.counts.total}</span>}
                {t === 'AI' && ai.unread > 0 && <span className="badge-count" aria-label={`${ai.unread} unread`}>{ai.unread}</span>}
              </button>
            );
          })}
        </div>
        {/* Wait for the join call: chat access requires an active session. */}
        {tab === 'Chat' && <ChatPanel meetingId={id} />}
        {tab === 'Notes' && <NotesPanel meetingId={id} />}
        {tab === 'AI' && <AiNotesPanel notes={ai.notes} hasMore={ai.hasMore} loadOlder={ai.loadOlder} aiOn={aiOn} error={ai.error} />}
        {tab === 'Tasks' && <TasksPanel tasks={tasks.tasks} counts={tasks.counts} filter={tasks.filter} setFilter={tasks.setFilter}
          hasMore={tasks.hasMore} loadMore={tasks.loadMore} error={tasks.error} />}
      </aside>
    </div>
  );
}
