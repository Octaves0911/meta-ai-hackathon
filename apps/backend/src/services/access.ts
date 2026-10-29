import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../app.js';
import { HttpError } from '../errors.js';

/** Participant row merged into the meeting, or 404 (outsiders cannot learn that a meeting exists). */
export async function participation(app: FastifyInstance, meetingId: string, me: AuthUser) {
  if (!z.string().uuid().safeParse(meetingId).success) throw new HttpError(404, 'not_found', 'meeting not found');
  const { rows } = await app.db.query(
    `select m.*, p.invite_status, p.last_session_started_at
     from meetings m join meeting_participants p on p.meeting_id = m.id and p.user_id = $2
     where m.id = $1`, [meetingId, me.id]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'meeting not found');
  return rows[0];
}

/** Chat and transcript are readable by the owner, by anyone when shared, or by whoever is in the call (F2.6). */
export function canReadConversation(m: any, me: AuthUser): boolean {
  return m.owner_id === me.id || m.share_chat_transcript || !!m.last_session_started_at;
}
