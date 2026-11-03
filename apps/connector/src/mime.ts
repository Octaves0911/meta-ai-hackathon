import { randomBytes } from 'node:crypto';

// Build an RFC 2822 message for the Gmail send API. Pure, strict, and unit-tested: no header can be injected.
export interface Attachment { filename: string; mime: string; data: Buffer }
export interface MailInput { from: string; to: string[]; cc?: string[]; subject: string; body: string; inReplyTo?: string | null; references?: string | null; attachments?: Attachment[] }

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // total, across all files (Gmail allows 25 MB including encoding)
const PDF_MAGIC = Buffer.from('%PDF-');
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}\.pdf$/;

export const MAX_RECIPIENTS = 10;
export const MAX_SUBJECT = 300;
export const MAX_BODY = 50_000;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export class MimeError extends Error {}

const clean = (v: string, what: string): string => {
  if (/[\r\n\0]/.test(v)) throw new MimeError(`${what} must not contain line breaks`);
  return v;
};
const addr = (a: string): string => {
  const v = clean(a.trim(), 'address');
  if (!EMAIL.test(v)) throw new MimeError(`invalid email address: ${v.slice(0, 80)}`);
  return v;
};
const encodeSubject = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const chunk76 = (b64: string) => b64.match(/.{1,76}/g)?.join('\r\n') ?? '';
const msgId = (v: string, what: string) => {
  const c = clean(v.trim(), what);
  if (!/^(<[^<>\s]+>\s*)+$/.test(c)) throw new MimeError(`${what} is not a valid Message-ID`);
  return c;
};

/** First pass: PDF only. The bytes decide, not the claimed type or extension. */
export function checkAttachments(list: Attachment[] | undefined): Attachment[] {
  const files = list ?? [];
  if (files.length > MAX_ATTACHMENTS) throw new MimeError(`at most ${MAX_ATTACHMENTS} attachments are allowed`);
  let total = 0;
  for (const f of files) {
    if (!FILENAME.test(f.filename)) throw new MimeError(`invalid attachment name: ${f.filename.slice(0, 60)}`);
    if (f.mime !== 'application/pdf') throw new MimeError(`attachment type not allowed: ${f.mime.slice(0, 40)}`);
    if (f.data.length === 0) throw new MimeError(`attachment is empty: ${f.filename}`);
    if (!f.data.subarray(0, 5).equals(PDF_MAGIC)) throw new MimeError(`attachment is not a PDF: ${f.filename}`);
    total += f.data.length;
  }
  if (total > MAX_ATTACHMENT_BYTES) throw new MimeError('attachments are larger than 10 MB in total');
  return files;
}

export function buildRaw(m: MailInput): string {
  const to = m.to.map(addr), cc = (m.cc ?? []).map(addr);
  if (to.length === 0) throw new MimeError('at least one recipient is required');
  if (to.length + cc.length > MAX_RECIPIENTS) throw new MimeError(`at most ${MAX_RECIPIENTS} recipients are allowed`);
  const subject = clean(m.subject, 'subject');
  if (subject.length > MAX_SUBJECT) throw new MimeError(`subject is longer than ${MAX_SUBJECT} characters`);
  if (m.body.length > MAX_BODY) throw new MimeError(`body is longer than ${MAX_BODY} characters`);
  const files = checkAttachments(m.attachments);
  const boundary = `=_mp_${randomBytes(16).toString('hex')}`;
  const headers = [
    `From: ${addr(m.from)}`, `To: ${to.join(', ')}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeSubject(subject)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${msgId(m.inReplyTo, 'In-Reply-To')}`] : []),
    ...(m.references ? [`References: ${msgId(m.references, 'References')}`] : []),
    'MIME-Version: 1.0',
  ];
  const text = chunk76(Buffer.from(m.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'));
  if (files.length === 0) {
    return Buffer.from(`${[...headers, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'].join('\r\n')}\r\n\r\n${text}\r\n`).toString('base64url');
  }
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${text}`,
    ...files.map((f) => `--${boundary}\r\nContent-Type: ${f.mime}; name="${f.filename}"\r\nContent-Disposition: attachment; filename="${f.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${chunk76(f.data.toString('base64'))}`),
  ];
  return Buffer.from(`${[...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`].join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n--${boundary}--\r\n`).toString('base64url');
}
