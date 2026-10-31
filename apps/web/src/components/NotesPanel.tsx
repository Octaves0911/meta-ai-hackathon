import { Lock, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PersonalNote } from '@meetpilot/shared';
import { api } from '../lib/api';

export function NotesPanel({ meetingId }: { meetingId: string }) {
  const [body, setBody] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<PersonalNote>(`/meetings/${meetingId}/notes`).then((n) => { setBody(n.body); setSaved(n.updatedAt); }).catch((e) => setError(e.message));
  }, [meetingId]);

  const save = async () => {
    setError('');
    try {
      const n = await api<PersonalNote>(`/meetings/${meetingId}/notes`, { method: 'PUT', json: { body } });
      setSaved(n.updatedAt); setDirty(false);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="panel-col" style={{ padding: 8 }}>
      <p className="faint" style={{ margin: '4px 0 10px', fontSize: 13 }}><Lock size={13} style={{ verticalAlign: -2 }} /> Private. Only you can see these notes.</p>
      <textarea placeholder="Jot down anything you want to remember…" style={{ flex: 1, resize: 'none' }} value={body} aria-label="Personal notes"
        onChange={(e) => { setBody(e.target.value); setDirty(true); }} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
        <span className="faint" style={{ fontSize: 13 }}>{dirty ? 'Unsaved changes' : saved ? `Saved ${new Date(saved).toLocaleTimeString()}` : 'Not saved yet'}</span>
        <button className="primary" onClick={save} disabled={!dirty}>Save</button>
      </div>
    </div>
  );
}
