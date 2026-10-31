import { AlertTriangle, Bot, CheckCircle2, MessageSquareQuote, Mic } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Avatar } from '../ui';

/** Window chrome used for every product shot on the landing page. */
export function Frame({ title, children, style, className = '' }: { title: string; children: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <div className={`lframe ${className}`} style={style} aria-hidden>
      <div className="lframe-bar"><i /><i /><i /><span>{title}</span><span className="pill success live" style={{ marginLeft: 'auto' }}><span className="dot" /> Live</span></div>
      {children}
    </div>
  );
}

export function CallArea({ caption, speaker = 'Priya' }: { caption: ReactNode; speaker?: string }) {
  return (
    <div className="call-area">
      <div className="call-grid">
        {['Priya', 'Aman', 'Dana', 'Sam'].map((n, i) => (
          <div className={`call-tile t${i}`} key={n}><Avatar name={n} size="lg" /><span>{n}</span>{i === 0 && <em><Mic size={11} /></em>}</div>
        ))}
      </div>
      <div className="mock-sub"><b>{speaker}:</b> {caption}</div>
    </div>
  );
}

export function ConflictCard({ style }: { style?: CSSProperties }) {
  return (
    <div className="insight kind-conflict" style={style}>
      <div className="insight-head"><span className="ico"><AlertTriangle size={14} /></span><strong>Conflicts with an earlier decision</strong></div>
      <div className="insight-body">Release planning decided deployment on August 1.</div>
      <div className="insight-source">Source: Meeting “Release planning” · Oct 30</div>
    </div>
  );
}

export function AnswerCard({ style }: { style?: CSSProperties }) {
  return (
    <div className="insight kind-answer" style={style}>
      <div className="insight-head"><span className="ico"><MessageSquareQuote size={14} /></span><strong>Answer from memory</strong></div>
      <div className="insight-quote">Why did we choose streaming captions?</div>
      <div className="insight-body">Lower latency than batch transcription; decided in “Architecture sync”.</div>
    </div>
  );
}

export function TaskRow({ title, who, due, state, style }: { title: string; who: string; due: string; state: ReactNode; style?: CSSProperties }) {
  return (
    <div className="mock-task" style={style}>
      <CheckCircle2 size={16} style={{ color: 'var(--success)', flex: 'none' }} />
      <div style={{ minWidth: 0, flex: 1 }}><strong>{title}</strong><div className="faint" style={{ fontSize: 12 }}>{who} · due {due}</div></div>
      <span className="pill ai"><Bot size={11} /> {state}</span>
    </div>
  );
}
