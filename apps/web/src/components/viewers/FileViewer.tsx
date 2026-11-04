import { Download, FileText } from 'lucide-react';
import { useState } from 'react';
import { fetchBlob } from '../../lib/api';

const OWN_FILE = /^\/artifacts\/[0-9a-f-]{36}\/file$/;

/** A generated file that is not a PDF (a static site as a zip): its contents list and an authenticated download. Never rendered or executed here. */
export function FileViewer({ title, payload }: { title: string | null; payload: Record<string, any> | null }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const url = typeof payload?.url === 'string' && OWN_FILE.test(payload.url) ? payload.url : null;
  const files: { path: string; size: number }[] = Array.isArray(payload?.files) ? payload.files.filter((f: any) => typeof f?.path === 'string') : [];
  const name = String(payload?.filename ?? 'download.zip');
  if (!url) return <p className="muted">{title ?? 'This file'} is not available yet.</p>;
  const download = async () => {
    setBusy(true); setError('');
    try {
      const blob = await fetchBlob(url);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="row" style={{ gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <button onClick={download} disabled={busy}><Download size={15} /> {busy ? 'Downloading…' : `Download ${name}`}</button>
        <span className="faint">{payload?.kind === 'deck' ? `${payload.slides} slides` : `${files.length} file${files.length === 1 ? '' : 's'}`}{typeof payload?.size === 'number' ? ` · ${(payload.size / 1024).toFixed(1)} KB` : ''}{payload?.kind === 'site' ? ' · unzip and open index.html' : ''}{payload?.kind === 'deck' ? ' · editable in PowerPoint, Keynote or Google Slides' : ''}</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Files in the download">
        {files.map((f) => (
          <li key={f.path} className="row" style={{ gap: 8, padding: '4px 0', justifyContent: 'space-between' }}>
            <span><FileText size={14} style={{ verticalAlign: -2, marginRight: 6 }} /><code>{f.path}</code></span>
            <span className="faint">{f.size} B</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
