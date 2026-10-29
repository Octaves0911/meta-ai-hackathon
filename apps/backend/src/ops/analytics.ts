// Product analytics (PRD §11). Events are IDs and categories only — never message text, transcript lines, file names or addresses.
import type { Pool } from 'pg';
import type { Metrics } from './metrics.js';

export const EVENTS = [
  'meeting_created', 'meeting_joined', 'captions_started', 'captions_error', 'ai_assist_toggled', 'insight_posted', 'insight_feedback',
  'ai_question_asked', 'task_created', 'meeting_closed', 'execution_routed', 'execution_review', 'integration_connected', 'email_sent',
] as const;
export type EventName = (typeof EVENTS)[number];

export interface EventContext { userId?: string | null; projectId?: string | null; meetingId?: string | null }
/** Only these property keys are stored; anything else (e.g. free text) is dropped. */
const ALLOWED_PROPS = new Set(['kind', 'tier', 'verdict', 'category', 'provider', 'enabled', 'reason', 'agent', 'durationSec', 'value']);
const SAFE_VALUE = /^[\w .:+-]{0,40}$/;

export function sanitizeProps(props: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!ALLOWED_PROPS.has(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && SAFE_VALUE.test(v)) out[k] = v;
  }
  return out;
}

export class Analytics {
  constructor(private db: Pool, private metrics: Metrics, private log: { error: (...a: any[]) => void }) {}

  /** Fire-and-forget: tracking must never slow down or break a request. */
  track(name: EventName, props: Record<string, unknown> = {}, ctx: EventContext = {}) {
    const p = sanitizeProps(props);
    this.metrics.inc('meetpilot_events_total', 'Product analytics events', { event: name, ...(p.kind ? { kind: String(p.kind) } : {}), ...(p.verdict ? { verdict: String(p.verdict) } : {}) });
    this.db.query('insert into events(name, props, user_id, project_id, meeting_id) values ($1,$2,$3,$4,$5)',
      [name, p, ctx.userId ?? null, ctx.projectId ?? null, ctx.meetingId ?? null]).catch((e) => this.log.error(e, 'analytics insert failed'));
  }
}
