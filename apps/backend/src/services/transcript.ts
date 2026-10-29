// Pure transcript helpers: import parsing and export formatting (docs/03 §1).

export interface ParsedLine { speaker: string; text: string; offsetMs: number | null }
export interface ExportSegment { seq: number; speaker: string; text: string; offsetMs: number }

const LINE = /^(?:\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*)?([^:\n]{1,60}):\s*(.+)$/;

/** Parse `Speaker: text` lines with an optional `[hh:mm:ss]` / `[mm:ss]` prefix. Non-matching lines continue the previous line. */
export function parseTranscript(input: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (m) {
      const [, a, b, c, speaker, text] = m;
      const offsetMs = a === undefined ? null
        : (c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c)) * 1000;
      out.push({ speaker: speaker.trim(), text: text.trim(), offsetMs });
    } else if (out.length) {
      out[out.length - 1].text += ` ${line}`;
    }
  }
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function srtTime(ms: number): string {
  return `${formatClock(ms)},${pad(ms % 1000, 3)}`;
}

export function toText(segments: ExportSegment[]): string {
  return segments.map((s) => `[${formatClock(s.offsetMs)}] ${s.speaker}: ${s.text}`).join('\n') + (segments.length ? '\n' : '');
}

/** Each cue lasts until the next one starts (min 1 s, max 8 s). */
export function toSrt(segments: ExportSegment[]): string {
  return segments.map((s, i) => {
    const next = segments[i + 1]?.offsetMs;
    const end = s.offsetMs + Math.min(8000, Math.max(1000, next !== undefined ? next - s.offsetMs : 3000));
    return `${i + 1}\n${srtTime(s.offsetMs)} --> ${srtTime(end)}\n${s.speaker}: ${s.text}\n`;
  }).join('\n');
}
