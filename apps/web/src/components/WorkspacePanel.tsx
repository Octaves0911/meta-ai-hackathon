import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceFile, WorkspaceInfo } from '@meetpilot/shared';
import { api, storedUser } from '../lib/api';

interface FileDetail extends WorkspaceFile { content: string | null }
interface Node { name: string; path: string; folder: boolean; file?: WorkspaceFile; children: Node[] }

const IMG = /\.(png|jpe?g|gif|webp)$/i;
const PDF = /\.pdf$/i;

function buildTree(files: WorkspaceFile[]): Node {
  const root: Node = { name: '', path: '', folder: true, children: [] };
  for (const f of files) {
    let cur = root;
    const parts = f.path.split('/');
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let next = cur.children.find((c) => c.name === part && c.folder === (i < parts.length - 1));
      if (!next) { next = { name: part, path, folder: i < parts.length - 1, file: i === parts.length - 1 ? f : undefined, children: [] }; cur.children.push(next); }
      cur = next;
    });
  }
  const sort = (n: Node) => { n.children.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name)); n.children.forEach(sort); };
  sort(root);
  return root;
}

async function fetchBlob(path: string): Promise<Blob> {
  const res = await fetch(`/api${path}`, { headers: { 'x-user': storedUser() ?? '' } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? 'download failed');
  return res.blob();
}

export function WorkspacePanel({ projectId }: { projectId: string }) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = useState<FileDetail | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [targetDir, setTargetDir] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<(WorkspaceFile & { snippet: string | null })[] | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [i, f] = await Promise.all([api<WorkspaceInfo>(`/projects/${projectId}/workspace`), api<WorkspaceFile[]>(`/projects/${projectId}/files`)]);
      setInfo(i); setFiles(f); setError('');
    } catch (e) { setError((e as Error).message); setInfo(null); setFiles([]); }
  }, [projectId]);
  useEffect(() => { setSelected(null); setResults(null); setQuery(''); void load(); }, [load]);
  // A connected local folder changes on disk; refresh the list now and then.
  useEffect(() => { if (!info?.localRoot) return; const t = setInterval(load, 5000); return () => clearInterval(t); }, [info?.localRoot, load]);

  const tree = useMemo(() => buildTree(files), [files]);
  const canWrite = info?.level === 'write';

  const open = async (f: WorkspaceFile) => {
    setMsg(''); setError('');
    try { setSelected(await api<FileDetail>(`/files/${f.id}`)); } catch (e) { setError((e as Error).message); }
  };

  const search = async (q: string) => {
    setQuery(q);
    if (!q.trim()) return setResults(null);
    try { setResults(await api(`/projects/${projectId}/files/search?q=${encodeURIComponent(q.trim())}`)); } catch (e) { setError((e as Error).message); }
  };

  const upload = async (list: FileList | File[]) => {
    const fd = new FormData();
    fd.append('dir', targetDir);
    for (const f of Array.from(list)) fd.append('files', f, f.name);
    setMsg('Uploading…'); setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/files`, { method: 'POST', headers: { 'x-user': storedUser() ?? '' }, body: fd });
      const body = await res.json();
      if (!res.ok && !body.rejected) throw new Error(body?.error?.message ?? 'upload failed');
      setMsg(`${body.uploaded.length} uploaded${body.rejected.length ? `, ${body.rejected.length} skipped: ${body.rejected.map((r: { name: string; reason: string }) => `${r.name} (${r.reason})`).join('; ')}` : ''}`);
      await load();
    } catch (e) { setError((e as Error).message); setMsg(''); }
  };

  const setSettings = async (patch: { shareWorkspace?: boolean; localRoot?: string | null }) => {
    setError('');
    try { await api(`/projects/${projectId}/workspace`, { method: 'PUT', json: patch }); await load(); } catch (e) { setError((e as Error).message); }
  };

  const rescan = async () => {
    setMsg('Scanning…');
    try { const r = await api<{ files: number; indexed: number; removed: number }>(`/projects/${projectId}/rescan`, { method: 'POST' }); setMsg(`Scanned ${r.files} files (${r.indexed} updated, ${r.removed} removed).`); await load(); }
    catch (e) { setError((e as Error).message); setMsg(''); }
  };

  const remove = async (f: WorkspaceFile) => {
    if (!confirm(`Delete ${f.path}? This removes the file and its search index.`)) return;
    try { await api(`/files/${f.id}`, { method: 'DELETE' }); if (selected?.id === f.id) setSelected(null); await load(); } catch (e) { setError((e as Error).message); }
  };

  const renderNode = (n: Node, depth: number): JSX.Element[] => n.children.map((c) => {
    if (c.folder) {
      const isCollapsed = collapsed.has(c.path);
      return (
        <div key={c.path}>
          <button className={`tree-row${targetDir === c.path ? ' target' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} aria-expanded={!isCollapsed}
            onClick={() => { setTargetDir(c.path); setCollapsed((s) => { const x = new Set(s); isCollapsed ? x.delete(c.path) : x.add(c.path); return x; }); }}>
            {isCollapsed ? '▸' : '▾'} 📁 {c.name}
          </button>
          {!isCollapsed && renderNode(c, depth + 1)}
        </div>
      );
    }
    const f = c.file!;
    return (
      <button key={c.path} className={`tree-row${selected?.id === f.id ? ' active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} title={f.summary ?? f.path} onClick={() => open(f)}>
        📄 {c.name} {f.kind === 'local' && <span className="badge">local</span>}
      </button>
    );
  });

  if (!info) return error ? <div className="card"><p role="alert" className="muted">{error}</p></div> : <p className="muted">Loading…</p>;

  return (
    <div className="ws" onDragOver={(e) => canWrite && e.preventDefault()} onDrop={(e) => { if (!canWrite) return; e.preventDefault(); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}>
      <aside className="ws-side">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <input aria-label="Search files" placeholder="Search files…" value={query} onChange={(e) => void search(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
          {canWrite && <><button className="mini" onClick={() => input.current?.click()}>Upload{targetDir ? ` to ${targetDir}/` : ''}</button>
            <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} /></>}
          {info.localRoot && canWrite && <button className="mini" onClick={rescan}>Rescan</button>}
        </div>
        {msg && <p className="muted" role="status" style={{ fontSize: 13 }}>{msg}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {info.isOwner && (
          <details className="settings" style={{ margin: '8px 0' }}>
            <summary>Workspace settings</summary>
            <label className="row" style={{ color: 'var(--text)' }}><input type="checkbox" style={{ width: 'auto' }} checked={info.shareWorkspace} onChange={(e) => setSettings({ shareWorkspace: e.target.checked })} /> Share with project members</label>
            {info.localEnabled ? (
              <>
                <label htmlFor="local-root">Local folder on the server</label>
                <select id="local-root" value={info.localRoot ?? ''} onChange={(e) => setSettings({ localRoot: e.target.value || null })}
                  style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, width: '100%' }}>
                  <option value="">None (uploaded files only)</option>
                  {info.localFolders.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </>
            ) : <p className="muted" style={{ fontSize: 13 }}>Local folders are not enabled on this server.</p>}
          </details>
        )}
        <div className="tree" role="tree" aria-label="Files">
          {results ? (
            results.length === 0 ? <p className="muted">No matches.</p> : results.map((r) => (
              <button key={r.id} className="tree-row" onClick={() => open(r)}><div><strong>{r.path}</strong>{r.snippet && <div className="muted" style={{ fontSize: 12 }}>{r.snippet}</div>}</div></button>
            ))
          ) : files.length === 0 ? <p className="muted" style={{ padding: 8 }}>No files yet. {canWrite ? 'Upload some or drop them here.' : ''}</p> : renderNode(tree, 0)}
        </div>
        {!canWrite && <p className="muted" style={{ fontSize: 12 }}>Read-only access.</p>}
      </aside>
      <section className="ws-main">
        {selected ? <Viewer key={selected.id} file={selected} canWrite={!!canWrite} onSaved={load} onDelete={() => remove(selected)} /> : <div className="card"><p className="muted">Select a file to preview or edit it.</p></div>}
      </section>
    </div>
  );
}

function Viewer({ file, canWrite, onSaved, onDelete }: { file: FileDetail; canWrite: boolean; onSaved: () => Promise<unknown>; onDelete: () => void }) {
  const [text, setText] = useState(file.content ?? '');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const isImg = IMG.test(file.path), isPdf = PDF.test(file.path), isText = file.content !== null;

  useEffect(() => {
    if (!isImg && !isPdf) return;
    let url: string | null = null, gone = false;
    fetchBlob(`/files/${file.id}/raw`).then((b) => { if (!gone) { url = URL.createObjectURL(b); setBlobUrl(url); } }).catch((e) => setStatus((e as Error).message));
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [file.id, isImg, isPdf]);

  const save = useCallback(async () => {
    setStatus('Saving…');
    try { await api(`/files/${file.id}`, { method: 'PUT', json: { content: text } }); setDirty(false); setStatus('Saved'); await onSaved(); } catch (e) { setStatus((e as Error).message); }
  }, [file.id, text, onSaved]);

  const download = async () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await fetchBlob(`/files/${file.id}/raw`)); a.download = file.path.split('/').pop() ?? 'file'; a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><strong>{file.path}</strong> <span className="muted">· {file.size ?? 0} bytes · {file.kind}</span>{file.summary && <div className="muted" style={{ fontSize: 13 }}>{file.summary}</div>}</div>
        <div className="row">
          {isText && canWrite && <button className="primary" onClick={save} disabled={!dirty}>Save</button>}
          <button onClick={download}>Download</button>
          {canWrite && file.kind === 'cloud' && <button className="danger" onClick={onDelete}>Delete</button>}
        </div>
      </div>
      {status && <span className="muted" role="status">{status}{dirty && !status.startsWith('Sav') ? '' : ''}</span>}
      {isText && <textarea className="editor" aria-label={`Contents of ${file.path}`} value={text} readOnly={!canWrite} spellCheck={false}
        onChange={(e) => { setText(e.target.value); setDirty(true); setStatus(''); }}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (dirty && canWrite) void save(); } }} />}
      {isImg && (blobUrl ? <div className="image-frame"><img src={blobUrl} alt={file.path} style={{ maxWidth: '100%' }} /></div> : <p className="muted">Loading preview…</p>)}
      {isPdf && (blobUrl ? <iframe title={file.path} src={blobUrl} className="frame" /> : <p className="muted">Loading preview…</p>)}
      {!isText && !isImg && !isPdf && <p className="muted">No preview for this file type. Use Download to open it.</p>}
      {isText && dirty && <span className="muted" style={{ fontSize: 12 }}>Unsaved changes (⌘/Ctrl+S to save)</span>}
    </div>
  );
}
