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

/** Authenticated download of raw bytes (iframes and <a> cannot send the user header, so we fetch and hand out an object URL). */
export async function fetchBlob(path: string): Promise<Blob> {
  const res = await fetch(`/api${path}`, { headers: { 'x-user': storedUser() ?? '' } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? 'download failed');
  return res.blob();
}

/** POST that answers with newline-delimited JSON (the streamed agent chat): `onLine` gets each parsed line as it arrives; resolves when the stream ends. */
export async function streamNdjson<T = any>(path: string, json: unknown, onLine: (line: T) => void): Promise<void> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': storedUser() ?? '' }, body: JSON.stringify(json) });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error?.message ?? 'request failed');
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { try { onLine(JSON.parse(line) as T); } catch { /* a broken line is skipped */ } }
    }
  }
}

export interface Session { user: User | null; setUser: (u: User | null) => void }
export const SessionContext = createContext<Session>({ user: null, setUser: () => {} });
export const useSession = () => useContext(SessionContext);
