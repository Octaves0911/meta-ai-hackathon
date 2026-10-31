import { Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../ui';

interface Props {
  stream: MediaStream | null; name: string; self?: boolean; state?: string;
  onRetry?: () => void; className?: string;
}

export function VideoTile({ stream, name, self, state, onRetry, className = '' }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [slow, setSlow] = useState(false);
  const connected = self || state === 'connected';

  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream; }, [stream]);
  // Offer a manual retry if we are still connecting after 10 s (F3.1).
  useEffect(() => {
    setSlow(false);
    if (connected) return;
    const t = setTimeout(() => setSlow(true), 10000);
    return () => clearTimeout(t);
  }, [connected]);

  const hasVideo = !!stream?.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
  const failed = state === 'failed';
  return (
    <div className={`tile ${className}`}>
      <video ref={ref} autoPlay playsInline muted={self} style={{ transform: self ? 'scaleX(-1)' : undefined, opacity: hasVideo ? 1 : 0 }} />
      {!hasVideo && <div className="tile-avatar"><Avatar name={name} size="lg" /></div>}
      <div className="tile-name">{self ? 'You' : name}</div>
      {!connected && (
        <div className="tile-overlay" role="status">
          <div className="row" style={{ justifyContent: 'center', gap: 8 }}>{failed ? <WifiOff size={18} /> : <Loader2 size={18} className="spin" />}{failed ? 'Connection failed' : 'Connecting…'}</div>
          {(slow || failed) && onRetry && <div><button onClick={onRetry} style={{ background: 'rgba(255,255,255,0.14)', color: '#fff', borderColor: 'transparent' }}><RefreshCw size={15} /> Retry connection</button></div>}
        </div>
      )}
    </div>
  );
}
