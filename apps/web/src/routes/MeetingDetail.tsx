import { ArrowLeft, CheckCircle2, Clock, DoorOpen, Sparkles, ListChecks, MessageSquare, Mic, PhoneOff, StickyNote, Users, Video } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { MeetingDetail as Detail, MeetingSummary, Task } from '@meetpilot/shared';
import { ChatTab } from '../components/meeting/ChatTab';
import { InsightsTab } from '../components/meeting/InsightsTab';
import { NotesPanel } from '../components/NotesPanel';
import { TasksTab } from '../components/meeting/TasksTab';
import { TranscriptTab } from '../components/meeting/TranscriptTab';
import '../styles/meeting.css';
import { AppShell } from '../components/AppShell';
import { StatusPill } from '../components/MeetingsTable';
import { api, useSession } from '../lib/api';
import { Avatar, EmptyState, Skeleton, toast, useConfirm } from '../ui';

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export function MeetingDetail() {
  const { id } = useParams();
  const { user } = useSession();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [m, setM] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const [params, setParams] = useSearchParams();
  const [focusSeq, setFocusSeq] = useState<number | null>(null);
  const tab = (['insights', 'tasks', 'transcript', 'chat', 'notes'].includes(params.get('tab') ?? '') ? params.get('tab') : 'insights') as 'insights' | 'tasks' | 'transcript' | 'chat' | 'notes';
  const setTab = (t: string) => setParams({ tab: t }, { replace: true });
  const jump = (seq: number) => { setFocusSeq(seq); setTab('transcript'); };

  const load = useCallback(() => api<Detail>(`/meetings/${id}`).then(setM).catch((e) => setError(e.message)), [id]);
  useEffect(() => { if (user) void load(); }, [user, load]);
  useEffect(() => {
    if (user) api<{ tasks: Task[] }>(`/meetings/${id}/tasks?limit=100`).then((r) => setTasks(r.tasks.slice().reverse())).catch(() => {});
  }, [user, id]);
  useEffect(() => { if (user) api<MeetingSummary>(`/meetings/${id}/summary`).then(setSummary).catch(() => {}); }, [user, id]);
  if (!user) return <Navigate to="/start" replace />;

  const act = async (path: string, json?: unknown, ok?: string) => {
    try { await api(`/meetings/${id}/${path}`, { method: 'POST', json }); if (ok) toast.success(ok); await load(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const end = async () => {
    if (await confirm({ title: 'End this meeting for everyone?', message: 'Tasks are generated and agents start on the doable ones.', confirmLabel: 'End meeting', danger: true })) await act('end', undefined, 'Meeting ended');
  };

  const crumbs = <><Link to="/dashboard/meetings" className="row" style={{ gap: 6, color: 'var(--text-2)' }}><ArrowLeft size={16} /> Meetings</Link></>;
  if (!m) return <AppShell active="meetings" crumbs={crumbs}>{error ? <div className="card"><EmptyState icon={Video} title="Meeting not found">{error}</EmptyState></div> : <div className="stack"><Skeleton h={34} w={280} /><Skeleton h={90} /></div>}</AppShell>;

  const isOwner = m.ownerId === user.id;
  const over = m.status === 'ended' || m.status === 'closed';
  const invited = m.myInviteStatus === 'invited';
  const joined = m.myInviteStatus === 'joined';
  const canJoin = !over && !invited && !!m.myInviteStatus && m.myInviteStatus !== 'declined';

  const tabs: { key: typeof tab; label: string; icon: typeof Mic; count?: number }[] = [
    { key: 'insights', label: 'Insights', icon: Sparkles },
    { key: 'tasks', label: 'Tasks', icon: ListChecks, count: tasks.length },
    { key: 'transcript', label: 'Transcript', icon: Mic, count: m.stats.transcriptSegments },
    { key: 'chat', label: 'Chat', icon: MessageSquare, count: m.stats.messages },
    { key: 'notes', label: 'My notes', icon: StickyNote },
  ];

  return (
    <AppShell active="meetings" crumbs={crumbs}>
      <div className="page-head">
        <div>
          <div className="row" style={{ gap: 10, marginBottom: 6 }}><StatusPill status={m.status} /><span className="faint">{m.projectName} · owned by {m.ownerName}</span></div>
          <h1>{m.title}</h1>
          {m.description && <p>{m.description}</p>}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {invited && <><button className="primary" onClick={() => act('respond', { accept: true }, 'Invitation accepted')}>Accept invitation</button><button onClick={() => act('respond', { accept: false })}>Decline</button></>}
          {canJoin && <button className="primary" onClick={() => nav(`/room/${m.id}`)}><DoorOpen size={17} /> {joined ? 'Return to call' : 'Join meeting'}</button>}
          {!over && isOwner && m.status === 'active' && <button className="danger" onClick={end}><PhoneOff size={16} /> End meeting</button>}
        </div>
      </div>

      {over && <div className="note-inline info" role="status"><CheckCircle2 size={18} /> This meeting has ended. Its tasks and transcript stay available here.</div>}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="meta-strip">
        <span><Clock size={14} /> {Math.floor(m.totalDurationSec / 60)}m {m.totalDurationSec % 60}s</span><span><Users size={14} /> {m.participants.length} people</span>
        <span>Started {fmt(m.startedAt)}</span>{m.endedAt && <span>Ended {fmt(m.endedAt)}</span>}
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(({ key, label, icon: Icon, count }) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}><Icon size={15} /> {label}{count != null && <em>{count}</em>}</button>
        ))}
      </div>
      <div className="tab-panel" key={tab}>
        {tab === 'insights' && (summary ? <InsightsTab s={summary} onJump={jump} /> : <Skeleton h={260} />)}
        {tab === 'tasks' && <TasksTab tasks={tasks} />}
        {tab === 'transcript' && <TranscriptTab meetingId={m.id} summary={summary} focusSeq={focusSeq} />}
        {tab === 'chat' && <ChatTab meetingId={m.id} />}
        {tab === 'notes' && <div className="card" style={{ height: 380 }}><NotesPanel meetingId={m.id} /></div>}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', marginTop: 22 }}>
        <div className="card">
          <h3>Timeline</h3>
          <dl className="kv" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div><dt>Scheduled</dt><dd>{fmt(m.scheduledAt)}</dd></div><div><dt>Created</dt><dd>{fmt(m.createdAt)}</dd></div>
            <div><dt>Started</dt><dd>{fmt(m.startedAt)}</dd></div><div><dt>Ended</dt><dd>{fmt(m.endedAt)}</dd></div>
          </dl>
        </div>
        <div className="card">
          <h3>People</h3>
          <div className="people">
            {m.participants.map((p) => (
              <div className="person" key={p.userId}><Avatar name={p.username} /><strong>{p.username}</strong>
                <span className={`pill ${p.inviteStatus === 'joined' ? 'success' : p.inviteStatus === 'declined' ? 'danger' : p.inviteStatus === 'accepted' ? 'accent' : ''}`} style={{ marginLeft: 'auto' }}>{p.inviteStatus}</span></div>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
