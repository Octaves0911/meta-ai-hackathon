import type { FastifyInstance } from 'fastify';
import { requireUser } from '../app.js';

export interface IceServer { urls: string | string[]; username?: string; credential?: string }

/** STUN always; TURN relays when configured (TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL), so video calls also work between strict networks. Read at request time, so a redeploy is not needed to change them. */
export function iceServers(env: NodeJS.ProcessEnv = process.env): IceServer[] {
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter((s) => /^(stun|turn|turns):/i.test(s));
  const stun = list(env.STUN_URLS);
  const out: IceServer[] = [{ urls: stun.length ? stun : ['stun:stun.l.google.com:19302'] }];
  const turn = list(env.TURN_URLS);
  if (turn.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) out.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  return out;
}

export async function iceRoutes(app: FastifyInstance) {
  app.get('/ice-servers', async (req) => {
    await requireUser(app, req);   // TURN credentials are for signed-in users only
    return { iceServers: iceServers() };
  });
}
