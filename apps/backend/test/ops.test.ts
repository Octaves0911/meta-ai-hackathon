import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, ROUTE_LIMITS } from '../src/ops/rateLimit.js';
import { Metrics } from '../src/ops/metrics.js';
import { sanitizeProps } from '../src/ops/analytics.js';

test('rate limiter: fixed window per key, retry-after, reset', () => {
  let t = 1_000_000;
  const rl = new RateLimiter(3, 60_000, () => t);
  assert.deepEqual([1, 2, 3].map(() => rl.check('a').allowed), [true, true, true]);
  const blocked = rl.check('a');
  assert.equal(blocked.allowed, false); assert.equal(blocked.remaining, 0); assert.equal(blocked.retryAfterSec, 60);
  assert.equal(rl.check('b').allowed, true, 'other keys are independent');
  t += 59_000; assert.equal(rl.check('a').retryAfterSec, 1);
  t += 1_000; assert.equal(rl.check('a').allowed, true, 'window reset');
});

test('rate limiter: disabled when limit <= 0, and sweep frees expired windows', () => {
  assert.equal(new RateLimiter(0).check('x').allowed, true);
  let t = 0; const rl = new RateLimiter(1, 1000, () => t);
  rl.check('a'); rl.check('b'); assert.equal(rl.size, 2);
  t = 5000; rl.sweep(); assert.equal(rl.size, 0);
});

test('route limits cover the expensive endpoints', () => {
  const hit = (m: string, u: string) => ROUTE_LIMITS.find((r) => r.method === m && r.match.test(u))?.name;
  assert.equal(hit('POST', '/api/executions/abc/send-email'), 'send_email');
  assert.equal(hit('POST', '/api/projects/p1/files'), 'upload');
  assert.equal(hit('GET', '/api/projects/p1/files'), undefined, 'listing is not special');
  assert.equal(hit('GET', '/api/projects/p1/memory/search'), 'memory_search');
});

test('metrics render counters, gauges and histograms in Prometheus format', () => {
  const m = new Metrics();
  m.inc('http_requests_total', 'Requests', { route: '/api/x', status: 200 }); m.inc('http_requests_total', 'Requests', { route: '/api/x', status: 200 }, 2);
  m.inc('weird', 'w', { v: 'a"b\\c\nd' });
  m.gauge('sockets', 'Open sockets', () => 7);
  m.gauge('queue', 'Queue', () => [{ labels: { status: 'pending' }, value: 3 }]);
  m.observe('latency_seconds', 'Latency', 0.03, { route: '/r' }); m.observe('latency_seconds', 'Latency', 3, { route: '/r' });
  assert.equal(m.value('http_requests_total', { route: '/api/x', status: 200 }), 3);
  const out = m.render();
  assert.match(out, /# TYPE http_requests_total counter\nhttp_requests_total\{route="\/api\/x",status="200"\} 3/);
  assert.match(out, /weird\{v="a\\"b\\\\c\\nd"\} 1/);
  assert.match(out, /sockets 7/); assert.match(out, /queue\{status="pending"\} 3/);
  assert.match(out, /latency_seconds_bucket\{route="\/r",le="0.05"\} 1/); assert.match(out, /latency_seconds_bucket\{route="\/r",le="\+Inf"\} 2/);
  assert.match(out, /latency_seconds_sum\{route="\/r"\} 3.03/); assert.match(out, /latency_seconds_count\{route="\/r"\} 2/);
});

test('analytics keeps only safe, allow-listed properties (no free text)', () => {
  assert.deepEqual(sanitizeProps({ kind: 'conflict', tier: 'interrupt', body: 'secret chat message', email: 'a@b.com', durationSec: 12, enabled: true, verdict: 'x'.repeat(100) }),
    { kind: 'conflict', tier: 'interrupt', durationSec: 12, enabled: true });
  assert.deepEqual(sanitizeProps({ kind: 'has <script>' }), {});
  assert.deepEqual(sanitizeProps(), {});
});
