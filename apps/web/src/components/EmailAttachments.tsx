import { AlertCircle, CheckCircle2, Clock, Loader2, Paperclip, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Events, type AttachmentChip, type EmailAttachments } from '@meetpilot/shared';
import { api, useSession } from '../lib/api';
import { getSocket } from '../lib/socket';
import { AGENT_LABEL } from '../routes/Reviews';

const WAITING = new Set(['working', 'awaiting_approval']);
export const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Chips for a draft's attachments, kept live: refreshed on any execution event and polled while something is still being prepared. */
export function useAttachments(executionId: string, enabled = true) {
  const { user } = useSession();
  const [data, setData] = useState<EmailAttachments | null>(null);
  const load = useCallback(() => api<EmailAttachments>(`/executions/${executionId}/attachments`).then(setData).catch(() => undefined), [executionId]);
  useEffect(() => { if (enabled) void load(); }, [load, enabled]);
  useEffect(() => {
    if (!user || !enabled) return;
    const s = getSocket(user.username);
    s.on(Events.executionUpdate, load); s.on(Events.executionStep, load);
    return () => { s.off(Events.executionUpdate, load); s.off(Events.executionStep, load); };
  }, [user, load, enabled]);
  const waiting = !!data?.selected.some((c) => WAITING.has(c.state));
  useEffect(() => {
    if (!waiting || !enabled) return;
    const t = setInterval(load, 4000);  // in case a push is missed
    return () => clearInterval(t);
  }, [waiting, load, enabled]);
  return { data, reload: load, allReady: !!data && data.selected.every((c) => c.state === 'ready') };
}

const icon = (s: AttachmentChip['state']) => s === 'ready' ? <CheckCircle2 size={15} color="var(--success)" /> : s === 'working' ? <Loader2 size={15} className="spin" />
  : s === 'awaiting_approval' ? <Clock size={15} color="var(--warn)" /> : <AlertCircle size={15} color="var(--danger)" />;

/** One attachable deliverable and where it is right now. */
export function Chip({ chip, onRemove, onAdd, suggested }: { chip: AttachmentChip; onRemove?: () => void; onAdd?: () => void; suggested?: boolean }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: 'flex-start', padding: '8px 10px', border: `1px ${suggested ? 'dashed' : 'solid'} var(--border)`, borderRadius: 10 }}>
      <span style={{ paddingTop: 2 }}>{icon(chip.state)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div><strong>{chip.taskTitle}</strong> <span className="faint">· {AGENT_LABEL[chip.agent ?? ''] ?? chip.agent}</span></div>
        <div className="faint" style={{ fontSize: 13 }}>
          {chip.state === 'ready' ? chip.files.map((f) => `${f.filename} (${kb(f.size)})`).join(', ') : chip.label}
        </div>
        {chip.state === 'awaiting_approval' && <a href={`/reviews/${chip.executionId}`} target="_blank" rel="noreferrer noopener" style={{ fontSize: 13 }}>Open it to review and approve</a>}
      </div>
      {onAdd && <button className="mini" onClick={onAdd}><Plus size={14} /> Attach</button>}
      {onRemove && <button className="ghost icon" onClick={onRemove} aria-label={`Remove ${chip.taskTitle}`}><X size={15} /></button>}
    </div>
  );
}

/** Attachments section of the email editor. Nothing is attached until the reviewer picks it; sending waits for approval. */
export function AttachmentsBox({ executionId, selectedIds, editable, onChange }: { executionId: string; selectedIds: string[]; editable: boolean; onChange: (ids: string[]) => void }) {
  const { data } = useAttachments(executionId);
  if (!data) return null;
  const suggested = data.suggested.filter((c) => !selectedIds.includes(c.executionId));
  const others = data.candidates.filter((c) => !selectedIds.includes(c.executionId) && !suggested.some((s) => s.executionId === c.executionId));
  if (!selectedIds.length && !suggested.length && !others.length) return null;
  const add = (id: string) => onChange([...selectedIds, id].slice(0, 5));
  const pending = data.selected.filter((c) => c.state !== 'ready').length;
  return (
    <div style={{ marginTop: 14 }}>
      <label className="row" style={{ gap: 6 }}><Paperclip size={14} /> Attachments</label>
      <div className="stack" style={{ gap: 8 }}>
        {data.selected.map((c) => <Chip key={c.executionId} chip={c} onRemove={editable ? () => onChange(selectedIds.filter((i) => i !== c.executionId)) : undefined} />)}
        {editable && suggested.map((c) => <Chip key={c.executionId} chip={c} suggested onAdd={() => add(c.executionId)} />)}
      </div>
      {suggested.length > 0 && editable && <p className="faint" style={{ margin: '6px 0 0', fontSize: 13 }}>The agent suggests these because the task mentions a file. Nothing is attached until you add it.</p>}
      {pending > 0 && <p className="note-inline info" role="status" style={{ marginTop: 8 }}><Loader2 size={15} className="spin" /> <span>{pending} attachment{pending > 1 ? 's are' : ' is'} not ready yet. You can send this email once {pending > 1 ? 'they are' : 'it is'} approved, or remove {pending > 1 ? 'them' : 'it'}.</span></p>}
      {editable && others.length > 0 && selectedIds.length < 5 && (
        <div className="row" style={{ marginTop: 8, gap: 8 }}>
          <select aria-label="Add an attachment" value="" onChange={(e) => { if (e.target.value) add(e.target.value); }}>
            <option value="">Add another deliverable…</option>
            {others.map((c) => <option key={c.executionId} value={c.executionId}>{c.taskTitle} — {AGENT_LABEL[c.agent ?? ''] ?? c.agent}{c.state === 'ready' ? '' : ` (${c.state === 'working' ? 'in progress' : c.state === 'awaiting_approval' ? 'awaiting approval' : 'unavailable'})`}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

