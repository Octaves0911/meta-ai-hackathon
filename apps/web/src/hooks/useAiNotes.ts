import { useCallback, useEffect, useState } from 'react';
import { Events, type Insight } from '@meetpilot/shared';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';

const PAGE = 30;

/** AI Notes feed: newest first, live additions, older pages on demand, unread count for the tab badge. */
export function useAiNotes(meetingId: string, username: string, enabled: boolean, tabActive: boolean) {
  const [notes, setNotes] = useState<Insight[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled) return;
    api<Insight[]>(`/meetings/${meetingId}/insights?tier=feed&limit=${PAGE}`)
      .then((l) => { setNotes(l); setHasMore(l.length === PAGE); })
      .catch((e) => setError(e.message));
    const s = getSocket(username);
    const onNew = (p: { insight: Insight; tier: string; ephemeral?: boolean }) => {
      if (p.tier !== 'feed' || p.insight.meetingId !== meetingId) return;
      setNotes((l) => (l.some((n) => n.id === p.insight.id) ? l : [p.insight, ...l]));
      setUnread((n) => n + 1);
    };
    s.on(Events.insightNew, onNew);
    return () => { s.off(Events.insightNew, onNew); };
  }, [meetingId, username, enabled]);

  useEffect(() => { if (tabActive) setUnread(0); }, [tabActive, notes.length]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || notes.length === 0) return;
    try {
      const page = await api<Insight[]>(`/meetings/${meetingId}/insights?tier=feed&limit=${PAGE}&before=${encodeURIComponent(notes[notes.length - 1].createdAt)}`);
      setNotes((l) => [...l, ...page]);
      setHasMore(page.length === PAGE);
    } catch (e) { setError((e as Error).message); }
  }, [hasMore, notes, meetingId]);

  return { notes, unread, hasMore, loadOlder, error };
}
