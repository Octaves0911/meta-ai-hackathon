import { useState } from 'react';
import type { ExecutionArtifact } from '@meetpilot/shared';
import { api } from '../../lib/api';

const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/** Editable email draft (To/Cc/Subject/Body) until the work is approved. Sending is a separate, explicit step (later release). */
export function EmailEditor({ executionId, artifact, editable, onSaved }: { executionId: string; artifact: ExecutionArtifact; editable: boolean; onSaved: () => void }) {
  const p = artifact.payload ?? {};
  const [to, setTo] = useState<string>((p.to ?? []).join(', '));
  const [cc, setCc] = useState<string>((p.cc ?? []).join(', '));
  const [subject, setSubject] = useState<string>(p.subject ?? '');
  const [body, setBody] = useState<string>(p.body ?? '');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const missing = split(to).length === 0;

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      await api(`/executions/${executionId}/artifacts/${artifact.id}`, { method: 'PUT', json: { to: split(to), cc: split(cc), subject, body } });
      setMsg('Draft saved.'); onSaved();
    } catch (e) { setMsg((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <div className="email">
      {missing && <div className="note-inline" role="status">No recipient yet — add one before this email can be sent. Addresses are never guessed.</div>}
      {!!p.open_questions?.length && <ul className="muted">{p.open_questions.map((q: string) => <li key={q}>Open question: {q}</li>)}</ul>}
      <label htmlFor="em-to">To</label><input id="em-to" value={to} onChange={(e) => setTo(e.target.value)} disabled={!editable} placeholder="name@example.com, …" />
      <label htmlFor="em-cc">Cc</label><input id="em-cc" value={cc} onChange={(e) => setCc(e.target.value)} disabled={!editable} />
      <label htmlFor="em-sub">Subject</label><input id="em-sub" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!editable} />
      <label htmlFor="em-body">Body</label><textarea id="em-body" rows={10} value={body} onChange={(e) => setBody(e.target.value)} disabled={!editable} />
      {!!p.sources?.length && <p className="muted" style={{ fontSize: 12 }}>Sources used: {p.sources.join(' · ')}</p>}
      {editable ? (
        <div className="row" style={{ marginTop: 8 }}><button onClick={save} disabled={saving}>Save draft</button><span className="muted">{msg}</span></div>
      ) : <p className="muted">The draft is locked.</p>}
    </div>
  );
}
