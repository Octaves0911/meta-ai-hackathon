// Signed, expiring OAuth `state`: binds the callback to the project, user and choices made when connecting.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OAuthState { projectId: string; userId: string; services: ('gmail' | 'drive')[]; visibility: 'private' | 'project'; exp: number; nonce: string }
const TTL_MS = 10 * 60_000;

const sig = (body: string) => createHmac('sha256', process.env.INTERNAL_SECRET ?? '').update(body).digest('base64url');

export function signState(s: Omit<OAuthState, 'exp' | 'nonce'>, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...s, exp: now + TTL_MS, nonce: randomBytes(8).toString('hex') })).toString('base64url');
  return `${body}.${sig(body)}`;
}

export function verifyState(token: string, now = Date.now()): OAuthState | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(sig(body)), given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthState;
    return s.exp > now ? s : null;
  } catch { return null; }
}
