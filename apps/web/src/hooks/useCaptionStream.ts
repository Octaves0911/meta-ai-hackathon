import { useEffect, useRef, useState } from 'react';

export type CaptionStatus = 'starting' | 'ok' | 'reconnecting' | 'unavailable';

const SILENT_RETRIES = 3;         // transient start-up failures are retried without UI noise (F4.4)
const SLOW_RETRY_MS = 15000;      // after that, keep trying in the background
const STALL_MS = 3000;            // watchdog: no audio frames for this long => rebuild capture (F4.5)

interface Opts { meetingId: string; username: string; stream: MediaStream | null; muted: boolean; enabled: boolean }

/** Streams this participant's microphone to /stt as 16 kHz PCM16; restarts itself when anything stalls. */
export function useCaptionStream({ meetingId, username, stream, muted, enabled }: Opts): CaptionStatus {
  const [status, setStatus] = useState<CaptionStatus>('starting');
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    const track = stream?.getAudioTracks()[0];
    if (!enabled || !stream || !track) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let ctx: AudioContext | null = null;
    let node: AudioWorkletNode | null = null;
    let lastFrame = Date.now();
    let retries = 0;
    let wasOk = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    async function startAudio() {
      ctx = new AudioContext();
      await ctx.audioWorklet.addModule('/pcm-worklet.js');
      const src = ctx.createMediaStreamSource(new MediaStream([track!]));
      node = new AudioWorkletNode(ctx, 'pcm-processor');
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        lastFrame = Date.now();
        if (!mutedRef.current && ws?.readyState === WebSocket.OPEN) ws.send(e.data);
      };
      src.connect(node); // no destination: we never play our own mic back
    }
    function stopAudio() {
      node?.port.close(); node?.disconnect(); node = null;
      void ctx?.close().catch(() => {}); ctx = null;
    }

    function connect() {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/stt?meetingId=${encodeURIComponent(meetingId)}&user=${encodeURIComponent(username)}`);
      ws = sock;
      sock.onopen = () => { retries = 0; };
      sock.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data as string);
          if (m.type !== 'status') return;
          if (m.state === 'ok') { wasOk = true; setStatus('ok'); }
          else if (m.state === 'reconnecting') setStatus('reconnecting');
          else if (m.state === 'unavailable') setStatus('unavailable');
        } catch { /* ignore */ }
      };
      sock.onclose = (e) => {
        if (disposed || ws !== sock) return;
        if (e.code === 4001) return setStatus('starting'); // meeting over / not allowed: stop quietly
        if (e.code === 4002) return setStatus('unavailable'); // speech disabled on the server
        retries++;
        if (retries > SILENT_RETRIES) setStatus('unavailable');
        else if (wasOk) setStatus('reconnecting');
        retryTimer = setTimeout(connect, retries > SILENT_RETRIES ? SLOW_RETRY_MS : 500 * retries);
      };
    }

    (async () => {
      try { await startAudio(); } catch { if (!disposed) setStatus('unavailable'); return; }
      connect();
    })();

    const watchdog = setInterval(() => {
      if (disposed) return;
      if (track.readyState === 'ended') return setStatus('unavailable');
      if (ctx?.state === 'suspended') void ctx.resume();
      if (Date.now() - lastFrame > STALL_MS) {
        lastFrame = Date.now();
        stopAudio();
        startAudio().catch(() => setStatus('unavailable'));
      }
    }, 2000);

    return () => {
      disposed = true;
      clearInterval(watchdog);
      clearTimeout(retryTimer);
      ws?.close();
      stopAudio();
    };
  }, [meetingId, username, stream, enabled]);

  return status;
}
