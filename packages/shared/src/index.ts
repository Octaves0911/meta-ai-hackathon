import { z } from 'zod';

export const MeetingStatus = z.enum(['scheduled', 'active', 'ended', 'closed']);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

export const InsightKind = z.enum([
  'conflict', 'update', 'repeat', 'answer', 'reminder', 'context', 'no_record', 'external', 'brief', 'recap',
]);
export type InsightKind = z.infer<typeof InsightKind>;

export const InsightTier = z.enum(['interrupt', 'queued', 'feed']);
export type InsightTier = z.infer<typeof InsightTier>;

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiError>;

export const Health = z.object({
  service: z.string(),
  status: z.literal('ok'),
});
export type Health = z.infer<typeof Health>;

/** Socket.IO event names (docs/03-api-and-events.md §2). */
export const Events = {
  chatMessage: 'chat:message',
  aiAssist: 'ai:assist',
  insightNew: 'insight:new',
  taskUpserted: 'task:upserted',
  meetingEnded: 'meeting:ended',
  meetingTasksReady: 'meeting:tasks_ready',
  captionInterim: 'caption:interim',
  captionFinal: 'caption:final',
  captionStatus: 'caption:status',
  executionUpdate: 'execution:update',
  executionStep: 'execution:step',
  executionMessage: 'execution:message',
} as const;

export const SERVICE_PORTS = { web: 5173, backend: 4000, ai: 5001, connector: 6100 } as const;

export const Username = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'letters, numbers, _ . - only')
  .transform((s) => s.toLowerCase());

export const CreateUserBody = z.object({ username: Username });
export type CreateUserBody = z.infer<typeof CreateUserBody>;

export const CreateProjectBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  shareWorkspace: z.boolean().default(false),
});
export type CreateProjectBody = z.infer<typeof CreateProjectBody>;

export interface User { id: string; username: string; createdAt: string }
export interface Project {
  id: string; name: string; description: string | null; ownerId: string;
  shareWorkspace: boolean; role: 'owner' | 'member'; createdAt: string;
  /** Agents never search the web for this project (owner setting). */
  noExternalLookups: boolean;
  /** Owner-written brand and voice note (≤1,500 chars) that Marketing, Communication and Designer always see. */
  brandNote: string | null;
}
export const MAX_BRAND_NOTE = 1500;
export const ProjectSettingsBody = z.object({ noExternalLookups: z.boolean().optional(), brandNote: z.string().max(MAX_BRAND_NOTE).nullable().optional() });
export interface ProjectOverview {
  meetings: number; thisWeek: number; avgDurationSec: number; activeNow: number;
  byStatus: Record<MeetingStatus, number>;
  monthly: { month: string; count: number }[];
}

export const CreateMeetingBody = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  scheduledAt: z.string().datetime().optional(),
  inviteeIds: z.array(z.string().uuid()).max(50).default([]),
  shareChatTranscript: z.boolean().default(false),
  shareWorkspace: z.boolean().default(false),
});
export type CreateMeetingBody = z.infer<typeof CreateMeetingBody>;

export const InviteStatus = z.enum(['invited', 'accepted', 'declined', 'joined']);
export type InviteStatus = z.infer<typeof InviteStatus>;

export interface Meeting {
  id: string; projectId: string; ownerId: string; ownerName: string;
  title: string; description: string | null; status: MeetingStatus;
  scheduledAt: string | null; startedAt: string | null; endedAt: string | null;
  totalDurationSec: number; shareChatTranscript: boolean; shareWorkspace: boolean;
  aiAssist: boolean; createdAt: string;
}
export interface MeetingParticipant { userId: string; username: string; inviteStatus: InviteStatus }
export interface MeetingDetail extends Meeting {
  projectName: string;
  participants: MeetingParticipant[];
  myInviteStatus: InviteStatus | null;
  stats: { messages: number; notes: number; transcriptSegments: number };
}
export interface AppNotification {
  id: string; type: 'invite' | 'review_ready';
  payload: Record<string, any>; readAt: string | null; createdAt: string;
}

export interface ChatMessage {
  id: string; meetingId: string; userId: string | null; username: string | null;
  kind: 'user' | 'ai_insight'; body: string; createdAt: string;
  insight?: Insight | null;            // present on kind 'ai_insight'
}
export interface PersonalNote { body: string; updatedAt: string | null }
export interface RoomPeer { userId: string; socketId: string; name: string }
export const SendMessageBody = z.object({ body: z.string().trim().min(1).max(4000) });
export const SaveNoteBody = z.object({ body: z.string().max(20000) });

/** Last ~`max` characters of `text`, cut at a word boundary with a leading "…" (subtitle rule, PRD §7.2). */
export function tailText(text: string, max = 200): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const space = cut.indexOf(' ');
  return '…' + (space >= 0 ? cut.slice(space + 1) : cut);
}

export interface Insight {
  id: string; meetingId: string; kind: InsightKind; tier: InsightTier;
  title: string; body: string; quote: string | null;
  sourceLabel: string | null; sourceUrl: string | null;
  score: number | null; topicKey: string | null;
  private: boolean;                    // true => only visible to its audience user
  feedback: 'helpful' | 'dismissed' | null;
  deliveredToChat: boolean; createdAt: string;
}
export const FeedbackBody = z.object({ value: z.enum(['helpful', 'dismissed']) });
export const AiAssistBody = z.object({ enabled: z.boolean() });

export const TaskStatus = z.enum(['open', 'in_progress', 'review', 'done']);
export type TaskStatus = z.infer<typeof TaskStatus>;
export interface TaskUser { id: string; username: string }
export interface Task {
  id: string; meetingId: string; title: string; description: string | null;
  assignedTo: TaskUser | null; assignedBy: TaskUser | null;
  assigneeName?: string | null; // a person named aloud who is not a project member
  dueDate: string | null; status: TaskStatus; finalized: boolean; createdAt: string;
}
export const UpdateTaskBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  status: TaskStatus.optional(),
});

export type ExecutionStatus = 'routed' | 'running' | 'awaiting_review' | 'changes_requested' | 'approved' | 'rejected' | 'failed' | 'skipped_human';
export type AgentName = 'research' | 'marketing' | 'designer' | 'communication' | 'code';
export const MAX_REVISIONS = 5;
export type MessageKind = 'ask' | 'change' | 'clarify';
export interface ExecutionMessage { id: string; revision: number; role: 'user' | 'agent'; kind: MessageKind; text: string; proposedChange: string | null; author: string | null; createdAt: string }
export const ChatBody = z.object({ text: z.string().trim().min(1).max(2000) });
export const RerunBody = z.object({ comment: z.string().trim().max(2000).optional() });
export const MAX_CHAT_MESSAGES = 60;

export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };
/** Line diff (longest common subsequence) for comparing two revisions of a text deliverable. Very large inputs fall back to a coarse diff. */
export function lineDiff(before: string, after: string, maxLines = 1500): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length > maxLines || b.length > maxLines) return [...a.map((text) => ({ type: 'del' as const, text })), ...b.map((text) => ({ type: 'add' as const, text }))];
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: 'del', text: a[i++] });
    else out.push({ type: 'add', text: b[j++] });
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}
export interface ReviewCounts { needsReview: number; working: number }
export interface ExecutionSummary {
  id: string; taskId: string; taskTitle: string; meetingId: string; meetingTitle: string; projectId: string; projectName: string;
  agent: AgentName | null; status: ExecutionStatus; revision: number; summary: string | null; error: string | null;
  routeReason: string | null; reviewer: TaskUser | null; assignee: TaskUser | null; dueDate: string | null; updatedAt: string;
  /** 0..1 self-assessed readiness of the work (quality gate); routeConfidence is how sure the router was. */
  confidence: number | null; routeConfidence: number | null;
  /** Design work with two directions: which one the reviewer approved. */
  approvedChoice: 'A' | 'B' | null;
  /** Planned agents for this task, e.g. designer → code (web pages only), and the agent suggested when the router was unsure. */
  stagePlan: { stages?: { agent: AgentName; goal: string }[]; scope?: 'deliverable' | 'build'; suggestedAgent?: AgentName | null; missingInputs?: string[];
    /** Code work: several linked repositories fit and the reviewer must choose one. */
    repoChoice?: { reason: string; candidates: { repo_id: string; full_name: string; score: number; reason: string }[] } } | null;
  /** Code work: the linked repository this execution targets. */
  repo: { id: string; fullName: string } | null;
}
export type StepKind = 'plan' | 'search' | 'read' | 'consult' | 'tool' | 'draft' | 'check';
export interface ExecutionStep { seq: number; revision: number; kind: StepKind; label: string; detail: Record<string, unknown>; status: 'running' | 'done' | 'failed'; startedAt: string; endedAt: string | null }
export interface ExecutionUsage { calls: number; searches?: number; sandboxCostUsd?: number; promptTokens: number; completionTokens: number; costUsd: number; models: string[] }
export interface ExecutionArtifact {
  id: string; type: 'markdown' | 'image' | 'pdf' | 'video' | 'diff' | 'link' | 'file' | 'email_draft' | 'html' | 'table' | 'verification';
  title: string | null; uri: string | null; payload: Record<string, any> | null; revision: number;
}
export interface Consultation { id: string; fromAgent: string; toAgent: string; question: string; answer: string | null; depth: number }
export interface ExecutionReview { revision: number; verdict: 'approve' | 'changes' | 'reject'; comment: string | null; lineComments: unknown[] | null; reviewer: string | null; createdAt: string }
export interface ExecutionDetail extends ExecutionSummary {
  task: Task; notes: string | null; artifacts: ExecutionArtifact[]; consultations: Consultation[]; reviews: ExecutionReview[]; canReview: boolean;
  /** Things the agent could not settle and a human must supply or confirm (shown first on a review). */
  openQuestions: string[]; usage: ExecutionUsage | null; steps: ExecutionStep[];
  /** Email-drafting runs only: whether the reviewer allowed sending via Gmail, and every send made from this run (audit). */
  send: { granted: boolean | null; account: string | null; sent: { sentAt: string; from: string | null; to: string[]; cc: string[]; subject: string; messageId: string | null; attachments: { filename: string; size: number }[] }[] } | null;
}
export const ChooseRepoBody = z.object({ repoId: z.string().uuid() });
export const RunWithBody = z.object({ agent: z.enum(['research', 'marketing', 'designer', 'communication', 'code']) });
export const ReviewBody = z.object({
  verdict: z.enum(['approve', 'changes', 'reject']),
  /** Required when approving design work that offers two directions. */
  choice: z.enum(['A', 'B']).optional(),
  comment: z.string().trim().max(4000).optional(),
  lineComments: z.array(z.object({ file: z.string().max(300).optional(), line: z.number().int().min(0).optional(), text: z.string().trim().min(1).max(2000) })).max(50).optional(),
});
const noBreaks = (s: string) => !/[\r\n\0]/.test(s);
export const MAX_RECIPIENTS = 10; // to + cc together
export const EmailDraftBody = z.object({
  to: z.array(z.string().email()).max(MAX_RECIPIENTS), cc: z.array(z.string().email()).max(MAX_RECIPIENTS),
  subject: z.string().max(300).refine(noBreaks, 'subject must be a single line'), body: z.string().max(50000),
  /** Executions whose PDF deliverable is attached (they must be approved before the email can be sent). */
  attachments: z.array(z.string().uuid()).max(5).default([]),
}).refine((d) => d.to.length + d.cc.length <= MAX_RECIPIENTS, { message: `at most ${MAX_RECIPIENTS} recipients in total`, path: ['to'] });
export type AttachmentState = 'ready' | 'awaiting_approval' | 'working' | 'failed' | 'no_file';
/** One attachable deliverable (another execution's PDF) and where it is right now. */
export interface AttachmentChip { executionId: string; taskTitle: string; agent: AgentName | null; state: AttachmentState; label: string; files: { artifactId: string; filename: string; size: number }[] }
export interface EmailAttachments { selected: AttachmentChip[]; suggested: AttachmentChip[]; candidates: AttachmentChip[] }
export const SendEmailBody = z.object({ artifactId: z.string().uuid(), confirm: z.literal(true, { error: 'sending needs explicit confirmation' }) });

export interface ConnectionView {
  id: string; provider: 'gmail' | 'drive'; visibility: 'private' | 'project'; status: 'needs_setup' | 'connected' | 'syncing' | 'error' | string;
  account: string | null; lastSyncAt: string | null; itemCount: number; ownerId: string; ownerName: string; isOwner: boolean; lastError: string | null;
  config: { labels: string[]; lookbackDays: number; folderIds: string[]; includeSubfolders: boolean };
}

export interface WorkspaceFile {
  id: string; path: string; kind: 'cloud' | 'local'; size: number | null; mime: string | null;
  summary: string | null; updatedAt: string; textual: boolean;
}
export interface WorkspaceInfo {
  level: 'write' | 'read'; isOwner: boolean; shareWorkspace: boolean;
  localRoot: string | null; localEnabled: boolean; localFolders: string[]; maxUploadMb: number;
}
export const WorkspaceSettingsBody = z.object({ shareWorkspace: z.boolean().optional(), localRoot: z.string().max(200).nullable().optional() });
export const SaveFileBody = z.object({ content: z.string().max(1_100_000) });

// ---- Project intelligence (analytics derived from meetings, decisions, tasks and their history) ----
export interface IntelTask {
  id: string; meetingId: string; meetingTitle: string; title: string; assignee: string | null;
  status: TaskStatusT; priority: string; category: string; department: string;
  dueDate: string | null; createdAt: string; completedAt: string | null;
  overdue: boolean; daysLate: number | null; rescheduled: number;
}
export type TaskStatusT = 'open' | 'in_progress' | 'review' | 'done';
export interface MeetingRef { id: string; title: string; at: string }
export interface Slice { key: string; label: string; total: number; done: number; overdue: number }
export interface Pattern { key: string; title: string; count: number; meetings: MeetingRef[]; firstSeen: string; lastSeen: string; resolved: boolean; who: string[] }
export interface Risk { id: string; severity: 'high' | 'medium' | 'low'; title: string; detail: string; drill?: { kind: 'tasks' | 'conflicts' | 'patterns' | 'changes'; assignee?: string; filter?: 'overdue' | 'review' } }
export interface StatementChange { key: string; label: string; kind: 'decision' | 'deadline'; from: string; to: string; fromBy: string | null; by: string | null; at: string; fromAt: string; meeting: MeetingRef | null; fromMeeting: MeetingRef | null; contradictsOther: boolean }
export interface PersonStats { name: string; assigned: number; done: number; open: number; overdue: number; late: number; onTime: number; onTimeRate: number | null; avgDelayDays: number; share: number; rescheduled: number }
export interface TimelineItem { at: string; type: 'meeting' | 'decision' | 'conflict' | 'change' | 'done' | 'overdue'; title: string; detail?: string; meetingId?: string }
export interface ProjectIntelligence {
  generatedAt: string; today: string; weeks: number;
  health: { score: number | null; label: 'on_track' | 'at_risk' | 'critical' | 'no_data'; drivers: { key: string; label: string; score: number; weight: number; note: string }[]; risks: Risk[] };
  kpis: { totalTasks: number; done: number; inProgress: number; review: number; pending: number; overdue: number; completionRate: number; onTimeRate: number | null; conflicts: number; reversals: number; openBlockers: number; meetings: number; decisions: number };
  trend: { week: string; created: number; completed: number; conflicts: number }[];
  classification: { category: Slice[]; priority: Slice[]; department: Slice[]; assignee: Slice[] };
  patterns: { recurringTasks: Pattern[]; recurringBlockers: Pattern[]; unresolved: Pattern[] };
  commitments: { total: number; delivered: number; deliveredLate: number; missed: number; pending: number; rescheduled: number; reliability: number | null;
    byMeeting: (MeetingRef & { made: number; delivered: number; late: number; missed: number })[] };
  conflicts: { total: number; items: { id: string; title: string; body: string; at: string; source: string | null; meeting: MeetingRef | null }[] };
  statementChanges: StatementChange[];
  accountability: { people: PersonStats[]; team: { assigned: number; done: number; overdue: number; onTimeRate: number | null; avgDelayDays: number } };
  timeline: TimelineItem[];
  tasks: IntelTask[];
}

// ---- Per-meeting insights ----
export type MomentType = 'decision' | 'task' | 'deadline' | 'question' | 'blocker' | 'info' | 'conflict';
export interface Moment {
  id: string; type: MomentType; title: string; who: string | null; quote: string | null;
  seq: number | null; atMs: number | null; at: string;
  changedFrom: { value: string; meeting: MeetingRef | null } | null;   // decisions that replaced an earlier value
  raisedBefore: MeetingRef[];                                           // same topic in earlier meetings
}
export interface MeetingSummary {
  readable: boolean;                  // false when the owner has not shared the conversation with this viewer
  recap: { title: string; body: string; createdAt: string } | null;
  kpis: { lines: number; words: number; speakers: number; decisions: number; tasks: number; questions: number; blockers: number; conflicts: number; messages: number };
  speakers: { name: string; lines: number; words: number; share: number; minutes: number }[];
  pulse: { label: string; lines: number; marks: Partial<Record<MomentType, number>> }[];
  moments: Moment[];
  tasks: { total: number; done: number; overdue: number; unassigned: number; byStatus: Record<TaskStatusT, number>; byAssignee: { name: string; total: number; done: number }[] };
}

// ---- project repositories (docs/09 §1.10)
export interface GithubRepoRef { owner: string; name: string }
/** Accepts https://github.com/owner/name (with .git, a trailing slash, or /tree/... after it) or plain owner/name. Anything else is refused. */
export function parseGithubRepo(input: string): GithubRepoRef | null {
  const s = String(input ?? '').trim();
  if (!s || s.length > 300 || /[\s\0]/.test(s)) return null;
  const owner = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})', name = '[A-Za-z0-9._-]{1,100}';
  const m = new RegExp(`^https://github\\.com/(${owner})/(${name}?)(?:\\.git)?(?:/(?:tree|blob|pulls?|issues?|commits?)/[^?#]*)?/?(?:[?#].*)?$`, 'i').exec(s)
    ?? new RegExp(`^(${owner})/(${name}?)(?:\\.git)?$`, 'i').exec(s);
  if (!m) return null;
  const repo = m[2].replace(/\.git$/i, '');
  if (repo === '.' || repo === '..' || !repo) return null;
  return { owner: m[1], name: repo };
}
export const AddRepoBody = z.object({ url: z.string().trim().min(3).max(300), description: z.string().trim().max(300).optional() });
export const UpdateRepoBody = z.object({ description: z.string().trim().max(300).nullable() });
export const GithubTokenBody = z.object({ token: z.string().trim().min(20).max(255).regex(/^[A-Za-z0-9_\-]+$/, 'that does not look like a GitHub token') });
export const MAX_PROJECT_REPOS = 10;
export interface ProjectRepo {
  id: string; owner: string; name: string; fullName: string; url: string; defaultBranch: string; description: string | null; githubDescription: string | null;
  isPrivate: boolean; canPush: boolean; language: string | null; languages: Record<string, number>; indexedAt: string | null; createdAt: string;
}
export interface GithubStatus { connected: boolean; account: string | null }

// ---- unified diff parsing (Code agent review)
export interface PatchLine { type: 'ctx' | 'add' | 'del' | 'note'; text: string; oldNo: number | null; newNo: number | null }
export interface PatchHunk { header: string; lines: PatchLine[] }
export interface PatchFile { path: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; hunks: PatchHunk[] }
/** Parses the `diff --git` unified diffs the Code agent produces. Tolerant of junk; never throws. */
export function parseDiff(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null, hunk: PatchHunk | null = null, o = 0, n = 0;
  for (const raw of String(text ?? '').split('\n')) {
    const g = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (g) { file = { path: g[2], status: 'modified', additions: 0, deletions: 0, hunks: [] }; files.push(file); hunk = null; continue; }
    if (!file) continue;
    if (raw.startsWith('new file mode')) { file.status = 'added'; continue; }
    if (raw.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
    if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('index ') || raw.startsWith('similarity ') || raw.startsWith('rename ')) { if (!hunk) continue; }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { hunk = { header: raw, lines: [] }; file.hunks.push(hunk); o = Number(h[1]); n = Number(h[2]); continue; }
    if (!hunk) continue;
    if (raw.startsWith('\\')) { hunk.lines.push({ type: 'note', text: raw.slice(2), oldNo: null, newNo: null }); continue; }
    const c = raw[0], body = raw.slice(1);
    if (c === '+') { hunk.lines.push({ type: 'add', text: body, oldNo: null, newNo: n++ }); file.additions++; }
    else if (c === '-') { hunk.lines.push({ type: 'del', text: body, oldNo: o++, newNo: null }); file.deletions++; }
    else if (c === ' ') { hunk.lines.push({ type: 'ctx', text: body, oldNo: o++, newNo: n++ }); }
  }
  return files;
}
