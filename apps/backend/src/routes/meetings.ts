import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CreateMeetingBody, type Meeting, type MeetingDetail } from '@meetpilot/shared';
import { requireUser, type AuthUser } from '../app.js';
import { HttpError } from '../errors.js';
import { createNotification } from '../services/notifications.js';
import { flushSegment, leaveMeeting } from '../services/sessions.js';
import { indexMeetingTranscript } from '../memory/store.js';

const MEETING_SELECT = `select m.*, u.username as owner_name from meetings m join users u on u.id = m.owner_id`;

const toMeeting = (r: any): Meeting => ({
  id: r.id, projectId: r.project_id, ownerId: r.owner_id, ownerName: r.owner_name,
  title: r.title, description: r.description, status: r.status,
  scheduledAt: r.scheduled_at, startedAt: r.started_at, endedAt: r.ended_at,
  totalDurationSec: r.total_duration_sec, shareChatTranscript: r.share_chat_transcript,
  shareWorkspace: r.share_workspace, aiAssist: r.ai_assist, createdAt: r.created_at,
});

export async function meetingRoutes(app: FastifyInstance) {
  async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await app.db.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  /** Meeting visible to its owner, its participants and members of its project. */
  async function loadMeeting(id: string, me: AuthUser) {
    if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'not_found', 'meeting not found');
    const { rows } = await app.db.query(
      `${MEETING_SELECT} where m.id = $1 and (
         m.owner_id = $2
         or exists (select 1 from meeting_participants p where p.meeting_id = m.id and p.user_id = $2)
         or exists (select 1 from project_members pm where pm.project_id = m.project_id and pm.user_id = $2))`,
      [id, me.id],
    );
    if (!rows[0]) throw new HttpError(404, 'not_found', 'meeting not found');
    return rows[0];
  }

  async function sendInvites(meeting: any, projectName: string, inviter: AuthUser, userIds: string[]) {
    for (const userId of userIds) {
      if (userId === meeting.owner_id) continue;
      const { rows } = await app.db.query(
        `insert into meeting_participants(meeting_id, user_id) values ($1,$2) on conflict do nothing returning user_id`,
        [meeting.id, userId],
      );
      if (!rows[0]) continue; // already invited
      await createNotification(app, userId, 'invite', {
        meetingId: meeting.id, meetingTitle: meeting.title, projectName, invitedBy: inviter.username,
        scheduledAt: meeting.scheduled_at,
      });
    }
  }

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/projects/:id/meetings', async (req) => {
    const me = await requireUser(app, req);
    const { rows: member } = await app.db.query('select 1 from project_members where project_id = $1 and user_id = $2', [req.params.id, me.id]);
    if (!member[0]) throw new HttpError(404, 'not_found', 'project not found');
    const status = req.query.status;
    const { rows } = await app.db.query(
      `${MEETING_SELECT} where m.project_id = $1 and ($2::text is null or m.status = $2)
       order by coalesce(m.scheduled_at, m.created_at) desc limit 200`,
      [req.params.id, status ?? null],
    );
    return rows.map(toMeeting);
  });

  app.post<{ Params: { id: string } }>('/projects/:id/meetings', async (req, reply) => {
    const me = await requireUser(app, req);
    const body = CreateMeetingBody.parse(req.body);
    const { rows: pr } = await app.db.query(
      `select p.name from projects p join project_members pm on pm.project_id = p.id and pm.user_id = $2 where p.id = $1`,
      [req.params.id, me.id],
    );
    if (!pr[0]) throw new HttpError(404, 'not_found', 'project not found');
    if (body.inviteeIds.length) {
      const { rows } = await app.db.query('select id from users where id = any($1::uuid[])', [body.inviteeIds]);
      if (rows.length !== new Set(body.inviteeIds).size) throw new HttpError(400, 'invalid_invitee', 'unknown invitee');
    }
    // A meeting with a schedule is "scheduled" until someone joins; otherwise it is an instant call (F2.2).
    const status = body.scheduledAt ? 'scheduled' : 'active';
    const meeting = await inTx(async (c) => {
      const { rows } = await c.query(
        `insert into meetings(project_id, owner_id, title, description, status, scheduled_at, share_chat_transcript, share_workspace)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [req.params.id, me.id, body.title, body.description ?? null, status, body.scheduledAt ?? null, body.shareChatTranscript, body.shareWorkspace],
      );
      await c.query("insert into meeting_participants(meeting_id, user_id, invite_status) values ($1,$2,'accepted')", [rows[0].id, me.id]);
      return rows[0];
    });
    await sendInvites(meeting, pr[0].name, me, body.inviteeIds);
    return reply.status(201).send(toMeeting({ ...meeting, owner_name: me.username }));
  });

  app.get<{ Params: { id: string } }>('/meetings/:id', async (req): Promise<MeetingDetail> => {
    const me = await requireUser(app, req);
    const m = await loadMeeting(req.params.id, me);
    const [parts, proj, counts] = await Promise.all([
      app.db.query(
        `select p.user_id, u.username, p.invite_status from meeting_participants p join users u on u.id = p.user_id
         where p.meeting_id = $1 order by u.username`, [m.id]),
      app.db.query('select name from projects where id = $1', [m.project_id]),
      app.db.query(
        `select (select count(*)::int from chat_messages where meeting_id = $1) messages,
                (select count(*)::int from personal_notes where meeting_id = $1) notes,
                (select count(*)::int from transcript_segments where meeting_id = $1) segments`, [m.id]),
    ]);
    const participants = parts.rows.map((r) => ({ userId: r.user_id, username: r.username, inviteStatus: r.invite_status }));
    return {
      ...toMeeting(m),
      projectName: proj.rows[0].name,
      participants,
      myInviteStatus: participants.find((p) => p.userId === me.id)?.inviteStatus ?? null,
      stats: { messages: counts.rows[0].messages, notes: counts.rows[0].notes, transcriptSegments: counts.rows[0].segments },
    };
  });

  app.post<{ Params: { id: string } }>('/meetings/:id/invite', async (req, reply) => {
    const me = await requireUser(app, req);
    const { userIds } = z.object({ userIds: z.array(z.string().uuid()).min(1).max(50) }).parse(req.body);
    const m = await loadMeeting(req.params.id, me);
    if (m.owner_id !== me.id) throw new HttpError(403, 'forbidden', 'owner only');
    if (m.status === 'ended' || m.status === 'closed') throw new HttpError(409, 'meeting_over', 'meeting has ended');
    const { rows } = await app.db.query('select id from users where id = any($1::uuid[])', [userIds]);
    if (rows.length !== new Set(userIds).size) throw new HttpError(400, 'invalid_invitee', 'unknown invitee');
    const { rows: pr } = await app.db.query('select name from projects where id = $1', [m.project_id]);
    await sendInvites(m, pr[0].name, me, userIds);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/meetings/:id/respond', async (req, reply) => {
    const me = await requireUser(app, req);
    const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
    const m = await loadMeeting(req.params.id, me);
    const { rowCount } = await app.db.query(
      `update meeting_participants set invite_status = $3
       where meeting_id = $1 and user_id = $2 and invite_status in ('invited','accepted','declined')`,
      [m.id, me.id, accept ? 'accepted' : 'declined'],
    );
    if (!rowCount) throw new HttpError(409, 'not_invited', 'no pending invitation');
    return reply.status(204).send();
  });

  // scheduled -> active on first join; ended/closed meetings cannot be re-joined (F2.5).
  app.post<{ Params: { id: string } }>('/meetings/:id/join', async (req) => {
    const me = await requireUser(app, req);
    const m = await loadMeeting(req.params.id, me);
    if (m.status === 'ended' || m.status === 'closed') throw new HttpError(409, 'meeting_over', 'meeting has ended');
    const { rows: part } = await app.db.query(
      'select invite_status from meeting_participants where meeting_id = $1 and user_id = $2', [m.id, me.id]);
    if (!part[0]) throw new HttpError(403, 'not_invited', 'you are not a participant of this meeting');
    if (part[0].invite_status === 'declined') throw new HttpError(403, 'declined', 'you declined this invitation');
    await inTx(async (c) => {
      await c.query(
        `update meetings set status = 'active', started_at = coalesce(started_at, now()),
           segment_started_at = coalesce(segment_started_at, now()) where id = $1`, [m.id]);
      await c.query(
        `update meeting_participants set invite_status = 'joined', joined_at = coalesce(joined_at, now()),
           last_session_started_at = now() where meeting_id = $1 and user_id = $2`, [m.id, me.id]);
    });
    return { status: 'active' };
  });

  app.post<{ Params: { id: string } }>('/meetings/:id/leave', async (req, reply) => {
    const me = await requireUser(app, req);
    const m = await loadMeeting(req.params.id, me);
    await leaveMeeting(app.db, m.id, me.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/meetings/:id/end', async (req, reply) => {
    const me = await requireUser(app, req);
    const m = await loadMeeting(req.params.id, me);
    if (m.owner_id !== me.id) throw new HttpError(403, 'forbidden', 'only the owner can end the meeting');
    if (m.status !== 'active') throw new HttpError(409, 'not_active', 'meeting is not active');
    await inTx(async (c) => {
      await flushSegment(c, m.id);
      await c.query("update meetings set status = 'ended', ended_at = now() where id = $1", [m.id]);
      await c.query('update meeting_participants set last_session_started_at = null where meeting_id = $1', [m.id]);
    });
    app.io.to(`meeting:${m.id}`).emit('meeting:ended', { meetingId: m.id });
    app.closeCaptions(m.id);
    // Make this meeting's discussion searchable for future meetings; failures must not affect ending the meeting.
    indexMeetingTranscript(app.db, app.embedder, m.id).catch((e) => app.log.error(e, 'transcript indexing failed'));
    return reply.status(204).send();
  });

  app.delete<{ Params: { id: string } }>('/meetings/:id', async (req, reply) => {
    const me = await requireUser(app, req);
    const m = await loadMeeting(req.params.id, me);
    if (m.owner_id !== me.id) throw new HttpError(403, 'forbidden', 'owner only');
    await app.db.query('delete from meetings where id = $1', [m.id]);
    return reply.status(204).send();
  });
}
