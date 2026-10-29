// Client for the AI service's LLM endpoints. Every call returns `undefined` when the LLM is unavailable so callers
// can use the rules fallback; a short circuit-breaker avoids hammering an unconfigured service every tick.
import type { Candidate, EventDraft, TranscriptLine, Verdict } from './types.js';

export class LlmClient {
  private downUntil = 0;
  constructor(private url: string, private secret: string, private mode: string = 'auto') {}

  private async post<T>(path: string, body: unknown): Promise<T | undefined> {
    if (this.mode === 'off' || Date.now() < this.downUntil) return undefined;
    try {
      const res = await fetch(`${this.url}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': this.secret },
        body: JSON.stringify(body), signal: AbortSignal.timeout(50_000),
      });
      if (!res.ok) { this.downUntil = Date.now() + (res.status === 503 ? 60_000 : 10_000); return undefined; }
      return (await res.json()) as T;
    } catch {
      this.downUntil = Date.now() + 10_000;
      return undefined;
    }
  }

  async extract(lines: TranscriptLine[], earlier: TranscriptLine[]): Promise<EventDraft[] | undefined> {
    const r = await this.post<{ events: any[] }>('/extract', { lines, earlier, today: new Date().toISOString().slice(0, 10) });
    return r?.events.map((e) => ({
      type: e.type, entityKey: e.entity_key ?? null, value: e.value ?? null, summary: e.summary, who: e.who ?? null,
      dueText: e.due_text ?? null, referencesEarlier: !!e.references_earlier, quote: e.quote ?? '', fromSeq: e.from_seq, toSeq: e.to_seq,
    }));
  }

  /** `null` = the model says stay quiet; `undefined` = LLM unavailable. */
  async judge(ev: EventDraft, cands: Candidate[]): Promise<Verdict | null | undefined> {
    const r = await this.post<any>('/judge', {
      event: { type: ev.type, entity_key: ev.entityKey, value: ev.value, summary: ev.summary, who: ev.who, due_text: ev.dueText,
        references_earlier: ev.referencesEarlier, quote: ev.quote, from_seq: ev.fromSeq, to_seq: ev.toSeq },
      candidates: cands.map((c) => ({ id: c.id, label: c.label, text: c.text.slice(0, 600), score: c.score, source_type: c.sourceType, entity_key: c.entityKey ?? null, value: c.value ?? null })),
    });
    if (!r) return undefined;
    if (!r.speak) return null;
    const src = cands.find((c) => c.id === r.source_id);
    return {
      speak: true, kind: r.kind, score: r.score, title: r.title || 'From project memory', message: r.message,
      sourceLabel: src?.label ?? 'Project memory', sourceUrl: src?.url ?? null,
      topicKey: r.topic_key || `${r.kind}:${ev.summary.slice(0, 60).toLowerCase()}`,
      evidenceIds: src ? [src.id] : [], private: !!src?.private,
    };
  }

  async answer(question: string, ctx: Candidate[]): Promise<{ answer: string; used: Candidate[] } | undefined> {
    const r = await this.post<{ answer: string; used_ids: string[] }>('/answer', {
      question, context: ctx.map((c) => ({ id: c.id, label: c.label, text: c.text.slice(0, 600), score: c.score, source_type: c.sourceType })),
    });
    return r && { answer: r.answer, used: ctx.filter((c) => r.used_ids.includes(c.id)) };
  }
}

export const createLlmClient = () =>
  new LlmClient(process.env.AI_URL ?? 'http://localhost:5001', process.env.INTERNAL_SECRET ?? '', process.env.INSIGHTS_LLM ?? 'auto');
