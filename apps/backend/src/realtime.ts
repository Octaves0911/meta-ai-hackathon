import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
    emitToUser: (userId: string, event: string, payload: unknown) => void;
  }
}

/** Socket.IO on the Fastify HTTP server. Each socket joins `user:<id>` for notifications. */
export function attachRealtime(app: FastifyInstance) {
  const io = new Server(app.server, { serveClient: false });

  io.use(async (socket, next) => {
    const name = socket.handshake.auth?.username;
    if (typeof name !== 'string') return next(new Error('unauthenticated'));
    const { rows } = await app.db.query('select id from users where username = $1', [name.toLowerCase()]);
    if (!rows[0]) return next(new Error('unknown_user'));
    socket.data.userId = rows[0].id;
    next();
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);
  });

  app.decorate('io', io);
  app.decorate('emitToUser', (userId: string, event: string, payload: unknown) => {
    io.to(`user:${userId}`).emit(event, payload);
  });
  app.addHook('onClose', async () => { io.close(); });
}
