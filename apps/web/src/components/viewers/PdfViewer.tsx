import { Download, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchBlob } from '../../lib/api';

/** Where the bytes come from: our own file route, or an https link. Anything else is refused. */
export const pdfSource = (uri: string | null | undefined, path?: unknown): { kind: 'api' | 'link'; value: string } | null => {
  const v = typeof path === 'string' && path ? path : uri;
  if (!v) return null;
  if (/^\/artifacts\/[0-9a-f-]{36}\/file$/.test(v)) return { kind: 'api', value: v };
  return /^https:\/\//i.test(v) ? { kind: 'link', value: v } : null;
};

/** PDFs open inside the site (the browser's own viewer) with open-in-tab and download. Our own files are fetched with the user's identity. */
export function PdfViewer({ title, uri, payload }: { title: string | null; uri: string | null; payload: Record<string, any> | null }) {
  const src = pdfSource(uri, payload?.url);
  const [url, setUrl] = useState<string | null>(src?.kind === 'link' ? src.value : null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!src || src.kind !== 'api') return;
    let gone = false, made = '';
    fetchBlob(src.value).then((b) => { if (!gone) { made = URL.createObjectURL(new Blob([b], { type: 'application/pdf' })); setUrl(made); } }).catch((e) => setError((e as Error).message));
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [src?.kind, src?.value]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!src) return <p className="muted">This PDF is not available yet.</p>;
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!url) return <p className="muted"><span className="spinner" /> Loading the PDF…</p>;
  const name = String(payload?.filename ?? `${(title ?? 'document').replace(/\W+/g, '-')}.pdf`);
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <a className="mini-link" href={url} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} /> Open in a new tab</a>
        <a className="mini-link" href={url} download={name}><Download size={14} /> Download</a>
        {typeof payload?.pages === 'number' && <span className="faint">{payload.pages} page{payload.pages === 1 ? '' : 's'}{typeof payload?.size === 'number' ? ` · ${(payload.size / 1024).toFixed(0)} KB` : ''}</span>}
        {payload?.attachable === true && <span className="faint">· ready to attach to an email</span>}
      </div>
      <iframe title={title ?? 'PDF'} src={`${url}#toolbar=1&view=FitH`} className="frame" style={{ height: '75vh' }} />
    </div>
  );
}
