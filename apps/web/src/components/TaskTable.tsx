import type { Task } from '@meetpilot/shared';
import { fmtDate } from './TasksPanel';
import { Avatar } from '../ui';

const who = (u: { username: string } | null, empty = '—') => u ? <span className="row" style={{ gap: 8 }}><Avatar name={u.username} size="sm" />{u.username}</span> : <span className="faint">{empty}</span>;

/** The six task fields as a table (end-of-meeting overlay and meeting detail page). */
export function TaskTable({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return <p className="muted">No tasks were identified in this meeting.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead><tr><th>Title</th><th>Description</th><th>Assigned to</th><th>Assigned by</th><th>Due date</th><th>Created</th></tr></thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td><strong>{t.title}</strong></td><td className="muted" style={{ maxWidth: 260 }}>{t.description ?? '—'}</td>
              <td>{who(t.assignedTo, 'Unassigned')}</td><td>{who(t.assignedBy)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.dueDate)}</td><td className="faint" style={{ whiteSpace: 'nowrap' }}>{new Date(t.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
