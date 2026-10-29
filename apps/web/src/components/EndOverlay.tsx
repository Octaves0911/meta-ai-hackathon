import { useEffect, useRef } from 'react';
import type { Task } from '@meetpilot/shared';
import { TaskTable } from './TaskTable';

/** Full-page overlay shown to everyone when the owner ends the meeting: spinner, then the task table (F7.4). */
export function EndOverlay({ tasks, fetchAll, onDone }: { tasks: Task[] | null; fetchAll: () => Promise<void>; onDone: () => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  // If the broadcast is missed, fall back to fetching the list after a few seconds.
  useEffect(() => {
    if (tasks) return;
    const t = setTimeout(() => void fetchAll().catch(() => {}), 8000);
    return () => clearTimeout(t);
  }, [tasks, fetchAll]);
  useEffect(() => { if (tasks) btn.current?.focus(); }, [tasks]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="end-title">
      <div className="overlay-card">
        <h2 id="end-title">Meeting ended</h2>
        {!tasks ? (
          <p role="status" className="row"><span className="spinner" aria-hidden /> Generating tasks…</p>
        ) : (
          <>
            <p className="muted">{tasks.length} task{tasks.length === 1 ? '' : 's'} from this meeting</p>
            <TaskTable tasks={tasks} />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button ref={btn} className="primary" onClick={onDone}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
