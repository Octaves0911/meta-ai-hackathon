import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { Events } from '@meetpilot/shared';
import { saveSegment } from './services/captions.js';
import { DeepgramSession, MockSession, type SttSession, type SttState } from './services/sttSession.js';

declare module 'fastify' {
  interface FastifyInstance { closeCaptions: (meetingId: string) => void }
}

// Close codes (docs/03 §2): 4001 not allowed / meeting closed, 4002 speech disabled or unconfigured.
const CLOSE_DENIED = 4001;
const CLOSE_STT_OFF = 4002;

/**
 * `ws://…/stt?meetingId=&user=` — client streams 16 kHz mono PCM16 frames; server relays them to the STT provider,
 * mirrors interim/final captions into the meeting room, and persists every final segment (F4.1, F4.6).
 */
export function attachStt(app: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true });
  const byMeeting = new Map<string, Set<WebSocket>>();

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/stt') return; // other paths (socket.io) are handled by their own listeners
    wss.handleUpgrade(req, socket, head, (ws) => { void onConnection(ws, url); });
  });

  async function onConnection(ws: WebSocket, url: URL) {
    const early: Buffer[] = [];
    let session: SttSession | null = null;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const buf = data as Buffer;
      if (session) session.send(buf);
      else if (early.length < 20) early.push(buf);
    });
    ws.on('close', () => session?.close());

    const mode = process.env.STT_MODE ?? 'off';
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (mode === 'off' || (mode === 'stream' && !apiKey) || !['stream', 'mock'].includes(mode)) { app.analytics.track('captions_error', { reason: 'disabled' }); return ws.close(CLOSE_STT_OFF, 'speech disabled'); }

    const meetingId = url.searchParams.get('meetingId') ?? '';
    const username = (url.searchParams.get('user') ?? '').toLowerCase();
    let who: { id: string; username: string } | undefined;
    try {
      const { rows } = await app.db.query(
        `select u.id, u.username from users u
         join meeting_participants p on p.user_id = u.id and p.meeting_id = $1
         join meetings m on m.id = p.meeting_id
         where u.username = $2 and p.invite_status = 'joined' and m.status = 'active'`,
        [meetingId, username]);
      who = rows[0];
    } catch { /* invalid uuid etc. => denied */ }
    if (!who || ws.readyState !== ws.OPEN) return ws.close(CLOSE_DENIED, 'not allowed');

    const room = `meeting:${meetingId}`;
    const userId = who.id;
    app.analytics.track('captions_started', {}, { userId: who.id, meetingId });
    const speaker = who.username;
    let chain = Promise.resolve(); // keep persistence + broadcast of finals in order

    const handlers = {
      onResult: (r: { text: string; final: boolean; confidence: number }) => {
        const base = { meetingId, userId, speaker, text: r.text, ts: Date.now() };
        if (!r.final) return void app.io.to(room).emit(Events.captionInterim, base);
        chain = chain.then(async () => {
          const saved = await saveSegment(app.db, { meetingId, userId, speaker, text: r.text, confidence: r.confidence });
          app.io.to(room).emit(Events.captionFinal, { ...base, seq: saved.seq });
        }).catch((e) => app.log.error(e, 'caption persist failed'));
      },
      onStatus: (state: SttState) => {
        if (state === 'unavailable') app.analytics.track('captions_error', { reason: 'unavailable' }, { userId, meetingId });
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'status', state }));
      },
    };

    session = mode === 'mock'
      ? new MockSession(handlers)
      : new DeepgramSession(apiKey!, process.env.DEEPGRAM_URL ?? 'wss://api.deepgram.com/v1/listen', handlers);
    for (const b of early.splice(0)) session.send(b);

    const set = byMeeting.get(meetingId) ?? new Set();
    set.add(ws);
    byMeeting.set(meetingId, set);
    ws.on('close', () => { set.delete(ws); if (!set.size) byMeeting.delete(meetingId); });
  }

  app.decorate('closeCaptions', (meetingId: string) => {
    for (const ws of byMeeting.get(meetingId) ?? []) ws.close(CLOSE_DENIED, 'meeting ended');
  });
  app.addHook('onClose', async () => { for (const c of wss.clients) c.terminate(); wss.close(); });
}
