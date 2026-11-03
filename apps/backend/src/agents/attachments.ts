// Attachments for email drafts (docs/09 §2.2): a draft attaches the PDF deliverable of another execution in the same project.
// A file is attachable only once its execution is approved; until then the draft shows live progress instead.
import type { Pool } from 'pg';
import type { AttachmentChip, AttachmentState } from '@meetpilot/shared';

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Agents that produce a document someone might attach. */
export const FILE_AGENTS = ['research', 'marketing', 'designer', 'code'];

export interface SourceRow { status: string; revision: number; step_label: string | null; files: { artifactId: string; filename: string; size: number; attachable: boolean }[] | null }

/** Where an attachment is in its life: ready, waiting for the reviewer to approve it, being worked on, or never going to exist. */
export function stateOf(r: SourceRow): { state: AttachmentState; label: string } {
  const files = (r.files ?? []).filter((f) => f.attachable);
  switch (r.status) {
    case 'approved': return files.length ? { state: 'ready', label: 'Ready to attach' } : { state: 'no_file', label: 'Approved, but it has no PDF to attach' };
    case 'awaiting_review': return { state: 'awaiting_approval', label: 'Waiting for its review and approval' };
    case 'routed': return { state: 'working', label: 'Waiting to start' };
    case 'running': case 'changes_requested': return { state: 'working', label: r.step_label ? `Agent working: ${r.step_label}` : 'Agent working' };
    case 'rejected': return { state: 'failed', label: 'Rejected, so there is nothing to attach' };
    case 'failed': return { state: 'failed', label: 'The agent could not finish this' };
    default: return { state: 'failed', label: 'No agent is working on this' };
  }
}

const SELECT = `select x.id, x.status, x.agent, x.revision, t.title, t.meeting_id,
  (select s.label from execution_steps s where s.execution_id = x.id and s.revision = x.revision order by (s.status = 'running') desc, s.seq desc limit 1) as step_label,
  (select jsonb_agg(jsonb_build_object('artifactId', a.id, 'filename', f.filename, 'size', f.size, 'attachable', coalesce((a.payload->>'attachable')::boolean, false)) order by a.title)
     from execution_artifacts a join execution_files f on f.artifact_id = a.id where f.mime = 'application/pdf' and a.execution_id = x.id and a.revision = x.revision) as files
  from executions x join tasks t on t.id = x.task_id`;

const toChip = (r: any): AttachmentChip => {
  const s = stateOf(r);
  return {
    executionId: r.id, taskTitle: r.title, agent: r.agent, state: s.state, label: s.label,
    files: (r.files ?? []).filter((f: any) => f.attachable).map((f: any) => ({ artifactId: f.artifactId, filename: f.filename, size: f.size })),
  };
};

/** Live state of the chosen executions (project-scoped, so one project can never attach another's files). */
export async function chipsFor(db: Pool, projectId: string, ids: string[]): Promise<AttachmentChip[]> {
  if (!ids.length) return [];
  const { rows } = await db.query(`${SELECT} where x.id = any($1::uuid[]) and t.project_id = $2`, [ids, projectId]);
  const byId = new Map(rows.map((r) => [r.id, toChip(r)]));
  return ids.map((id) => byId.get(id)).filter((c): c is AttachmentChip => !!c);
}

/** What the reviewer can attach: other deliverable-producing work in this project, this meeting's first. */
export async function candidatesFor(db: Pool, e: { id: string; project_id: string; meeting_id: string }): Promise<AttachmentChip[]> {
  const { rows } = await db.query(
    `${SELECT} where t.project_id = $1 and x.id <> $2 and x.agent = any($3) and x.status not in ('skipped_human', 'rejected')
     order by (t.meeting_id = $4) desc, x.updated_at desc limit 25`, [e.project_id, e.id, FILE_AGENTS, e.meeting_id]);
  return rows.map(toChip);
}

/** The chosen ids must be other, file-producing executions of the same project. Returns the ids that are not. */
export async function invalidAttachmentIds(db: Pool, e: { id: string; project_id: string }, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `select x.id from executions x join tasks t on t.id = x.task_id where x.id = any($1::uuid[]) and t.project_id = $2 and x.id <> $3 and x.agent = any($4)`,
    [ids, e.project_id, e.id, FILE_AGENTS]);
  const ok = new Set(rows.map((r) => r.id));
  return ids.filter((id) => !ok.has(id));
}

export interface SendFile { artifactId: string; filename: string; mime: string; size: number; sha256: string; data: Buffer }

/** Everything that would go out. Throws a message for the reviewer if any chosen attachment is not ready or the total is too big. */
export async function filesForSend(db: Pool, projectId: string, ids: string[]): Promise<SendFile[]> {
  if (!ids.length) return [];
  const chips = await chipsFor(db, projectId, ids);
  const notReady = chips.filter((c) => c.state !== 'ready');
  if (chips.length !== ids.length || notReady.length) {
    const what = notReady.length ? notReady.map((c) => `“${c.taskTitle}” (${c.label.toLowerCase()})`).join('; ') : 'an attachment is no longer available';
    throw new AttachmentError('attachments_not_ready', `these attachments are not ready yet: ${what}`);
  }
  const artifactIds = chips.flatMap((c) => c.files.map((f) => f.artifactId));
  if (artifactIds.length === 0) throw new AttachmentError('attachments_not_ready', 'the chosen attachments have no files');
  if (artifactIds.length > MAX_ATTACHMENTS) throw new AttachmentError('too_many_attachments', `at most ${MAX_ATTACHMENTS} files can be attached`);
  const { rows } = await db.query('select artifact_id, filename, mime, size, sha256, data from execution_files where artifact_id = any($1::uuid[])', [artifactIds]);
  const files: SendFile[] = rows.map((r) => ({ artifactId: r.artifact_id, filename: r.filename, mime: r.mime, size: r.size, sha256: r.sha256, data: r.data }));
  if (files.reduce((n, f) => n + f.size, 0) > MAX_ATTACHMENT_BYTES) throw new AttachmentError('attachments_too_large', 'the attachments are larger than 10 MB in total');
  // distinct names so two reports with the same title do not collide in the recipient's mail client
  const seen = new Map<string, number>();
  for (const f of files) { const n = (seen.get(f.filename) ?? 0) + 1; seen.set(f.filename, n); if (n > 1) f.filename = f.filename.replace(/\.pdf$/, ` (${n}).pdf`); }
  return files;
}

export class AttachmentError extends Error { constructor(public code: string, message: string) { super(message); } }
