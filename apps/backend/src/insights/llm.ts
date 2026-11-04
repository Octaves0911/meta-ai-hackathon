// Client for the AI service's LLM endpoints. Every call returns `undefined` when the LLM is unavailable so callers
// can use the rules fallback; a short circuit-breaker avoids hammering an unconfigured service every tick.
import type { Candidate, EventDraft, TranscriptLine, Verdict } from './types.js';

export class LlmClient {
  private downUntil = 0;
  /** False once the AI service says it has no key (503); until then a failed call is treated as a transient error to retry. */
  configured = true;
  constructor(private url: string, private secret: string, private mode: string = 'auto') {}

  private async post<T>(path: string, body: unknown): Promise<T | undefined> {
    if (this.mode === 'off') { this.configured = false; return undefined; }
    if (Date.now() < this.downUntil) return undefined;
    try {
      const res = await fetch(`${this.url}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': this.secret },
        body: JSON.stringify(body), signal: AbortSignal.timeout(50_000),
      });
      if (!res.ok) { this.downUntil = res.status === 503 ? Date.now() + 60_000 : 0; this.configured = res.status !== 503; return undefined; }
      this.configured = true;
      return (await res.json()) as T;
    } catch {
      this.downUntil = Date.now() + 10_000;
      return undefined;
    }
  }

  async extract(lines: TranscriptLine[], earlier: TranscriptLine[], knownKeys: string[] = []): Promise<EventDraft[] | undefined> {
    const r = await this.post<{ events: any[] }>('/extract', { lines, earlier, today: new Date().toISOString().slice(0, 10), known_keys: knownKeys.slice(0, 40) });
    return r?.events.map((e) => ({
      type: e.type, entityKey: e.entity_key ?? null, value: e.value ?? null, summary: e.summary, who: e.who ?? null,
      dueText: e.due_text ?? null, referencesEarlier: !!e.references_earlier, quote: e.quote ?? '', details: e.details || undefined, priority: e.priority ?? null, fromSeq: e.from_seq, toSeq: e.to_seq,
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

  /** With `tools`, the model may also look things up itself (function calling): it calls back into the backend's lookup endpoint. */
  async answer(question: string, ctx: Candidate[], tools?: { url: string; projectId: string }): Promise<{ answer: string; used: Candidate[]; toolsUsed: string[] } | undefined> {
    const r = await this.post<{ answer: string; used_ids: string[]; tools_used?: string[] }>('/answer', {
      question, context: ctx.map((c) => ({ id: c.id, label: c.label, text: c.text.slice(0, 600), score: c.score, source_type: c.sourceType })),
      ...(tools ? { tool_url: tools.url, project_id: tools.projectId } : {}),
    });
    return r && { answer: r.answer, used: ctx.filter((c) => r.used_ids.includes(c.id)), toolsUsed: r.tools_used ?? [] };
  }
}

export const createLlmClient = () =>
  new LlmClient(process.env.AI_URL ?? 'http://localhost:5001', process.env.INTERNAL_SECRET ?? '', process.env.INSIGHTS_LLM ?? 'auto');
