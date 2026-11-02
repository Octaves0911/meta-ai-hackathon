/** Speech-to-text splits sentences ("Priya will send the updated" / "pricing deck by Friday."). Extracting a half sentence
 * yields a truncated task, so the newest lines that stop mid-sentence wait until the sentence completes or goes quiet. */
const ENDS_SENTENCE = /[.?!…]["'”’)\]]*\s*$/;
export const HOLD_MS = 4_000; // segments are already whole sentences (services/sentences.ts); this only covers a flushed fragment

export function heldTail<T extends { text: string; created_at: Date | string }>(rows: T[], now = Date.now()): T[] {
  let end = rows.length;
  while (end > 0) {
    const r = rows[end - 1];
    const fresh = now - new Date(r.created_at).getTime() < HOLD_MS;
    if (fresh && !ENDS_SENTENCE.test(r.text.trim())) end--;
    else break;
  }
  return rows.slice(0, end);
}
