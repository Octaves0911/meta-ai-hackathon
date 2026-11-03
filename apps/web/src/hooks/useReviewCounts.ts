import { useCallback, useEffect, useState } from 'react';
import { Events, type ReviewCounts } from '@meetpilot/shared';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';

/** Numbers for the sidebar badge; refreshed whenever any execution of this user changes. */
export function useReviewCounts(username: string | undefined): ReviewCounts {
  const [counts, setCounts] = useState<ReviewCounts>({ needsReview: 0, working: 0 });
  const load = useCallback(() => { api<ReviewCounts>('/reviews/counts').then(setCounts).catch(() => undefined); }, []);
  useEffect(() => {
    if (!username) return;
    load();
    const s = getSocket(username);
    s.on(Events.executionUpdate, load);
    return () => { s.off(Events.executionUpdate, load); };
  }, [username, load]);
  return counts;
}
