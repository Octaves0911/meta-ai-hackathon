/**
 * Deepgram's `is_final` results end wherever the speaker paused, not where a sentence ends ("Sam, please fix" / "the login bug…").
 * Saving each chunk as a transcript segment splits sentences across rows and mixes the tail of one sentence into the next,
 * which then bleeds into key points and task quotes. The assembler buffers final chunks and releases whole sentences.
 */
const ABBREV = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|inc|ltd|no)\.$/i;
const MIN_WORDS_BEFORE_CAP_BREAK = 6;
const TERMINAL = /[.?!…]["'”’)\]]*$/;

/** Split text into sentences at ". ? !" followed by a space, leaving abbreviations and decimals (3.5) intact. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.?!…]["'”’)\]]*\s+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].trimEnd().length;
    const piece = text.slice(start, end);
    const next = text[m.index + m[0].length];
    const endsWithDot = /\.["'”’)\]]*$/.test(piece);
    if (endsWithDot && (ABBREV.test(piece.trim()) || (next !== undefined && !/[A-Z"'“(]/.test(next)))) continue; // "Dr. Rao", "Nov. 20"

    out.push(piece.trim());
    start = m.index + m[0].length;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

export class SentenceAssembler {
  private pending = '';

  /** Text waiting for its sentence to finish (shown in front of interim captions so the line never jumps). */
  get buffered() { return this.pending; }

  /** Feed one final chunk; returns the sentences that are now complete. */
  push(chunk: string): string[] {
    // Deepgram sometimes omits the final period. Smart-format only capitalises sentence starts, names and "I", so a long
    // unfinished line followed by a capitalised chunk is two sentences, not one.
    const early = this.pending && /^[A-Z]/.test(chunk.trim()) && this.pending.split(/\s+/).length >= MIN_WORDS_BEFORE_CAP_BREAK ? this.flush() : [];
    if (early.length) return [...early, ...this.push(chunk)];
    this.pending = `${this.pending} ${chunk}`.trim();
    const parts = splitSentences(this.pending);
    const last = parts[parts.length - 1];
    if (last && !TERMINAL.test(last)) { this.pending = parts.pop()!; return parts; }
    this.pending = '';
    return parts;
  }

  /** The speaker went quiet or the stream closed: release whatever is left as its own segment. */
  flush(): string[] {
    const rest = this.pending.trim();
    this.pending = '';
    return rest ? [rest] : [];
  }
}
