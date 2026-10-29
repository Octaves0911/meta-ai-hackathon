import { useCallback, useEffect, useState } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import type { Project, ProjectOverview } from '@meetpilot/shared';
import { api, storeUser, useSession } from '../lib/api';
import { NewProjectModal } from '../components/NewProjectModal';

const PANELS = ['meetings', 'workspace', 'agents', 'integrations'] as const;

export function Dashboard() {
  const { user, setUser } = useSession();
  const { panel = 'meetings' } = useParams();
  const nav = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState('');

  const loadProjects = useCallback(async () => {
    try {
      const list = await api<Project[]>('/projects');
      setProjects(list);
      setProjectId((cur) => (list.some((p) => p.id === cur) ? cur : list[0]?.id ?? ''));
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { if (user) loadProjects(); }, [user, loadProjects]);
  useEffect(() => {
    setOverview(null);
    if (projectId) api<ProjectOverview>(`/projects/${projectId}/overview`).then(setOverview).catch((e) => setError(e.message));
  }, [projectId]);

  if (!user) return <Navigate to="/start" replace />;
  const project = projects.find((p) => p.id === projectId);

  const signOut = () => { storeUser(null); setUser(null); nav('/'); };
  const deleteProject = async () => {
    if (!project || !confirm(`Delete "${project.name}" and all its meetings, tasks and memory? This cannot be undone.`)) return;
    try { await api(`/projects/${project.id}`, { method: 'DELETE' }); await loadProjects(); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <div className={`shell${collapsed ? ' collapsed' : ''}`}>
      <aside className="sidebar" aria-label="Sidebar">
        <button onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? '»' : '«'}
        </button>
        {!collapsed && (
          <>
            <label htmlFor="project">Project</label>
            <select id="project" value={projectId} onChange={(e) => setProjectId(e.target.value)}
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role === 'member' ? ' (shared)' : ''}</option>)}
            </select>
            <nav aria-label="Panels">
              {PANELS.map((p) => (
                <NavLink key={p} to={`/dashboard/${p}`} className={panel === p ? 'active' : ''}>{p[0].toUpperCase() + p.slice(1)}</NavLink>
              ))}
              <span className="muted" title="Coming soon">Reviews</span>
            </nav>
            <div className="spacer" />
            <div className="card">
              <strong>{user.username}</strong>
              <div><button onClick={signOut} style={{ marginTop: 8 }}>Switch user</button></div>
            </div>
          </>
        )}
      </aside>
      <main className="main">
        <div className="toolbar">
          <button disabled title="Coming soon" aria-label="Notifications">🔔</button>
          <button className="primary" onClick={() => setShowNew(true)}>New project</button>
          <button disabled title="Coming soon">New meeting</button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {!project ? (
          <div className="card"><h2>No projects yet</h2><p className="muted">Create your first project to start scheduling meetings.</p>
            <button className="primary" onClick={() => setShowNew(true)}>New project</button></div>
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div><h1>{project.name}</h1><p className="muted">{project.description}</p></div>
              {project.role === 'owner' && <button className="danger" onClick={deleteProject}>Delete project</button>}
            </div>
            {panel === 'meetings' ? <Overview o={overview} /> : (
              <div className="card"><h3>{panel[0].toUpperCase() + panel.slice(1)}</h3><p className="muted">Coming in a later release.</p></div>
            )}
          </>
        )}
      </main>
      {showNew && <NewProjectModal onClose={() => setShowNew(false)}
        onCreated={(p) => { setShowNew(false); setProjects((l) => [p, ...l]); setProjectId(p.id); }} />}
    </div>
  );
}

function Overview({ o }: { o: ProjectOverview | null }) {
  if (!o) return <p className="muted">Loading…</p>;
  const max = Math.max(1, ...o.monthly.map((m) => m.count));
  const stats: [string, string | number][] = [
    ['Meetings', o.meetings], ['This week', o.thisWeek], ['Active now', o.activeNow],
    ['Avg duration', `${Math.round(o.avgDurationSec / 60)} min`],
  ];
  return (
    <>
      <div className="grid">{stats.map(([l, v]) => <div className="card" key={l}><div className="muted">{l}</div><div className="stat">{v}</div></div>)}</div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Meetings, last 6 months</h3>
        <div className="bars" role="img" aria-label="Meetings per month">
          {o.monthly.map((m) => (
            <div key={m.month} style={{ height: `${(m.count / max) * 100}%` }} title={`${m.month}: ${m.count}`}><span>{m.month.slice(5)}</span></div>
          ))}
        </div>
      </div>
    </>
  );
}
