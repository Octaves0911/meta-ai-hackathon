import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { Project } from '@meetpilot/shared';
import { api } from '../lib/api';
import { toast } from '../ui';

/** Owner switch: when on, agents never search the web for this project (Research then uses project context only). */
export function AgentPrivacy({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const owner = project.role === 'owner';
  const toggle = async (v: boolean) => {
    setBusy(true);
    try { await api(`/projects/${project.id}/settings`, { method: 'PATCH', json: { noExternalLookups: v } }); toast.success(v ? 'Agents will not search the web for this project' : 'Agents may search the web again'); onChanged(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 className="row" style={{ gap: 8, margin: '0 0 6px' }}><ShieldCheck size={17} /> Agent privacy</h3>
      <label className="row" style={{ gap: 10, color: 'var(--text)', alignItems: 'flex-start' }}>
        <input type="checkbox" style={{ width: 'auto', marginTop: 4 }} checked={project.noExternalLookups} disabled={!owner || busy} onChange={(e) => toggle(e.target.checked)} />
        <span><strong>No external lookups</strong><br /><span className="muted">Agents will not search the web for tasks in this project. Research uses only what is already in the project. Search queries never include people&rsquo;s names, emails or internal figures either way.{!owner && ' Only the project owner can change this.'}</span></span>
      </label>
    </div>
  );
}
