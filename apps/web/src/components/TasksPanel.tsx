import type { TaskStatus } from '@meetpilot/shared';
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
        {tasks.length === 0 && <p className="muted">{filter === 'all' ? 'No tasks yet. Commitments like “I will send the report by Friday” appear here automatically.' : 'No tasks with this status.'}</p>}
        {tasks.map((t) => (
          <article key={t.id} className="task-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{t.title}</strong><span className={`status status-${t.status}`}>{t.status.replace('_', ' ')}</span>
            </div>
            {t.description && <div className="muted task-desc">{t.description}</div>}
            <dl className="task-meta">
              <div><dt>Assigned to</dt><dd>{t.assignedTo?.username ?? 'Unassigned'}</dd></div>
              <div><dt>Assigned by</dt><dd>{t.assignedBy?.username ?? '—'}</dd></div>
              <div><dt>Due</dt><dd>{fmtDate(t.dueDate)}</dd></div>
              <div><dt>Created</dt><dd>{new Date(t.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>
            </dl>
          </article>
        ))}
        {hasMore && <button className="mini" onClick={loadMore}>Load more</button>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
