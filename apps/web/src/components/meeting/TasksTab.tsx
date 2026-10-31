import { ListChecks } from 'lucide-react';
import type { Task } from '@meetpilot/shared';
import { Avatar, EmptyState } from '../../ui';
import { fmtDate } from '../TasksPanel';

const today = () => new Date().toISOString().slice(0, 10);
const LABEL = { open: 'Open', in_progress: 'In progress', review: 'In review', done: 'Done' } as const;

export function TasksTab({ tasks }: { tasks: Task[] }) {
  if (!tasks.length) return <div className="card"><EmptyState icon={ListChecks} title="No tasks yet">Commitments like “I will send the report by Friday” become tasks automatically.</EmptyState></div>;
  return (
    <div className="card flush" style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead><tr><th>Task</th><th>Owner</th><th>Assigned by</th><th>Due</th><th>Status</th></tr></thead>
        <tbody>{tasks.map((t) => {
          const late = t.status !== 'done' && !!t.dueDate && t.dueDate < today();
          return (
            <tr key={t.id}>
              <td><strong>{t.title}</strong>{t.description && <div className="faint small">{t.description}</div>}</td>
              <td>{t.assignedTo ? <span className="row" style={{ gap: 8 }}><Avatar name={t.assignedTo.username} size="sm" />{t.assignedTo.username}</span> : <span className="faint">Unassigned</span>}</td>
              <td>{t.assignedBy?.username ?? <span className="faint">—</span>}</td>
              <td style={{ whiteSpace: 'nowrap' }} className={late ? 'bad' : ''}>{fmtDate(t.dueDate)}{late ? ' · overdue' : ''}</td>
              <td><span className={`pill ${t.status === 'done' ? 'success' : late ? 'danger' : 'accent'}`}>{LABEL[t.status]}</span></td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
