import type { Insight } from '@meetpilot/shared';
import { InsightCard } from './InsightCard';

export function AiNotesPanel({ notes, hasMore, loadOlder, aiOn, error }:
  { notes: Insight[]; hasMore: boolean; loadOlder: () => void; aiOn: boolean; error: string }) {
  return (
    <div className="panel-col">
      <div className="messages" onScroll={(e) => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) loadOlder(); }}>
        {!aiOn && notes.length === 0 && <p className="muted">Turn on AI Assistance to get live help.</p>}
        {aiOn && notes.length === 0 && <p className="muted">Quiet so far. Lower-priority findings will collect here instead of interrupting the chat.</p>}
        {notes.map((n) => <InsightCard key={n.id} insight={n} compact />)}
        {hasMore && notes.length > 0 && <button className="mini" onClick={loadOlder}>Load older</button>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
