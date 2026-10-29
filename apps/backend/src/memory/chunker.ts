// Pure chunking rules (docs/02 §3).
export interface Segment { speaker: string; text: string }

const TRANSCRIPT_WINDOW = 6;      // segments per chunk
const TRANSCRIPT_MAX_CHARS = 800;
const DOC_MAX_CHARS = 1000;

/** Sliding window of ~6 segments, ≤800 chars, with one segment of overlap. */
export function chunkTranscript(segments: Segment[]): string[] {
  const lines = segments.map((s) => `${s.speaker}: ${s.text}`);
  const chunks: string[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && end - start < TRANSCRIPT_WINDOW && (end === start || size + lines[end].length + 1 <= TRANSCRIPT_MAX_CHARS)) {
      size += lines[end].length + 1;
      end++;
    }
    chunks.push(lines.slice(start, end).join('\n').slice(0, TRANSCRIPT_MAX_CHARS));
    if (end >= lines.length) break;
    start = Math.max(end - 1, start + 1); // overlap one segment, always progress
  }
  return chunks;
}

/** Paragraph-aware chunks of ≤1000 chars; oversized paragraphs are split on sentence/word boundaries. */
export function chunkDocument(text: string, max = DOC_MAX_CHARS): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  const flush = () => { if (cur) chunks.push(cur); cur = ''; };
  for (const p of paras) {
    if (p.length > max) {
      flush();
      let rest = p;
      while (rest.length > max) {
        const window = rest.slice(0, max);
        const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf(' '));
        const at = cut > max * 0.4 ? cut + 1 : max;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      cur = rest;
    } else if (cur && cur.length + p.length + 2 > max) {
      flush();
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  flush();
  return chunks;
}
