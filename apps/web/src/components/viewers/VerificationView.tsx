import { AlertTriangle, CheckCircle2, Clock, FlaskConical, XCircle } from 'lucide-react';

interface Step { phase: string; label: string; exit_code: number; seconds?: number; timed_out?: boolean; output: string; counts?: { passed?: number; failed?: number; skipped?: number } }

const TONE = {
  verified: { icon: <CheckCircle2 size={20} />, color: 'var(--success)', title: 'Verified in an isolated sandbox', soft: 'var(--success-soft)' },
  failed: { icon: <XCircle size={20} />, color: 'var(--danger)', title: 'Failed verification', soft: 'var(--danger-soft)' },
  not_tested: { icon: <AlertTriangle size={20} />, color: 'var(--warn)', title: 'Not tested', soft: 'var(--warn-soft)' },
} as const;

/** What the sandbox actually did with the change: the headline, the red/green test evidence, warnings, and every command with its output. */
export function VerificationView({ payload }: { payload: Record<string, any> | null }) {
  const p = payload ?? {};
  const t = TONE[(p.status as keyof typeof TONE) ?? 'not_tested'] ?? TONE.not_tested;
  const steps: Step[] = Array.isArray(p.steps) ? p.steps : [];
  return (
    <div>
      <div className="row" style={{ gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 12, background: t.soft }} role="status">
        <span style={{ color: t.color, paddingTop: 1 }}>{t.icon}</span>
        <div>
          <strong>{t.title}{p.status === 'verified' && p.summary ? ` — ${String(p.summary).replace(/^Verified\s*/, '')}` : ''}</strong>
          {p.reason && <div className="muted">{p.reason}</div>}
          {p.mode === 'mock' && <div className="faint">Mock mode: no code was run.</div>}
        </div>
      </div>
      <dl className="kv" style={{ margin: '12px 0' }}>
        {p.repo && <div><dt>Repository</dt><dd>{p.repo}{p.branch ? <span className="faint"> @ {p.branch}</span> : null}</dd></div>}
        {p.ecosystem && <div><dt>Project type</dt><dd>{p.ecosystem}</dd></div>}
        {typeof p.seconds === 'number' && p.seconds > 0 && <div><dt>Duration</dt><dd><Clock size={13} style={{ verticalAlign: -2 }} /> {Math.round(p.seconds)} s</dd></div>}
        {typeof p.cost_usd === 'number' && p.cost_usd > 0 && <div><dt>Sandbox cost (est.)</dt><dd>${p.cost_usd.toFixed(3)}</dd></div>}
      </dl>
      {p.red_exit != null && (
        <p className="row" style={{ gap: 8, margin: '0 0 10px' }}><FlaskConical size={16} />
          <span>New tests <strong>{p.red_exit !== 0 ? 'failed' : 'passed'}</strong> before the fix and <strong>{p.green_exit === 0 ? 'passed' : 'failed'}</strong> after it.{p.red_exit === 0 ? ' They may not test the change.' : ''}</span></p>
      )}
      {Array.isArray(p.warnings) && p.warnings.length > 0 && <ul className="muted" style={{ margin: '0 0 12px', paddingLeft: 20 }}>{p.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>}
      {steps.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <strong style={{ fontSize: 14 }}>What ran</strong>
          {steps.map((s, i) => (
            <details key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px' }}>
              <summary style={{ cursor: 'pointer' }}>
                <span className="faint">{s.phase === 'setup' ? 'setup (limited network)' : s.phase === 'static' ? 'static check' : 'run (no network)'} · </span><strong>{s.label}</strong>
                <span style={{ marginLeft: 8, color: s.exit_code === 0 && !s.timed_out ? 'var(--success-text)' : 'var(--danger-text)' }}>{s.timed_out ? 'timed out' : s.phase === 'static' ? (s.exit_code === 0 ? 'passed' : 'failed') : `exit ${s.exit_code}`}</span>
                <span className="faint">{s.phase === 'static' ? '' : ` · ${(s.seconds ?? 0).toFixed(1)} s`}{s.counts?.passed != null ? ` · ${s.counts.passed} passed${s.counts.failed ? `, ${s.counts.failed} failed` : ''}` : ''}</span>
              </summary>
              <pre className="diff" style={{ marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto' }}><code>{s.output || '(no output)'}</code></pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
