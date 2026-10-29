import type { FastifyInstance } from 'fastify';
import { requireUser } from '../app.js';
import { toNotification } from '../services/notifications.js';

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/notifications', async (req) => {
    const me = await requireUser(app, req);
    const { rows } = await app.db.query(
      'select id, type, payload, read_at, created_at from notifications where user_id = $1 order by created_at desc limit 50',
      [me.id],
    );
    return rows.map(toNotification);
  });

  app.post<{ Params: { id: string } }>('/notifications/:id/read', async (req, reply) => {
    const me = await requireUser(app, req);
    await app.db.query('update notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null', [req.params.id, me.id]);
    return reply.status(204).send();
  });
}
