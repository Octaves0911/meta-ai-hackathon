import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../errors.js';
import { chunkDocument } from '../memory/chunker.js';
import { searchMemory } from '../memory/search.js';
import { reindexSource } from '../memory/store.js';
import { cleanRelPath, isCodeFile, isTextFile, MAX_SCAN_BYTES, MAX_TEXT_BYTES, mimeFor, PathError, resolveInside, SKIP_DIRS, summarize } from '../services/workspacePaths.js';

export interface FileRow { id: string; project_id: string; path: string; kind: 'cloud' | 'local'; size: number | null; mime: string | null; summary: string | null; updated_at: string; content_hash: string | null }
export interface ProjectRow { id: string; owner_id: string; local_root: string | null; share_workspace: boolean }
export type Level = 'write' | 'read';

const MAX_SCAN_FILES = 5000;
const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

/** Project files: uploaded (cloud) and/or a folder on the server (local). Indexed for the assistant and the agents. */
export class WorkspaceService {
  private watchers = new Map<string, FSWatcher>();
  private scanning = new Map<string, boolean>(); // true = another scan was requested while running
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private app: FastifyInstance) {}
  private get db() { return this.app.db; }

  /** Parent folder that local workspaces must live under. Unset => local folders are disabled. */
  localBase(): string | null {
    const b = process.env.WORKSPACE_LOCAL_BASE;
    return b && existsSync(b) ? realpathSync(b) : null;
  }
  cloudRoot(projectId: string) { return join(resolve(process.env.WORKSPACE_DIR ?? 'data/workspaces'), projectId); }
  maxUploadBytes() { return Number(process.env.WORKSPACE_MAX_UPLOAD_MB ?? 50) * 1024 * 1024; }

  async project(projectId: string): Promise<ProjectRow> {
    const { rows } = await this.db.query('select id, owner_id, local_root, share_workspace from projects where id = $1', [projectId]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'project not found');
    return rows[0];
  }

  /**
   * Owner: read/write. Members: read/write only if the owner shared the workspace. Meeting invitees who are not members:
   * read-only, only when the meeting allows workspace access (F10.4).
   */
  async access(projectId: string, userId: string, need: Level = 'read'): Promise<ProjectRow> {
    const { rows } = await this.db.query(
      `select p.id, p.owner_id, p.local_root, p.share_workspace,
              exists(select 1 from project_members m where m.project_id = p.id and m.user_id = $2) as member,
              exists(select 1 from meeting_participants mp join meetings mt on mt.id = mp.meeting_id
                     where mt.project_id = p.id and mp.user_id = $2 and mt.share_workspace) as invited
       from projects p where p.id = $1`, [projectId, userId]);
    const r = rows[0];
    if (!r || (!r.member && !r.invited)) throw new HttpError(404, 'not_found', 'project not found');
    const level: Level | null = r.owner_id === userId || (r.member && r.share_workspace) ? 'write' : r.invited ? 'read' : null;
    if (!level) throw new HttpError(403, 'workspace_not_shared', 'the owner has not shared this workspace');
    if (need === 'write' && level !== 'write') throw new HttpError(403, 'read_only', 'you have read-only access to this workspace');
    return r;
  }

  async file(id: string): Promise<FileRow> {
    const { rows } = await this.db.query('select * from workspace_files where id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'file not found');
    return rows[0];
  }

  localDir(project: ProjectRow): string | null {
    const base = this.localBase();
    return base && project.local_root ? join(base, project.local_root) : null;
  }

  /** Absolute, traversal-proof location of a file's bytes. */
  physical(file: FileRow, project: ProjectRow): string {
    try {
      if (file.kind === 'cloud') return resolveInside(this.cloudRoot(project.id), file.path);
      const dir = this.localDir(project);
      if (!dir) throw new HttpError(409, 'local_unavailable', 'the local folder is not connected');
      return resolveInside(dir, file.path);
    } catch (e) {
      if (e instanceof PathError) throw new HttpError(400, 'invalid_path', e.message);
      throw e;
    }
  }

  // ---- reading / writing -------------------------------------------------------------------------------------
  async readText(file: FileRow, project: ProjectRow): Promise<string> {
    const p = this.physical(file, project);
    const buf = await readFile(p).catch(() => { throw new HttpError(404, 'not_found', 'the file is no longer on disk'); });
    if (buf.length > MAX_TEXT_BYTES || !isTextFile(file.path, buf)) throw new HttpError(415, 'not_text', 'this file cannot be edited as text');
    return buf.toString('utf8');
  }

  /** Save an edited text file in place (cloud storage or the local folder) and re-index it (F10.2). */
  async saveText(file: FileRow, project: ProjectRow, content: string) {
    const buf = Buffer.from(content, 'utf8');
    if (buf.length > MAX_TEXT_BYTES) throw new HttpError(413, 'too_large', 'text files are limited to 1 MB');
    if (!isTextFile(file.path, buf)) throw new HttpError(415, 'not_text', 'this file cannot be edited as text');
    const p = this.physical(file, project);
    await writeFile(p, buf);
    const st = await stat(p);
    await this.db.query('update workspace_files set size = $2, updated_at = now(), content_hash = $3 where id = $1', [file.id, buf.length, file.kind === 'local' ? `${st.size}:${st.mtimeMs}` : sha1(buf)]);
    await this.index({ ...file, size: buf.length }, project, buf);
  }

  /** Add (or replace) an uploaded file in cloud storage. */
  async upload(project: ProjectRow, rawPath: string, buf: Buffer): Promise<FileRow> {
    let rel: string;
    try { rel = cleanRelPath(rawPath); } catch (e) { throw new HttpError(400, 'invalid_path', (e as Error).message); }
    const { rows: ex } = await this.db.query('select id, kind from workspace_files where project_id = $1 and path = $2', [project.id, rel]);
    if (ex[0]?.kind === 'local') throw new HttpError(409, 'path_exists', 'a file from the connected folder already has this path');
    const stub = { id: ex[0]?.id ?? '', project_id: project.id, path: rel, kind: 'cloud' } as FileRow;
    const p = this.physical(stub, project);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, buf);
    const { rows } = await this.db.query(
      `insert into workspace_files(project_id, path, kind, size, mime, content_hash) values ($1,$2,'cloud',$3,$4,$5)
       on conflict (project_id, path) do update set size = excluded.size, mime = excluded.mime, content_hash = excluded.content_hash, updated_at = now()
       returning *`, [project.id, rel, buf.length, mimeFor(rel), sha1(buf)]);
    await this.index(rows[0], project, buf);
    return (await this.file(rows[0].id));
  }

  /** Called when a project is deleted: stop watching and delete uploaded files (never touches a connected local folder). */
  async removeStorage(projectId: string) {
    this.stopWatcher(projectId);
    await rm(this.cloudRoot(projectId), { recursive: true, force: true });
  }

  async remove(file: FileRow, project: ProjectRow) {
    if (file.kind === 'local') throw new HttpError(409, 'local_readonly_delete', 'files in a connected folder are managed on disk; remove the file there and rescan');
    await rm(this.physical(file, project), { force: true });
    await this.db.query('delete from workspace_files where id = $1', [file.id]); // trigger removes its embeddings
  }

  // ---- indexing ---------------------------------------------------------------------------------------------
  /** Summary + embeddings for text files; other types are listed but not embedded. */
  async index(file: FileRow, project: ProjectRow, buf?: Buffer) {
    const data = buf ?? (await readFile(this.physical(file, project)).catch(() => null));
    if (!data || data.length > MAX_TEXT_BYTES || !isTextFile(file.path, data)) {
      await reindexSource(this.db, this.app.embedder, { projectId: project.id, sourceType: isCodeFile(file.path) ? 'code' : 'workspace_doc', sourceId: file.id, texts: [] });
      await this.db.query('update workspace_files set summary = null where id = $1', [file.id]);
      return;
    }
    const text = data.toString('utf8');
    await this.db.query('update workspace_files set summary = $2 where id = $1', [file.id, summarize(text, file.path)]);
    // the path leads the first chunk so searching by file name works semantically too
    await reindexSource(this.db, this.app.embedder, {
      projectId: project.id, sourceType: isCodeFile(file.path) ? 'code' : 'workspace_doc', sourceId: file.id,
      texts: chunkDocument(`${file.path}\n\n${text}`),
    });
  }

  // ---- local folder -----------------------------------------------------------------------------------------
  /** Connect (or disconnect with null) a folder under WORKSPACE_LOCAL_BASE; owner only. */
  async setLocalRoot(projectId: string, name: string | null) {
    if (name === null) {
      this.stopWatcher(projectId);
      await this.db.query("delete from workspace_files where project_id = $1 and kind = 'local'", [projectId]);
      await this.db.query('update projects set local_root = null where id = $1', [projectId]);
      return;
    }
    const base = this.localBase();
    if (!base) throw new HttpError(409, 'local_disabled', 'local folders are not enabled on this server (WORKSPACE_LOCAL_BASE)');
    if (!/^[\w][\w .-]*$/.test(name) || name === '.' || name === '..') throw new HttpError(400, 'invalid_path', 'choose a folder name from the list');
    const dir = join(base, name);
    let real: string;
    try { real = realpathSync(dir); } catch { throw new HttpError(404, 'not_found', 'that folder does not exist'); }
    if (real !== join(base, name) || !statSync(real).isDirectory()) throw new HttpError(400, 'invalid_path', 'that folder is not available');
    await this.db.query("delete from workspace_files where project_id = $1 and kind = 'local'", [projectId]); // switching folders starts clean
    await this.db.query('update projects set local_root = $2 where id = $1', [projectId, name]);
    await this.scanLocal(projectId);
    this.watch(projectId);
  }

  listLocalFolders(): string[] {
    const base = this.localBase();
    if (!base) return [];
    return readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.isSymbolicLink()).map((d) => d.name).sort();
  }

  /** Mirror the local folder into the index: add/update changed files, drop missing ones. Symlinks are never followed. */
  async scanLocal(projectId: string): Promise<{ files: number; indexed: number; removed: number }> {
    if (this.scanning.has(projectId)) { this.scanning.set(projectId, true); return { files: 0, indexed: 0, removed: 0 }; }
    this.scanning.set(projectId, false);
    try {
      const project = await this.project(projectId);
      const root = this.localDir(project);
      if (!root || !existsSync(root)) return { files: 0, indexed: 0, removed: 0 };
      const seen: string[] = [];
      let indexed = 0;
      const stack = [''];
      while (stack.length && seen.length < MAX_SCAN_FILES) {
        const rel = stack.pop()!;
        for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
          if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
          const childRel = rel ? `${rel}/${d.name}` : d.name;
          if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) stack.push(childRel); continue; }
          if (!d.isFile()) continue;
          let path: string;
          try { path = cleanRelPath(childRel); } catch { continue; }
          const st = lstatSync(join(root, path));
          if (st.size > MAX_SCAN_BYTES) continue;
          seen.push(path);
          const key = `${st.size}:${st.mtimeMs}`;
          const { rows } = await this.db.query('select id, content_hash from workspace_files where project_id = $1 and path = $2', [projectId, path]);
          if (rows[0]?.content_hash === key) continue; // unchanged
          const { rows: up } = await this.db.query(
            `insert into workspace_files(project_id, path, kind, size, mime, content_hash, updated_at) values ($1,$2,'local',$3,$4,$5,$6)
             on conflict (project_id, path) do update set size = excluded.size, mime = excluded.mime, content_hash = excluded.content_hash, updated_at = excluded.updated_at
             where workspace_files.kind = 'local' returning *`, [projectId, path, st.size, mimeFor(path), key, st.mtime]);
          if (up[0]) { await this.index(up[0], project).catch((e) => this.app.log.error(e, 'index failed')); indexed++; }
        }
      }
      const del = await this.db.query("delete from workspace_files where project_id = $1 and kind = 'local' and not (path = any($2::text[]))", [projectId, seen]);
      return { files: seen.length, indexed, removed: del.rowCount ?? 0 };
    } finally {
      const again = this.scanning.get(projectId);
      this.scanning.delete(projectId);
      if (again) void this.scanLocal(projectId).catch(() => {}); // changes arrived mid-scan
    }
  }

  // ---- watcher ----------------------------------------------------------------------------------------------
  /** Keep a connected folder in sync: any change triggers a debounced rescan (only changed files are re-embedded). */
  async watch(projectId: string) {
    this.stopWatcher(projectId);
    const root = this.localDir(await this.project(projectId));
    if (!root || !existsSync(root)) return;
    try {
      const w = watch(root, { recursive: true }, () => {
        clearTimeout(this.timers.get(projectId));
        this.timers.set(projectId, setTimeout(() => void this.scanLocal(projectId).catch((e) => this.app.log.error(e, 'scan failed')), Number(process.env.WORKSPACE_WATCH_DEBOUNCE_MS ?? 400)));
      });
      w.on('error', () => this.stopWatcher(projectId));
      this.watchers.set(projectId, w);
    } catch { /* platform without recursive watch: manual rescan still works */ }
  }
  stopWatcher(projectId: string) { this.watchers.get(projectId)?.close(); this.watchers.delete(projectId); clearTimeout(this.timers.get(projectId)); }

  async start() {
    if (!this.localBase()) return;
    const { rows } = await this.db.query('select id from projects where local_root is not null');
    for (const r of rows) { void this.scanLocal(r.id).catch(() => {}); await this.watch(r.id); }
  }
  stop() { for (const id of [...this.watchers.keys()]) this.stopWatcher(id); }

  // ---- search -----------------------------------------------------------------------------------------------
  /** File-name/summary matches first, then files whose content is semantically close. */
  async search(projectId: string, q: string) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const { rows: byName } = await this.db.query('select * from workspace_files where project_id = $1 and (path ilike $2 or summary ilike $2) order by path limit 30', [projectId, like]);
    const hits = await searchMemory(this.db, this.app.embedder, { projectId, query: q, types: ['workspace_doc', 'code'], k: 12 });
    const out = new Map<string, { file: FileRow; snippet: string | null; score: number | null }>();
    for (const f of byName) out.set(f.id, { file: f, snippet: f.summary, score: null });
    const ids = hits.map((h) => h.sourceId).filter((x): x is string => !!x && !out.has(x));
    if (ids.length) {
      const { rows } = await this.db.query('select * from workspace_files where id = any($1::uuid[])', [ids]);
      for (const h of hits) { const f = rows.find((r) => r.id === h.sourceId); if (f && !out.has(f.id)) out.set(f.id, { file: f, snippet: h.text.slice(0, 200), score: h.score }); }
    }
    return [...out.values()];
  }
}
