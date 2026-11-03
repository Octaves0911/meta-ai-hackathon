// GitHub access for project repositories (docs/09 §1.10). The optional per-project token is sealed with the same vault as Google's tokens, never leaves
// this service, never appears in errors or logs, and is never sent to a model. Public repositories work without any token (GitHub's anonymous rate limit
// applies); private repositories and PR permission checks need one.
import type pg from 'pg';
import { open, seal, vaultConfigured } from './vault.js';

export class GithubError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

const API = () => (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
export const MAX_INDEX_CHARS = 6000;
const MAX_README = 1800;

export interface RepoMeta { owner: string; name: string; defaultBranch: string; description: string | null; isPrivate: boolean; canPush: boolean; language: string | null; htmlUrl: string }
export interface RepoInspection { meta: RepoMeta; languages: Record<string, number>; indexText: string }

type Fetch = typeof fetch;

export class GithubClient {
  constructor(private f: Fetch = fetch) {}

  /** One GET with the token (if any). Errors are mapped to short, token-free messages. */
  private async get(path: string, token?: string | null): Promise<any> {
    let res: Response;
    try {
      res = await this.f(`${API()}${path}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'MeetPilot', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
    } catch { throw new GithubError(502, 'github_unreachable', 'GitHub could not be reached'); }
    if (res.status === 404) throw new GithubError(404, 'repo_not_found', token ? 'Repository not found, or the token has no access to it' : 'Repository not found (if it is private, add a GitHub token first)');
    if (res.status === 401) throw new GithubError(401, 'bad_token', 'GitHub rejected the token');
    if (res.status === 403 || res.status === 429) {
      const limited = res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429;
      if (limited) throw new GithubError(429, 'rate_limited', 'GitHub rate limit reached; add a token or try again later');
      throw new GithubError(403, 'forbidden', 'GitHub refused access to this repository');
    }
    if (!res.ok) throw new GithubError(502, 'github_error', `GitHub answered ${res.status}`);
    return res.json();
  }

  async user(token: string): Promise<{ login: string }> {
    const u = await this.get('/user', token);
    if (!u?.login) throw new GithubError(502, 'github_error', 'GitHub returned no account');
    return { login: String(u.login) };
  }

  async repo(owner: string, name: string, token?: string | null): Promise<RepoMeta> {
    if (!OWNER.test(owner) || !NAME.test(name)) throw new GithubError(400, 'invalid_repo', 'that is not a valid repository name');
    const r = await this.get(`/repos/${owner}/${name}`, token);
    return {
      owner: String(r.owner?.login ?? owner), name: String(r.name ?? name), defaultBranch: String(r.default_branch ?? 'main'), description: r.description ? String(r.description).slice(0, 300) : null,
      isPrivate: !!r.private, canPush: !!r.permissions?.push, language: r.language ? String(r.language) : null, htmlUrl: String(r.html_url ?? `https://github.com/${owner}/${name}`),
    };
  }

  /** Everything the repo picker reads about a repository: languages, README start, the top-level tree and manifest highlights. Best effort per part. */
  async inspect(owner: string, name: string, token?: string | null): Promise<RepoInspection> {
    const meta = await this.repo(owner, name, token);
    const safe = async <T>(p: Promise<T>, d: T): Promise<T> => { try { return await p; } catch (e) { if (e instanceof GithubError && ['rate_limited', 'bad_token'].includes(e.code)) throw e; return d; } };
    const base = `/repos/${meta.owner}/${meta.name}`;
    const [languages, readme, tree] = await Promise.all([
      safe(this.get(`${base}/languages`, token) as Promise<Record<string, number>>, {}),
      safe(this.get(`${base}/readme`, token), null),
      safe(this.get(`${base}/contents/`, token), []),
    ]);
    const top: { name: string; type: string }[] = Array.isArray(tree) ? tree.map((t: any) => ({ name: String(t.name), type: String(t.type) })).slice(0, 60) : [];
    const manifests: string[] = [];
    for (const f of ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'Gemfile'].filter((f) => top.some((t) => t.name === f && t.type === 'file')).slice(0, 3)) {
      const c = await safe(this.get(`${base}/contents/${f}`, token), null);
      const text = decode(c?.content);
      if (text) manifests.push(`${f}: ${summariseManifest(f, text)}`);
    }
    return { meta, languages: languages && typeof languages === 'object' ? languages : {}, indexText: buildIndexText(meta, languages ?? {}, decode(readme?.content), top, manifests) };
  }
}

const decode = (b64?: unknown): string => (typeof b64 === 'string' ? Buffer.from(b64, 'base64').toString('utf8') : '');

/** The README with images, HTML and badges removed, trimmed to the start (where the purpose is stated). */
export function cleanReadme(md: string): string {
  return md.replace(/<[^>]+>/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\&*_`#>\[\]()!-])/g, '$1').replace(/[`*_>#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_README);
}

export function summariseManifest(file: string, text: string): string {
  if (file === 'package.json') {
    try {
      const j = JSON.parse(text);
      const deps = Object.keys({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }).slice(0, 15);
      return `name ${j.name ?? '?'}${j.description ? `, “${String(j.description).slice(0, 120)}”` : ''}; scripts ${Object.keys(j.scripts ?? {}).slice(0, 10).join(', ') || 'none'}; deps ${deps.join(', ') || 'none'}`;
    } catch { return 'unreadable'; }
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}

export function buildIndexText(meta: RepoMeta, languages: Record<string, number>, readme: string, top: { name: string; type: string }[], manifests: string[]): string {
  const total = Object.values(languages).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0) || 1;
  const langs = Object.entries(languages).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, n]) => `${l} ${Math.round((n / total) * 100)}%`).join(', ');
  const parts = [
    `${meta.owner}/${meta.name}${meta.description ? ` — ${meta.description}` : ''}`,
    langs ? `Languages: ${langs}` : '',
    top.length ? `Top level: ${top.map((t) => (t.type === 'dir' ? `${t.name}/` : t.name)).join(', ')}` : '',
    ...manifests,
    readme ? `README: ${cleanReadme(readme)}` : '',
  ].filter(Boolean);
  return parts.join('\n').slice(0, MAX_INDEX_CHARS);
}

/** Per-project token storage (sealed) and the calls that use it. */
export class GithubService {
  constructor(private db: pg.Pool, private client = new GithubClient()) {}

  private async token(projectId: string): Promise<string | null> {
    const { rows } = await this.db.query('select token_ciphertext, token_iv, token_tag from github_connections where project_id = $1', [projectId]);
    if (!rows[0]) return null;
    try { return open({ ciphertext: rows[0].token_ciphertext, iv: rows[0].token_iv, tag: rows[0].token_tag }).access_token; } catch { return null; }
  }

  async status(projectId: string): Promise<{ connected: boolean; account: string | null }> {
    const { rows } = await this.db.query('select account from github_connections where project_id = $1', [projectId]);
    return { connected: !!rows[0], account: rows[0]?.account ?? null };
  }

  /** Validates the token with GitHub, then stores it sealed. The token itself is never returned. */
  async saveToken(projectId: string, userId: string, token: string): Promise<{ account: string }> {
    if (!vaultConfigured()) throw new GithubError(503, 'vault_not_configured', 'TOKEN_ENC_KEY is not configured, so the token cannot be stored safely');
    const { login } = await this.client.user(token);
    const s = seal({ access_token: token, expires_at: 0 });
    await this.db.query(
      `insert into github_connections(project_id, token_ciphertext, token_iv, token_tag, account, added_by) values ($1,$2,$3,$4,$5,$6)
       on conflict (project_id) do update set token_ciphertext = excluded.token_ciphertext, token_iv = excluded.token_iv, token_tag = excluded.token_tag, account = excluded.account, added_by = excluded.added_by, created_at = now()`,
      [projectId, s.ciphertext, s.iv, s.tag, login, userId]);
    return { account: login };
  }

  async removeToken(projectId: string): Promise<void> { await this.db.query('delete from github_connections where project_id = $1', [projectId]); }

  async inspect(projectId: string, owner: string, name: string): Promise<RepoInspection> {
    return this.client.inspect(owner, name, await this.token(projectId));
  }

  /** Read credential for cloning in the sandbox's setup phase (docs/09 §2.5). Only ever handed to the AI service's sandbox layer, over the internal secret. */
  async cloneToken(projectId: string): Promise<string | null> { return this.token(projectId); }
}
