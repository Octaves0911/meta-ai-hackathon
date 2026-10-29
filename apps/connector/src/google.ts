// Minimal Google client (OAuth + Gmail + Drive, read-only). Endpoints are overridable so tests can use a fake Google.
import type { Tokens } from './vault.js';

const env = (k: string, d: string) => process.env[k] || d;
const base = () => env('GOOGLE_API_BASE', 'https://www.googleapis.com');
export const SCOPES = { gmail: 'https://www.googleapis.com/auth/gmail.readonly', drive: 'https://www.googleapis.com/auth/drive.readonly' } as const;

export class GoogleError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }

export function authUrl(state: string, services: ('gmail' | 'drive')[]): string {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '', redirect_uri: redirectUri(), response_type: 'code', access_type: 'offline', prompt: 'consent',
    include_granted_scopes: 'false', scope: ['openid', 'email', ...services.map((s) => SCOPES[s])].join(' '), state,
  });
  return `${env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth')}?${q}`;
}
export const redirectUri = () => env('GOOGLE_REDIRECT_URI', 'http://localhost:5173/api/connections/google/callback');

async function tokenRequest(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch(env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '', ...params }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(res.status, 'token request failed', body?.error);
  return body;
}

const toTokens = (r: { access_token: string; refresh_token?: string; expires_in: number }, prevRefresh?: string): Tokens =>
  ({ access_token: r.access_token, refresh_token: r.refresh_token ?? prevRefresh, expires_at: Date.now() + r.expires_in * 1000 });

export const exchangeCode = async (code: string) => toTokens(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() }));
export const refresh = async (t: Tokens) => {
  if (!t.refresh_token) throw new GoogleError(401, 'no refresh token', 'invalid_grant');
  return toTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token }), t.refresh_token);
};

export async function revoke(t: Tokens): Promise<void> {
  // Best effort: a token that is already invalid must not block deleting our copy of the data.
  await fetch(env('GOOGLE_REVOKE_URL', 'https://oauth2.googleapis.com/revoke'), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }),
  }).catch(() => {});
}

async function get(path: string, token: string, query: Record<string, string | string[] | undefined> = {}, raw = false): Promise<any> {
  const u = new URL(`${base()}${path}`);
  for (const [k, v] of Object.entries(query)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) u.searchParams.append(k, x);
  const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new GoogleError(res.status, `Google API ${path} failed`);
  return raw ? res.text() : res.json();
}

export const userEmail = async (token: string): Promise<string> => (await get('/oauth2/v3/userinfo', token)).email ?? 'unknown';

export const gmail = {
  labels: async (token: string): Promise<{ id: string; name: string; type: string }[]> => (await get('/gmail/v1/users/me/labels', token)).labels ?? [],
  async listIds(token: string, labelIds: string[], days: number, cap = 500): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const r = await get('/gmail/v1/users/me/messages', token, { labelIds, q: `newer_than:${days}d`, maxResults: '100', pageToken });
      ids.push(...(r.messages ?? []).map((m: { id: string }) => m.id));
      pageToken = r.nextPageToken;
    } while (pageToken && ids.length < cap);
    return [...new Set(ids)].slice(0, cap);
  },
  get: (token: string, id: string) => get(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, token, { format: 'full' }),
};

export interface DriveFile { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string; trashed?: boolean }
export const DOC_MIME = 'application/vnd.google-apps.document';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const TEXT_MIMES = new Set(['text/plain', 'text/markdown']);
export const indexable = (f: DriveFile) => f.mimeType === DOC_MIME || TEXT_MIMES.has(f.mimeType);

export const drive = {
  async list(token: string, parent: string, pageCap = 5): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < pageCap; i++) {
      const r = await get('/drive/v3/files', token, { q: `'${parent.replace(/'/g, '')}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,trashed)', pageSize: '100', pageToken });
      out.push(...(r.files ?? []));
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out.filter((f) => !f.trashed);
  },
  text: (token: string, f: DriveFile): Promise<string> => f.mimeType === DOC_MIME
    ? get(`/drive/v3/files/${encodeURIComponent(f.id)}/export`, token, { mimeType: 'text/plain' }, true)
    : get(`/drive/v3/files/${encodeURIComponent(f.id)}`, token, { alt: 'media' }, true),
};
