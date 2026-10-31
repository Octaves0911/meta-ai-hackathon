import { FormEvent, useState } from 'react';
import type { Project } from '@meetpilot/shared';
import { api } from '../lib/api';
import { Modal, toast } from '../ui';

export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [shareWorkspace, setShare] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const p = await api<Project>('/projects', { method: 'POST', json: { name, description: description || undefined, shareWorkspace } });
      toast.success(`Created “${p.name}”`);
      onCreated(p);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title="New project" description="A project holds meetings, files, memory and integrations.">
      <form onSubmit={submit}>
        <label htmlFor="np-name">Name</label>
        <input id="np-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Launch Q3" />
        <label htmlFor="np-desc">Description <span className="faint">(optional)</span></label>
        <textarea id="np-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about?" />
        <label className="check"><input type="checkbox" checked={shareWorkspace} onChange={(e) => setShare(e.target.checked)} /> Share the workspace with project members</label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim() || busy}>Create project</button></div>
      </form>
    </Modal>
  );
}
