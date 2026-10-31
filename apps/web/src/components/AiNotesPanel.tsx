import { Sparkles } from 'lucide-react';
import type { Insight } from '@meetpilot/shared';
import { InsightCard } from './InsightCard';

export function AiNotesPanel({ notes, hasMore, loadOlder, aiOn, error }:
  { notes: Insight[]; hasMore: boolean; loadOlder: () => void; aiOn: boolean; error: string }) {
  return (
    <div className="panel-col">
      <div className="messages" onScroll={(e) => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) loadOlder(); }}>
        {notes.length === 0 && <div className="empty" style={{ margin: 'auto' }}><div className="empty-icon" style={{ background: 'var(--ai-soft)', color: 'var(--ai-text)' }}><Sparkles size={22} /></div>
          <h3>{aiOn ? 'Quiet so far' : 'AI Assistance is off'}</h3>
          <p>{aiOn ? 'Lower-priority findings collect here instead of interrupting the chat.' : 'Turn it on in the header to get decisions, conflicts and answers while you talk.'}</p></div>}
        {notes.map((n) => <InsightCard key={n.id} insight={n} compact />)}
        {hasMore && notes.length > 0 && <button className="mini" onClick={loadOlder}>Load older</button>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
