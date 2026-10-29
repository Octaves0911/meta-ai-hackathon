import { WebSocket } from 'ws';
import { parseDeepgramResult, type SttResult } from './deepgram.js';

export type SttState = 'ok' | 'reconnecting' | 'unavailable';
export interface SttHandlers { onResult(r: SttResult): void; onStatus(s: SttState): void }
export interface SttSession { send(chunk: Buffer): void; close(): void }

const MAX_RECONNECTS = 3;       // PRD §10: 3 reconnects
const QUEUE_CHUNKS = 20;        // ~2 s of 100 ms frames buffered while (re)connecting
const KEEPALIVE_MS = 8000;

/** Streaming session to Deepgram with bounded reconnects; audio is queued briefly while offline. */
export class DeepgramSession implements SttSession {
  private ws: WebSocket | null = null;
  private queue: Buffer[] = [];
  private attempts = 0;
  private everConnected = false;
  private closed = false;
  private lastAudioAt = Date.now();
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private apiKey: string, private baseUrl: string, private h: SttHandlers) {
    this.connect();
  }

  private url() {
    const q = new URLSearchParams({
      model: 'nova-2', language: 'en', encoding: 'linear16', sample_rate: '16000', channels: '1',
      interim_results: 'true', smart_format: 'true', punctuate: 'true', endpointing: '300',
    });
    return `${this.baseUrl}?${q}`;
  }

  private connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url(), { headers: { Authorization: `Token ${this.apiKey}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.attempts = 0;
      this.everConnected = true;
      this.h.onStatus('ok');
      for (const c of this.queue.splice(0)) ws.send(c);
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN && Date.now() - this.lastAudioAt > KEEPALIVE_MS - 2000) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, KEEPALIVE_MS);
    });
    ws.on('message', (data) => {
      try {
        const r = parseDeepgramResult(JSON.parse(data.toString()));
        if (r) this.h.onResult(r);
      } catch { /* ignore malformed frames */ }
    });
    const lost = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.keepAlive) clearInterval(this.keepAlive);
      if (this.closed) return;
      if (++this.attempts > MAX_RECONNECTS) return this.h.onStatus('unavailable');
      // Silent while starting up; visible once a working stream drops.
      if (this.everConnected) this.h.onStatus('reconnecting');
      this.retryTimer = setTimeout(() => this.connect(), 300 * this.attempts);
    };
    ws.on('close', lost);
    ws.on('error', lost);
  }

  send(chunk: Buffer) {
    this.lastAudioAt = Date.now();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(chunk);
    else { this.queue.push(chunk); if (this.queue.length > QUEUE_CHUNKS) this.queue.shift(); }
  }

  close() {
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'CloseStream' })); ws.close(); }
    else ws?.terminate();
  }
}

/** Deterministic fake used when STT_MODE=mock: lets the UI be exercised without an API key or microphone. */
export class MockSession implements SttSession {
  private frames = 0;
  private n = 0;
  constructor(private h: SttHandlers) { h.onStatus('ok'); }
  send() {
    this.frames++;
    if (this.frames % 15 === 0) { this.n++; this.h.onResult({ text: `Mock caption number ${this.n}.`, final: true, confidence: 0.99, startMs: 0 }); }
    else if (this.frames % 5 === 0) this.h.onResult({ text: `Mock caption number ${this.n + 1}`.slice(0, 12 + (this.frames % 15)), final: false, confidence: 0.5, startMs: 0 });
  }
  close() {}
}
