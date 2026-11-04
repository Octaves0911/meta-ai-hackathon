import { Bot, GitCompare, ImagePlus, Send, User, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Events, MAX_CHAT_MESSAGES, MAX_REVISIONS, lineDiff, type ExecutionDetail, type ExecutionMessage } from '@meetpilot/shared';
import { api, fetchBlob, streamNdjson, useSession } from '../lib/api';
import { getSocket } from '../lib/socket';
import { AGENT_LABEL } from '../routes/Reviews';
import { toast } from '../ui';

const MAX_IMAGE = 2_500_000;
const readDataUrl = (f: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('could not read the image')); r.readAsDataURL(f); });

/** A screenshot attached to a chat message: fetched with the user's identity, shown as a thumbnail that opens full size. */
function ChatImage({ executionId, messageId }: { executionId: string; messageId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let gone = false, made = '';
    fetchBlob(`/executions/${executionId}/messages/${messageId}/image`).then((b) => { if (!gone) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => undefined);
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [executionId, messageId]);
  if (!url) return <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Loading screenshot…</div>;
  return <a href={url} target="_blank" rel="noreferrer noopener"><img src={url} alt="Screenshot attached to this message" style={{ marginTop: 6, maxWidth: 260, maxHeight: 160, borderRadius: 8, border: '1px solid var(--border)', display: 'block' }} /></a>;
}

const KIND_LABEL: Record<string, string> = { ask: 'Answer', change: 'Planned change', clarify: 'Question for you' };

/** Talk to the agent that produced the work: ask questions, ask for changes, answer its questions, then Apply & rerun. */
export function ReviewChat({ d, onChanged }: { d: ExecutionDetail; onChanged: () => void }) {
  const { user } = useSession();
  const [messages, setMessages] = useState<ExecutionMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<string | null>(null);   // the agent's reply while it is still being written
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => api<ExecutionMessage[]>(`/executions/${d.id}/messages`).then(setMessages).catch(() => undefined), [d.id]);
  useEffect(() => { void load(); }, [load, d.revision]);
  useEffect(() => {
    if (!user) return;
    const s = getSocket(user.username);
    s.on(Events.executionMessage, load);
    return () => { s.off(Events.executionMessage, load); };
  }, [user, load]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages.length, streaming]);

  if (!d.agent) return null;
  const agent = AGENT_LABEL[d.agent] ?? d.agent;
  const open = d.canReview && d.status === 'awaiting_review';
  const pending = messages.filter((m) => m.revision === d.revision && m.role === 'user' && (m.kind === 'change' || m.kind === 'clarify')).length;
  const revisionsLeft = MAX_REVISIONS - d.revision;
  if (!open && messages.length === 0) return null;

  const attach = async (f: File | null | undefined) => {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { setError('Attach a PNG, JPEG or WebP screenshot.'); return; }
    if (f.size > MAX_IMAGE) { setError('That screenshot is larger than 2.5 MB.'); return; }
    setError('');
    try { setImage(await readDataUrl(f)); } catch (e) { setError((e as Error).message); }
  };
  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true); setError(''); setStreaming('');
    try {
      // Streamed: the reply appears word by word; when it is done the saved messages replace the draft.
      let finished = false;
      await streamNdjson<{ t: string; text?: string; message?: string; messages?: ExecutionMessage[] }>(`/executions/${d.id}/messages/stream`, { text: t, ...(image ? { image } : {}) }, (line) => {
        if (line.t === 'delta') setStreaming((s) => (s ?? '') + (line.text ?? ''));
        else if (line.t === 'done' && line.messages) { finished = true; setMessages((m) => [...m, ...line.messages!]); setText(''); setImage(null); }
        else if (line.t === 'error') setError(line.message ?? 'The agent could not answer right now.');
      });
      if (!finished) void load();
    } catch (e) { setError((e as Error).message); } finally { setSending(false); setStreaming(null); }
  };
  const rerun = async () => {
    setRerunning(true); setError('');
    try { await api(`/executions/${d.id}/rerun`, { method: 'POST', json: {} }); toast(`The ${agent} agent is redoing the work…`); onChanged(); }
    catch (e) { setError((e as Error).message); } finally { setRerunning(false); }
  };

  return (
    <div className="card" style={{ marginTop: 16 }} aria-label={`Chat with the ${agent} agent`}>
      <h3 className="row" style={{ gap: 8, margin: '0 0 4px' }}><Bot size={17} /> Talk to the {agent} agent</h3>
      <p className="faint" style={{ margin: '0 0 12px', fontSize: 13 }}>Ask why it did something, or tell it what to change. Nothing changes until you click <strong>Apply &amp; rerun</strong>.</p>
      <div className="stack" style={{ gap: 10, maxHeight: 360, overflowY: 'auto', paddingRight: 4 }} role="log" aria-live="polite">
        {messages.length === 0 && <p className="muted" style={{ margin: 0 }}>For example: “Why did you choose this date?” or “Make the summary shorter and add a risks section.”</p>}
        {messages.map((m) => (
          <div key={m.id} className="row" style={{ gap: 10, alignItems: 'flex-start', flexDirection: m.role === 'user' ? 'row-reverse' : 'row' }}>
            <span className="avatar sm" style={{ background: m.role === 'agent' ? 'var(--ai)' : 'var(--accent)' }}>{m.role === 'agent' ? <Bot size={14} /> : <User size={14} />}</span>
            <div style={{ maxWidth: '82%', background: m.role === 'user' ? 'var(--accent-soft)' : 'var(--surface-3)', borderRadius: 12, padding: '8px 12px' }}>
              {m.role === 'agent' && <div className="faint" style={{ fontSize: 12, fontWeight: 600 }}>{KIND_LABEL[m.kind] ?? m.kind}{m.revision !== d.revision ? ` · revision ${m.revision}` : ''}</div>}
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
              {m.hasImage && <ChatImage executionId={d.id} messageId={m.id} />}
              {m.proposedChange && <div style={{ marginTop: 6, fontSize: 13 }}><strong>Will change:</strong> {m.proposedChange}</div>}
            </div>
          </div>
        ))}
        {sending && streaming === '' && <div className="faint row" style={{ gap: 8 }}><span className="spinner" /> {agent} is thinking…</div>}
        {sending && !!streaming && (
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }} aria-live="off">
            <span className="avatar sm" style={{ background: 'var(--ai)' }}><Bot size={14} /></span>
            <div style={{ maxWidth: '82%', background: 'var(--surface-3)', borderRadius: 12, padding: '8px 12px' }}>
              <div className="faint" style={{ fontSize: 12, fontWeight: 600 }}>{agent} is writing…</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{streaming}<span className="caret" aria-hidden>▍</span></div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {open && (
        <>
          {image && (
            <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
              <img src={image} alt="Screenshot to send" style={{ maxHeight: 64, maxWidth: 120, borderRadius: 6, border: '1px solid var(--border)' }} />
              <span className="faint" style={{ fontSize: 13 }}>The agent will look at this screenshot.</span>
              <button className="ghost icon" onClick={() => setImage(null)} aria-label="Remove the screenshot" title="Remove the screenshot"><X size={14} /></button>
            </div>
          )}
          <div className="row" style={{ gap: 8, marginTop: image ? 8 : 12, alignItems: 'flex-end' }}>
            <textarea rows={2} style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="Message to the agent" placeholder="Ask a question, describe a change, or paste a screenshot…"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              onPaste={(e) => { const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); void attach(f); } }} />
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void attach(e.target.files?.[0]); e.target.value = ''; }} />
            <button className="ghost icon" onClick={() => fileRef.current?.click()} aria-label="Attach a screenshot" title="Attach a screenshot" disabled={sending}><ImagePlus size={17} /></button>
            <button disabled={sending || !text.trim() || messages.length >= MAX_CHAT_MESSAGES} onClick={send}><Send size={15} /> Send</button>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginTop: 10 }}>
            <span className="faint" style={{ fontSize: 13 }}>{pending > 0 ? `${pending} change${pending > 1 ? 's' : ''} ready to apply` : 'No changes requested yet'} · {revisionsLeft > 0 ? `${revisionsLeft} rerun${revisionsLeft > 1 ? 's' : ''} left` : 'no reruns left'}</span>
            <button className="primary" disabled={rerunning || pending === 0 || revisionsLeft <= 0} onClick={rerun}>{rerunning ? 'Starting…' : 'Apply & rerun'}</button>
          </div>
        </>
      )}
      {error && <p className="error" role="alert" style={{ margin: '8px 0 0' }}>{error}</p>}
    </div>
  );
}

/** What changed since the previous revision of the written deliverable (line diff). */
export function RevisionDiff({ d }: { d: ExecutionDetail }) {
  const [prev, setPrev] = useState<string | null>(null);
  const cur = d.artifacts.find((a) => a.type === 'markdown')?.payload?.content as string | undefined;
  useEffect(() => {
    if (d.revision < 1) return;
    let gone = false;
    api<ExecutionDetail>(`/executions/${d.id}?revision=${d.revision - 1}`).then((p) => { if (!gone) setPrev((p.artifacts.find((a) => a.type === 'markdown')?.payload?.content as string | undefined) ?? null); }).catch(() => undefined);
    return () => { gone = true; };
  }, [d.id, d.revision]);
  if (d.revision < 1 || !cur || prev == null || prev === cur) return null;
  const diff = lineDiff(prev, cur).filter((l) => l.text.trim() !== '' || l.type !== 'same');
  const added = diff.filter((l) => l.type === 'add').length, removed = diff.filter((l) => l.type === 'del').length;
  return (
    <details className="card" style={{ marginBottom: 16 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}><GitCompare size={15} style={{ verticalAlign: -2, marginRight: 6 }} />What changed since revision {d.revision - 1} <span className="faint" style={{ fontWeight: 450 }}>· +{added} −{removed} lines</span></summary>
      <pre className="diff" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{diff.map((l, i) => (
        <div key={i} style={{ background: l.type === 'add' ? 'var(--success-soft)' : l.type === 'del' ? 'var(--danger-soft)' : 'transparent', color: l.type === 'same' ? 'var(--text-3)' : undefined }}>
          {l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}{l.text}
        </div>
      ))}</pre>
    </details>
  );
}
