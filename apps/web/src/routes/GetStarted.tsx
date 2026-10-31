import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Loader2, Sparkles, Trash2 } from 'lucide-react';
import type { User } from '@meetpilot/shared';
import { api, storedUser, storeUser, useSession } from '../lib/api';
import { Avatar, Logo, Skeleton, ThemeToggle, toast } from '../ui';

export function GetStarted() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { setUser } = useSession();
  const nav = useNavigate();

  const load = () => api<User[]>('/users').then(setUsers).catch((e) => { setError(e.message); setUsers([]); });
  useEffect(() => { void load(); }, []);

  const enter = (u: User) => { storeUser(u.username); setUser(u); nav('/dashboard'); };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try { enter(await api<User>('/users', { method: 'POST', json: { username: name } })); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  const remove = async (u: User) => {
    if (!confirm(`Delete ${u.username} and everything they own? This cannot be undone.`)) return;
    try {
      const prev = storedUser();
      storeUser(u.username); // identity is username-only, so deleting acts as that user
      await api(`/users/${u.id}`, { method: 'DELETE' });
      storeUser(prev);
      toast.success(`Deleted ${u.username}`);
      await load();
    } catch (err) { toast.error((err as Error).message); }
  };

  return (
    <div className="auth">
      <aside className="auth-art">
        <Link to="/" className="brand"><Logo size={34} /> <span>MeetPilot</span></Link>
        <div>
          <h2>Meetings that remember, and follow through.</h2>
          <p>Live captions, a quiet assistant with project memory, and specialist agents that draft the follow-up for you.</p>
        </div>
        <div className="quote"><Sparkles size={16} style={{ verticalAlign: -3, marginRight: 6 }} />“Earlier meeting decided deployment on August 1.” The assistant speaks up only when it changes the decision.</div>
      </aside>

      <section className="auth-panel">
        <div className="theme-corner"><ThemeToggle /></div>
        <div className="auth-card">
          <h1>Welcome</h1>
          <p className="muted">Pick your name, or create one. There’s no password in this version.</p>

          <div className="user-pick" aria-live="polite">
            {users === null && [0, 1].map((i) => <Skeleton key={i} h={56} />)}
            {users?.map((u) => (
              <div className="user-row" key={u.id}>
                <button className="user-option" onClick={() => enter(u)}><Avatar name={u.username} /><span className="name">{u.username}</span><ArrowRight size={17} className="go" /></button>
                <button className="ghost icon" style={{ minHeight: 56, width: 44 }} aria-label={`Delete ${u.username}`} title="Delete user" onClick={() => remove(u)}><Trash2 size={17} /></button>
              </div>
            ))}
          </div>

          <div className="auth-divider">{users && users.length > 0 ? 'or create a new one' : 'create your name'}</div>
          <form onSubmit={create}>
            <label htmlFor="username">Username</label>
            <input id="username" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder="e.g. priya" />
            <button className="primary" style={{ width: '100%', marginTop: 14, minHeight: 44 }} disabled={name.trim().length < 2 || busy}>
              {busy ? <Loader2 size={17} className="spin" /> : null} Create and continue
            </button>
          </form>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}
