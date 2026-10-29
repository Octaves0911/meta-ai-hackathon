import type { FastifyInstance } from 'fastify';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import type { RoomPeer } from '@meetpilot/shared';
import { leaveMeeting } from './services/sessions.js';

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
    emitToUser: (userId: string, event: string, payload: unknown) => void;
  }
}

const roomOf = (meetingId: string) => `meeting:${meetingId}`;
const JoinBody = z.object({ meetingId: z.string().uuid() });
const RelayBody = z.object({ to: z.string() }).passthrough();

/**
 * Socket.IO on the Fastify HTTP server.
 * - every socket joins `user:<id>` (notifications)
 * - `room:join` puts it in `meeting:<id>` and relays WebRTC signaling between peers (docs/03 §2)
 */
export function attachRealtime(app: FastifyInstance) {
  const io = new Server(app.server, { serveClient: false });

  io.use(async (socket, next) => {
    const name = socket.handshake.auth?.username;
    if (typeof name !== 'string') return next(new Error('unauthenticated'));
    const { rows } = await app.db.query('select id, username from users where username = $1', [name.toLowerCase()]);
    if (!rows[0]) return next(new Error('unknown_user'));
    socket.data.userId = rows[0].id;
    socket.data.username = rows[0].username;
    next();
  });

  /** Leave the call room; flush duration only when this was the user's last socket in it. */
  async function leaveRoom(socket: Socket) {
    const meetingId: string | undefined = socket.data.meetingId;
    if (!meetingId) return;
    socket.data.meetingId = undefined;
    socket.leave(roomOf(meetingId));
    socket.to(roomOf(meetingId)).emit('peer:left', { userId: socket.data.userId, socketId: socket.id });
    const others = await io.in(roomOf(meetingId)).fetchSockets();
    if (!others.some((s) => s.data.userId === socket.data.userId)) {
      await leaveMeeting(app.db, meetingId, socket.data.userId).catch((e) => app.log.error(e));
    }
  }

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);

    socket.on('room:join', async (raw, ack?: (r: unknown) => void) => {
      try {
        const { meetingId } = JoinBody.parse(raw);
        const { rows } = await app.db.query(
          `select m.status, p.invite_status from meetings m
           join meeting_participants p on p.meeting_id = m.id and p.user_id = $2 where m.id = $1`,
          [meetingId, socket.data.userId]);
        if (!rows[0]) return ack?.({ error: 'not_found' });
        if (rows[0].status !== 'active') return ack?.({ error: 'meeting_over' });
        if (rows[0].invite_status !== 'joined') return ack?.({ error: 'not_joined' });

        if (socket.data.meetingId && socket.data.meetingId !== meetingId) await leaveRoom(socket);
        const existing = await io.in(roomOf(meetingId)).fetchSockets();
        const peers: RoomPeer[] = existing
          .filter((s) => s.id !== socket.id)
          .map((s) => ({ userId: s.data.userId, socketId: s.id, name: s.data.username }));
        socket.data.meetingId = meetingId;
        socket.join(roomOf(meetingId));
        socket.to(roomOf(meetingId)).emit('peer:joined', { userId: socket.data.userId, socketId: socket.id, name: socket.data.username });
        ack?.({ peers });
      } catch {
        ack?.({ error: 'invalid_request' });
      }
    });

    socket.on('room:leave', async (_raw, ack?: () => void) => {
      await leaveRoom(socket);
      ack?.();
    });

    // WebRTC signaling is relayed only between sockets that share the caller's meeting room.
    for (const event of ['rtc:offer', 'rtc:answer', 'rtc:ice', 'rtc:retry'] as const) {
      socket.on(event, (raw) => {
        const parsed = RelayBody.safeParse(raw);
        const meetingId: string | undefined = socket.data.meetingId;
        if (!parsed.success || !meetingId) return;
        const { to, ...rest } = parsed.data;
        const target = io.sockets.sockets.get(to);
        if (!target || target.data.meetingId !== meetingId) return;
        target.emit(event, { ...rest, from: socket.id, userId: socket.data.userId, name: socket.data.username });
      });
    }

    socket.on('disconnect', () => { void leaveRoom(socket); });
  });

  app.decorate('io', io);
  app.decorate('emitToUser', (userId: string, event: string, payload: unknown) => {
    io.to(`user:${userId}`).emit(event, payload);
  });
  app.addHook('onClose', async () => { io.close(); });
}
