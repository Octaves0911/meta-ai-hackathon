export type InsightKind = 'conflict' | 'answer' | 'reminder' | 'context' | 'no_record' | 'external' | 'brief' | 'recap';
export type Tier = 'interrupt' | 'queued' | 'feed';
export type EventType = 'task' | 'decision' | 'deadline' | 'question' | 'blocker' | 'info';

export interface TranscriptLine { seq: number; speaker: string; text: string }

/** A structured fact extracted from speech (docs/04 §1). */
export interface EventDraft {
  type: EventType;
  entityKey: string | null;      // e.g. deployment_date
  value: string | null;          // decision value, e.g. "September 5"
  summary: string;
  who: string | null;
  dueText: string | null;
  referencesEarlier: boolean;
  quote: string;
  fromSeq: number;
  toSeq: number;
}

/** Something retrieved from memory that the judge may turn into an insight. */
export interface Candidate {
  id: string;
  sourceType: string;            // decision | transcript | task | event | workspace_doc | code | external
  text: string;
  score: number;
  label: string;                 // "Meeting “Release planning” · Jul 12" / "Gmail · Alice · Re: Q3"
  url?: string | null;
  entityKey?: string | null;     // decisions only
  value?: string | null;
  private?: boolean;             // came from the viewer's private source
}

export interface Verdict {
  speak: boolean;
  kind: InsightKind;
  score: number;                 // 0..1: "would this change what people say or decide right now?"
  title: string;
  message: string;               // ≤ 2 sentences
  sourceLabel: string;
  sourceUrl?: string | null;
  topicKey: string;
  evidenceIds: string[];
  private: boolean;
}
