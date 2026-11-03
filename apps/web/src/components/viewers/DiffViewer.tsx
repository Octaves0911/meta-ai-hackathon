import { ChevronDown, ChevronRight, Download, FilePlus2, FileText, MessageSquarePlus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseDiff, type PatchFile } from '@meetpilot/shared';

export interface LineComment { file: string; line: number; text: string }
const MAX_PARSE = 250_000;

/** A reviewable diff: file list with +/− counts, collapsible files, old/new line numbers, and line comments that go back to the agent with "Request changes". */
export function DiffViewer({ diff, title, comments, onComments, editable }: { diff: string; title?: string | null; comments: LineComment[]; onComments: (c: LineComment[]) => void; editable: boolean }) {
  const files = useMemo(() => (diff.length <= MAX_PARSE ? parseDiff(diff) : []), [diff]);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<{ file: string; line: number; text: string } | null>(null);
  if (!diff.trim()) return <p className="muted">No changes.</p>;
  if (!files.length) return <pre className="diff"><code>{diff.slice(0, MAX_PARSE)}</code></pre>;

  const total = files.reduce((a, f) => [a[0] + f.additions, a[1] + f.deletions], [0, 0]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([diff], { type: 'text/x-diff' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${(title ?? 'change').replace(/\W+/g, '-').toLowerCase()}.patch`; a.click(); URL.revokeObjectURL(url);
  };
  const save = () => { if (draft && draft.text.trim()) onComments([...comments, { ...draft, text: draft.text.trim() }]); setDraft(null); };
  const on = (f: PatchFile, line: number) => comments.filter((c) => c.file === f.path && c.line === line);

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="muted"><strong>{files.length}</strong> file{files.length > 1 ? 's' : ''} changed · <span style={{ color: 'var(--success-text)' }}>+{total[0]}</span> <span style={{ color: 'var(--danger-text)' }}>−{total[1]}</span></span>
        <button className="mini" onClick={download}><Download size={14} /> Download .patch</button>
      </div>
      {files.length > 1 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }} aria-label="Changed files">
          {files.map((f) => <a key={f.path} href={`#diff-${f.path}`} className="status" onClick={() => setClosed((c) => ({ ...c, [f.path]: false }))}>{f.path.split('/').pop()} <span className="faint">+{f.additions} −{f.deletions}</span></a>)}
        </div>
      )}
      <div className="stack" style={{ gap: 12 }}>
        {files.map((f) => (
          <section key={f.path} id={`diff-${f.path}`} style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            <button className="ghost" style={{ width: '100%', justifyContent: 'flex-start', gap: 8, borderRadius: 0, padding: '8px 12px', background: 'var(--surface-3)' }} aria-expanded={!closed[f.path]} onClick={() => setClosed((c) => ({ ...c, [f.path]: !c[f.path] }))}>
              {closed[f.path] ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
              {f.status === 'added' ? <FilePlus2 size={15} color="var(--success)" /> : <FileText size={15} />}
              <code style={{ fontSize: 13 }}>{f.path}</code>
              {f.status === 'added' && <span className="status status-done">new</span>}
              <span style={{ marginLeft: 'auto', fontSize: 12.5 }}><span style={{ color: 'var(--success-text)' }}>+{f.additions}</span> <span style={{ color: 'var(--danger-text)' }}>−{f.deletions}</span></span>
            </button>
            {!closed[f.path] && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.55 }}>
                  <tbody>
                    {f.hunks.map((h, hi) => (
                      <HunkRows key={hi} f={f} h={h} editable={editable} on={on} draft={draft} setDraft={setDraft} save={save} remove={(c) => onComments(comments.filter((x) => x !== c))} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </div>
      {comments.length > 0 && <p className="faint" style={{ margin: '10px 0 0', fontSize: 13 }}>{comments.length} line comment{comments.length > 1 ? 's' : ''} will be sent to the agent with “Request changes”.</p>}
    </div>
  );
}

function HunkRows({ f, h, editable, on, draft, setDraft, save, remove }: {
  f: PatchFile; h: PatchFile['hunks'][number]; editable: boolean; on: (f: PatchFile, line: number) => LineComment[];
  draft: { file: string; line: number; text: string } | null; setDraft: (d: { file: string; line: number; text: string } | null) => void; save: () => void; remove: (c: LineComment) => void;
}) {
  const bg = { add: 'var(--success-soft)', del: 'var(--danger-soft)', ctx: 'transparent', note: 'transparent' } as const;
  return (
    <>
      <tr><td colSpan={4} style={{ background: 'var(--surface-3)', color: 'var(--text-3)', padding: '2px 12px' }}>{h.header}</td></tr>
      {h.lines.map((l, i) => {
        const line = l.newNo ?? l.oldNo ?? 0;
        const existing = l.type === 'note' ? [] : on(f, line);
        const editing = draft && draft.file === f.path && draft.line === line && l.type !== 'note';
        return (
          <FragmentRow key={i}>
            <tr style={{ background: bg[l.type] }}>
              <td style={{ width: 42, textAlign: 'right', padding: '0 6px', color: 'var(--text-3)', userSelect: 'none' }}>{l.oldNo ?? ''}</td>
              <td style={{ width: 42, textAlign: 'right', padding: '0 6px', color: 'var(--text-3)', userSelect: 'none' }}>{l.newNo ?? ''}</td>
              <td style={{ width: 22, textAlign: 'center', color: l.type === 'add' ? 'var(--success-text)' : l.type === 'del' ? 'var(--danger-text)' : 'var(--text-3)', userSelect: 'none' }}>
                {editable && l.type !== 'note' ? <button className="ghost icon" style={{ minHeight: 18, minWidth: 18, padding: 0 }} aria-label={`Comment on ${f.path} line ${line}`} title="Comment on this line" onClick={() => setDraft({ file: f.path, line, text: '' })}><MessageSquarePlus size={12} /></button> : (l.type === 'add' ? '+' : l.type === 'del' ? '−' : '')}
              </td>
              <td style={{ whiteSpace: 'pre', padding: '0 12px 0 4px', fontStyle: l.type === 'note' ? 'italic' : undefined, color: l.type === 'note' ? 'var(--text-3)' : undefined }}>{l.type === 'note' ? `\\ ${l.text}` : l.text || ' '}</td>
            </tr>
            {existing.map((c, k) => (
              <tr key={`c${k}`}><td colSpan={4} style={{ padding: '4px 12px 6px 90px', background: 'var(--warn-soft)', fontFamily: 'inherit', whiteSpace: 'normal' }}>
                <span className="row" style={{ gap: 8, justifyContent: 'space-between' }}><span><strong>Your comment:</strong> {c.text}</span>{editable && <button className="ghost icon" aria-label="Remove comment" onClick={() => remove(c)}><X size={13} /></button>}</span>
              </td></tr>
            ))}
            {editing && (
              <tr><td colSpan={4} style={{ padding: '6px 12px 8px 90px', background: 'var(--surface-2)', whiteSpace: 'normal', fontFamily: 'inherit' }}>
                <textarea autoFocus rows={2} value={draft!.text} onChange={(e) => setDraft({ ...draft!, text: e.target.value })} placeholder="What should change on this line?" aria-label="Line comment" style={{ width: '100%' }} />
                <div className="row" style={{ gap: 6, marginTop: 4 }}><button className="mini primary" disabled={!draft!.text.trim()} onClick={save}>Add comment</button><button className="mini" onClick={() => setDraft(null)}>Cancel</button></div>
              </td></tr>
            )}
          </FragmentRow>
        );
      })}
    </>
  );
}
const FragmentRow = ({ children }: { children: React.ReactNode }) => <>{children}</>;
