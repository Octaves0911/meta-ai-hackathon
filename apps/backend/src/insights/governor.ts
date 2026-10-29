// The governor decides WHERE an insight goes: chat now, a merged card later, or the silent AI Notes feed (docs/04 §4).
import type { InsightKind, Tier } from './types.js';

export interface Routable {
  kind: InsightKind; score: number; topicKey: string; evidenceIds: string[]; private?: boolean;
}

export interface GovernorOptions {
  now?: () => number;
  maxChat?: number;          // chat cards per window
  windowMs?: number;
  cooldownMs?: number;       // min gap between cards
  conflictCooldownMs?: number;
  pauseMs?: number;          // silence that counts as "a pause"
}

const DEFAULT_THRESHOLDS: Record<InsightKind, number> = {
  conflict: 0.5, reminder: 0.55, answer: 0.55, context: 0.65, external: 0.65, no_record: 0.7, brief: 0, recap: 0,
};
export const PRIORITY: InsightKind[] = ['conflict', 'reminder', 'answer', 'context', 'external', 'no_record', 'brief', 'recap'];
const WEAK = 0.3;
const MIN_THRESHOLD = 0.35;
const MAX_THRESHOLD = 0.9;
const MAX_MERGED = 3;

export class Governor<T extends Routable = Routable> {
  private now: () => number;
  private maxChat: number;
  private windowMs: number;
  private cooldownMs: number;
  private conflictCooldownMs: number;
  private pauseMs: number;
  private cards: number[] = [];               // timestamps of chat cards in the window
  private lastCardAt = 0;
  private shownTopics = new Set<string>();
  private shownEvidence = new Set<string>();
  private muted = new Set<string>();
  private thresholds = { ...DEFAULT_THRESHOLDS };
  private queue: T[] = [];

  constructor(o: GovernorOptions = {}) {
    this.now = o.now ?? Date.now;
    this.maxChat = o.maxChat ?? Number(process.env.AI_GOVERNOR_MAX_CHAT ?? 6);
    this.windowMs = o.windowMs ?? Number(process.env.AI_GOVERNOR_WINDOW_MIN ?? 30) * 60_000;
    this.cooldownMs = o.cooldownMs ?? 90_000;
    this.conflictCooldownMs = o.conflictCooldownMs ?? 30_000;
    this.pauseMs = o.pauseMs ?? 8_000;
  }

  private pruneWindow() {
    const cutoff = this.now() - this.windowMs;
    this.cards = this.cards.filter((t) => t > cutoff);
  }

  /** Mark a card as shown in chat (also used for briefs, answers and merged cards). */
  recordShown(c: Pick<Routable, 'topicKey' | 'evidenceIds'>) {
    this.cards.push(this.now());
    this.lastCardAt = this.now();
    this.shownTopics.add(c.topicKey);
    c.evidenceIds.forEach((e) => this.shownEvidence.add(e));
  }

  /** Decide the tier. Nothing is ever dropped: weak or repeated items go to the feed. */
  route(c: T): Tier {
    if (c.private) return 'feed';                         // private-source insights never reach shared chat or queue
    if (c.kind === 'no_record') return 'feed';
    if (c.score < WEAK) return 'feed';
    if (this.muted.has(c.topicKey)) return 'feed';
    if (this.shownTopics.has(c.topicKey) || c.evidenceIds.some((e) => this.shownEvidence.has(e))) return 'feed';
    if (c.score < this.thresholds[c.kind]) return 'feed';
    this.pruneWindow();
    const isConflict = c.kind === 'conflict';
    if (!isConflict && this.cards.length >= this.maxChat) return 'feed';
    const gap = isConflict ? this.conflictCooldownMs : this.cooldownMs;
    if (this.now() - this.lastCardAt >= gap) { this.recordShown(c); return 'interrupt'; }
    this.queue.push(c);
    return 'queued';
  }

  get queued(): readonly T[] { return this.queue; }

  /**
   * Merge queued items into ONE card at the next pause or once the cooldown has passed (never sooner than the
   * conflict cooldown). Items beyond the merge limit, or beyond the chat cap, fall back to the feed.
   */
  flush(silenceMs: number): { merged: T[]; feed: T[] } | null {
    if (!this.queue.length) return null;
    const sinceLast = this.now() - this.lastCardAt;
    if (sinceLast < this.conflictCooldownMs) return null;
    if (!(silenceMs >= this.pauseMs || sinceLast >= this.cooldownMs)) return null;
    this.pruneWindow();
    const sorted = [...this.queue].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || b.score - a.score);
    this.queue = [];
    if (this.cards.length >= this.maxChat) return { merged: [], feed: sorted };
    const merged = sorted.slice(0, MAX_MERGED);
    merged.forEach((m) => this.recordShown(m));
    return { merged, feed: sorted.slice(MAX_MERGED) };
  }

  /** 👍 lowers the bar for that kind; 👎 raises it and mutes the topic for the rest of the meeting (F5.7). */
  feedback(kind: InsightKind, topicKey: string, value: 'helpful' | 'dismissed') {
    if (value === 'helpful') this.thresholds[kind] = Math.max(MIN_THRESHOLD, this.thresholds[kind] - 0.05);
    else { this.thresholds[kind] = Math.min(MAX_THRESHOLD, this.thresholds[kind] + 0.1); this.muted.add(topicKey); }
  }

  threshold(kind: InsightKind) { return this.thresholds[kind]; }
}
