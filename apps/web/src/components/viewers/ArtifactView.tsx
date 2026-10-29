import type { ExecutionArtifact } from '@meetpilot/shared';
import { EmailEditor } from './EmailEditor';
import { ImageViewer } from './ImageViewer';
import { MarkdownViewer } from './MarkdownViewer';

const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

/** Picks the typed viewer for one deliverable (PRD F8.5). Diff/PDF/video viewers are minimal for now. */
export function ArtifactView({ artifact, executionId, editable, onSaved }: { artifact: ExecutionArtifact; executionId: string; editable: boolean; onSaved: () => void }) {
  const a = artifact;
  switch (a.type) {
    case 'markdown': return <MarkdownViewer source={a.payload?.content ?? ''} />;
    case 'image': return <ImageViewer title={a.title} payload={a.payload} uri={safeUrl(a.uri)} />;
    case 'email_draft': return <EmailEditor executionId={executionId} artifact={a} editable={editable} onSaved={onSaved} />;
    case 'pdf': return safeUrl(a.uri) ? <iframe title={a.title ?? 'PDF'} src={safeUrl(a.uri)!} className="frame" /> : <p className="muted">PDF not available.</p>;
    case 'video': return safeUrl(a.uri) ? <video controls src={safeUrl(a.uri)!} style={{ width: '100%' }} /> : <p className="muted">Video not available.</p>;
    case 'diff': return <pre className="diff"><code>{a.payload?.diff ?? ''}</code></pre>;
    case 'link': return safeUrl(a.uri) ? <a href={safeUrl(a.uri)!} target="_blank" rel="noreferrer noopener">{a.title ?? a.uri}</a> : <p className="muted">{a.title}</p>;
    default: return <p className="muted">{a.title ?? 'File'}{safeUrl(a.uri) && <> — <a href={safeUrl(a.uri)!} target="_blank" rel="noreferrer noopener">open</a></>}</p>;
  }
}
