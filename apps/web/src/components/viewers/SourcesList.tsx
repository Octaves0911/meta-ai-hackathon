import { ExternalLink } from 'lucide-react';

/** Only web links are clickable (http or https; never javascript:, data: and the like). */
const safeHttps = (u: unknown): string | null => (typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u) ? u : null);

/** Cited web sources (Research). Every link here is a page the search tool actually returned. */
export function SourcesList({ payload }: { payload: Record<string, any> | null }) {
  const items: { title: string; url: string; host?: string }[] = Array.isArray(payload?.items) ? payload!.items : [];
  if (!items.length) return <p className="muted">No sources.</p>;
  return (
    <div>
      <p className="faint" style={{ marginTop: 0 }}>{payload?.searched_on ? `Searched on ${payload.searched_on}. ` : ''}These are search results; open them to confirm figures before relying on them.</p>
      <ol className="stack" style={{ gap: 8, paddingLeft: 20, margin: 0 }}>
        {items.map((s, i) => {
          const url = safeHttps(s.url);
          return (
            <li key={i}>
              {url ? <a href={url} target="_blank" rel="noreferrer noopener"><strong>{s.title || s.host || url}</strong> <ExternalLink size={13} style={{ verticalAlign: -1 }} /></a> : <strong>{s.title}</strong>}
              <div className="faint" style={{ fontSize: 13 }}>{s.host ?? ''}</div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
