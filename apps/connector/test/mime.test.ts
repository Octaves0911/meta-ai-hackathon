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
