import { AlertTriangle, ExternalLink, GitBranch, KeyRound, Lock, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { MAX_PROJECT_REPOS, type GithubStatus, type Project, type ProjectRepo } from '@meetpilot/shared';
import { api } from '../lib/api';
import { toast, useConfirm } from '../ui';

/** GitHub repositories the owner links to the project. For a code task the agent first picks the right one from this list. */
export function ProjectRepos({ project }: { project: Project }) {
  const owner = project.role === 'owner';
  const confirmDialog = useConfirm();
  const [repos, setRepos] = useState<ProjectRepo[] | null>(null);
  const [gh, setGh] = useState<GithubStatus>({ connected: false, account: null });
  const [url, setUrl] = useState('');
  const [desc, setDesc] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(() => {
    void api<ProjectRepo[]>(`/projects/${project.id}/repos`).then(setRepos).catch(() => setRepos([]));
    void api<GithubStatus>(`/projects/${project.id}/github`).then(setGh).catch(() => undefined);
  }, [project.id]);
  useEffect(() => { setRepos(null); load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setError('');
    try { await fn(); if (ok) toast.success(ok); load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const add = () => act(async () => { await api(`/projects/${project.id}/repos`, { method: 'POST', json: { url, description: desc || undefined } }); setUrl(''); setDesc(''); }, 'Repository linked');
  const connect = () => act(async () => { await api(`/projects/${project.id}/github`, { method: 'PUT', json: { token } }); setToken(''); }, 'GitHub connected');
  const disconnect = async () => { if (await confirmDialog({ title: 'Disconnect GitHub?', message: 'The stored token is deleted. Public repositories keep working; private ones and pull requests will not.', confirmLabel: 'Disconnect', danger: true })) void act(() => api(`/projects/${project.id}/github`, { method: 'DELETE' }), 'GitHub disconnected'); };
  const remove = async (r: ProjectRepo) => { if (await confirmDialog({ title: `Remove ${r.fullName}?`, message: 'Agents will no longer consider this repository. Nothing on GitHub changes.', confirmLabel: 'Remove', danger: true })) void act(() => api(`/projects/${project.id}/repos/${r.id}`, { method: 'DELETE' })); };
  const saveDesc = (r: ProjectRepo) => act(async () => { await api(`/projects/${project.id}/repos/${r.id}`, { method: 'PATCH', json: { description: draft } }); setEditing(null); });

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 className="row" style={{ gap: 8, margin: '0 0 6px' }}><GitBranch size={17} /> Code repositories</h3>
      <p className="muted" style={{ margin: '0 0 12px' }}>GitHub repositories the Code agent may work on. For a code task it first picks the right one from this list; a short description from you makes that choice far more reliable. Nothing is changed on GitHub without your approval.</p>

      {repos === null ? <p className="muted">Loading…</p> : repos.length === 0 ? <p className="faint">No repositories linked yet.</p> : (
        <div className="stack" style={{ gap: 8 }}>
          {repos.map((r) => (
            <div key={r.id} className="row" style={{ gap: 10, alignItems: 'flex-start', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <a href={r.url} target="_blank" rel="noreferrer noopener"><strong>{r.fullName}</strong> <ExternalLink size={13} style={{ verticalAlign: -1 }} /></a>
                  {r.language && <span className="status">{r.language}</span>}
                  <span className="faint" title="Default branch" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }}>{r.defaultBranch}</span>
                  {r.isPrivate && <span className="status"><Lock size={11} style={{ verticalAlign: -1 }} /> private</span>}
                  {gh.connected && !r.canPush && <span className="status status-failed" title="The token can read this repository but not push; pull requests cannot be opened."><AlertTriangle size={11} style={{ verticalAlign: -1 }} /> read-only</span>}
                </div>
                {editing === r.id ? (
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <input value={draft} maxLength={300} onChange={(e) => setDraft(e.target.value)} aria-label="Repository description" placeholder="What is this repository for?" style={{ flex: 1 }} />
                    <button className="mini" disabled={busy} onClick={() => saveDesc(r)}>Save</button><button className="mini" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                ) : (
                  <div className="muted" style={{ marginTop: 4 }}>
                    {r.description ?? <span className="faint">{r.githubDescription ?? 'No description'}{owner ? ' — add yours to help the agent choose' : ''}</span>}
                    {owner && <button className="ghost icon" style={{ marginLeft: 4 }} aria-label={`Edit description of ${r.fullName}`} onClick={() => { setEditing(r.id); setDraft(r.description ?? ''); }}><Pencil size={13} /></button>}
                  </div>
                )}
              </div>
              {owner && (
                <div className="row" style={{ gap: 2 }}>
                  <button className="ghost icon" disabled={busy} aria-label={`Refresh ${r.fullName}`} title="Refresh from GitHub" onClick={() => act(() => api(`/projects/${project.id}/repos/${r.id}/reindex`, { method: 'POST' }), 'Refreshed')}><RefreshCw size={15} /></button>
                  <button className="ghost icon" disabled={busy} aria-label={`Remove ${r.fullName}`} onClick={() => remove(r)}><Trash2 size={15} /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {owner && (repos?.length ?? 0) < MAX_PROJECT_REPOS && (
        <div className="stack" style={{ gap: 8, marginTop: 14 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="GitHub repository link" placeholder="https://github.com/owner/repository" style={{ flex: '2 1 260px' }} onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) void add(); }} />
            <input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} aria-label="Short description" placeholder="What it is for (optional)" style={{ flex: '2 1 220px' }} />
            <button className="primary" disabled={busy || !url.trim()} onClick={add}><Plus size={15} /> Add repository</button>
          </div>
        </div>
      )}
      {error && <p className="error" role="alert" style={{ margin: '8px 0 0' }}>{error}</p>}

      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <div className="row" style={{ gap: 8 }}><KeyRound size={16} /> <strong>GitHub access</strong>
          <span className="faint">{gh.connected ? `Connected as ${gh.account}` : 'Not connected: public repositories only'}</span></div>
        {owner ? (
          <>
            <p className="muted" style={{ margin: '6px 0 8px' }}>Private repositories and pull requests need a fine-grained personal access token limited to the repositories above. Read access is enough for agents to read and test code; <strong>Contents</strong> and <strong>Pull requests</strong> write access is needed only to open pull requests. The token is stored encrypted and is never shown again.</p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} aria-label="GitHub token" placeholder={gh.connected ? 'Replace the token' : 'github_pat_…'} style={{ flex: '2 1 260px' }} />
              <button disabled={busy || token.trim().length < 20} onClick={connect}>{gh.connected ? 'Replace token' : 'Connect GitHub'}</button>
              {gh.connected && <button className="ghost" disabled={busy} onClick={disconnect}>Disconnect</button>}
            </div>
          </>
        ) : <p className="muted" style={{ margin: '6px 0 0' }}>Only the project owner can change repositories or GitHub access.</p>}
      </div>
    </div>
  );
}
