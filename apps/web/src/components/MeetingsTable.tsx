import { CalendarClock, ChevronRight, Radio, Video } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Meeting } from '@meetpilot/shared';
import { Avatar, EmptyState } from '../ui';

const when = (m: Meeting) => new Date(m.scheduledAt ?? m.startedAt ?? m.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export function StatusPill({ status }: { status: Meeting['status'] }) {
  if (status === 'active') return <span className="pill success live"><span className="dot" /> Live</span>;
  if (status === 'scheduled') return <span className="pill accent"><CalendarClock size={12} /> Scheduled</span>;
  return <span className="pill">{status === 'closed' ? 'Closed' : 'Ended'}</span>;
}

export function MeetingsTable({ meetings, action }: { meetings: Meeting[]; action?: React.ReactNode }) {
  if (meetings.length === 0) return <div className="card"><EmptyState icon={Video} title="Start your first meeting" action={action}>Meetings you start or schedule appear here, with their tasks and what the assistant noticed.</EmptyState></div>;
  return (
    <div className="card list-card">
      {meetings.map((m) => (
        <Link key={m.id} to={m.status === 'active' ? `/room/${m.id}` : `/meetings/${m.id}`} className="meeting-row">
          <div className="title"><Avatar name={m.ownerName} /><div style={{ minWidth: 0 }}><span style={{ display: 'block' }}>{m.title}</span><span className="meta" style={{ fontWeight: 450 }}>{m.ownerName} · {when(m)}</span></div></div>
          <StatusPill status={m.status} />
          {m.status === 'active' ? <Radio size={17} className="faint" /> : <ChevronRight size={17} className="faint" />}
        </Link>
      ))}
    </div>
  );
}
