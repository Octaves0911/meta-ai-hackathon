import type { ExecutionArtifact } from '@meetpilot/shared';
import { DiffViewer, type LineComment } from './DiffViewer';
import { EmailEditor } from './EmailEditor';
import { HtmlViewer } from './HtmlViewer';
import { ImageViewer } from './ImageViewer';
import { MarkdownViewer } from './MarkdownViewer';
import { PdfViewer } from './PdfViewer';
import { SourcesList } from './SourcesList';
import { TableViewer } from './TableViewer';
import { VerificationView } from './VerificationView';

const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

/** Picks the typed viewer for one deliverable (PRD F8.5). Diff/PDF/video viewers are minimal for now. */
export function ArtifactView({ artifact, executionId, editable, onSaved, lineComments = [], onLineComments = () => {} }: { artifact: ExecutionArtifact; executionId: string; editable: boolean; onSaved: () => void; lineComments?: LineComment[]; onLineComments?: (c: LineComment[]) => void }) {
  const a = artifact;
  switch (a.type) {
    case 'markdown': return <MarkdownViewer source={a.payload?.content ?? ''} />;
    case 'image': return <ImageViewer title={a.title} payload={a.payload} uri={safeUrl(a.uri)} />;
    case 'email_draft': return <EmailEditor executionId={executionId} artifact={a} editable={editable} onSaved={onSaved} />;
    case 'pdf': return <PdfViewer title={a.title} uri={a.uri} payload={a.payload} />;
    case 'html': return <HtmlViewer title={a.title} html={String(a.payload?.html ?? '')} />;
    case 'table': return <TableViewer payload={a.payload} />;
    case 'video': return safeUrl(a.uri) ? <video controls src={safeUrl(a.uri)!} style={{ width: '100%' }} /> : <p className="muted">Video not available.</p>;
    case 'diff': return <DiffViewer diff={String(a.payload?.diff ?? '')} title={a.title} comments={lineComments} onComments={onLineComments} editable={editable} />;
    case 'verification': return <VerificationView payload={a.payload} />;
    case 'link': if (Array.isArray(a.payload?.items)) return <SourcesList payload={a.payload} />;
      return safeUrl(a.uri) ? <a href={safeUrl(a.uri)!} target="_blank" rel="noreferrer noopener">{a.title ?? a.uri}</a> : <p className="muted">{a.title}</p>;
    default: return <p className="muted">{a.title ?? 'File'}{safeUrl(a.uri) && <> — <a href={safeUrl(a.uri)!} target="_blank" rel="noreferrer noopener">open</a></>}</p>;
  }
}
