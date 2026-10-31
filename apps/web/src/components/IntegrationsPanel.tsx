import { Check, FolderOpen, HardDrive, Lock, Mail, RefreshCw, ShieldCheck, Trash2, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ConnectionView } from '@meetpilot/shared';
import { api } from '../lib/api';
import { Modal, toast, useConfirm } from '../ui';

const ERRORS: Record<string, string> = {
  cancelled: 'Google sign-in was cancelled.', invalid_state: 'The sign-in link expired. Please try again.', oauth_failed: 'Google did not accept the sign-in. Please try again.',
  not_configured: 'Google is not configured on this server yet (ask the admin to set the Google credentials).', failed: 'Connecting failed. Please try again.',
};
const NAME = { gmail: 'Gmail', drive: 'Google Drive' } as const;
const LOGO = { gmail: Mail, drive: HardDrive } as const;
const STATUS: Record<string, string> = { needs_setup: 'Choose what to sync', connected: 'Connected', syncing: 'Syncing…', error: 'Needs attention' };

export function IntegrationsPanel({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const [conns, setConns] = useState<ConnectionView[] | null>(null);
  const [services, setServices] = useState<{ gmail: boolean; drive: boolean }>({ gmail: true, drive: true });
  const [busy, setBusy] = useState(false);
  const [confirmShare, setConfirmShare] = useState<ConnectionView | null>(null);

  const load = useCallback(() => api<ConnectionView[]>(`/projects/${projectId}/connections`).then(setConns).catch((e) => { toast.error(e.message); setConns([]); }), [projectId]);
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
    if (!picked.length) return toast.error('Pick Gmail, Drive or both.');
    setBusy(true);
    try { const r = await api<{ url: string }>(`/projects/${projectId}/connections/google/start`, { method: 'POST', json: { services: picked, visibility: 'private' } }); window.location.href = r.url; }
    catch (e) { toast.error((e as Error).message); setBusy(false); }
  };

  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast.success(ok); await load(); } catch (e) { toast.error((e as Error).message); } };

  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <div className="card accent">
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <ShieldCheck size={22} style={{ color: 'var(--accent-text)', flex: 'none', marginTop: 2 }} />
          <div><strong>Your data stays yours.</strong>
            <p className="muted" style={{ margin: '4px 0 0' }}>MeetPilot asks for read-only access. Nothing is read until you choose labels or folders, and every source is <strong>only visible to you</strong> unless you share it. Disconnecting revokes Google’s access and deletes everything indexed from it.</p></div>
        </div>
      </div>
      {banner && <div className={`note-inline ${banner.ok ? 'success' : ''}`} role={banner.ok ? 'status' : 'alert'}>{banner.text} <button className="link-btn" onClick={() => setParams({})}>Dismiss</button></div>}

      <div className="card">
        <h3>Connect Google</h3>
        <p className="muted">Pick what MeetPilot may read for this project. You can change this any time.</p>
        <div className="row" style={{ gap: 18, margin: '4px 0 14px' }}>
          {(['gmail', 'drive'] as const).map((k) => {
            const Icon = LOGO[k];
            return <label key={k} className="check" style={{ margin: 0, padding: '10px 14px', border: '1px solid var(--border-strong)', borderRadius: 10, background: services[k] ? 'var(--accent-soft)' : 'transparent' }}>
              <input type="checkbox" checked={services[k]} onChange={(e) => setServices({ ...services, [k]: e.target.checked })} /><Icon size={17} /> {NAME[k]}</label>;
          })}
        </div>
        <button className="primary" onClick={connect} disabled={busy}>Connect Google</button>
      </div>

      <div className="section-title" style={{ margin: '8px 0 0' }}><h3>Connections</h3></div>
      {conns === null ? <div className="card"><div className="skeleton" style={{ height: 70 }} /></div> : conns.length === 0 ? <div className="card"><div className="empty"><div className="empty-icon"><Mail size={24} /></div><h3>No sources connected</h3><p>Connect Gmail or Drive so the assistant can cite your own mail and files, privately.</p></div></div> : (
        <div className="stack">{conns.map((c) => <ConnectionCard key={c.id} c={c} reload={load} act={act} onShare={() => setConfirmShare(c)} />)}</div>
      )}

      <Modal open={!!confirmShare} onClose={() => setConfirmShare(null)} title={`Share ${confirmShare ? NAME[confirmShare.provider] : ''} with this project?`}>
        {confirmShare && <>
          <p>Everyone in the project will be able to see snippets of your <strong>{confirmShare.provider === 'gmail' ? 'selected mail' : 'selected files'}</strong> in meetings, chat and assistant answers, including senders and subjects. You can make it private again at any time.</p>
          <div className="dialog-actions">
            <button onClick={() => setConfirmShare(null)}>Keep private</button>
            <button className="primary" onClick={() => { const c = confirmShare; setConfirmShare(null); void act(() => api(`/connections/${c.id}`, { method: 'PUT', json: { visibility: 'project', confirmShare: true } }), 'Shared with the project'); }}>Share with project</button>
          </div>
        </>}
      </Modal>
    </div>
  );
}

function ConnectionCard({ c, reload, act, onShare }: { c: ConnectionView; reload: () => Promise<unknown>; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; onShare: () => void }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(c.status === 'needs_setup');
  const shared = c.visibility === 'project';
  const Icon = LOGO[c.provider];
  const statusTone = c.status === 'error' ? 'danger' : c.status === 'connected' ? 'success' : c.status === 'syncing' ? 'accent' : 'warn';
  return (
    <article className="card conn-card" aria-label={`${NAME[c.provider]} connection`}>
      <div className="head">
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <span className="conn-logo"><Icon size={20} /></span>
          <div>
            <strong>{NAME[c.provider]}</strong> <span className="muted">· {c.account ?? 'account'}{!c.isOwner && ` · shared by ${c.ownerName}`}</span>
            <div className="faint" style={{ fontSize: 13, marginTop: 2 }}>{c.itemCount} item{c.itemCount === 1 ? '' : 's'} indexed · {c.lastSyncAt ? `last sync ${new Date(c.lastSyncAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'not synced yet'}</div>
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className={`pill ${shared ? 'accent' : ''}`} title={shared ? 'Visible to everyone in this project' : 'Only you can see this'}>{shared ? <><Users size={12} /> Everyone in project</> : <><Lock size={12} /> Only me</>}</span>
          <span className={`pill ${statusTone}`}>{c.status === 'connected' && <Check size={12} />}{STATUS[c.status] ?? c.status}</span>
        </div>
      </div>
      {c.lastError && <p className="error" role="alert">{c.lastError}</p>}
      {c.isOwner && (
        <>
          <div className="row" style={{ marginTop: 14, flexWrap: 'wrap', gap: 8 }}>
            <button className="mini" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide settings' : 'What to sync'}</button>
            <button className="mini" disabled={c.status === 'needs_setup' || c.status === 'syncing'} onClick={() => act(() => api(`/connections/${c.id}/sync`, { method: 'POST' }), 'Sync started')}><RefreshCw size={13} /> Sync now</button>
            {shared ? <button className="mini" onClick={() => act(() => api(`/connections/${c.id}`, { method: 'PUT', json: { visibility: 'private' } }), 'Now private')}><Lock size={13} /> Make private</button>
              : <button className="mini" onClick={onShare}><Users size={13} /> Share with project…</button>}
            <button className="mini danger" onClick={async () => { if (await confirm({ title: `Disconnect ${NAME[c.provider]}?`, message: 'Google access is revoked and everything indexed from it is deleted.', confirmLabel: 'Disconnect', danger: true })) void act(() => api(`/connections/${c.id}`, { method: 'DELETE' }), 'Disconnected'); }}><Trash2 size={13} /> Disconnect</button>
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
          <button className="mini" onClick={() => setPath([...path, f])}><FolderOpen size={13} /> {f.name}</button>
        </div>
      ))}
      {picked.length > 0 && <p className="muted" style={{ fontSize: 13 }}>Selected: {picked.map((p) => p.name).join(', ')}</p>}
      <label className="row" style={{ color: 'var(--text)' }}><input type="checkbox" style={{ width: 'auto' }} checked={sub} onChange={(e) => setSub(e.target.checked)} /> Include sub-folders</label>
      <div className="row" style={{ marginTop: 8 }}><button className="primary" disabled={picked.length === 0} onClick={save}>Save and sync</button><span className="muted">{msg}</span></div>
    </fieldset>
  );
}
