import { ArrowLeft, CheckCircle2, Clock, DoorOpen, ListChecks, MessageSquare, Mic, PhoneOff, StickyNote, Users, Video } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import type { MeetingDetail as Detail, Task } from '@meetpilot/shared';
import { AppShell } from '../components/AppShell';
import { StatusPill } from '../components/MeetingsTable';
import { TaskTable } from '../components/TaskTable';
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

  const load = useCallback(() => api<Detail>(`/meetings/${id}`).then(setM).catch((e) => setError(e.message)), [id]);
  useEffect(() => { if (user) void load(); }, [user, load]);
  useEffect(() => {
    if (user) api<{ tasks: Task[] }>(`/meetings/${id}/tasks?limit=100`).then((r) => setTasks(r.tasks.slice().reverse())).catch(() => {});
  }, [user, id]);
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

  const facts = [
    { icon: Clock, label: 'Duration', value: `${Math.floor(m.totalDurationSec / 60)}m ${m.totalDurationSec % 60}s` },
    { icon: Users, label: 'Participants', value: m.participants.length },
    { icon: MessageSquare, label: 'Messages', value: m.stats.messages },
    { icon: ListChecks, label: 'Tasks', value: tasks.length },
    { icon: Mic, label: 'Transcript lines', value: m.stats.transcriptSegments },
    { icon: StickyNote, label: 'Private notes', value: m.stats.notes },
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

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {facts.map(({ icon: Icon, label, value }) => (
          <div className="card stat-card" key={label} style={{ padding: '14px 16px' }}>
            <div className="label"><span className="ico"><Icon size={15} /></span>{label}</div><div className="stat" style={{ fontSize: 24 }}>{value}</div>
          </div>
        ))}
      </div>

      <div className="section-title"><h3>Tasks</h3></div>
      <div className="card list-card" style={{ overflowX: 'auto' }}>{tasks.length ? <TaskTable tasks={tasks} /> : <EmptyState icon={ListChecks} title="No tasks yet">Commitments like “I will send the report by Friday” become tasks automatically.</EmptyState>}</div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', marginTop: 18 }}>
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
