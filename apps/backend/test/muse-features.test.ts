import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { parseChatImage, MAX_IMAGE_BYTES, toDataUrl } from '../src/agents/images.js';
import { aiToolRoutes } from '../src/routes/aiTools.js';
import { HttpError } from '../src/errors.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-image')]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif')]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);
const url = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

test('chat screenshots are accepted by their bytes, whatever the claimed type', () => {
  assert.equal(parseChatImage(url('image/png', png)).mime, 'image/png');
  assert.equal(parseChatImage(url('image/jpeg', jpg)).mime, 'image/jpeg');
  assert.equal(parseChatImage(url('image/webp', webp)).mime, 'image/webp');
  assert.equal(parseChatImage(url('image/png', jpg)).mime, 'image/jpeg');   // the real format wins over the label
  assert.equal(toDataUrl('image/png', png), url('image/png', png));
});

test('chat screenshots that are not real images, are too large, or are not data URLs are refused', () => {
  const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as HttpError).code; } };
  assert.equal(code(() => parseChatImage(url('image/png', Buffer.from('<html><script>alert(1)</script>')))), 'invalid_image');
  assert.equal(code(() => parseChatImage('https://example.com/a.png')), 'invalid_image');
  assert.equal(code(() => parseChatImage('data:image/svg+xml;base64,PHN2Zz4=')), 'invalid_image');
  assert.equal(code(() => parseChatImage('data:text/html;base64,PGI+')), 'invalid_image');
  assert.equal(code(() => parseChatImage('data:image/png;base64,')), 'invalid_image');
  assert.equal(code(() => parseChatImage(url('image/png', Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)])))), 'image_too_large');
});

// ---- lookup tools for the live assistant
function toolApp(rows: Record<string, any[]>, calls: { sql: string; params: unknown[] }[] = []) {
  const app = Fastify();
  app.decorate('db', { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); const key = /from decisions/.test(sql) ? 'decisions' : /from tasks/.test(sql) ? 'tasks' : 'memory'; return { rows: rows[key] ?? [] }; } } as any);
  app.decorate('embedder', { embed: async (xs: string[]) => xs.map(() => new Array(1536).fill(0.01)) } as any);
  app.setErrorHandler((err, _r, reply) => reply.status(err instanceof HttpError ? err.status : ((err as any).statusCode ?? 400)).send({ error: String(err.message) }));
  app.register(aiToolRoutes, { prefix: '/api' });
  return app;
}
const P = '8ff41350-216c-4617-9874-49c1b984b86b';
const call = (app: ReturnType<typeof toolApp>, body: unknown, secret = 'topsecret-topsecret-topsecret') =>
  app.inject({ method: 'POST', url: '/api/internal/ai-tools', headers: { 'x-internal-secret': secret }, payload: body as any });

test('the lookup tools need the shared secret and a valid request', async () => {
  process.env.INTERNAL_SECRET = 'topsecret-topsecret-topsecret';
  const app = toolApp({});
  assert.equal((await call(app, { project_id: P, tool: 'list_tasks' }, 'wrong-secret-wrong-secret-xx')).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/internal/ai-tools', payload: { project_id: P, tool: 'list_tasks' } })).statusCode, 401);
  assert.equal((await call(app, { project_id: 'nope', tool: 'list_tasks' })).statusCode, 400);
  assert.equal((await call(app, { project_id: P, tool: 'drop_database' })).statusCode, 400);   // only the three known tools exist
  await app.close();
});

test('list_decisions returns current values with what they replaced, and filters by topic', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const app = toolApp({ decisions: [{ entity_key: 'launch date', value: 'November 22, 2026', decided_on: '2026-11-04', earlier: ['November 15, 2026'] }] }, calls);
  const res = await call(app, { project_id: P, tool: 'list_decisions', args: { topic: 'Launch' } });
  assert.deepEqual(res.json(), [{ topic: 'launch date', current: 'November 22, 2026', decided_on: '2026-11-04', earlier_values: ['November 15, 2026'] }]);
  assert.deepEqual(calls[0].params, [P, 'launch']);
  assert.match(calls[0].sql, /superseded_by is null/);
  await app.close();
});

test('list_tasks defaults to open work, and an unknown status falls back to open', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const app = toolApp({ tasks: [{ title: 'Research pricing', status: 'open', due: '2026-11-06', owner: 'sam' }] }, calls);
  assert.deepEqual((await call(app, { project_id: P, tool: 'list_tasks' })).json(), [{ title: 'Research pricing', status: 'open', due: '2026-11-06', owner: 'sam' }]);
  await call(app, { project_id: P, tool: 'list_tasks', args: { status: "x'; drop table tasks;--" } });
  await call(app, { project_id: P, tool: 'list_tasks', args: { status: 'done' } });
  assert.deepEqual(calls.map((c) => c.params[1]), ['open', 'open', 'done']);             // values are parameters, never part of the SQL
  assert.ok(calls.every((c) => !c.sql.includes('drop table')));
  await app.close();
});

test('search_project searches shared project memory and returns short snippets; an empty query returns nothing', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const app = toolApp({ memory: [{ id: 'm1', source_type: 'decision', source_id: null, meeting_id: null, text: 'x'.repeat(900), created_at: new Date(), score: 0.8123 }] }, calls);
  const hits = (await call(app, { project_id: P, tool: 'search_project', args: { query: 'launch date' } })).json();
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text.length, 400);
  assert.equal(hits[0].score, 0.81);
  assert.deepEqual((await call(app, { project_id: P, tool: 'search_project', args: { query: '   ' } })).json(), []);
  await app.close();
});
