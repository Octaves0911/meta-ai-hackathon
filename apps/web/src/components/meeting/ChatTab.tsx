import { MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChatMessage } from '@meetpilot/shared';
import { api, useSession } from '../../lib/api';
import { Avatar, EmptyState, Skeleton } from '../../ui';
import { InsightCard } from '../InsightCard';

export function ChatTab({ meetingId }: { meetingId: string }) {
  const { user } = useSession();
  const [msgs, setMsgs] = useState<ChatMessage[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api<ChatMessage[]>(`/meetings/${meetingId}/messages?limit=100`).then((r) => { setMsgs(r.slice().reverse()); setMore(r.length === 100); }).catch((e) => setError(e.message));
  }, [meetingId]);
  const older = async () => {
    if (!msgs?.length) return;
    const r = await api<ChatMessage[]>(`/meetings/${meetingId}/messages?limit=100&before=${encodeURIComponent(msgs[0].createdAt)}`);
    setMsgs([...r.slice().reverse(), ...msgs]); setMore(r.length === 100);
  };
  if (error) return <div className="card"><EmptyState icon={MessageSquare} title="Chat unavailable">{error}</EmptyState></div>;
  if (!msgs) return <Skeleton h={200} />;
  if (!msgs.length) return <div className="card"><EmptyState icon={MessageSquare} title="No messages">Nobody wrote in the chat during this meeting.</EmptyState></div>;
  return (
    <div className="card chat-tab">
      {more && <button className="ghost" onClick={older}>Load older messages</button>}
      {msgs.map((m) => m.kind === 'ai_insight' && m.insight ? (
        <div className="chat-ai" key={m.id}><InsightCard insight={m.insight} /><time>{new Date(m.createdAt).toLocaleTimeString([], { timeStyle: 'short' })}</time></div>
      ) : (
        <div className={`chat-row${m.userId === user?.id ? ' mine' : ''}`} key={m.id}>
          <Avatar name={m.username ?? '?'} size="sm" />
          <div><div className="msg-meta">{m.username ?? 'Unknown'} · {new Date(m.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div><div className="msg" style={{ maxWidth: '100%' }}>{m.body}</div></div>
        </div>
      ))}
    </div>
  );
}
