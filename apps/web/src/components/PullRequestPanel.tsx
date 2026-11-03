import { AlertTriangle, CheckCircle2, ExternalLink, GitPullRequest, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ExecutionDetail } from '@meetpilot/shared';
import { api, useSession } from '../lib/api';
import { Modal, toast } from '../ui';

/** After approval, a verified code change can become a pull request: every condition is shown, and opening it is a deliberate, confirmed click. */
export function PullRequestPanel({ d, onDone }: { d: ExecutionDetail; onDone: () => Promise<unknown> | void }) {
  const pr = d.pr;
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (pr && !open) { setTitle(pr.defaultTitle); setBody(pr.defaultBody); setError(''); } }, [pr?.defaultTitle, pr?.defaultBody, open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pr || (d.status !== 'approved' && !pr.pullRequest)) return null;

  const created = pr.pullRequest;
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ number: number; url: string }>(`/executions/${d.id}/pr`, { method: 'POST', json: { confirm: true, draft, title: title.trim() || undefined, body } });
      toast.success(`Pull request #${r.number} opened`); setOpen(false); await onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 className="row" style={{ gap: 8, margin: '0 0 8px' }}><GitPullRequest size={17} /> Pull request</h3>
      {created ? (
        created.status === 'open' ? (
          <p className="note-inline success" role="status"><CheckCircle2 size={17} style={{ flex: 'none', marginTop: 2 }} />
            <span>{created.draft ? 'Draft pull request' : 'Pull request'} <a href={created.url ?? '#'} target="_blank" rel="noreferrer noopener"><strong>#{created.number}</strong> <ExternalLink size={13} style={{ verticalAlign: -1 }} /></a> opened from <code>{created.branch}</code> into <code>{created.baseBranch}</code> on {new Date(created.createdAt).toLocaleString()}. Nothing was merged.</span></p>
        ) : (
          <p className="note-inline" role="alert"><AlertTriangle size={17} style={{ flex: 'none', marginTop: 2 }} /><span>We couldn&rsquo;t confirm whether the pull request was opened. Check <strong>{pr.repo}</strong> on GitHub (branch <code>{created.branch}</code>) before trying again.</span></p>
        )
      ) : (
        <>
          <p className="muted" style={{ margin: '0 0 10px' }}>A pull request is only offered for changes you approved that passed verification in the sandbox. It never pushes to <code>{pr.baseBranch ?? 'the default branch'}</code>, never force-pushes, and never merges.</p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }} aria-label="Pull request checks">
            {pr.checks.map((c) => (
              <li key={c.key} className="row" style={{ gap: 8, alignItems: 'flex-start', padding: '3px 0' }}>
                <span style={{ paddingTop: 2 }}>{c.ok ? <CheckCircle2 size={15} color="var(--success)" /> : <XCircle size={15} color="var(--danger)" />}</span>
                <span>{c.label}{c.detail && <span className="muted" style={{ display: 'block', fontSize: 13 }}>{c.detail}</span>}</span>
              </li>
            ))}
          </ul>
          {d.reviewer && (
            <button className="primary" disabled={!pr.allowed || !d.reviewer || d.reviewer.username !== user?.username} onClick={() => setOpen(true)} title={pr.allowed ? undefined : 'Every check above must pass first'}><GitPullRequest size={15} /> Open pull request…</button>
          )}
        </>
      )}

      <Modal open={open} onClose={() => !busy && setOpen(false)} title="Open this pull request?" description="This creates a new branch on GitHub and opens a pull request. Check what will be written." wide>
        <dl className="kv" style={{ gridTemplateColumns: '110px 1fr', gap: '8px 12px', margin: '10px 0' }}>
          <dt>Repository</dt><dd>{pr.repo}</dd>
          <dt>Into branch</dt><dd><code>{pr.baseBranch}</code></dd>
          <dt>New branch</dt><dd><code>{pr.branch}</code></dd>
          <dt>Files</dt><dd>{pr.files.map((f) => <div key={f.path}><code>{f.path}</code> <span className="faint">{f.status} · +{f.additions} −{f.deletions}</span></div>)}</dd>
        </dl>
        <label htmlFor="pr-title">Title</label>
        <input id="pr-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="pr-body" style={{ marginTop: 10 }}>Description</label>
        <textarea id="pr-body" rows={9} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
        <p className="faint" style={{ fontSize: 12.5, margin: '4px 0 8px' }}>The description is public if the repository is. It contains nothing from the meeting unless you add it.</p>
        <label className="check"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Open as a draft</label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions"><button onClick={() => setOpen(false)} disabled={busy}>Cancel</button><button className="primary" onClick={submit} disabled={busy || !title.trim()}>{busy ? 'Opening…' : 'Open pull request'}</button></div>
      </Modal>
    </div>
  );
}
