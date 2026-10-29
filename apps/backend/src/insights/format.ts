import type { Insight } from '@meetpilot/shared';

export const toInsight = (r: any): Insight => ({
  id: r.id, meetingId: r.meeting_id, kind: r.kind, tier: r.tier, title: r.title, body: r.body, quote: r.quote,
  sourceLabel: r.source_label, sourceUrl: r.source_url, score: r.score, topicKey: r.topic_key,
  private: r.audience_user_id != null, feedback: r.feedback, deliveredToChat: r.delivered_to_chat, createdAt: r.created_at,
});

/** Column list for insights joined into chat messages (prefixed to avoid clashes). */
export const INSIGHT_COLS = `i.id as i_id, i.meeting_id as i_meeting_id, i.kind as i_kind, i.tier as i_tier, i.title as i_title,
  i.body as i_body, i.quote as i_quote, i.source_label as i_source_label, i.source_url as i_source_url, i.score as i_score,
  i.topic_key as i_topic_key, i.audience_user_id as i_audience_user_id, i.feedback as i_feedback,
  i.delivered_to_chat as i_delivered_to_chat, i.created_at as i_created_at`;

export function insightFromJoined(r: any): Insight | null {
  if (!r.i_id) return null;
  return toInsight({
    id: r.i_id, meeting_id: r.i_meeting_id, kind: r.i_kind, tier: r.i_tier, title: r.i_title, body: r.i_body, quote: r.i_quote,
    source_label: r.i_source_label, source_url: r.i_source_url, score: r.i_score, topic_key: r.i_topic_key,
    audience_user_id: r.i_audience_user_id, feedback: r.i_feedback, delivered_to_chat: r.i_delivered_to_chat, created_at: r.i_created_at,
  });
}
