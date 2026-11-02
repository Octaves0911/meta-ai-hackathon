import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { Events } from '@meetpilot/shared';
import { saveSegment } from './services/captions.js';
import { SentenceAssembler } from './services/sentences.js';
import { DeepgramSession, MockSession, type SttSession, type SttState } from './services/sttSession.js';

declare module 'fastify' {
  interface FastifyInstance {
    closeCaptions: (meetingId: string) => void;
    /** Save any unfinished sentence of every open caption stream; resolves once persisted (call before ending a meeting). */
    flushCaptions: (meetingId: string) => Promise<void>;
  }
}

// Close codes (docs/03 §2): 4001 not allowed / meeting closed, 4002 speech disabled or unconfigured.
const CLOSE_DENIED = 4001;
const CLOSE_STT_OFF = 4002;
const SENTENCE_IDLE_MS = 3000; // an unfinished sentence is saved as-is after this much silence

/**
 * `ws://…/stt?meetingId=&user=` — client streams 16 kHz mono PCM16 frames; server relays them to the STT provider,
 * mirrors interim/final captions into the meeting room, and persists every final segment (F4.1, F4.6).
 */
export function attachStt(app: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true });
  const byMeeting = new Map<string, Set<WebSocket>>();
  const flushers = new Map<WebSocket, () => Promise<void>>();
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

    // Deepgram finals end at pauses, not sentences; save one segment per whole sentence (see services/sentences.ts).
    const assembler = new SentenceAssembler();
    let idle: ReturnType<typeof setTimeout> | null = null;
    let lastConfidence = 0;
    const persist = (text: string, confidence: number) => {
      chain = chain.then(async () => {
        const saved = await saveSegment(app.db, { meetingId, userId, speaker, text, confidence });
        app.io.to(room).emit(Events.captionFinal, { meetingId, userId, speaker, text, ts: Date.now(), seq: saved.seq });
      }).catch((e) => app.log.error(e, 'caption persist failed'));
    };
    const flushPending = () => {
      if (idle) clearTimeout(idle);
      idle = null;
      for (const t of assembler.flush()) persist(t, lastConfidence);
    };
    ws.on('close', flushPending);
    const flusher = async () => { flushPending(); await chain; };

    const handlers = {
      onResult: (r: { text: string; final: boolean; confidence: number }) => {
        if (!r.final) {
          const text = [assembler.buffered, r.text].filter(Boolean).join(' '); // keep the unfinished sentence on screen
          return void app.io.to(room).emit(Events.captionInterim, { meetingId, userId, speaker, text, ts: Date.now() });
        }
        if (idle) clearTimeout(idle);
        lastConfidence = r.confidence;
        for (const sentence of assembler.push(r.text)) persist(sentence, r.confidence);
        idle = assembler.buffered ? setTimeout(flushPending, SENTENCE_IDLE_MS) : null;
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
    flushers.set(ws, flusher);
    byMeeting.set(meetingId, set);
    ws.on('close', () => { flushers.delete(ws); set.delete(ws); if (!set.size) byMeeting.delete(meetingId); });
  }

  app.decorate('flushCaptions', async (meetingId: string) => {
    await Promise.all([...(byMeeting.get(meetingId) ?? [])].map((ws) => flushers.get(ws)?.()));
  });
  app.decorate('closeCaptions', (meetingId: string) => {
    for (const ws of byMeeting.get(meetingId) ?? []) ws.close(CLOSE_DENIED, 'meeting ended');
  });
  app.addHook('onClose', async () => { for (const c of wss.clients) c.terminate(); wss.close(); });
}
