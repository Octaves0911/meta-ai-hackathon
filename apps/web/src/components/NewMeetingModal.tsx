import { FormEvent, useEffect, useRef, useState } from 'react';
import type { Meeting, User } from '@meetpilot/shared';
import { api, useSession } from '../lib/api';

export function NewMeetingModal({ projectId, onClose, onCreated }:
  { projectId: string; onClose: () => void; onCreated: (m: Meeting) => void }) {
  const { user } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [when, setWhen] = useState('');
  const [invitees, setInvitees] = useState<string[]>([]);
  const [shareChat, setShareChat] = useState(false);
  const [shareWs, setShareWs] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    api<User[]>('/users').then((l) => setUsers(l.filter((u) => u.id !== user?.id)));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, user]);

  const toggle = (id: string) => setInvitees((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onCreated(await api<Meeting>(`/projects/${projectId}/meetings`, {
        method: 'POST',
        json: {
          title, description: description || undefined,
          scheduledAt: when ? new Date(when).toISOString() : undefined,
          inviteeIds: invitees, shareChatTranscript: shareChat, shareWorkspace: shareWs,
        },
      }));
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="card modal" role="dialog" aria-modal="true" aria-labelledby="nm-title"
        onMouseDown={(e) => e.stopPropagation()} onSubmit={submit} style={{ maxHeight: '90vh', overflow: 'auto' }}>
        <h2 id="nm-title">New meeting</h2>
        <label htmlFor="nm-t">Title</label>
        <input id="nm-t" ref={first} value={title} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="nm-d">Description</label>
        <textarea id="nm-d" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <label htmlFor="nm-w">Schedule (leave empty for an instant call)</label>
        <input id="nm-w" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <fieldset style={{ border: 0, padding: 0, margin: '12px 0 0' }}>
          <legend className="muted" style={{ fontSize: 14 }}>Invitees</legend>
          {users.length === 0 && <p className="muted">No other users yet.</p>}
          {users.map((u) => (
            <label key={u.id} className="row" style={{ color: 'var(--text)', margin: '4px 0' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={invitees.includes(u.id)} onChange={() => toggle(u.id)} />
              {u.username}
            </label>
          ))}
        </fieldset>
        <label className="row" style={{ color: 'var(--text)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={shareChat} onChange={(e) => setShareChat(e.target.checked)} />
          Share chat &amp; transcript with invitees
        </label>
        <label className="row" style={{ color: 'var(--text)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={shareWs} onChange={(e) => setShareWs(e.target.checked)} />
          Allow invitees into the project's workspace
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!title.trim()}>{when ? 'Schedule' : 'Start now'}</button>
        </div>
      </form>
    </div>
  );
}
