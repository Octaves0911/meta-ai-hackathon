import type { FastifyInstance } from 'fastify';
import { Events, SaveNoteBody, SendMessageBody, type ChatMessage, type PersonalNote } from '@meetpilot/shared';
import { requireUser, type AuthUser } from '../app.js';
import { HttpError } from '../errors.js';
import { canReadConversation, participation as participationFor } from '../services/access.js';

const toMessage = (r: any): ChatMessage => ({
  id: r.id, meetingId: r.meeting_id, userId: r.user_id, username: r.username ?? null,
  kind: r.kind, body: r.body, createdAt: r.created_at,
});

export async function roomRoutes(app: FastifyInstance) {
  const participation = (id: string, me: AuthUser) => participationFor(app, id, me);

  // Chat is readable by the owner, by anyone when the owner shared it, or by whoever is currently in the call (F2.6).
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>('/meetings/:id/messages', async (req) => {
    const me = await requireUser(app, req);
    const m = await participation(req.params.id, me);
    if (!canReadConversation(m, me)) {
      throw new HttpError(403, 'forbidden', 'chat is not shared for this meeting');
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const before = req.query.before ? new Date(req.query.before) : null;
    if (before && Number.isNaN(before.getTime())) throw new HttpError(400, 'invalid_request', 'bad before cursor');
    // Newest first; the client reverses for display and pages older with `before`.
    const { rows } = await app.db.query(
      `select c.*, u.username from chat_messages c left join users u on u.id = c.user_id
       where c.meeting_id = $1 and ($2::timestamptz is null or c.created_at < $2)
       order by c.created_at desc limit $3`,
      [m.id, before, limit],
    );
    return rows.map(toMessage);
  });

  app.post<{ Params: { id: string } }>('/meetings/:id/messages', async (req, reply) => {
    const me = await requireUser(app, req);
    const { body } = SendMessageBody.parse(req.body);
    const m = await participation(req.params.id, me);
    if (m.status !== 'active' || m.invite_status !== 'joined') throw new HttpError(409, 'not_in_call', 'join the active meeting to chat');
    const { rows } = await app.db.query(
      "insert into chat_messages(meeting_id, user_id, kind, body) values ($1,$2,'user',$3) returning *", [m.id, me.id, body]);
    const msg = toMessage({ ...rows[0], username: me.username });
    app.io.to(`meeting:${m.id}`).emit(Events.chatMessage, msg);
    return reply.status(201).send(msg);
  });

  // Personal notes are private to their author (F3.5).
  app.get<{ Params: { id: string } }>('/meetings/:id/notes', async (req): Promise<PersonalNote> => {
    const me = await requireUser(app, req);
    const m = await participation(req.params.id, me);
    const { rows } = await app.db.query('select body, updated_at from personal_notes where meeting_id = $1 and user_id = $2', [m.id, me.id]);
    return { body: rows[0]?.body ?? '', updatedAt: rows[0]?.updated_at ?? null };
  });

  app.put<{ Params: { id: string } }>('/meetings/:id/notes', async (req): Promise<PersonalNote> => {
    const me = await requireUser(app, req);
    const { body } = SaveNoteBody.parse(req.body);
    const m = await participation(req.params.id, me);
    const { rows } = await app.db.query(
      `insert into personal_notes(meeting_id, user_id, body) values ($1,$2,$3)
       on conflict (meeting_id, user_id) do update set body = excluded.body, updated_at = now()
       returning body, updated_at`, [m.id, me.id, body]);
    return { body: rows[0].body, updatedAt: rows[0].updated_at };
  });
}
