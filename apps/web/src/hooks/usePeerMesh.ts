import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomPeer } from '@meetpilot/shared';
import { getSocket } from '../lib/socket';

export interface Peer { socketId: string; userId: string; name: string; stream: MediaStream | null; state: RTCPeerConnectionState | 'new' }

const RTC_CONFIG: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // no TURN (known limitation)
const MAX_AUTO_RETRIES = 3;

/** Full-mesh WebRTC for one meeting room. The later joiner always makes the first offer. */
export function usePeerMesh(meetingId: string, username: string, enabled: boolean) {
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [mediaNote, setMediaNote] = useState('');
  const [joinError, setJoinError] = useState('');
  const [ended, setEnded] = useState(false);
  const retryFnRef = useRef<(id: string) => void>(() => {});

  const toggle = useCallback((kind: 'audio' | 'video') => {
    setLocal((s) => {
      s?.getTracks().filter((t) => t.kind === kind).forEach((t) => { t.enabled = !t.enabled; });
      return s;
    });
    (kind === 'audio' ? setMicOn : setCamOn)((v) => !v);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const pcs = new Map<string, RTCPeerConnection>();
    const pending = new Map<string, RTCIceCandidateInit[]>();
    const attempts = new Map<string, number>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let stream: MediaStream | null = null;
    const socket = getSocket(username);

    const patch = (id: string, p: Partial<Peer>) =>
      setPeers((m) => (m[id] ? { ...m, [id]: { ...m[id], ...p } } : m));
    const addPeer = (p: RoomPeer) =>
      setPeers((m) => ({ ...m, [p.socketId]: m[p.socketId] ?? { ...p, stream: null, state: 'new' } }));

    const closePc = (id: string) => {
      clearTimeout(timers.get(id));
      pcs.get(id)?.close();
      pcs.delete(id);
      pending.delete(id);
    };

    function createPc(id: string): RTCPeerConnection {
      closePc(id);
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcs.set(id, pc);
      const remote = new MediaStream();
      stream?.getTracks().forEach((t) => pc.addTrack(t, stream!));
      // Always negotiate both directions of media, even if our camera/mic is missing.
      for (const kind of ['audio', 'video'] as const) {
        if (!stream?.getTracks().some((t) => t.kind === kind)) pc.addTransceiver(kind, { direction: 'recvonly' });
      }
      pc.onicecandidate = (e) => e.candidate && socket.emit('rtc:ice', { to: id, candidate: e.candidate.toJSON() });
      // Tracks can arrive late (mobile); keep one stream per peer and add each track as it shows up.
      pc.ontrack = (e) => {
        if (!remote.getTracks().includes(e.track)) remote.addTrack(e.track);
        patch(id, { stream: remote });
        e.track.onunmute = () => patch(id, { stream: remote });
      };
      pc.onconnectionstatechange = () => {
        patch(id, { state: pc.connectionState });
        clearTimeout(timers.get(id));
        if (pc.connectionState === 'connected') attempts.set(id, 0);
        // Recover from failed / stuck-disconnected connections automatically (F3.3).
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          timers.set(id, setTimeout(() => {
            const n = attempts.get(id) ?? 0;
            if (!disposed && n < MAX_AUTO_RETRIES && pcs.get(id) === pc) { attempts.set(id, n + 1); retry(id); }
          }, pc.connectionState === 'failed' ? 1000 : 5000));
        }
      };
      return pc;
    }

    async function call(id: string) {
      const pc = createPc(id);
      await pc.setLocalDescription(await pc.createOffer());
      socket.emit('rtc:offer', { to: id, sdp: pc.localDescription });
    }

    function retry(id: string) {
      socket.emit('rtc:retry', { to: id });
      call(id).catch(() => {});
    }
    retryFnRef.current = retry;

    async function flushIce(id: string, pc: RTCPeerConnection) {
      for (const c of pending.get(id) ?? []) await pc.addIceCandidate(c).catch(() => {});
      pending.delete(id);
    }

    const onJoined = (p: RoomPeer) => addPeer(p);
    const onLeft = ({ socketId }: { socketId: string }) => {
      closePc(socketId);
      setPeers((m) => { const { [socketId]: _, ...rest } = m; return rest; });
    };
    const onOffer = async (d: { from: string; userId: string; name: string; sdp: RTCSessionDescriptionInit }) => {
      addPeer({ socketId: d.from, userId: d.userId, name: d.name });
      try {
        const pc = createPc(d.from);
        await pc.setRemoteDescription(d.sdp);
        await flushIce(d.from, pc);
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit('rtc:answer', { to: d.from, sdp: pc.localDescription });
      } catch { /* superseded by a newer negotiation */ }
    };
    const onAnswer = async (d: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = pcs.get(d.from);
      if (!pc || pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(d.sdp).catch(() => {});
      await flushIce(d.from, pc);
    };
    const onIce = async (d: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = pcs.get(d.from);
      if (pc?.remoteDescription) await pc.addIceCandidate(d.candidate).catch(() => {});
      else pending.set(d.from, [...(pending.get(d.from) ?? []), d.candidate]);
    };
    const onRetry = ({ from }: { from: string }) => closePc(from); // the requester will send a fresh offer
    const onEnded = () => setEnded(true);

    socket.on('peer:joined', onJoined);
    socket.on('peer:left', onLeft);
    socket.on('rtc:offer', onOffer);
    socket.on('rtc:answer', onAnswer);
    socket.on('rtc:ice', onIce);
    socket.on('rtc:retry', onRetry);
    socket.on('meeting:ended', onEnded);

    const enter = () =>
      socket.emit('room:join', { meetingId }, (r: { peers?: RoomPeer[]; error?: string }) => {
        if (disposed) return;
        if (r.error) return setJoinError(r.error === 'meeting_over' ? 'This meeting has ended.' : 'Could not enter the room.');
        r.peers?.forEach((p) => { addPeer(p); call(p.socketId).catch(() => {}); });
      });

    (async () => {
      // Camera + mic, falling back to audio-only, then to no local media (F3.2).
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); }
      catch {
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); setMediaNote('Camera unavailable — audio only.'); }
        catch { setMediaNote('No camera or microphone available — you can still watch and chat.'); }
      }
      if (disposed) return stream?.getTracks().forEach((t) => t.stop());
      setLocal(stream);
      setMicOn(!!stream?.getAudioTracks().length);
      setCamOn(!!stream?.getVideoTracks().length);
      if (socket.connected) enter(); else socket.once('connect', enter);
    })();

    // Re-enter the room after a transient socket drop and rebuild connections.
    const onReconnect = () => { if (stream !== undefined && !disposed) { [...pcs.keys()].forEach(closePc); setPeers({}); enter(); } };
    socket.io.on('reconnect', onReconnect);

    return () => {
      disposed = true;
      socket.emit('room:leave', {});
      for (const ev of ['peer:joined', 'peer:left', 'rtc:offer', 'rtc:answer', 'rtc:ice', 'rtc:retry', 'meeting:ended'])
        socket.off(ev);
      socket.io.off('reconnect', onReconnect);
      [...pcs.keys()].forEach(closePc);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [meetingId, username, enabled]);

  return {
    peers: Object.values(peers), local, micOn, camOn, mediaNote, joinError, ended,
    toggleMic: () => toggle('audio'), toggleCam: () => toggle('video'),
    retry: (id: string) => retryFnRef.current(id),
  };
}
