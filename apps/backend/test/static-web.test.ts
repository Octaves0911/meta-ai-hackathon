import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { serveWeb } from '../src/staticWeb.js';

function dist() {
  const d = mkdtempSync(path.join(tmpdir(), 'web-'));
  mkdirSync(path.join(d, 'assets'));
  writeFileSync(path.join(d, 'index.html'), '<!doctype html><title>MeetPilot</title>');
  writeFileSync(path.join(d, 'assets', 'app-abc123.js'), 'console.log(1)');
  return d;
}

test('serves the page shell, hashed assets and client-side routes; API misses stay JSON 404s', async () => {
  const app = Fastify();
  app.get('/api/ping', async () => ({ ok: true }));
  assert.equal(serveWeb(app, dist()), true);
  const index = await app.inject('/');
  assert.equal(index.statusCode, 200);
  assert.match(index.body, /MeetPilot/);
  assert.equal(index.headers['cache-control'], 'no-cache');
  const asset = await app.inject('/assets/app-abc123.js');
  assert.equal(asset.statusCode, 200);
  assert.match(String(asset.headers['cache-control']), /immutable/);
  const route = await app.inject('/reviews/5f68b094-ac46-41dc-8c31-4360028c8edd');
  assert.equal(route.statusCode, 200);
  assert.match(route.body, /MeetPilot/);                                   // deep link falls back to the app shell
  assert.equal((await app.inject('/api/ping')).statusCode, 200);          // real API routes still win
  const miss = await app.inject('/api/nope');
  assert.equal(miss.statusCode, 404);
  assert.equal(miss.json().error.code, 'not_found');                       // not the HTML shell
  assert.equal((await app.inject('/assets/missing.js')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/reviews/x' })).statusCode, 404);
  await app.close();
});

test('does nothing when WEB_DIST is unset or has no index.html', async () => {
  const app = Fastify();
  assert.equal(serveWeb(app, undefined), false);
  assert.equal(serveWeb(app, mkdtempSync(path.join(tmpdir(), 'empty-'))), false);
  assert.equal((await app.inject('/')).statusCode, 404);
  await app.close();
});
