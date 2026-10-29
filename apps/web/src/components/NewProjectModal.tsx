import { FormEvent, useEffect, useRef, useState } from 'react';
import type { Project } from '@meetpilot/shared';
import { api } from '../lib/api';

export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [shareWorkspace, setShare] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onCreated(await api<Project>('/projects', { method: 'POST', json: { name, description: description || undefined, shareWorkspace } }));
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="card modal" role="dialog" aria-modal="true" aria-labelledby="np-title"
        onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 id="np-title">New project</h2>
        <label htmlFor="np-name">Name</label>
        <input id="np-name" ref={first} value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="np-desc">Description</label>
        <textarea id="np-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        <label className="row" style={{ color: 'var(--text)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={shareWorkspace} onChange={(e) => setShare(e.target.checked)} />
          Share workspace with project members
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim()}>Create</button>
        </div>
      </form>
    </div>
  );
}
