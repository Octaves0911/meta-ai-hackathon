import { useEffect, useRef, useState } from 'react';
import { Events } from '@meetpilot/shared';
import { getSocket } from '../lib/socket';

export interface CaptionLine { key: number; userId: string; speaker: string; text: string; final: boolean }
interface CaptionEvent { meetingId: string; userId: string; speaker: string; text: string }

const THROTTLE_MS = 220;   // interim updates are applied at most this often (PRD §7.2)
const IDLE_FADE_MS = 8000; // block fades out after this much silence

/** Live subtitle state: at most two lines (previous + current), throttled interims, idle fade. */
export function useCaptionFeed(meetingId: string, username: string) {
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const [visible, setVisible] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const socket = getSocket(username);
    let lastApplied = 0;
    let pending: { ev: CaptionEvent; final: boolean } | null = null;
    let throttle: ReturnType<typeof setTimeout> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const apply = (ev: CaptionEvent, final: boolean) => {
      lastApplied = Date.now();
      setLines((prev) => {
        const cur = prev[prev.length - 1];
        if (cur && !cur.final && cur.userId === ev.userId) return [...prev.slice(0, -1), { ...cur, text: ev.text, final }];
        return [...prev, { key: ++seq.current, userId: ev.userId, speaker: ev.speaker, text: ev.text, final }].slice(-2);
      });
      setVisible(true);
      clearTimeout(idle);
      idle = setTimeout(() => setVisible(false), IDLE_FADE_MS);
    };

    const onInterim = (ev: CaptionEvent) => {
      if (ev.meetingId !== meetingId) return;
      pending = { ev, final: false };
      const wait = THROTTLE_MS - (Date.now() - lastApplied);
      if (wait <= 0) { apply(ev, false); pending = null; }
      else if (!throttle) throttle = setTimeout(() => { throttle = undefined; if (pending) { apply(pending.ev, false); pending = null; } }, wait);
    };
    const onFinal = (ev: CaptionEvent) => {
      if (ev.meetingId !== meetingId) return;
      pending = null; // a final supersedes any queued interim
      apply(ev, true);
    };

    socket.on(Events.captionInterim, onInterim);
    socket.on(Events.captionFinal, onFinal);
    return () => {
      socket.off(Events.captionInterim, onInterim);
      socket.off(Events.captionFinal, onFinal);
      clearTimeout(throttle); clearTimeout(idle);
    };
  }, [meetingId, username]);

  return { lines, visible };
}
