import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@meetpilot/shared';
import { api, useSession } from '../lib/api';
import { getSocket } from '../lib/socket';

const PAGE = 30;
const NEAR_BOTTOM_PX = 80;

export function ChatPanel({ meetingId }: { meetingId: string }) {
  const { user } = useSession();
  const [messages, setMessages] = useState<ChatMessage[]>([]); // oldest -> newest
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);                 // follow new messages only while the reader is near the bottom
  const prevHeight = useRef<number | null>(null); // set while prepending older messages to keep scroll position

  const scrollToBottom = () => { if (box.current) box.current.scrollTop = box.current.scrollHeight; };

  // Initial load: latest page first.
  useEffect(() => {
    api<ChatMessage[]>(`/meetings/${meetingId}/messages?limit=${PAGE}`).then((page) => {
      setMessages(page.slice().reverse());
      setHasMore(page.length === PAGE);
      stick.current = true;
    }).catch((e) => setError(e.message));
  }, [meetingId]);

  const append = useCallback((m: ChatMessage) => {
    setMessages((l) => (l.some((x) => x.id === m.id) ? l : [...l, m]));
  }, []);

  useEffect(() => {
    if (!user) return;
    const s = getSocket(user.username);
    const onMsg = (m: ChatMessage) => { if (m.meetingId === meetingId) append(m); };
    s.on('chat:message', onMsg);
    return () => { s.off('chat:message', onMsg); };
  }, [user, meetingId, append]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (prevHeight.current !== null) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (stick.current) scrollToBottom();
  }, [messages]);

  const loadOlder = async () => {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const page = await api<ChatMessage[]>(`/meetings/${meetingId}/messages?limit=${PAGE}&before=${encodeURIComponent(messages[0].createdAt)}`);
      prevHeight.current = box.current?.scrollHeight ?? null;
      setMessages((l) => [...page.slice().reverse(), ...l]);
      setHasMore(page.length === PAGE);
    } catch (e) { setError((e as Error).message); }
    finally { setLoadingOlder(false); }
  };

  const onScroll = () => {
    const el = box.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (el.scrollTop < 40) void loadOlder();
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    try {
      const m = await api<ChatMessage>(`/meetings/${meetingId}/messages`, { method: 'POST', json: { body } });
      stick.current = true; // always follow your own message
      append(m);
    } catch (err) { setError((err as Error).message); setDraft(body); }
  };

  return (
    <div className="panel-col">
      <div className="messages" ref={box} onScroll={onScroll} aria-live="polite">
        {loadingOlder && <div className="muted center-text">Loading…</div>}
        {!hasMore && messages.length > 0 && <div className="muted center-text">Start of conversation</div>}
        {messages.length === 0 && <p className="muted">No messages yet.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg${m.userId === user?.id ? ' mine' : ''}`}>
            <div className="msg-meta">{m.username ?? 'AI'} · {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            <div>{m.body}</div>
          </div>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <form className="row" onSubmit={send} style={{ padding: 8 }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message…" aria-label="Message" />
        <button className="primary" disabled={!draft.trim()}>Send</button>
      </form>
    </div>
  );
}
