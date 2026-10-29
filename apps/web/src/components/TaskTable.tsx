import type { Task } from '@meetpilot/shared';
import { fmtDate } from './TasksPanel';

/** The six task fields as a table (end-of-meeting overlay and meeting detail page). */
export function TaskTable({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return <p className="muted">No tasks were identified in this meeting.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="task-table">
        <thead><tr><th>Title</th><th>Description</th><th>Assigned to</th><th>Assigned by</th><th>Due date</th><th>Created</th></tr></thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td><strong>{t.title}</strong></td><td className="muted">{t.description ?? '—'}</td>
              <td>{t.assignedTo?.username ?? 'Unassigned'}</td><td>{t.assignedBy?.username ?? '—'}</td>
              <td>{fmtDate(t.dueDate)}</td><td>{new Date(t.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
