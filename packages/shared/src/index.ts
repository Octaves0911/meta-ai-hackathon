import { z } from 'zod';

export const MeetingStatus = z.enum(['scheduled', 'active', 'ended', 'closed']);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

export const InsightKind = z.enum([
  'conflict', 'answer', 'reminder', 'context', 'no_record', 'external', 'brief', 'recap',
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
} as const;

export const SERVICE_PORTS = { web: 5173, backend: 4000, ai: 5001, connector: 6000 } as const;

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
}
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
