import { createContext, useContext } from 'react';
import type { User } from '@meetpilot/shared';

const KEY = 'meetpilot.user';

// Per-tab identity (sessionStorage) wins over the browser-wide default (localStorage), so two tabs can be two people.
export const storedUser = (): string | null => {
  try { return sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY); } catch { return null; }
};
export const storeUser = (name: string | null) => {
  try {
    for (const store of [sessionStorage, localStorage]) name ? store.setItem(KEY, name) : store.removeItem(KEY);
  } catch { /* storage unavailable */ }
};

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const user = storedUser();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(user ? { 'x-user': user } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `request failed (${res.status})`);
  return data as T;
}

export interface Session { user: User | null; setUser: (u: User | null) => void }
export const SessionContext = createContext<Session>({ user: null, setUser: () => {} });
export const useSession = () => useContext(SessionContext);
