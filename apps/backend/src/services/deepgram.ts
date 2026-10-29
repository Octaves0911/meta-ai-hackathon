export interface SttResult { text: string; final: boolean; confidence: number; startMs: number }

/** Extract a transcript result from a Deepgram live-streaming message; null for anything else or empty text. */
export function parseDeepgramResult(raw: unknown): SttResult | null {
  const m = raw as any;
  if (!m || m.type !== 'Results') return null;
  const alt = m.channel?.alternatives?.[0];
  const text = typeof alt?.transcript === 'string' ? alt.transcript.trim() : '';
  if (!text) return null;
  return {
    text,
    final: m.is_final === true,
    confidence: typeof alt.confidence === 'number' ? alt.confidence : 0,
    startMs: Math.round((typeof m.start === 'number' ? m.start : 0) * 1000),
  };
}
