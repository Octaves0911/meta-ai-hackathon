import { useCallback, useEffect, useRef, useState } from 'react';
import { Events, type Task, type TaskStatus } from '@meetpilot/shared';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';

const PAGE = 15;
export type Counts = Record<'open' | 'in_progress' | 'review' | 'done' | 'total', number>;
const EMPTY: Counts = { open: 0, in_progress: 0, review: 0, done: 0, total: 0 };

/** Live task list for a meeting: newest first, 15 per page, status filter, counts, and the final list on meeting end. */
export function useTasks(meetingId: string, username: string, enabled: boolean) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [counts, setCounts] = useState<Counts>(EMPTY);
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');
  const [hasMore, setHasMore] = useState(false);
  const [finalTasks, setFinalTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState('');
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const query = (f: TaskStatus | 'all', before?: string) =>
    `/meetings/${meetingId}/tasks?limit=${PAGE}${f !== 'all' ? `&status=${f}` : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`;

  const reload = useCallback(async (f: TaskStatus | 'all') => {
    try {
      const r = await api<{ tasks: Task[]; counts: Counts }>(query(f));
      setTasks(r.tasks); setCounts(r.counts); setHasMore(r.tasks.length === PAGE);
    } catch (e) { setError((e as Error).message); }
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (enabled) void reload(filter); }, [enabled, filter, reload]);

  useEffect(() => {
    if (!enabled) return;
    const s = getSocket(username);
    const onUpsert = (t: Task) => {
      if (t.meetingId !== meetingId) return;
      const f = filterRef.current;
      setTasks((l) => {
        const without = l.filter((x) => x.id !== t.id);
        if (f !== 'all' && t.status !== f) return without;
        return l.some((x) => x.id === t.id) ? l.map((x) => (x.id === t.id ? t : x)) : [t, ...l].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
      void api<{ counts: Counts }>(`/meetings/${meetingId}/tasks?limit=1`).then((r) => setCounts(r.counts)).catch(() => {});
    };
    const onReady = (p: { meetingId: string; tasks: Task[] }) => { if (p.meetingId === meetingId) setFinalTasks(p.tasks); };
    s.on(Events.taskUpserted, onUpsert);
    s.on(Events.meetingTasksReady, onReady);
    return () => { s.off(Events.taskUpserted, onUpsert); s.off(Events.meetingTasksReady, onReady); };
  }, [enabled, meetingId, username]);

  const loadMore = useCallback(async () => {
    if (!hasMore || tasks.length === 0) return;
    try {
      const r = await api<{ tasks: Task[] }>(query(filter, tasks[tasks.length - 1].createdAt));
      setTasks((l) => [...l, ...r.tasks]);
      setHasMore(r.tasks.length === PAGE);
    } catch (e) { setError((e as Error).message); }
  }, [hasMore, tasks, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Fallback if the broadcast was missed (e.g. a brief disconnect): fetch the whole list directly. */
  const fetchAll = useCallback(async () => {
    const r = await api<{ tasks: Task[] }>(`/meetings/${meetingId}/tasks?limit=100`);
    setFinalTasks(r.tasks.slice().reverse());
  }, [meetingId]);

  return { tasks, counts, filter, setFilter, hasMore, loadMore, finalTasks, fetchAll, error };
}
