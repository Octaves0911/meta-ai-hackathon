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
export const MAX_TREE_FILES = 6000;
export const MAX_FILE_BYTES = 200_000;

/** Files an agent must never read, whatever the repository: credentials, keys, environment files. Enforced here, the last line of defence. */
const SECRET_PATH = /(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.aws|\.ssh|\.gnupg|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.[a-z]+)?|secrets?(\.[a-z]+)?|service[-_]?account.*\.json|.*\.(pem|key|p12|pfx|jks|keystore|kdbx))$/i;
const SECRET_DIR = /(^|\/)\.(ssh|aws|gnupg|kube|docker)(\/|$)/i;  // anything inside these directories
export const isSecretPath = (p: string) => SECRET_PATH.test(p) || SECRET_DIR.test(p);
/** A repository-relative path: no traversal, no absolute paths, no control characters, not a secret. */
export function safePath(p: string): string | null {
  if (typeof p !== 'string' || !p || p.length > 300 || p.startsWith('/') || /[\0\r\n\\]/.test(p)) return null;
  if (p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  return isSecretPath(p) ? null : p;
}
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|coverage|vendor|\.next|\.venv|__pycache__|\.cache|target)\//;
const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock)$/;
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
        signal: AbortSignal.timeout(15_000), redirect: 'manual', // never follow a redirect to somewhere else with a token attached
      });
    } catch { throw new GithubError(502, 'github_unreachable', 'GitHub could not be reached'); }
    if ([301, 302, 307, 308].includes(res.status) || res.type === 'opaqueredirect') throw new GithubError(404, 'repo_moved', 'This repository has moved or been renamed on GitHub; use its new link');
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

  /** The repository's file list at a ref (default branch if none): paths and sizes, minus secrets, vendored folders and lockfiles. */
  async tree(owner: string, name: string, ref: string, token?: string | null): Promise<{ ref: string; commit: string; truncated: boolean; files: { path: string; size: number; mode: string }[] }> {
    if (!OWNER.test(owner) || !NAME.test(name) || !/^[A-Za-z0-9._\/-]{1,200}$/.test(ref) || ref.includes('..')) throw new GithubError(400, 'invalid_repo', 'that is not a valid repository or branch');
    const c = await this.get(`/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`, token);   // pin the exact commit: later reads, the sandbox clone and the PR branch all use it
    if (!/^[0-9a-f]{40}$/i.test(String(c?.sha ?? ''))) throw new GithubError(502, 'github_error', 'GitHub returned no commit for that branch');
    const t = await this.get(`/repos/${owner}/${name}/git/trees/${c.sha}?recursive=1`, token);
    const files = (Array.isArray(t.tree) ? t.tree : []).filter((e: any) => e.type === 'blob' && typeof e.path === 'string')
      .filter((e: any) => safePath(e.path) && !SKIP_DIRS.test(e.path) && !LOCKFILES.test(e.path)).slice(0, MAX_TREE_FILES).map((e: any) => ({ path: String(e.path), size: Number(e.size ?? 0), mode: String(e.mode ?? '100644') }));
    return { ref, commit: String(c.sha).toLowerCase(), truncated: !!t.truncated || files.length >= MAX_TREE_FILES, files };
  }

  /** One text file at a ref. Secrets, directories, binaries and anything over 200 KB are refused. */
  async file(owner: string, name: string, path: string, ref: string, token?: string | null): Promise<{ path: string; size: number; text: string }> {
    if (!OWNER.test(owner) || !NAME.test(name) || !/^[A-Za-z0-9._\/-]{1,200}$/.test(ref) || ref.includes('..')) throw new GithubError(400, 'invalid_repo', 'that is not a valid repository or branch');
    const p = safePath(path);
    if (!p) throw new GithubError(403, 'path_not_allowed', 'that path cannot be read');
    const c = await this.get(`/repos/${owner}/${name}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, token);
    if (Array.isArray(c) || c?.type !== 'file') throw new GithubError(400, 'not_a_file', 'that path is not a file');
    if (Number(c.size) > MAX_FILE_BYTES) throw new GithubError(413, 'file_too_large', 'that file is too large to read');
    const buf = Buffer.from(String(c.content ?? ''), 'base64');
    if (buf.includes(0)) throw new GithubError(415, 'binary_file', 'that file is not text');
    return { path: p, size: buf.length, text: buf.toString('utf8') };
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
  constructor(private db: pg.Pool, private client = new GithubClient(), private writer = new GithubWriter()) {}

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

  /** Opens a pull request with the project's token. Needs a stored token; refuses everything the PR path refuses (protected paths, size, branch names). */
  async createPullRequest(projectId: string, r: PrRequest): Promise<PrResult> {
    const token = await this.token(projectId);
    if (!token) throw new GithubError(409, 'github_not_connected', 'Connect a GitHub token with write access in project settings first');
    return this.writer.createPullRequest(r, token);
  }

  tree(projectId: string, owner: string, name: string, ref: string) { return this.token(projectId).then((t) => this.client.tree(owner, name, ref, t)); }
  file(projectId: string, owner: string, name: string, path: string, ref: string) { return this.token(projectId).then((t) => this.client.file(owner, name, path, ref, t)); }
}

// ---------------------------------------------------------------- pull requests (docs/09 §2.5, L3)
export const MAX_PR_FILES = 8;
export const MAX_PR_BYTES = 300_000;
const BRANCH = /^meetpilot\/[a-z0-9][a-z0-9-]{2,60}$/;
const SHA = /^[0-9a-f]{40}$/i;
const PROTECTED = /(^|\/)(\.git|\.github\/workflows|node_modules)(\/|$)/i;
const FILE_MODES = new Set(['100644', '100755']);

export interface PrFile { path: string; content: string; mode?: string }
export interface PrRequest { owner: string; name: string; baseBranch: string; baseSha: string; branch: string; title: string; body: string; files: PrFile[]; draft: boolean; message: string }
export interface PrResult { number: number; url: string; branch: string; headSha: string }

/** Everything the PR path refuses before any request is made. Returns the problem, or null. */
export function prProblem(r: PrRequest): string | null {
  if (!OWNER.test(r.owner) || !NAME.test(r.name)) return 'invalid repository';
  if (!BRANCH.test(r.branch)) return 'the branch name must look like meetpilot/short-description';
  if (!SHA.test(r.baseSha)) return 'the base commit is not a full commit id';
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(r.baseBranch) || r.baseBranch.includes('..')) return 'invalid base branch';
  if (!r.title.trim() || r.title.length > 200 || /[\r\n]/.test(r.title)) return 'the title must be one line of at most 200 characters';
  if (r.body.length > 20_000 || r.message.length > 5_000) return 'the description is too long';
  if (!r.files.length || r.files.length > MAX_PR_FILES) return `a pull request carries between 1 and ${MAX_PR_FILES} files`;
  let bytes = 0;
  const seen = new Set<string>();
  for (const f of r.files) {
    if (!safePath(f.path) || PROTECTED.test(f.path)) return `${String(f.path).slice(0, 80)} cannot be changed by an agent`;
    if (seen.has(f.path)) return `${f.path} appears twice`;
    seen.add(f.path);
    if (typeof f.content !== 'string' || f.content.includes('\0')) return `${f.path} is not text`;
    if (f.mode && !FILE_MODES.has(f.mode)) return `${f.path} has an unsupported file mode`;
    bytes += Buffer.byteLength(f.content);
  }
  return bytes > MAX_PR_BYTES ? 'the change is too large for a pull request' : null;
}

export class GithubWriter {
  constructor(private f: Fetch = fetch) {}

  private async send(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await this.f(`${API()}${path}`, {
        method, headers: { accept: 'application/vnd.github+json', 'user-agent': 'MeetPilot', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000), redirect: 'manual',
      });
    } catch { throw new GithubError(502, 'github_unreachable', 'GitHub could not be reached'); }
    if (res.ok) return res.json();
    let detail = '';
    try { const j: any = await res.json(); detail = [j?.message, ...(Array.isArray(j?.errors) ? j.errors.map((e: any) => e?.message ?? e?.code) : [])].filter(Boolean).join('; ').slice(0, 240); } catch { /* no body */ }
    detail = detail.split(token).join('***'); // GitHub never echoes the token, but an error must not be able to carry it either
    if (res.status === 401) throw new GithubError(401, 'bad_token', 'GitHub rejected the token');
    if (res.status === 403 || res.status === 404) throw new GithubError(403, 'no_write_access', 'The GitHub token cannot push to this repository. It needs Contents and Pull requests write access to it.');
    if (res.status === 422 && /reference already exists/i.test(detail)) throw new GithubError(409, 'branch_exists', 'A branch with that name already exists');
    if (res.status === 422) throw new GithubError(422, 'github_rejected', `GitHub refused the pull request: ${detail || 'validation failed'}`);
    if (res.status === 429) throw new GithubError(429, 'rate_limited', 'GitHub rate limit reached; try again later');
    throw new GithubError(502, 'github_error', `GitHub answered ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  /** One commit on a NEW branch cut from the exact commit that was read and verified, then a pull request into the base branch. Never touches the base branch itself, never force-pushes, never merges. */
  async createPullRequest(r: PrRequest, token: string): Promise<PrResult> {
    const bad = prProblem(r);
    if (bad) throw new GithubError(400, 'invalid_request', bad);
    const base = `/repos/${r.owner}/${r.name}`;
    const parent = await this.send('GET', `${base}/git/commits/${r.baseSha}`, token);
    const blobs = [];
    for (const f of r.files) blobs.push({ path: f.path, sha: (await this.send('POST', `${base}/git/blobs`, token, { content: f.content, encoding: 'utf-8' })).sha, mode: f.mode ?? '100644' });
    const tree = await this.send('POST', `${base}/git/trees`, token, { base_tree: parent.tree.sha, tree: blobs.map((b) => ({ path: b.path, mode: b.mode, type: 'blob', sha: b.sha })) });
    const commit = await this.send('POST', `${base}/git/commits`, token, { message: r.message, tree: tree.sha, parents: [r.baseSha] });
    await this.send('POST', `${base}/git/refs`, token, { ref: `refs/heads/${r.branch}`, sha: commit.sha });   // a new ref only: an existing branch is an error, never updated
    const pr = await this.send('POST', `${base}/pulls`, token, { title: r.title, head: r.branch, base: r.baseBranch, body: r.body, draft: r.draft, maintainer_can_modify: true });
    return { number: Number(pr.number), url: String(pr.html_url), branch: r.branch, headSha: String(commit.sha) };
  }
}
