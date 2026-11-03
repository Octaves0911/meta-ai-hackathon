import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRaw, MimeError } from '../src/mime.js';

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
const base = { from: 'me@example.com', to: ['dana@example.com'], subject: 'Re: Q3 budget', body: 'Hi Dana' };

test('builds a threaded reply with the right headers and a decodable body', () => {
  const msg = decode(buildRaw({ ...base, cc: ['boss@example.com'], inReplyTo: '<m1@mail.example.com>', references: '<m1@mail.example.com>' }));
  assert.match(msg, /^From: me@example.com\r\nTo: dana@example.com\r\nCc: boss@example.com\r\nSubject: Re: Q3 budget\r\n/);
  assert.match(msg, /In-Reply-To: <m1@mail\.example\.com>\r\nReferences: <m1@mail\.example\.com>/);
  const body = msg.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Hi Dana');
});

test('non-ASCII subjects and bodies survive (RFC 2047 / UTF-8)', () => {
  const msg = decode(buildRaw({ ...base, subject: 'Café – budget ✓', body: 'Grüße\nLine two' }));
  const m = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(msg)!;
  assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), 'Café – budget ✓');
  assert.equal(Buffer.from(msg.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Grüße\r\nLine two');
});

test('header injection is impossible', () => {
  for (const bad of [
    { subject: 'Hi\r\nBcc: evil@example.com' }, { subject: 'Hi\nBcc: evil@example.com' },
    { to: ['a@example.com\r\nBcc: evil@example.com'] }, { to: ['a@example.com, b@example.com'] },
    { from: 'me@example.com\nX: y' }, { inReplyTo: '<a@b>\r\nBcc: e@e.com' }, { references: 'not-an-id' },
  ]) assert.throws(() => buildRaw({ ...base, ...bad }), MimeError, JSON.stringify(bad));
});

test('limits: recipients, subject, body; at least one recipient; valid addresses', () => {
  const many = Array.from({ length: 11 }, (_, i) => `u${i}@example.com`);
  assert.throws(() => buildRaw({ ...base, to: many }), /at most 10/);
  assert.throws(() => buildRaw({ ...base, to: many.slice(0, 6), cc: many.slice(6, 12) }), /at most 10/, 'to + cc counted together');
  assert.doesNotThrow(() => buildRaw({ ...base, to: many.slice(0, 5), cc: many.slice(5, 10) }));
  assert.throws(() => buildRaw({ ...base, to: [] }), /at least one/);
  assert.throws(() => buildRaw({ ...base, to: ['not-an-email'] }), /invalid email/);
  assert.throws(() => buildRaw({ ...base, subject: 'x'.repeat(301) }), /subject/);
  assert.throws(() => buildRaw({ ...base, body: 'x'.repeat(50_001) }), /body/);
  assert.doesNotThrow(() => buildRaw({ ...base, subject: 'x'.repeat(300), body: 'x'.repeat(50_000) }));
});

// ---- attachments (PDF only, ≤ 5 files, ≤ 10 MB in total)
import { MAX_ATTACHMENT_BYTES } from '../src/mime.js';
const pdf = (n = 100) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n, 65)]);
const att = (filename = 'plan.pdf', data = pdf()) => ({ filename, mime: 'application/pdf', data });

test('with attachments the message is multipart/mixed: text first, then each file as a base64 PDF part', () => {
  const msg = decode(buildRaw({ ...base, attachments: [att('plan.pdf', pdf(5000)), att('Q4 report.pdf')] }));
  const ct = /Content-Type: multipart\/mixed; boundary="([^"]+)"/.exec(msg)!;
  assert.ok(ct, 'multipart header');
  const boundary = ct[1];
  assert.ok(msg.endsWith(`--${boundary}--\r\n`));
  const parts = msg.split(`--${boundary}`).slice(1, -1);
  assert.equal(parts.length, 3);
  assert.match(parts[0], /Content-Type: text\/plain; charset=UTF-8/);
  assert.equal(Buffer.from(parts[0].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Hi Dana');
  assert.match(parts[1], /Content-Type: application\/pdf; name="plan.pdf"\r\nContent-Disposition: attachment; filename="plan.pdf"/);
  const bytes = Buffer.from(parts[1].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64');
  assert.equal(bytes.length, pdf(5000).length);
  assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.match(parts[2], /filename="Q4 report.pdf"/);
  for (const line of parts[1].split('\r\n')) assert.ok(line.length <= 100, 'base64 lines are wrapped');
});

test('without attachments the message is exactly the old single-part text email', () => {
  const msg = decode(buildRaw(base));
  assert.match(msg, /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64/);
  assert.doesNotMatch(msg, /multipart/);
});

test('threading headers stay on a message with attachments', () => {
  const msg = decode(buildRaw({ ...base, inReplyTo: '<m1@mail.example.com>', references: '<m1@mail.example.com>', attachments: [att()] }));
  assert.match(msg, /In-Reply-To: <m1@mail\.example\.com>/);
  assert.match(msg, /MIME-Version: 1\.0\r\nContent-Type: multipart\/mixed/);
});

test('attachments: only real PDFs, safe names, at most five, at most 10 MB in total', () => {
  assert.throws(() => buildRaw({ ...base, attachments: [att('x.pdf', Buffer.from('<html>not a pdf'))] }), /not a PDF/);
  assert.throws(() => buildRaw({ ...base, attachments: [{ filename: 'x.pdf', mime: 'text/html', data: pdf() }] }), /type not allowed/);
  assert.throws(() => buildRaw({ ...base, attachments: [{ filename: 'x.pdf', mime: 'application/zip', data: pdf() }] }), /type not allowed/);
  assert.throws(() => buildRaw({ ...base, attachments: [att('x.pdf', Buffer.alloc(0))] }), /empty/);
  for (const bad of ['../etc/passwd.pdf', 'a\r\nBcc: e@e.com.pdf', 'x.exe', 'x.pdf"; evil="1', '.hidden.pdf', 'a/b.pdf', '']) {
    assert.throws(() => buildRaw({ ...base, attachments: [att(bad)] }), /invalid attachment name/, JSON.stringify(bad));
  }
  assert.throws(() => buildRaw({ ...base, attachments: Array.from({ length: 6 }, (_, i) => att(`f${i}.pdf`)) }), /at most 5/);
  assert.doesNotThrow(() => buildRaw({ ...base, attachments: Array.from({ length: 5 }, (_, i) => att(`f${i}.pdf`)) }));
  const half = pdf(MAX_ATTACHMENT_BYTES / 2);
  assert.throws(() => buildRaw({ ...base, attachments: [att('a.pdf', half), att('b.pdf', half)] }), /10 MB/);
  assert.doesNotThrow(() => buildRaw({ ...base, attachments: [att('a.pdf', pdf(MAX_ATTACHMENT_BYTES - 100))] }));
});
