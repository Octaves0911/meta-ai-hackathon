import { Download, ExternalLink } from 'lucide-react';

/** Only same-app file routes or https links can be framed; anything else is refused. */
export const safePdfSrc = (uri: string | null | undefined, path?: unknown): string | null => {
  const v = typeof path === 'string' && path ? path : uri;
  if (!v) return null;
  if (/^\/api\/[A-Za-z0-9/_\-.?=&%]+$/.test(v)) return v;
  return /^https:\/\//i.test(v) ? v : null;
};

/** PDFs open inside the site (the browser's own viewer), with open-in-tab and download. */
export function PdfViewer({ title, uri, payload }: { title: string | null; uri: string | null; payload: Record<string, any> | null }) {
  const src = safePdfSrc(uri, payload?.url);
  if (!src) return <p className="muted">This PDF is not available yet.</p>;
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <a className="mini-link" href={src} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} /> Open in a new tab</a>
        <a className="mini-link" href={src} download={`${(title ?? 'document').replace(/\W+/g, '-')}.pdf`}><Download size={14} /> Download</a>
        {typeof payload?.pages === 'number' && <span className="faint">{payload.pages} page{payload.pages === 1 ? '' : 's'}</span>}
      </div>
      <iframe title={title ?? 'PDF'} src={`${src}${src.includes('#') ? '' : '#toolbar=1&view=FitH'}`} className="frame" style={{ height: '75vh' }} />
    </div>
  );
}
