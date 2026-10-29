import { tailText } from '@meetpilot/shared';
import type { CaptionLine } from '../hooks/useCaptionFeed';
import type { CaptionStatus } from '../hooks/useCaptionStream';

/** Movie-style subtitles over the video (PRD §7.2) plus a quiet status chip. */
export function SubtitleOverlay({ lines, visible, status }: { lines: CaptionLine[]; visible: boolean; status: CaptionStatus }) {
  return (
    <>
      <div className={`subtitles${visible ? '' : ' faded'}`} aria-live="polite" aria-label="Live captions">
        {lines.map((l, i) => (
          <div key={l.key} className="subtitle-line" style={{ opacity: i < lines.length - 1 ? 0.55 : 1 }}>
            <b className="subtitle-name">{l.speaker}:</b> {tailText(l.text, 200)}
          </div>
        ))}
      </div>
      {status === 'reconnecting' && <div className="cap-chip" role="status">Reconnecting captions…</div>}
      {status === 'unavailable' && <div className="cap-chip" role="status">Captions unavailable</div>}
    </>
  );
}
