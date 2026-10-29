// In-memory fixed-window rate limiter (single node; Redis would replace the Map when scaling out, docs/01 §7).
export interface LimitResult { allowed: boolean; remaining: number; retryAfterSec: number }

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private limit: number, private windowMs = 60_000, private now: () => number = Date.now) {}

  /** limit <= 0 disables the limiter. */
  check(key: string): LimitResult {
    if (this.limit <= 0) return { allowed: true, remaining: Infinity, retryAfterSec: 0 };
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || h.resetAt <= t) { h = { count: 0, resetAt: t + this.windowMs }; this.hits.set(key, h); }
    h.count++;
    return { allowed: h.count <= this.limit, remaining: Math.max(0, this.limit - h.count), retryAfterSec: Math.max(1, Math.ceil((h.resetAt - t) / 1000)) };
  }

  /** Drop expired windows so the map cannot grow without bound. */
  sweep() { const t = this.now(); for (const [k, h] of this.hits) if (h.resetAt <= t) this.hits.delete(k); }
  startSweeper() { this.sweeper = setInterval(() => this.sweep(), this.windowMs).unref(); }
  stop() { if (this.sweeper) clearInterval(this.sweeper); }
  get size() { return this.hits.size; }
}

/** Expensive or sensitive endpoints get their own, stricter budget (per user), on top of the general one. */
export const ROUTE_LIMITS: { match: RegExp; method: string; perMin: number; name: string }[] = [
  { match: /^\/api\/executions\/[^/]+\/send-email$/, method: 'POST', perMin: 6, name: 'send_email' },
  { match: /^\/api\/projects\/[^/]+\/files$/, method: 'POST', perMin: 20, name: 'upload' },
  { match: /^\/api\/meetings\/[^/]+\/messages$/, method: 'POST', perMin: 60, name: 'chat' },
  { match: /^\/api\/projects\/[^/]+\/memory\/search$/, method: 'GET', perMin: 30, name: 'memory_search' },
  { match: /^\/api\/projects\/[^/]+\/connections\/google\/start$/, method: 'POST', perMin: 10, name: 'oauth_start' },
];
