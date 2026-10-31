import { AlertTriangle, BellRing, ClipboardList, Mail, MessageSquareQuote, NotebookText, SearchX, ThumbsDown, ThumbsUp, Lock, Lightbulb } from 'lucide-react';
import { useState } from 'react';
import type { Insight } from '@meetpilot/shared';
import { api } from '../lib/api';

const ICON: Record<Insight['kind'], typeof Lightbulb> = {
  conflict: AlertTriangle, answer: MessageSquareQuote, reminder: BellRing, context: Lightbulb, no_record: SearchX, external: Mail, brief: ClipboardList, recap: NotebookText,
};
const NO_FEEDBACK = new Set<Insight['kind']>(['brief', 'answer', 'recap']);

/** One assistant card (PRD §7.3). `compact` is the AI Notes variant. */
export function InsightCard({ insight, compact = false }: { insight: Insight; compact?: boolean }) {
  const [feedback, setFeedback] = useState(insight.feedback);
  const [open, setOpen] = useState(!compact);
  const [error, setError] = useState('');
  const canRate = !NO_FEEDBACK.has(insight.kind) && !insight.id.startsWith('off-');

  const rate = async (value: 'helpful' | 'dismissed') => {
    setError('');
    try { await api(`/insights/${insight.id}/feedback`, { method: 'POST', json: { value } }); setFeedback(value); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <article className={`insight kind-${insight.kind}${feedback === 'dismissed' ? ' dismissed' : ''}`} aria-label={`${insight.kind} insight`}>
      <header className="insight-head" onClick={compact ? () => setOpen(!open) : undefined} style={compact ? { cursor: 'pointer' } : undefined}>
        <span className="ico" aria-hidden>{(() => { const I = ICON[insight.kind]; return <I size={14} />; })()}</span>
        <strong>{insight.title}</strong>
        {insight.private && <span className="pill ai" title="Built from your private sources"><Lock size={11} /> Only you</span>}
      </header>
      {open && (
        <>
          {insight.quote && <blockquote className="insight-quote">{insight.quote}</blockquote>}
          <div className="insight-body">{insight.body}</div>
          {insight.sourceLabel && (
            <div className="insight-source">
              Source: {insight.sourceUrl ? <a href={insight.sourceUrl} target="_blank" rel="noreferrer noopener">{insight.sourceLabel}</a> : insight.sourceLabel}
            </div>
          )}
          {canRate && (
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <button className="mini" aria-pressed={feedback === 'helpful'} onClick={() => rate('helpful')}><ThumbsUp size={13} /> Helpful</button>
              <button className="mini" aria-pressed={feedback === 'dismissed'} onClick={() => rate('dismissed')}><ThumbsDown size={13} /> Dismiss</button>
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </>
      )}
    </article>
  );
}
