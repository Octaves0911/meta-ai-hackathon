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
