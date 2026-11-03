import { Palette, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MAX_BRAND_NOTE, type Project } from '@meetpilot/shared';
import { api } from '../lib/api';
import { toast } from '../ui';

/** Owner settings for the agents: no web lookups, and the brand and voice note Marketing, Communication and Designer always follow. */
export function AgentPrivacy({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(project.brandNote ?? '');
  useEffect(() => { setNote(project.brandNote ?? ''); }, [project.id, project.brandNote]);
  const owner = project.role === 'owner';
  const patch = async (json: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try { await api(`/projects/${project.id}/settings`, { method: 'PATCH', json }); toast.success(ok); onChanged(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const dirty = note.trim() !== (project.brandNote ?? '').trim();
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 className="row" style={{ gap: 8, margin: '0 0 6px' }}><ShieldCheck size={17} /> Agent settings</h3>
      <label className="row" style={{ gap: 10, color: 'var(--text)', alignItems: 'flex-start' }}>
        <input type="checkbox" style={{ width: 'auto', marginTop: 4 }} checked={project.noExternalLookups} disabled={!owner || busy}
          onChange={(e) => patch({ noExternalLookups: e.target.checked }, e.target.checked ? 'Agents will not search the web for this project' : 'Agents may search the web again')} />
        <span><strong>No external lookups</strong><br /><span className="muted">Agents will not search the web for tasks in this project. Research uses only what is already in the project. Search queries never include people&rsquo;s names, emails or internal figures either way.</span></span>
      </label>
      <div style={{ marginTop: 16 }}>
        <label htmlFor="brand-note" className="row" style={{ gap: 8, color: 'var(--text)' }}><Palette size={16} /> <strong>Brand and voice</strong></label>
        <p className="muted" style={{ margin: '4px 0 8px' }}>A short note the Marketing, Communication and Designer agents always follow: tone, words to use or avoid, what the product stands for.</p>
        <textarea id="brand-note" rows={4} maxLength={MAX_BRAND_NOTE} value={note} disabled={!owner || busy} onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Friendly and plain. Say “teams”, never “users”. No exclamation marks. We are the calm alternative to noisy tools." />
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
          <span className="faint" style={{ fontSize: 13 }}>{note.length} / {MAX_BRAND_NOTE}{!owner && ' · only the project owner can edit this'}</span>
          {owner && <button disabled={busy || !dirty} onClick={() => patch({ brandNote: note.trim() || null }, note.trim() ? 'Brand note saved' : 'Brand note cleared')}>Save brand note</button>}
        </div>
      </div>
    </div>
  );
}
