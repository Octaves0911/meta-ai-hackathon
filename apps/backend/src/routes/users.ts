import type { FastifyInstance } from 'fastify';
import { CreateUserBody, type User } from '@meetpilot/shared';
import { requireUser } from '../app.js';
import { HttpError } from '../errors.js';
import { connector } from '../services/connector.js';

const toUser = (r: any): User => ({ id: r.id, username: r.username, createdAt: r.created_at });

export async function userRoutes(app: FastifyInstance) {
  app.get('/users', async () => {
    const { rows } = await app.db.query('select id, username, created_at from users order by username');
    return rows.map(toUser);
  });

  app.post('/users', async (req, reply) => {
    const { username } = CreateUserBody.parse(req.body);
    const { rows } = await app.db.query(
      'insert into users(username) values ($1) on conflict do nothing returning id, username, created_at',
      [username],
    );
    if (!rows[0]) throw new HttpError(409, 'username_taken', 'username already exists');
    return reply.status(201).send(toUser(rows[0]));
  });

  // Account deletion cascades to owned projects and all derived data (F1.6).
  app.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const me = await requireUser(app, req);
    if (me.id !== req.params.id) throw new HttpError(403, 'forbidden', 'can only delete your own account');
    // Projects this account owns disappear with it, so their members' connections must be revoked too.
    const owned = await app.db.query('select id from projects where owner_id = $1', [me.id]);
    for (const p of owned.rows) await connector(`/projects/${p.id}/purge`, { method: 'POST' }).catch((e) => app.log.error(e, 'connector purge failed'));
    await connector(`/users/${me.id}/purge`, { method: 'POST' }).catch((e) => app.log.error(e, 'connector purge failed'));
    await app.db.query('delete from users where id = $1', [me.id]);
    return reply.status(204).send();
  });
}
