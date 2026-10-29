// Turn a Gmail API message resource into plain, de-quoted text. Pure and unit-tested.
export interface ParsedMail { subject: string; author: string; date: Date | null; text: string; fromEmail: string | null; messageId: string | null; threadId: string | null }
export const MAX_TEXT = 4000;

const b64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
const header = (headers: { name: string; value: string }[] | undefined, n: string) => headers?.find((h) => h.name.toLowerCase() === n)?.value ?? '';

function collect(part: any, out: { plain: string[]; html: string[] }) {
  if (!part) return;
  const data = part.body?.data;
  if (data && part.mimeType === 'text/plain') out.plain.push(b64(data));
  else if (data && part.mimeType === 'text/html') out.html.push(b64(data));
  for (const p of part.parts ?? []) collect(p, out);
}

const htmlToText = (h: string) => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

/** Drop quoted replies and signatures-by-convention so only what the author wrote is indexed. */
export function stripQuoted(text: string): string {
  const kept: string[] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^On .{5,120} wrote:\s*$/i.test(line) || /^-{2,}\s*(Original Message|Forwarded message)/i.test(line) || /^_{5,}$/.test(line) || /^From:.+\bSent:/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseMessage(msg: any): ParsedMail {
  const h = msg.payload?.headers as { name: string; value: string }[] | undefined;
  const out = { plain: [] as string[], html: [] as string[] };
  collect(msg.payload, out);
  const raw = out.plain.length ? out.plain.join('\n') : out.html.map(htmlToText).join('\n');
  const from = header(h, 'from');
  const author = (/^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1] ?? from.replace(/[<>]/g, '')).trim();
  const date = header(h, 'date') ? new Date(header(h, 'date')) : msg.internalDate ? new Date(Number(msg.internalDate)) : null;
  const email = /<([^<>\s@]+@[^<>\s@]+)>/.exec(from)?.[1] ?? (/^[^<>\s@]+@[^<>\s@]+$/.test(from.trim()) ? from.trim() : null);
  const messageId = header(h, 'message-id').trim() || null;
  return { fromEmail: email, messageId, threadId: typeof msg.threadId === 'string' ? msg.threadId : null, subject: header(h, 'subject') || '(no subject)', author, date: date && !Number.isNaN(date.getTime()) ? date : null, text: stripQuoted(raw || msg.snippet || '').slice(0, MAX_TEXT) };
}
