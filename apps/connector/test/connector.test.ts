import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { open, seal } from '../src/vault.js';
import { signState, verifyState } from '../src/state.js';
import { parseMessage, stripQuoted } from '../src/gmailParse.js';

process.env.TOKEN_ENC_KEY = randomBytes(32).toString('base64');
process.env.INTERNAL_SECRET = 'unit-secret';

test('vault round-trips tokens and the ciphertext hides them', () => {
  const t = { access_token: 'ya29.SECRET-ACCESS', refresh_token: '1//SECRET-REFRESH', expires_at: 123 };
  const s = seal(t);
  assert.deepEqual(open(s), t);
  assert.ok(!s.ciphertext.toString('utf8').includes('SECRET') && !s.ciphertext.toString('base64').includes('SECRET'));
  assert.notDeepEqual(seal(t).iv, s.iv, 'fresh IV per row');
});

test('vault rejects tampering and a wrong key', () => {
  const s = seal({ access_token: 'a', expires_at: 1 });
  const bad = Buffer.from(s.ciphertext); bad[0] ^= 1;
  assert.throws(() => open({ ...s, ciphertext: bad }));
  assert.throws(() => open({ ...s, tag: Buffer.alloc(16) }));
  const old = process.env.TOKEN_ENC_KEY;
  process.env.TOKEN_ENC_KEY = randomBytes(32).toString('base64');
  assert.throws(() => open(s));
  process.env.TOKEN_ENC_KEY = 'short';
  assert.throws(() => seal({ access_token: 'a', expires_at: 1 }), /32 bytes/);
  process.env.TOKEN_ENC_KEY = old;
});

test('OAuth state is signed, tamper-proof and expires', () => {
  const base = { projectId: 'p', userId: 'u', services: ['gmail' as const], visibility: 'private' as const };
  const tok = signState(base, 1_000);
  assert.equal(verifyState(tok, 2_000)?.projectId, 'p');
  assert.equal(verifyState(tok, 1_000 + 11 * 60_000), null, 'expired');
  const [body, mac] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), userId: 'attacker' })).toString('base64url');
  assert.equal(verifyState(`${forged}.${mac}`, 2_000), null, 'payload changed');
  assert.equal(verifyState('garbage', 2_000), null);
  assert.equal(verifyState(`${body}.`, 2_000), null);
});

const b64 = (s: string) => Buffer.from(s).toString('base64url');
test('Gmail parsing: headers, text part, quoted replies removed', () => {
  const m = parseMessage({ internalDate: '1700000000000', payload: { headers: [
    { name: 'From', value: '"Alice Ng" <alice@example.com>' }, { name: 'Subject', value: 'Re: Q3 budget' }, { name: 'Date', value: 'Tue, 14 Nov 2023 10:00:00 +0000' }],
    parts: [{ mimeType: 'text/plain', body: { data: b64('Budget is 40k.\n\nOn Mon, Nov 13, Bob wrote:\n> what is the budget?\n') } }] } });
  assert.equal(m.author, 'Alice Ng'); assert.equal(m.subject, 'Re: Q3 budget'); assert.equal(m.text, 'Budget is 40k.'); assert.equal(m.date?.getUTCFullYear(), 2023);
});

test('Gmail parsing: html fallback, nested parts, missing headers', () => {
  const m = parseMessage({ snippet: 'snip', payload: { headers: [{ name: 'From', value: 'bob@example.com' }], parts: [{ mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/html', body: { data: b64('<div>Hello&nbsp;<b>team</b></div><script>evil()</script><p>Ship it &amp; relax</p>') } }] }] } });
  assert.equal(m.subject, '(no subject)'); assert.equal(m.author, 'bob@example.com');
  assert.match(m.text, /Hello team/); assert.match(m.text, /Ship it & relax/); assert.ok(!m.text.includes('evil'));
});

test("stripQuoted keeps only the author's words; long bodies are capped", () => {
  assert.equal(stripQuoted('Hi\n> old\nThanks\n-----Original Message-----\nsecret old'), 'Hi\nThanks');
  assert.equal(parseMessage({ payload: { headers: [], body: {} }, snippet: 'only a snippet' }).text, 'only a snippet');
  assert.equal(parseMessage({ payload: { parts: [{ mimeType: 'text/plain', body: { data: b64('x'.repeat(9000)) } }] } }).text.length, 4000);
});
