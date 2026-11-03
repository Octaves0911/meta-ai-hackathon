import { Activity, CheckCircle2, CircleHelp, Gauge, GitBranch, Loader2, Play, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { AgentName, ExecutionDetail, ExecutionStep } from '@meetpilot/shared';
import { api } from '../lib/api';
import { toast } from '../ui';
import { AGENT_LABEL } from '../routes/Reviews';

const AGENTS: AgentName[] = ['research', 'marketing', 'designer', 'communication', 'code'];

/** 0..1 confidence as a labelled pill. Below 0.6 reads as "needs a careful look". */
export function ConfidencePill({ value }: { value: number | null }) {
  if (value == null) return <span className="faint">—</span>;
  const pct = Math.round(value * 100);
  const tone = value >= 0.8 ? 'var(--success)' : value >= 0.6 ? 'var(--warn)' : 'var(--danger)';
  return <span className="row" style={{ gap: 6, color: tone, fontWeight: 600 }}><Gauge size={14} />{pct}%<span className="faint" style={{ fontWeight: 450 }}>{value >= 0.8 ? 'high' : value >= 0.6 ? 'medium' : 'low'}</span></span>;
}

export const usd = (v: number) => (v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);

/** "Needs your input": what the agent could not settle. Shown first because it decides whether to approve. */
export function NeedsInput({ questions }: { questions: string[] }) {
  if (!questions.length) return null;
  return (
    <div className="card" role="note" style={{ marginBottom: 16, borderColor: 'var(--warn)' }}>
      <h3 className="row" style={{ gap: 8, margin: '0 0 8px' }}><CircleHelp size={17} /> Needs your input</h3>
      <ul style={{ margin: 0, paddingLeft: 20 }}>{questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
    </div>
  );
}

const icon = (s: ExecutionStep['status']) => s === 'done' ? <CheckCircle2 size={14} color="var(--success)" /> : s === 'failed' ? <XCircle size={14} color="var(--danger)" /> : <Loader2 size={14} className="spin" />;

/** "What the agent did": the live step trace, collapsed once the work is finished. */
export function AgentTrace({ steps, busy }: { steps: ExecutionStep[]; busy: boolean }) {
  if (!steps.length) return null;
  const secs = (s: ExecutionStep) => (typeof s.detail.seconds === 'number' ? `${s.detail.seconds.toFixed(1)}s` : '');
  return (
    <details className="card" style={{ marginBottom: 16 }} open={busy}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}><Activity size={15} style={{ verticalAlign: -2, marginRight: 6 }} />What the agent did <span className="faint" style={{ fontWeight: 450 }}>· {steps.length} step{steps.length > 1 ? 's' : ''}</span></summary>
      <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
        {steps.map((s) => (
          <li key={s.seq} className="consult row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <span style={{ paddingTop: 3 }}>{icon(s.status)}</span>
            <div style={{ flex: 1 }}>
              <div><strong>{s.label}</strong> <span className="faint">{s.kind} {secs(s)}</span></div>
              {Array.isArray(s.detail.issues) && s.detail.issues.length > 0 && <div className="muted">Found: {(s.detail.issues as string[]).join('; ')}</div>}
              {Array.isArray(s.detail.blocking) && s.detail.blocking.length > 0 && <div className="muted">Found: {(s.detail.blocking as string[]).join('; ')}</div>}
              {typeof s.detail.question === 'string' && <div className="muted">“{s.detail.question}”</div>}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Planned hand-offs, e.g. Designer → Code for a web page. */
export function StagePlan({ plan }: { plan: ExecutionDetail['stagePlan'] }) {
  if (!plan?.stages || plan.stages.length < 2) return null;  // a plan can hold only a repository question
  return <div className="faint" style={{ marginBottom: 12 }}>Plan: {plan.stages.map((s) => AGENT_LABEL[s.agent] ?? s.agent).join(' → ')} (each stage is reviewed before the next starts)</div>;
}

/** Router was unsure (or the task looked like human work): let the reviewer run a specialist anyway. */
export function RunWith({ d, onDone }: { d: ExecutionDetail; onDone: () => void }) {
  const suggested = d.stagePlan?.suggestedAgent ?? null;
  const [agent, setAgent] = useState<AgentName>(suggested ?? 'research');
  const [busy, setBusy] = useState(false);
  if (d.status !== 'skipped_human' || !d.canReview) return null;
  const run = async () => {
    setBusy(true);
    try { await api(`/executions/${d.id}/run-with`, { method: 'POST', json: { agent } }); toast(`Running the ${AGENT_LABEL[agent]} agent…`); onDone(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <strong>Run an agent on this anyway</strong>
        <select value={agent} onChange={(e) => setAgent(e.target.value as AgentName)} aria-label="Agent">
          {AGENTS.map((a) => <option key={a} value={a}>{AGENT_LABEL[a]}{a === suggested ? ' (suggested)' : ''}</option>)}
        </select>
        <button className="primary" disabled={busy} onClick={run}><Play size={15} /> Run with {AGENT_LABEL[agent]}</button>
      </div>
      {d.stagePlan?.missingInputs?.length ? <p className="muted" style={{ margin: '8px 0 0' }}>It may need: {d.stagePlan.missingInputs.join('; ')}</p> : null}
    </div>
  );
}

/** Code work where several linked repositories fit: the reviewer decides, the agent never guesses. */
export function RepoChoice({ d, onDone }: { d: ExecutionDetail; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const choice = d.stagePlan?.repoChoice;
  if (!choice || d.status !== 'awaiting_review' || !d.canReview) return null;
  const pick = async (repoId: string) => {
    setBusy(true);
    try { await api(`/executions/${d.id}/repo`, { method: 'POST', json: { repoId } }); toast('Working on it…'); onDone(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ marginBottom: 16, borderColor: 'var(--warn)' }} role="group" aria-label="Choose the repository">
      <h3 className="row" style={{ gap: 8, margin: '0 0 6px' }}><GitBranch size={17} /> Which repository should this change go to?</h3>
      <p className="muted" style={{ margin: '0 0 10px' }}>{choice.reason} Nothing has been changed yet.</p>
      <div className="stack" style={{ gap: 8 }}>
        {choice.candidates.map((c) => (
          <div key={c.repo_id} className="row" style={{ gap: 10, alignItems: 'flex-start', justifyContent: 'space-between', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 10 }}>
            <div><strong>{c.full_name}</strong> <span className="faint">· {Math.round(c.score * 100)}% match</span>{c.reason && <div className="muted" style={{ fontSize: 13 }}>{c.reason}</div>}</div>
            <button className="primary" disabled={busy} onClick={() => pick(c.repo_id)}>Use this repository</button>
          </div>
        ))}
      </div>
    </div>
  );
}
