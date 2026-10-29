import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { User } from '@meetpilot/shared';
import { api, storeUser, useSession } from '../lib/api';

export function GetStarted() {
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const { setUser } = useSession();
  const nav = useNavigate();

  const load = () => api<User[]>('/users').then(setUsers).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const enter = (u: User) => { storeUser(u.username); setUser(u); nav('/dashboard'); };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try { enter(await api<User>('/users', { method: 'POST', json: { username: name } })); }
    catch (err) { setError((err as Error).message); }
  };

  const remove = async (u: User) => {
    if (!confirm(`Delete ${u.username} and everything they own? This cannot be undone.`)) return;
    try {
      const prev = storeUserSwap(u.username);
      await api(`/users/${u.id}`, { method: 'DELETE' });
      prev();
      await load();
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <div className="center">
      <div className="card">
        <h2>Get started</h2>
        {users.length > 0 && (
          <>
            <p className="muted">Choose a user</p>
            <ul className="user-list">
              {users.map((u) => (
                <li key={u.id}>
                  <button onClick={() => enter(u)}>{u.username}</button>
                  <button className="danger" aria-label={`Delete ${u.username}`} onClick={() => remove(u)}>Delete</button>
                </li>
              ))}
            </ul>
          </>
        )}
        <form onSubmit={create}>
          <label htmlFor="username">New username</label>
          <input id="username" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          <button className="primary" style={{ marginTop: 12 }} disabled={name.trim().length < 2}>Create and continue</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  );
}

// Deleting acts as the target user (identity is username-only); restore the previous identity afterwards.
function storeUserSwap(username: string) {
  const prev = localStorage.getItem('meetpilot.user');
  storeUser(username);
  return () => storeUser(prev);
}
