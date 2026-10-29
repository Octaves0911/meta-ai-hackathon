import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Analytics } from './analytics.js';
import { Metrics } from './metrics.js';
import { RateLimiter, ROUTE_LIMITS } from './rateLimit.js';

declare module 'fastify' {
  interface FastifyInstance { metrics: Metrics; analytics: Analytics; limiter: RateLimiter }
}

const EXEMPT = /^\/(health|metrics)/;
const probe = async (url: string): Promise<'ok' | 'down'> => {
  try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok ? 'ok' : 'down'; } catch { return 'down'; }
};

/** Request ids, rate limits, security headers, metrics, readiness and analytics. Registered before any route. */
export function registerOps(app: FastifyInstance) {
  const metrics = new Metrics();
  const perMin = Number(process.env.RATE_LIMIT_PER_MIN ?? 120);
  const limiter = new RateLimiter(perMin);
  limiter.startSweeper();
  const routeLimiters = ROUTE_LIMITS.map((r) => ({ ...r, rl: new RateLimiter(Math.min(r.perMin, perMin > 0 ? r.perMin : 0)) }));
  routeLimiters.forEach((r) => r.rl.startSweeper());
  const analytics = new Analytics(app.db, metrics, app.log);
  app.decorate('metrics', metrics);
  app.decorate('analytics', analytics);
  app.decorate('limiter', limiter);
  app.addHook('onClose', async () => { limiter.stop(); routeLimiters.forEach((r) => r.rl.stop()); clearInterval(depthTimer); });

  // ---- gauges ----
  const started = Date.now();
  let jobDepth: { labels: { status: string }; value: number }[] = [];
  const refreshDepth = () => app.db.query('select status, count(*)::int n from jobs group by status').then((r) => { jobDepth = r.rows.map((x) => ({ labels: { status: x.status }, value: x.n })); }).catch(() => {});
  const depthTimer = setInterval(refreshDepth, 15_000).unref();
  void refreshDepth();
  metrics.gauge('meetpilot_websocket_clients', 'Connected Socket.IO clients', () => app.io?.engine?.clientsCount ?? 0);
  metrics.gauge('meetpilot_jobs', 'Background jobs by status', () => jobDepth);
  metrics.gauge('process_uptime_seconds', 'Process uptime', () => (Date.now() - started) / 1000);
  metrics.gauge('nodejs_heap_used_bytes', 'Heap used', () => process.memoryUsage().heapUsed);
  metrics.gauge('meetpilot_db_pool_connections', 'Postgres pool connections', () => [
    { labels: { state: 'total' }, value: app.db.totalCount }, { labels: { state: 'idle' }, value: app.db.idleCount }, { labels: { state: 'waiting' }, value: app.db.waitingCount }]);

  // ---- rate limits (per user, falling back to IP) ----
  app.addHook('onRequest', async (req, reply) => {
    if (EXEMPT.test(req.url) || !req.url.startsWith('/api/')) return;
    const path = req.url.split('?')[0];
    const who = typeof req.headers['x-user'] === 'string' && req.headers['x-user'] ? `u:${String(req.headers['x-user']).toLowerCase()}` : `ip:${req.ip}`;
    const special = routeLimiters.find((r) => r.method === req.method && r.match.test(path));
    const checks: [string, ReturnType<RateLimiter['check']>, number][] = [['general', limiter.check(who), perMin]];
    if (special) checks.push([special.name, special.rl.check(`${special.name}:${who}`), special.perMin]);
    const hit = checks.find(([, r]) => !r.allowed);
    const shown = checks[checks.length - 1];
    if (perMin > 0) reply.header('x-ratelimit-limit', shown[2]).header('x-ratelimit-remaining', shown[1].remaining);
    if (hit) {
      metrics.inc('meetpilot_rate_limited_total', 'Requests rejected by the rate limiter', { scope: hit[0] });
      return reply.status(429).header('retry-after', hit[1].retryAfterSec).send({ error: { code: 'rate_limited', message: `too many requests; retry in ${hit[1].retryAfterSec}s` } });
    }
  });

  // ---- security headers + request id ----
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('x-frame-options')) reply.header('x-frame-options', 'DENY');
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'no-referrer');
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  // ---- request metrics (route templates, never raw URLs, so labels stay low-cardinality) ----
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    metrics.inc('http_requests_total', 'HTTP requests', { method: req.method, route, status: reply.statusCode });
    metrics.observe('http_request_duration_seconds', 'HTTP request latency', reply.elapsedTime / 1000, { method: req.method, route });
  });

  // ---- operational endpoints ----
  app.get('/health/ready', async (_req, reply) => {
    const db = await app.db.query('select 1').then(() => 'ok' as const, () => 'down' as const);
    const [ai, connector] = await Promise.all([probe(process.env.AI_URL ?? 'http://localhost:5001'), probe(process.env.CONNECTOR_URL ?? 'http://localhost:6100')]);
    // Only the database is required to serve; the AI service and connector degrade features, not the room.
    const body = { service: 'backend', status: db === 'ok' ? (ai === 'ok' && connector === 'ok' ? 'ok' : 'degraded') : 'down', db, ai, connector, uptimeSec: Math.round((Date.now() - started) / 1000) };
    return reply.status(db === 'ok' ? 200 : 503).send(body);
  });

  app.get('/metrics', async (req, reply) => {
    const given = String(req.headers['x-internal-secret'] ?? ''), want = process.env.INTERNAL_SECRET ?? '';
    if (!want || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want))) return reply.status(401).send({ error: { code: 'unauthorized', message: 'invalid internal secret' } });
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render());
  });
}
