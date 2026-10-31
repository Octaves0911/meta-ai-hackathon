import { FormEvent, useEffect, useState } from 'react';
import type { Meeting, User } from '@meetpilot/shared';
import { api, useSession } from '../lib/api';
import { Avatar, Modal } from '../ui';

export function NewMeetingModal({ projectId, onClose, onCreated }: { projectId: string; onClose: () => void; onCreated: (m: Meeting) => void }) {
  const { user } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [when, setWhen] = useState('');
  const [invitees, setInvitees] = useState<string[]>([]);
  const [shareChat, setShareChat] = useState(false);
  const [shareWs, setShareWs] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<User[]>('/users').then((l) => setUsers(l.filter((u) => u.id !== user?.id))); }, [user]);
  const toggle = (id: string) => setInvitees((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      onCreated(await api<Meeting>(`/projects/${projectId}/meetings`, { method: 'POST', json: {
        title, description: description || undefined, scheduledAt: when ? new Date(when).toISOString() : undefined,
        inviteeIds: invitees, shareChatTranscript: shareChat, shareWorkspace: shareWs } }));
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title="New meeting" description="Start an instant call, or schedule one and invite your team.">
      <form onSubmit={submit}>
        <label htmlFor="nm-t">Title</label>
        <input id="nm-t" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Sprint sync" />
        <label htmlFor="nm-d">Description <span className="faint">(optional)</span></label>
        <textarea id="nm-d" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <label htmlFor="nm-w">Schedule <span className="faint">(leave empty for an instant call)</span></label>
        <input id="nm-w" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <fieldset style={{ border: 0, padding: 0, margin: '14px 0 0' }}>
          <legend style={{ fontSize: 13, fontWeight: 550, color: 'var(--text-2)', marginBottom: 6 }}>Invite people</legend>
          {users.length === 0 && <p className="muted" style={{ margin: 0 }}>No other users yet.</p>}
          <div className="stack" style={{ gap: 4 }}>
            {users.map((u) => (
              <label key={u.id} className="check" style={{ margin: 0, padding: '6px 8px', borderRadius: 8, background: invitees.includes(u.id) ? 'var(--accent-soft)' : 'transparent' }}>
                <input type="checkbox" checked={invitees.includes(u.id)} onChange={() => toggle(u.id)} /><Avatar name={u.username} size="sm" /> {u.username}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="check"><input type="checkbox" checked={shareChat} onChange={(e) => setShareChat(e.target.checked)} /> Share chat and transcript with invitees</label>
        <label className="check"><input type="checkbox" checked={shareWs} onChange={(e) => setShareWs(e.target.checked)} /> Let invitees view the project workspace</label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!title.trim() || busy}>{when ? 'Schedule meeting' : 'Start now'}</button></div>
      </form>
    </Modal>
  );
}
