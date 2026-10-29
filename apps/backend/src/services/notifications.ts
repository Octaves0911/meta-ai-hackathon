import type { FastifyInstance } from 'fastify';

export type NotificationType = 'invite' | 'review_ready';

export async function createNotification(app: FastifyInstance, userId: string, type: NotificationType, payload: object) {
  const { rows } = await app.db.query(
    'insert into notifications(user_id, type, payload) values ($1,$2,$3) returning id, type, payload, read_at, created_at',
    [userId, type, payload],
  );
  const n = toNotification(rows[0]);
  app.emitToUser(userId, 'notification:new', n);
  return n;
}

export const toNotification = (r: any) => ({ id: r.id, type: r.type, payload: r.payload, readAt: r.read_at, createdAt: r.created_at });
