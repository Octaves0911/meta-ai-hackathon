import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ConnectionView } from '@meetpilot/shared';
import { api } from '../lib/api';

const ERRORS: Record<string, string> = {
  cancelled: 'Google sign-in was cancelled.', invalid_state: 'The sign-in link expired. Please try again.', oauth_failed: 'Google did not accept the sign-in. Please try again.',
  not_configured: 'Google is not configured on this server yet (ask the admin to set the Google credentials).', failed: 'Connecting failed. Please try again.',
};
const NAME = { gmail: 'Gmail', drive: 'Google Drive' } as const;
const STATUS: Record<string, string> = { needs_setup: 'Choose what to sync', connected: 'Connected', syncing: 'Syncing…', error: 'Needs attention' };

export function IntegrationsPanel({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const [conns, setConns] = useState<ConnectionView[] | null>(null);
  const [services, setServices] = useState<{ gmail: boolean; drive: boolean }>({ gmail: true, drive: true });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmShare, setConfirmShare] = useState<ConnectionView | null>(null);

  const load = useCallback(() => api<ConnectionView[]>(`/projects/${projectId}/connections`).then(setConns).catch((e) => setError(e.message)), [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!conns?.some((c) => c.status === 'syncing')) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [conns, load]);

  const banner = params.get('connected') ? { ok: true, text: 'Google connected. Choose below what to sync — nothing is read until you do.' }
    : params.get('error') ? { ok: false, text: ERRORS[params.get('error')!] ?? ERRORS.failed } : null;

  const connect = async () => {
    const picked = (Object.keys(services) as ('gmail' | 'drive')[]).filter((s) => services[s]);
    if (!picked.length) return setError('Pick Gmail, Drive or both.');
    setBusy(true); setError('');
    try { const r = await api<{ url: string }>(`/projects/${projectId}/connections/google/start`, { method: 'POST', json: { services: picked, visibility: 'private' } }); window.location.href = r.url; }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };

  const act = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="card"><strong>Your data stays yours.</strong>
        <p className="muted" style={{ margin: '4px 0 0' }}>MeetPilot asks for read-only access. Nothing is read until you choose labels or folders, and every source is <strong>only visible to you</strong> unless you share it.
          Disconnecting revokes Google’s access and deletes everything indexed from it.</p></div>
      {banner && <div className={banner.ok ? 'note-inline' : 'card'} role={banner.ok ? 'status' : 'alert'} style={{ marginTop: 12 }}>{banner.text} <button className="mini" onClick={() => setParams({})}>Dismiss</button></div>}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="card" style={{ marginTop: 12 }}>
        <h3>Connect Google</h3>
        <div className="row" style={{ marginBottom: 8 }}>
          {(['gmail', 'drive'] as const).map((s) => (
            <label key={s} className="row" style={{ color: 'var(--text)', margin: 0 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={services[s]} onChange={(e) => setServices({ ...services, [s]: e.target.checked })} /> {NAME[s]}
            </label>
          ))}
        </div>
        <button className="primary" onClick={connect} disabled={busy}>Connect Google</button>
      </div>

      <h3 style={{ margin: '20px 0 8px' }}>Connections</h3>
      {conns === null ? <p className="muted">Loading…</p> : conns.length === 0 ? <div className="card"><p className="muted">No sources connected yet.</p></div> : (
        <div style={{ display: 'grid', gap: 12 }}>
          {conns.map((c) => (
            <ConnectionCard key={c.id} c={c} reload={load} act={act}
              onShare={() => setConfirmShare(c)} />
          ))}
        </div>
      )}

      {confirmShare && (
        <div className="modal-backdrop" onMouseDown={() => setConfirmShare(null)}>
          <div className="card modal" role="dialog" aria-modal="true" aria-labelledby="share-title" onMouseDown={(e) => e.stopPropagation()}>
            <h2 id="share-title">Share {NAME[confirmShare.provider]} with this project?</h2>
            <p>Everyone in the project will be able to see snippets of your <strong>{confirmShare.provider === 'gmail' ? 'selected mail' : 'selected files'}</strong> in meetings, chat and assistant answers — including the senders and subjects. You can make it private again at any time.</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmShare(null)}>Keep private</button>
              <button className="primary" onClick={() => { const c = confirmShare; setConfirmShare(null); void act(() => api(`/connections/${c.id}`, { method: 'PUT', json: { visibility: 'project', confirmShare: true } })); }}>Share with project</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectionCard({ c, reload, act, onShare }: { c: ConnectionView; reload: () => Promise<unknown>; act: (fn: () => Promise<unknown>) => Promise<void>; onShare: () => void }) {
  const [open, setOpen] = useState(c.status === 'needs_setup');
  const shared = c.visibility === 'project';
  return (
    <article className="card" aria-label={`${NAME[c.provider]} connection`}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
        <div>
          <strong>{c.provider === 'gmail' ? '✉️' : '📁'} {NAME[c.provider]}</strong> <span className="muted">· {c.account ?? 'account'}{!c.isOwner && ` · shared by ${c.ownerName}`}</span>
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            {c.itemCount} item{c.itemCount === 1 ? '' : 's'} indexed · {c.lastSyncAt ? `last sync ${new Date(c.lastSyncAt).toLocaleString()}` : 'not synced yet'}
          </div>
        </div>
        <div className="row">
          <span className="badge" title={shared ? 'Visible to everyone in this project' : 'Only you can see this'}>{shared ? '👥 Everyone in this project' : '🔒 Only me'}</span>
          <span className={`status status-${c.status === 'error' ? 'failed' : c.status === 'connected' ? 'approved' : 'running'}`}>{STATUS[c.status] ?? c.status}</span>
        </div>
      </div>
      {c.lastError && <p className="error" role="alert">{c.lastError}</p>}
      {c.isOwner && (
        <>
          <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button className="mini" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide settings' : 'What to sync'}</button>
            <button className="mini" disabled={c.status === 'needs_setup' || c.status === 'syncing'} onClick={() => act(() => api(`/connections/${c.id}/sync`, { method: 'POST' }))}>Sync now</button>
            {shared ? <button className="mini" onClick={() => act(() => api(`/connections/${c.id}`, { method: 'PUT', json: { visibility: 'private' } }))}>Make private</button>
              : <button className="mini" onClick={onShare}>Share with project…</button>}
            <button className="mini danger" onClick={() => { if (confirm(`Disconnect ${NAME[c.provider]}? Google access is revoked and everything indexed from it is deleted.`)) void act(() => api(`/connections/${c.id}`, { method: 'DELETE' })); }}>Disconnect</button>
          </div>
          {open && (c.provider === 'gmail' ? <GmailSettings c={c} onSaved={reload} /> : <DriveSettings c={c} onSaved={reload} />)}
        </>
      )}
    </article>
  );
}

function GmailSettings({ c, onSaved }: { c: ConnectionView; onSaved: () => Promise<unknown> }) {
  const [labels, setLabels] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState<string[]>(c.config.labels);
  const [days, setDays] = useState(c.config.lookbackDays);
  const [msg, setMsg] = useState('');
  useEffect(() => { api<{ id: string; name: string }[]>(`/connections/${c.id}/gmail/labels`).then(setLabels).catch((e) => setMsg(e.message)); }, [c.id]);
  const save = async () => {
    setMsg('');
    try { await api(`/connections/${c.id}`, { method: 'PUT', json: { labels: picked, lookbackDays: days } }); setMsg('Saved — syncing…'); await onSaved(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <fieldset className="settings">
      <legend>Gmail labels to sync</legend>
      <div className="label-grid">
        {labels.map((l) => (
          <label key={l.id} className="row" style={{ color: 'var(--text)', margin: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={picked.includes(l.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, l.id] : picked.filter((x) => x !== l.id))} /> {l.name}
          </label>
        ))}
      </div>
      <label htmlFor={`days-${c.id}`}>Look back <strong>{days}</strong> days</label>
      <input id={`days-${c.id}`} type="range" min={7} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} />
      <div className="row" style={{ marginTop: 8 }}><button className="primary" disabled={picked.length === 0} onClick={save}>Save and sync</button><span className="muted">{msg}</span></div>
    </fieldset>
  );
}

function DriveSettings({ c, onSaved }: { c: ConnectionView; onSaved: () => Promise<unknown> }) {
  const [path, setPath] = useState<{ id: string; name: string }[]>([{ id: 'root', name: 'My Drive' }]);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState<{ id: string; name: string }[]>(c.config.folderIds.map((id) => ({ id, name: id })));
  const [sub, setSub] = useState(c.config.includeSubfolders);
  const [msg, setMsg] = useState('');
  const here = path[path.length - 1];
  useEffect(() => {
    api<{ id: string; name: string }[]>(`/connections/${c.id}/drive/folders?parent=${encodeURIComponent(here.id)}`).then(setFolders).catch((e) => setMsg(e.message));
  }, [c.id, here.id]);
  const save = async () => {
    setMsg('');
    try { await api(`/connections/${c.id}`, { method: 'PUT', json: { folderIds: picked.map((p) => p.id), includeSubfolders: sub } }); setMsg('Saved — syncing…'); await onSaved(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <fieldset className="settings">
      <legend>Drive folders to sync</legend>
      <nav aria-label="Folder path" className="muted" style={{ marginBottom: 6 }}>
        {path.map((p, i) => <span key={p.id}>{i > 0 && ' / '}<button className="mini" onClick={() => setPath(path.slice(0, i + 1))}>{p.name}</button></span>)}
      </nav>
      {folders.length === 0 && <p className="muted">No folders here.</p>}
      {folders.map((f) => (
        <div key={f.id} className="row" style={{ margin: '2px 0' }}>
          <input type="checkbox" style={{ width: 'auto' }} aria-label={`Sync ${f.name}`} checked={picked.some((p) => p.id === f.id)}
            onChange={(e) => setPicked(e.target.checked ? [...picked, f] : picked.filter((p) => p.id !== f.id))} />
          <button className="mini" onClick={() => setPath([...path, f])}>📁 {f.name} ›</button>
        </div>
      ))}
      {picked.length > 0 && <p className="muted" style={{ fontSize: 13 }}>Selected: {picked.map((p) => p.name).join(', ')}</p>}
      <label className="row" style={{ color: 'var(--text)' }}><input type="checkbox" style={{ width: 'auto' }} checked={sub} onChange={(e) => setSub(e.target.checked)} /> Include sub-folders</label>
      <div className="row" style={{ marginTop: 8 }}><button className="primary" disabled={picked.length === 0} onClick={save}>Save and sync</button><span className="muted">{msg}</span></div>
    </fieldset>
  );
}
