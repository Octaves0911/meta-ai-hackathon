import { CheckCircle2, Mail, Send, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { ExecutionDetail } from '@meetpilot/shared';
import { api } from '../lib/api';
import { Modal, toast } from '../ui';

/** After approval: allow sending (separate permission), review the exact email, confirm, send. Every send is listed. */
export function SendEmailPanel({ d, onDone }: { d: ExecutionDetail; onDone: () => Promise<unknown> }) {
  const draft = d.artifacts.find((a) => a.type === 'email_draft');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [needsPermission, setNeedsPermission] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!draft || d.status !== 'approved' || !d.send) return null;

  const p = draft.payload ?? {};
  const to: string[] = p.to ?? [], cc: string[] = p.cc ?? [];
  const already = d.send.sent.length > 0;
  const granted = d.send.granted === true && !needsPermission;

  const allow = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ url: string }>(`/projects/${await projectId(d)}/connections/google/start`, { method: 'POST', json: { services: ['gmail'], sendAccess: true, returnTo: `/reviews/${d.id}?send=1` } });
      window.location.href = r.url;
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  const send = async () => {
    setBusy(true); setError('');
    try {
      await api(`/executions/${d.id}/send-email`, { method: 'POST', json: { artifactId: draft.id, confirm: true } });
      setConfirming(false); toast.success('Email sent'); await onDone();
    } catch (e) {
      const msg = (e as Error).message;
      if (/allow MeetPilot to send/i.test(msg)) { setNeedsPermission(true); setConfirming(false); }
      setError(msg);
    } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 className="row" style={{ gap: 8 }}><Mail size={17} /> Send email</h3>
      {d.send.sent.map((s, i) => (
        <p key={i} className="note-inline success" role="status"><CheckCircle2 size={17} style={{ flex: 'none', marginTop: 2 }} /> Sent {new Date(s.sentAt).toLocaleString()} from {s.from ?? 'your Gmail'} to {s.to.join(', ')}{s.cc.length ? ` (cc ${s.cc.join(', ')})` : ''} — “{s.subject}”</p>
      ))}
      {!already && (
        <>
          <p className="muted">Nothing is sent automatically. You will see the recipients and the exact text before it goes out.</p>
          {to.length === 0 && <p className="error">Add at least one recipient in the draft before sending.</p>}
          {!granted ? (
            <div>
              <p>MeetPilot can only <strong>read</strong> your Gmail today. To send this email, allow sending — you will be taken to Google and brought back here.</p>
              <button className="primary" onClick={allow} disabled={busy || to.length === 0}><ShieldCheck size={16} /> Allow sending via Gmail</button>
            </div>
          ) : <button className="primary" onClick={() => setConfirming(true)} disabled={to.length === 0}><Send size={16} /> Send via Gmail…</button>}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      <Modal open={confirming} onClose={() => !busy && setConfirming(false)} title="Send this email?" description="Check the recipients and text. This sends from your Gmail." wide>
        <dl className="kv" style={{ gridTemplateColumns: '70px 1fr', gap: '8px 12px', margin: '10px 0' }}>
          <dt>From</dt><dd>{d.send.account ?? 'your Gmail account'}</dd>
          <dt>To</dt><dd>{to.join(', ')}</dd>
          {cc.length > 0 && <><dt>Cc</dt><dd>{cc.join(', ')}</dd></>}
          <dt>Subject</dt><dd>{p.subject}</dd>
        </dl>
        <pre className="mail-preview">{p.body}</pre>
        {p.thread_id && <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>Sent as a reply in your existing thread.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions"><button onClick={() => setConfirming(false)} disabled={busy}>Cancel</button><button className="primary" onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send email'}</button></div>
      </Modal>
    </div>
  );
}

async function projectId(d: ExecutionDetail): Promise<string> {
  const m = await api<{ projectId: string }>(`/meetings/${d.meetingId}`);
  return m.projectId;
}
