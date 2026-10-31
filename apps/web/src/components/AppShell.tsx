import * as Menu from '@radix-ui/react-dropdown-menu';
import { Bot, ChevronsUpDown, FolderOpen, Gauge, Video, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Plug, Sun } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import type { Project } from '@meetpilot/shared';
import { storeUser, useSession } from '../lib/api';
import { Avatar, Logo, useTheme } from '../ui';
import { NotificationBell } from './NotificationBell';

export type NavKey = 'overview' | 'meetings' | 'workspace' | 'integrations' | 'reviews';
const NAV: { key: NavKey; to: string; label: string; icon: typeof Bot }[] = [
  { key: 'overview', to: '/dashboard/overview', label: 'Overview', icon: Gauge },
  { key: 'meetings', to: '/dashboard/meetings', label: 'Meetings', icon: Video },
  { key: 'workspace', to: '/dashboard/workspace', label: 'Workspace', icon: FolderOpen },
  { key: 'integrations', to: '/dashboard/integrations', label: 'Integrations', icon: Plug },
  { key: 'reviews', to: '/reviews', label: 'Agent reviews', icon: Bot },
];

interface Props {
  active: NavKey;
  crumbs: ReactNode;
  actions?: ReactNode;
  projects?: Project[];
  projectId?: string;
  onProject?: (id: string) => void;
  children: ReactNode;
}

/** Sidebar + top bar used by every signed-in page except the meeting room. */
export function AppShell({ active, crumbs, actions, projects, projectId, onProject, children }: Props) {
  const { user, setUser } = useSession();
  const { resolved, setMode } = useTheme();
  const nav = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const signOut = () => { storeUser(null); setUser(null); nav('/'); };

  return (
    <div className={`app${collapsed ? ' collapsed' : ''}`}>
      <aside className="sidebar" aria-label="Sidebar">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Link to="/dashboard" className="brand"><Logo /><span>MeetPilot</span></Link>
          <button className="ghost icon collapse-btn" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>

        {projects && (
          <div className="project-switch">
            <label htmlFor="project">Project</label>
            <select id="project" value={projectId ?? ''} onChange={(e) => onProject?.(e.target.value)}>
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role === 'member' ? ' (shared)' : ''}</option>)}
            </select>
          </div>
        )}

        <nav className="nav" aria-label="Main">
          {NAV.map(({ key, to, label, icon: Icon }) => (
            <NavLink key={key} to={to} className={`nav-item${active === key ? ' active' : ''}`} title={label}><Icon size={18} /><span>{label}</span></NavLink>
          ))}
        </nav>
        <div className="spacer" />

        {user && (
          <Menu.Root>
            <Menu.Trigger asChild>
              <button className="user-card ghost" style={{ justifyContent: 'flex-start', width: '100%', minHeight: 56, textAlign: 'left' }}>
                <Avatar name={user.username} />
                <span className="who">{user.username}<small>Signed in</small></span>
                <ChevronsUpDown size={15} className="faint" />
              </button>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content className="menu" side="top" align="start" sideOffset={8}>
                <div className="menu-label">Signed in as {user.username}</div>
                <Menu.Item className="menu-item" onSelect={() => setMode(resolved === 'dark' ? 'light' : 'dark')}>
                  {resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />} {resolved === 'dark' ? 'Light theme' : 'Dark theme'}
                </Menu.Item>
                <div className="menu-sep" />
                <Menu.Item className="menu-item" onSelect={signOut}><LogOut size={16} /> Switch user</Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        )}
      </aside>

      <div className="content">
        <header className="topbar">
          <div className="crumbs">{crumbs}</div>
          <div className="actions">{actions}<NotificationBell /></div>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
