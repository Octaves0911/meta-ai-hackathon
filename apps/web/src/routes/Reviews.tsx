import { Bot, CheckCircle2, ChevronRight, Clock, Hand, Loader2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { ExecutionSummary } from '@meetpilot/shared';
import { AppShell } from '../components/AppShell';
import { api, useSession } from '../lib/api';
import { getSocket } from '../lib/socket';
import { EmptyState, Skeleton } from '../ui';

export const STATUS_LABEL: Record<string, string> = {
  awaiting_review: 'Needs your review', routed: 'Queued', running: 'Working…', changes_requested: 'Redoing with your feedback',
  approved: 'Approved', rejected: 'Rejected', failed: 'Failed', skipped_human: 'Left for a human',
};
export const AGENT_LABEL: Record<string, string> = { research: 'Research', marketing: 'Marketing', designer: 'Designer', communication: 'Communication', code: 'Code' };

export function StatusBadge({ status }: { status: string }) {
  const icon = status === 'approved' ? <CheckCircle2 size={13} /> : (status === 'failed' || status === 'rejected') ? <XCircle size={13} /> : status === 'skipped_human' ? <Hand size={13} />
    : status === 'awaiting_review' ? <Clock size={13} /> : <Loader2 size={13} className="spin" />;
  return <span className={`status status-${status}`} style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>{icon}{STATUS_LABEL[status] ?? status}</span>;
}

function Row({ e }: { e: ExecutionSummary }) {
  return (
    <Link to={`/reviews/${e.id}`} className="review-row">
      <div className="row" style={{ gap: 14, minWidth: 0 }}>
        <span className="avatar lg" style={{ background: e.agent ? 'var(--ai)' : 'var(--text-3)', borderRadius: 12 }}><Bot size={20} /></span>
        <div style={{ minWidth: 0 }}><strong style={{ display: 'block' }}>{e.taskTitle}</strong>
          <span className="faint" style={{ fontSize: 13 }}>{e.projectName} · {e.meetingTitle}{e.agent ? ` · ${AGENT_LABEL[e.agent] ?? e.agent} agent` : ''}{e.dueDate ? ` · due ${e.dueDate}` : ''}</span></div>
      </div>
      <div className="row"><StatusBadge status={e.status} /><ChevronRight size={17} className="faint" /></div>
    </Link>
  );
}

const GROUPS: { key: string; label: string }[] = [
  { key: '', label: 'All' }, { key: 'needs_review', label: 'Needs review' }, { key: 'working', label: 'Working' },
  { key: 'done', label: 'Approved' }, { key: 'human', label: 'Left for a human' }, { key: 'problem', label: 'Failed / rejected' },
];

export function Reviews() {
  const { user } = useSession();
  const [items, setItems] = useState<ExecutionSummary[] | null>(null);
  const [group, setGroup] = useState('');
  const [project, setProject] = useState('');
  const [agent, setAgent] = useState('');
  const [all, setAll] = useState<ExecutionSummary[]>([]);
  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (group) q.set('group', group);
    if (project) q.set('project', project);
    if (agent) q.set('agent', agent);
    return api<ExecutionSummary[]>(`/reviews${q.size ? `?${q}` : ''}`).then(setItems).catch(() => setItems([]));
  }, [group, project, agent]);
  // Unfiltered list only to know which projects/counts exist for the filter controls.
  const loadAll = useCallback(() => api<ExecutionSummary[]>('/reviews').then(setAll).catch(() => setAll([])), []);

  useEffect(() => {
    if (!user) return;
    void load(); void loadAll();
    const s = getSocket(user.username);
    const both = () => { void load(); void loadAll(); };
    s.on('execution:update', both);
    return () => { s.off('execution:update', both); };
  }, [user, load, loadAll]);
  if (!user) return <Navigate to="/start" replace />;

  const projects = [...new Map(all.map((e) => [e.projectId, e.projectName])).entries()];
  const countOf = (key: string) => all.filter((e) => (key === '' ? true : GROUP_STATUS[key].includes(e.status))).length;
  const needs = (items ?? []).filter((e) => e.status === 'awaiting_review');
  const rest = (items ?? []).filter((e) => e.status !== 'awaiting_review');
  const filtered = !!(group || project || agent);
  return (
    <AppShell active="reviews" crumbs={<span>Agent reviews</span>}>
      <div className="page-head"><div><h1>Agent reviews</h1><p>Specialist agents draft the follow-up work. Nothing leaves MeetPilot until you approve it.</p></div></div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 16 }} role="toolbar" aria-label="Filter reviews">
        {GROUPS.map((g) => (
          <button key={g.key} className={`chip${group === g.key ? ' active' : ''}`} aria-pressed={group === g.key} onClick={() => setGroup(g.key)}>
            {g.label}{countOf(g.key) > 0 && <span className="faint"> {countOf(g.key)}</span>}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {projects.length > 1 && <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project"><option value="">All projects</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>}
        <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent"><option value="">All agents</option>{Object.entries(AGENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>
      {items === null ? <div className="stack"><Skeleton h={72} /><Skeleton h={72} /></div> : filtered ? (
        items.length === 0 ? <div className="card"><EmptyState icon={Bot} title="Nothing matches these filters">Try another status, project or agent.</EmptyState></div>
          : <div className="review-list">{items.map((e) => <Row key={e.id} e={e} />)}</div>
      ) : (
        <>
          <div className="section-title" style={{ marginTop: 0 }}><h3>Needs your review {needs.length > 0 && <span className="badge-count">{needs.length}</span>}</h3></div>
          {needs.length === 0 ? <div className="card"><EmptyState icon={CheckCircle2} title="Nothing is waiting for you">When a meeting ends, doable tasks are handed to agents and their drafts show up here.</EmptyState></div>
            : <div className="review-list">{needs.map((e) => <Row key={e.id} e={e} />)}</div>}
          <div className="section-title"><h3>Everything else</h3></div>
          {rest.length === 0 ? <div className="card"><EmptyState icon={Bot} title="No other agent work yet">Finished, running and human-only tasks are listed here.</EmptyState></div>
            : <div className="review-list">{rest.map((e) => <Row key={e.id} e={e} />)}</div>}
        </>
      )}
    </AppShell>
  );
}

const GROUP_STATUS: Record<string, string[]> = {
  needs_review: ['awaiting_review'], working: ['routed', 'running', 'changes_requested'], done: ['approved'], human: ['skipped_human'], problem: ['failed', 'rejected'],
};
