import { CalendarDays, ListChecks } from 'lucide-react';
import type { TaskStatus } from '@meetpilot/shared';
import { Avatar } from '../ui';
import type { Counts } from '../hooks/useTasks';
import type { Task } from '@meetpilot/shared';

const FILTERS: [TaskStatus | 'all', string, keyof Counts][] = [
  ['all', 'All', 'total'], ['open', 'Open', 'open'], ['in_progress', 'In progress', 'in_progress'], ['review', 'Review', 'review'], ['done', 'Done', 'done'],
];

export const fmtDate = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export function TasksPanel({ tasks, counts, filter, setFilter, hasMore, loadMore, error }: {
  tasks: Task[]; counts: Counts; filter: TaskStatus | 'all'; setFilter: (f: TaskStatus | 'all') => void;
  hasMore: boolean; loadMore: () => void; error: string;
}) {
  return (
    <div className="panel-col">
      <div className="chips" role="group" aria-label="Filter tasks by status">
        {FILTERS.map(([key, label, c]) => (
          <button key={key} className={`chip${filter === key ? ' active' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {label} <span className="muted">{counts[c]}</span>
          </button>
        ))}
      </div>
      <div className="messages" onScroll={(e) => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) loadMore(); }}>
        {tasks.length === 0 && <div className="empty" style={{ margin: 'auto' }}><div className="empty-icon"><ListChecks size={22} /></div><h3>{filter === 'all' ? 'No tasks yet' : 'Nothing here'}</h3><p>{filter === 'all' ? 'Commitments like “I will send the report by Friday” appear here automatically.' : 'No tasks with this status.'}</p></div>}
        {tasks.map((t) => (
          <article key={t.id} className="task-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{t.title}</strong><span className={`status status-${t.status}`}>{t.status.replace('_', ' ')}</span>
            </div>
            {t.description && <div className="muted task-desc">{t.description}</div>}
            <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
              {t.assignedTo ? <span className="pill accent" title="Assigned to"><Avatar name={t.assignedTo.username} size="sm" /> {t.assignedTo.username}</span> : <span className="pill">Unassigned</span>}
              {t.dueDate && <span className="pill warn" title="Due date"><CalendarDays size={12} /> {fmtDate(t.dueDate)}</span>}
              {t.assignedBy && <span className="faint" style={{ fontSize: 12.5 }}>from {t.assignedBy.username}</span>}
            </div>
          </article>
        ))}
        {hasMore && <button className="mini" onClick={loadMore}>Load more</button>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
