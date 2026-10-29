import { useState } from 'react';

/** Images and SVG sketches with zoom and download. SVG is shown via <img>, so embedded scripts can never run. */
export function ImageViewer({ title, payload, uri }: { title: string | null; payload: Record<string, any> | null; uri: string | null }) {
  const [zoom, setZoom] = useState(1);
  const src = payload?.svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(payload.svg)}` : (uri ?? '');
  if (!src) return <p className="muted">No image data.</p>;
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="mini" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} aria-label="Zoom out">−</button>
        <span className="muted">{Math.round(zoom * 100)}%</span>
        <button className="mini" onClick={() => setZoom((z) => Math.min(4, z + 0.25))} aria-label="Zoom in">+</button>
        <button className="mini" onClick={() => setZoom(1)}>Reset</button>
        <a className="mini-link" href={src} download={`${(title ?? 'image').replace(/\W+/g, '-')}${payload?.svg ? '.svg' : ''}`}>Download</a>
      </div>
      <div className="image-frame"><img src={src} alt={title ?? 'Generated image'} style={{ width: `${zoom * 100}%`, maxWidth: 'none' }} /></div>
    </div>
  );
}
