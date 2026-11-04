import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/**
 * Single-origin deployment: when WEB_DIST points at the built web app (apps/web/dist), the backend serves it too, so the
 * browser talks to one host for pages, /api, /socket.io and /stt (no CORS, one public URL). Unset in development, where Vite serves the pages.
 */
export function serveWeb(app: FastifyInstance, dist = process.env.WEB_DIST): boolean {
  if (!dist) return false;
  const root = path.resolve(dist);
  if (!existsSync(path.join(root, 'index.html'))) {
    app.log.warn({ root }, 'WEB_DIST has no index.html; not serving the web app');
    return false;
  }
  app.register(fastifyStatic, {
    root,
    wildcard: false,
    cacheControl: false, // set per file below
    // Hashed assets never change; the page shell must always be revalidated so a new deploy is picked up.
    setHeaders: (res, file) => res.setHeader('cache-control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  app.setNotFoundHandler((req, reply) => {
    const p = req.url.split('?')[0];
    const apiLike = p.startsWith('/api/') || p === '/api' || p.startsWith('/socket.io') || p.startsWith('/stt');
    if (req.method === 'GET' && !apiLike && !path.extname(p)) return reply.sendFile('index.html'); // client-side routes (/reviews/:id, /room/:id…)
    return reply.status(404).send({ error: { code: 'not_found', message: 'not found' } });
  });
  return true;
}
