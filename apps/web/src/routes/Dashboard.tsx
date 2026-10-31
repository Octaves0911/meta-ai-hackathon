import * as Menu from '@radix-ui/react-dropdown-menu';
import { CalendarDays, FolderPlus, MoreHorizontal, Plus, Radio, Timer, Trash2, Video } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import type { Meeting, Project, ProjectOverview } from '@meetpilot/shared';
import { api, useSession } from '../lib/api';
import { AppShell, type NavKey } from '../components/AppShell';
import { IntelligenceDashboard } from '../components/intel/IntelligenceDashboard';
import { IntegrationsPanel } from '../components/IntegrationsPanel';
import { MeetingsTable } from '../components/MeetingsTable';
import { NewMeetingModal } from '../components/NewMeetingModal';
import { NewProjectModal } from '../components/NewProjectModal';
import { WorkspacePanel } from '../components/WorkspacePanel';
import { EmptyState, Skeleton, toast, useConfirm } from '../ui';

const PANEL_TITLE: Record<string, string> = { overview: 'Overview', meetings: 'Meetings', workspace: 'Workspace', integrations: 'Integrations' };

export function Dashboard() {
  const { user } = useSession();
  const { panel = 'overview' } = useParams();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [showProject, setShowProject] = useState(false);
  const [showMeeting, setShowMeeting] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      const list = await api<Project[]>('/projects');
      setProjects(list);
      setProjectId((cur) => (list.some((p) => p.id === cur) ? cur : list[0]?.id ?? ''));
    } catch (e) { toast.error((e as Error).message); setProjects([]); }
  }, []);
  useEffect(() => { if (user) void loadProjects(); }, [user, loadProjects]);

  const loadProject = useCallback(() => {
    if (!projectId) return;
    api<ProjectOverview>(`/projects/${projectId}/overview`).then(setOverview).catch((e) => toast.error(e.message));
    api<Meeting[]>(`/projects/${projectId}/meetings`).then(setMeetings).catch((e) => toast.error(e.message));
  }, [projectId]);
  useEffect(() => { setOverview(null); setMeetings(null); loadProject(); }, [loadProject]);

  if (!user) return <Navigate to="/start" replace />;
  const project = projects?.find((p) => p.id === projectId);
  const active = (['overview', 'meetings', 'workspace', 'integrations'].includes(panel) ? panel : 'overview') as NavKey;

  const deleteProject = async () => {
    if (!project) return;
    const ok = await confirm({ title: `Delete “${project.name}”?`, message: 'This permanently removes its meetings, tasks, files, memory and connected accounts.', confirmLabel: 'Delete project', danger: true });
    if (!ok) return;
    try { await api(`/projects/${project.id}`, { method: 'DELETE' }); toast.success('Project deleted'); await loadProjects(); } catch (e) { toast.error((e as Error).message); }
  };

  const newMeetingBtn = <button className="primary" disabled={!project} onClick={() => setShowMeeting(true)}><Plus size={16} /> <span className="btn-label">New meeting</span></button>;

  return (
    <AppShell
      active={active} projects={projects ?? []} projectId={projectId} onProject={setProjectId}
      crumbs={<span>{project?.name ?? 'MeetPilot'}<span className="faint"> / </span><span style={{ color: 'var(--text)' }}>{PANEL_TITLE[active]}</span></span>}
      actions={<><button onClick={() => setShowProject(true)}><FolderPlus size={16} /> <span className="btn-label">New project</span></button>{newMeetingBtn}</>}
    >
      {projects === null ? <div className="stack"><Skeleton h={34} w={260} /><div className="grid"><Skeleton h={96} /><Skeleton h={96} /><Skeleton h={96} /><Skeleton h={96} /></div></div>
        : !project ? (
          <div className="card"><EmptyState icon={FolderPlus} title="Create your first project" action={<button className="primary" onClick={() => setShowProject(true)}><FolderPlus size={16} /> New project</button>}>
            Projects hold your meetings, files, connected accounts and the memory the assistant draws on.</EmptyState></div>
        ) : (
          <>
            <div className="page-head">
              <div><h1>{project.name}</h1>{project.description && <p>{project.description}</p>}</div>
              {project.role === 'owner' && (
                <Menu.Root>
                  <Menu.Trigger asChild><button className="ghost icon" aria-label="Project actions"><MoreHorizontal size={19} /></button></Menu.Trigger>
                  <Menu.Portal><Menu.Content className="menu" align="end" sideOffset={6}>
                    <Menu.Item className="menu-item" style={{ color: 'var(--danger-text)' }} onSelect={deleteProject}><Trash2 size={16} /> Delete project</Menu.Item>
                  </Menu.Content></Menu.Portal>
                </Menu.Root>
              )}
            </div>

            {active === 'overview' && <IntelligenceDashboard projectId={project.id} />}
            {active === 'meetings' && (
              <>
                <Stats o={overview} />
                <div className="section-title"><h3>Meetings</h3></div>
                {meetings === null ? <div className="card list-card"><Skeleton h={64} /><Skeleton h={64} /></div> : <MeetingsTable meetings={meetings} action={newMeetingBtn} />}
              </>
            )}
            {active === 'workspace' && <WorkspacePanel projectId={project.id} />}
            {active === 'integrations' && <IntegrationsPanel projectId={project.id} />}
          </>
        )}

      {showProject && <NewProjectModal onClose={() => setShowProject(false)} onCreated={(p) => { setShowProject(false); setProjects((l) => [p, ...(l ?? [])]); setProjectId(p.id); }} />}
      {showMeeting && project && <NewMeetingModal projectId={project.id} onClose={() => setShowMeeting(false)} onCreated={(m) => { setShowMeeting(false); loadProject(); nav(m.status === 'active' ? `/meetings/${m.id}` : `/meetings/${m.id}`); }} />}
    </AppShell>
  );
}

function Stats({ o }: { o: ProjectOverview | null }) {
  if (!o) return <div className="grid"><Skeleton h={104} /><Skeleton h={104} /><Skeleton h={104} /><Skeleton h={104} /></div>;
  const max = Math.max(1, ...o.monthly.map((m) => m.count));
  const cards = [
    { label: 'Meetings', value: o.meetings, icon: Video, tone: '', sub: 'in this project' },
    { label: 'This week', value: o.thisWeek, icon: CalendarDays, tone: 'ai', sub: 'last 7 days' },
    { label: 'Live now', value: o.activeNow, icon: Radio, tone: 'ok', sub: o.activeNow ? 'in progress' : 'nothing running' },
    { label: 'Avg duration', value: `${Math.round(o.avgDurationSec / 60)} min`, icon: Timer, tone: 'warn', sub: 'per meeting' },
  ];
  return (
    <>
      <div className="grid">
        {cards.map(({ label, value, icon: Icon, tone, sub }) => (
          <div className="card stat-card" key={label}>
            <div className="label"><span className={`ico ${tone}`}><Icon size={16} /></span>{label}</div>
            <div className="stat">{value}</div><div className="sub">{sub}</div>
          </div>
        ))}
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>Meetings per month</h3><span className="faint" style={{ fontSize: 13 }}>Last 6 months</span></div>
        <div className="bars" role="img" aria-label="Meetings per month">
          {o.monthly.map((m) => (
            <div className="bar" key={m.month} title={`${m.month}: ${m.count}`}><i className={m.count ? '' : 'zero'} style={{ height: `${Math.max(4, (m.count / max) * 100)}%` }} /><span>{m.month.slice(5)}</span></div>
          ))}
        </div>
      </div>
    </>
  );
}
