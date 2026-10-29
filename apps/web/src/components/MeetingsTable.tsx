import { Link } from 'react-router-dom';
import type { Meeting } from '@meetpilot/shared';

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');

export function MeetingsTable({ meetings }: { meetings: Meeting[] }) {
  if (meetings.length === 0) return <div className="card"><p className="muted">No meetings yet. Use “New meeting” to schedule one or start an instant call.</p></div>;
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr className="muted" style={{ textAlign: 'left' }}>
          <th>Title</th><th>Status</th><th>When</th><th>Owner</th>
        </tr></thead>
        <tbody>
          {meetings.map((m) => (
            <tr key={m.id} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '8px 0' }}><Link to={`/meetings/${m.id}`}>{m.title}</Link></td>
              <td>{m.status}</td><td>{fmt(m.scheduledAt ?? m.startedAt ?? m.createdAt)}</td><td>{m.ownerName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
