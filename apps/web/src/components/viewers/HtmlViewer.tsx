import { Monitor, Smartphone } from 'lucide-react';
import { useState } from 'react';

export const MAX_HTML = 200_000;
// Nothing in a generated mockup may run or load anything: no scripts, no network, only inline styles and data: images.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;
const BASE = `<meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank">`;

/** Design mockups written as self-contained HTML. Shown in a fully sandboxed iframe (no scripts, no same-origin, no remote resources). */
export function HtmlViewer({ title, html }: { title: string | null; html: string }) {
  const [mobile, setMobile] = useState(false);
  if (!html) return <p className="muted">No mockup content.</p>;
  if (html.length > MAX_HTML) return <p className="muted">This mockup is too large to preview safely.</p>;
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }} role="group" aria-label="Preview size">
        <button className={`mini${!mobile ? ' active' : ''}`} aria-pressed={!mobile} onClick={() => setMobile(false)}><Monitor size={14} /> Desktop</button>
        <button className={`mini${mobile ? ' active' : ''}`} aria-pressed={mobile} onClick={() => setMobile(true)}><Smartphone size={14} /> Mobile (375 px)</button>
      </div>
      <div className="image-frame" style={{ display: 'flex', justifyContent: 'center', background: 'var(--surface-3)' }}>
        <iframe title={title ?? 'Design mockup'} sandbox="" referrerPolicy="no-referrer" srcDoc={`${CSP}${BASE}${html}`}
          style={{ width: mobile ? 375 : '100%', maxWidth: '100%', height: '65vh', border: 0, background: '#fff' }} />
      </div>
    </div>
  );
}
